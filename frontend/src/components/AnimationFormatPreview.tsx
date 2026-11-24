import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { BVHLoader } from "three/examples/jsm/loaders/BVHLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { getToken } from "../api";
import { inflateFbxBuffer, isFbxFileName } from "../utils/zstdFbx";
import { useReportPlayback } from "../playbackClock";
import { faceMeshOutward } from "../utils/faceOutward";
import type { RetargetFrame, RetargetFrameSkeleton } from "../types";
import {
  applyViewerFigureColors,
  FrameFigure,
  shiftCameraWithPoint,
  DataOriginAxes,
  SkeletonLines,
  useViewerLook,
  ViewerSceneChrome,
} from "./ViewerSceneChrome";
import { NAMES_OFF, NameToggleButtons, SceneNameLabels, useNameFlags, type NameFlags } from "./NameLabels";
import {
  cycleUpAxisMode,
  detectUpAxisFromPointFrames,
  resolveUpAxis,
  upAxisModeLabel,
  upAxisToRotationX,
  uprightGroundOffset,
  useUpAxisMode,
  type LayoutPoint,
  type UpAxis,
} from "../viewerUpAxis";
import {
  cycleLengthUnitMode,
  detectLengthUnit,
  detectLengthUnitFromExtents,
  lengthUnitModeLabel,
  lengthUnitToScale,
  resolveLengthUnit,
  useLengthUnitMode,
  type LengthUnit,
  type LengthUnitMode,
} from "../viewerUnits";
import {
  isNamedSkeletonBone,
  pointDisplayName,
  rigidMarkerKey,
  rigidPrettyName,
  skeletonJointName,
} from "../captureLabels";

const _bvhHips = new THREE.Vector3();
const _followPoint = new THREE.Vector3();
const _bvhBox = new THREE.Box3();
const _bvhPt = new THREE.Vector3();
const _meshBox = new THREE.Box3();
const _meshSize = new THREE.Vector3();

/** WebGL 不可用或渲染出错时给出提示，而不是留下空白画布。 */
class CanvasErrorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: "" };

  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(err: unknown) {
    console.error("[preview] canvas 渲染失败", err);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="storage-preview-empty">
          3D 渲染失败：{this.state.error}
          <br />
          请确认浏览器支持并开启了 WebGL
        </div>
      );
    }
    return this.props.children;
  }
}

async function fetchBinary(url: string) {
  const token = getToken();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`文件下载失败（${res.status}）`);
  return inflateFbxBuffer(await res.arrayBuffer());
}

export function BvhScene({
  url,
  time,
  duration,
  onDuration,
  viewNonce = 0,
  rotationX = 0,
  unitMode = "auto",
  followRoot = false,
  names = NAMES_OFF,
  onDetectedUpAxis,
  onDetectedLengthUnit,
}: {
  url: string;
  time: number;
  duration: number;
  onDuration?: (sec: number) => void;
  viewNonce?: number;
  rotationX?: number;
  unitMode?: LengthUnitMode;
  followRoot?: boolean;
  names?: NameFlags;
  onDetectedUpAxis?: (up: UpAxis) => void;
  onDetectedLengthUnit?: (unit: LengthUnit) => void;
}) {
  const centerRef = useRef<THREE.Group>(null);
  const boneRootRef = useRef<THREE.Bone | null>(null);
  const helperRef = useRef<THREE.SkeletonHelper | null>(null);
  const mixer = useRef<THREE.AnimationMixer | null>(null);
  const action = useRef<THREE.AnimationAction | null>(null);
  const fixedOffset = useRef(new THREE.Vector3());
  const offsetReady = useRef(false);
  const onDurationRef = useRef(onDuration);
  onDurationRef.current = onDuration;
  const onDetectedRef = useRef(onDetectedUpAxis);
  onDetectedRef.current = onDetectedUpAxis;
  const onDetectedUnitRef = useRef(onDetectedLengthUnit);
  onDetectedUnitRef.current = onDetectedLengthUnit;
  const samplesRef = useRef<{ points: LayoutPoint[]; roots: LayoutPoint[] }>({ points: [], roots: [] });
  const [layoutNonce, setLayoutNonce] = useState(0);
  const [detectedUnit, setDetectedUnit] = useState<LengthUnit>("m");
  const [boneRoot, setBoneRoot] = useState<THREE.Bone | null>(null);
  const [helper, setHelper] = useState<THREE.SkeletonHelper | null>(null);
  const [scale, setScale] = useState(0.01);
  const [axisLength, setAxisLength] = useState(1);
  const [offset, setOffset] = useState<[number, number, number]>([0, 0, 0]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const look = useViewerLook();
  const followRef = useRef(followRoot);
  const lastRoot = useRef(new THREE.Vector3());
  const hasLastRoot = useRef(false);
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as
    | { target: THREE.Vector3; update: () => void }
    | undefined;
  followRef.current = followRoot;

  useEffect(() => {
    hasLastRoot.current = false;
  }, [followRoot, url, rotationX]);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError("");
    setBoneRoot(null);
    hasLastRoot.current = false;
    setHelper(null);
    setOffset([0, 0, 0]);
    boneRootRef.current = null;
    mixer.current = null;
    action.current = null;
    offsetReady.current = false;
    fixedOffset.current.set(0, 0, 0);
    samplesRef.current = { points: [], roots: [] };
    if (helperRef.current) {
      helperRef.current.geometry.dispose();
      (helperRef.current.material as THREE.Material).dispose();
      helperRef.current = null;
    }

    const loader = new BVHLoader();
    fetchBinary(url)
      .then((buf) => {
        if (cancelled) return;
        const text = new TextDecoder().decode(buf);
        if (!/HIERARCHY/i.test(text) || !/MOTION/i.test(text)) {
          throw new Error("不是有效的 BVH 文件");
        }
        const result = loader.parse(text);
        const bone0 = result.skeleton?.bones?.[0];
        if (!bone0) throw new Error("BVH 中没有骨骼根节点");

        if (bone0.parent) bone0.parent.remove(bone0);

        const probeMixer = new THREE.AnimationMixer(bone0);
        const probeAction = probeMixer.clipAction(result.clip);
        probeAction.play();
        probeAction.paused = true;

        const clipDur = result.clip.duration || 1;
        let spanY = 0;
        let spanZ = 0;
        const poseFrames: LayoutPoint[][] = [];
        const roots: LayoutPoint[] = [];
        const points: LayoutPoint[] = [];
        const n = 24;
        for (let i = 0; i < n; i++) {
          probeAction.time = (i / Math.max(n - 1, 1)) * clipDur;
          probeMixer.update(0);
          bone0.updateMatrixWorld(true);
          bone0.getWorldPosition(_bvhHips);
          roots.push({ x: _bvhHips.x, y: _bvhHips.y, z: _bvhHips.z });
          const pose = collectPoseSamples(bone0);
          if (pose.length) {
            poseFrames.push(pose);
            points.push(...pose);
            let minY = Infinity;
            let maxY = -Infinity;
            let minZ = Infinity;
            let maxZ = -Infinity;
            for (const point of pose) {
              minY = Math.min(minY, point.y);
              maxY = Math.max(maxY, point.y);
              minZ = Math.min(minZ, point.z);
              maxZ = Math.max(maxZ, point.z);
            }
            spanY = Math.max(spanY, maxY - minY);
            spanZ = Math.max(spanZ, maxZ - minZ);
          }
        }
        const maxHeight = Math.max(spanY, spanZ);
        onDetectedRef.current?.(detectUpAxisFromPointFrames(poseFrames));
        const unit = detectLengthUnit(maxHeight);
        setDetectedUnit(unit);
        setAxisLength(maxHeight > 1e-6 ? maxHeight : 1);
        onDetectedUnitRef.current?.(unit);
        samplesRef.current = { points, roots };
        setLayoutNonce((value) => value + 1);

        const jointRadius = Math.max((maxHeight || 1) * 0.016, 1e-4);
        const jointGeo = new THREE.SphereGeometry(jointRadius, 10, 10);
        const jointMat = new THREE.MeshBasicMaterial({
          color: look.joint,
        });
        bone0.traverse((obj) => {
          if (!(obj as THREE.Bone).isBone) return;
          const dot = new THREE.Mesh(jointGeo, jointMat);
          dot.name = "__bvh_joint_dot";
          obj.add(dot);
        });

        const nextHelper = styleSkeletonHelper(new THREE.SkeletonHelper(bone0), look);
        helperRef.current = nextHelper;

        boneRootRef.current = bone0;
        mixer.current = probeMixer;
        action.current = probeAction;
        if (clipDur > 0) onDurationRef.current?.(clipDur);
        setBoneRoot(bone0);
        setHelper(nextHelper);
        setStatus("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        console.error(e);
        setStatus("error");
        setError(e instanceof Error ? e.message : "BVH 加载失败");
      });

    return () => {
      cancelled = true;
      if (helperRef.current) {
        helperRef.current.geometry.dispose();
        (helperRef.current.material as THREE.Material).dispose();
        helperRef.current = null;
      }
      const bone = boneRootRef.current;
      if (bone) {
        let disposedGeo: THREE.BufferGeometry | null = null;
        let disposedMat: THREE.Material | null = null;
        bone.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (mesh.name !== "__bvh_joint_dot") return;
          if (mesh.parent) mesh.parent.remove(mesh);
          if (mesh.geometry && mesh.geometry !== disposedGeo) {
            disposedGeo = mesh.geometry;
            disposedGeo.dispose();
          }
          if (mesh.material && mesh.material !== disposedMat) {
            disposedMat = mesh.material as THREE.Material;
            disposedMat.dispose();
          }
        });
      }
    };
  }, [url]);

  useEffect(() => {
    const nextScale = lengthUnitToScale(resolveLengthUnit(unitMode, detectedUnit));
    const next = uprightGroundOffset(
      samplesRef.current.points,
      samplesRef.current.roots,
      rotationX,
      nextScale,
    );
    fixedOffset.current.set(next[0], next[1], next[2]);
    offsetReady.current = samplesRef.current.points.length > 0;
    setScale(nextScale);
    setOffset(next);
  }, [unitMode, detectedUnit, rotationX, layoutNonce]);

  useEffect(() => {
    applyViewerFigureColors(helperRef.current, boneRootRef.current, look);
  }, [look, boneRoot, status]);

  useFrame(() => {
    const center = centerRef.current;
    if (!mixer.current || !action.current || !center) return;

    const clipDur = action.current.getClip().duration || duration || 1;
    action.current.time = Math.min(Math.max(time, 0), clipDur);
    mixer.current.update(0);
    if (offsetReady.current) {
      center.position.copy(fixedOffset.current);
    }
    const root = boneRootRef.current;
    if (!root) return;
    root.getWorldPosition(_followPoint);
    shiftCameraWithPoint(
      _followPoint,
      camera,
      controls,
      lastRoot.current,
      hasLastRoot,
      followRef.current,
    );
  });

  return (
    <>
      {helper && <primitive object={helper} />}
      <SkeletonLines root={boneRoot} color={look.bone} />
      <group ref={centerRef} position={offset}>
        <group rotation={[rotationX, 0, 0]}>
          {boneRoot && (
            <group scale={scale}>
              <DataOriginAxes length={axisLength} />
              <primitive object={boneRoot} />
              <SceneNameLabels root={boneRoot} names={names} />
            </group>
          )}
        </group>
        <FrameFigure
          objectRef={centerRef}
          ready={status === "ready" && !!boneRoot}
          resetKey={`${url}:${scale}:${offset.join(",")}:${rotationX}`}
          nonce={viewNonce}
        />
        {status === "loading" && (
          <Html center style={{ pointerEvents: "none" }}>
            <div className="muted animation-format-status">BVH 加载中…</div>
          </Html>
        )}
        {status === "error" && (
          <Html center style={{ pointerEvents: "none" }}>
            <div className="error animation-format-status">{error || "BVH 可视化失败"}</div>
          </Html>
        )}
      </group>
    </>
  );
}

/** 骨架关节，以及刚体 / marker 网格的包围盒角点。 */
function collectPoseSamples(root: THREE.Object3D): LayoutPoint[] {
  const points: LayoutPoint[] = [];
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    const bone = obj as THREE.Bone;
    const mesh = obj as THREE.Mesh;
    if (bone.isBone) {
      obj.getWorldPosition(_bvhPt);
      points.push({ x: _bvhPt.x, y: _bvhPt.y, z: _bvhPt.z });
      return;
    }
    if (
      !mesh.isMesh ||
      (mesh as THREE.SkinnedMesh).isSkinnedMesh ||
      mesh.name.startsWith("__") ||
      !mesh.geometry?.attributes?.position?.count
    ) {
      return;
    }
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const local = mesh.geometry.boundingBox;
    if (!local || local.isEmpty()) return;
    const xs = [local.min.x, local.max.x];
    const ys = [local.min.y, local.max.y];
    const zs = [local.min.z, local.max.z];
    for (const x of xs) {
      for (const y of ys) {
        for (const z of zs) {
          _bvhPt.set(x, y, z).applyMatrix4(mesh.matrixWorld);
          points.push({ x: _bvhPt.x, y: _bvhPt.y, z: _bvhPt.z });
        }
      }
    }
  });
  return points;
}

function expandSkeletonBox(root: THREE.Object3D, box: THREE.Box3) {
  box.makeEmpty();
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    if ((obj as THREE.Bone).isBone) {
      obj.getWorldPosition(_bvhPt);
      box.expandByPoint(_bvhPt);
    }
  });
  if (box.isEmpty()) {
    box.setFromObject(root);
  }
}

/** 取骨骼最多的那棵骨架。道具、刚体点不会和人体绑在同一棵树上。 */
function primaryBoneRoot(root: THREE.Object3D): THREE.Object3D | null {
  let best: THREE.Object3D | null = null;
  let bestCount = 0;
  root.traverse((obj) => {
    if (!(obj as THREE.Bone).isBone) return;
    if (obj.parent && (obj.parent as THREE.Bone).isBone) return;
    let count = 0;
    obj.traverse((child) => {
      if ((child as THREE.Bone).isBone) count += 1;
    });
    if (count > bestCount) {
      best = obj;
      bestCount = count;
    }
  });
  return bestCount >= 2 ? best : null;
}

function styleSkeletonHelper(helper: THREE.SkeletonHelper, look?: { bone: string }) {
  const mat = helper.material as THREE.LineBasicMaterial;
  mat.depthTest = false;
  mat.depthWrite = false;
  mat.transparent = true;
  mat.opacity = 1;
  mat.vertexColors = false;
  if (look) mat.color.set(look.bone);
  helper.frustumCulled = false;
  return helper;
}

function expandMeshBox(root: THREE.Object3D, box: THREE.Box3) {
  box.makeEmpty();
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || mesh.name === "__joint_dot" || !mesh.geometry?.attributes?.position?.count) {
      return;
    }
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const local = mesh.geometry.boundingBox;
    if (!local || local.isEmpty()) return;
    box.expandByPoint(_bvhPt.copy(local.min).applyMatrix4(mesh.matrixWorld));
    box.expandByPoint(_bvhPt.copy(local.max).applyMatrix4(mesh.matrixWorld));
  });
}

function isObstacleMesh(mesh: THREE.Mesh) {
  const name = `${mesh.name} ${mesh.parent?.name || ""}`;
  return /obstacle/i.test(name);
}

function styleObstacleMeshes(root: THREE.Object3D) {
  const wood = new THREE.MeshStandardMaterial({
    color: 0xd7b98a,
    roughness: 0.55,
    metalness: 0.04,
    emissive: 0x4a3218,
    emissiveIntensity: 0.28,
    side: THREE.FrontSide,
  });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0xfff3df });
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !isObstacleMesh(mesh)) return;
    if (!mesh.geometry?.attributes?.position?.count) return;
    faceMeshOutward(mesh.geometry);
    mesh.material = wood;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    if (mesh.getObjectByName("__obstacle_edges")) return;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 15), edgeMat);
    edges.name = "__obstacle_edges";
    edges.castShadow = false;
    mesh.add(edges);
  });
}

type CaptureRole =
  | "table-marker"
  | "table"
  | "rigid-marker"
  | "rigid"
  | "skeleton-marker"
  | "marker";

type CaptureTable = {
  markers: THREE.Object3D[];
  surface: THREE.BufferAttribute;
  edge: THREE.BufferAttribute;
};

type CaptureHull = {
  key: string;
  markers: THREE.Object3D[];
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
};

type CaptureLink = {
  markers: THREE.Object3D[];
  lines: LineSegments2;
};

const RIGID_COLORS = [0xf08c00, 0x4dabf7, 0xbe4bdb, 0x40c057];

function captureLabel(obj: THREE.Object3D) {
  const original = String(obj.userData.originalName || obj.name || "");
  return original.toLowerCase().replace(/[:\s]+/g, "_");
}

function captureRole(obj: THREE.Object3D): CaptureRole | null {
  // 骨骼只走骨架线。`Skeleton 001_Hips` 归一化后和光学点 `Skeleton_001_*` 撞名，不能再当成标记点。
  if ((obj as THREE.Bone).isBone) return null;
  const name = captureLabel(obj);
  const original = String(obj.userData.originalName || obj.name || "");
  if (/_root$/.test(name) || /_bone$/.test(name) || name === "marker_null_root" || /optical$/.test(name)) return null;
  if (/table_marker_?\d+/.test(name)) return "table-marker";
  if (/(^|_)table$/.test(name)) return "table";
  if (rigidMarkerKey(name)) return "rigid-marker";
  if (/刚体/.test(original) && /点|marker/.test(name)) return "rigid-marker";
  if (/rigid_?body_?\d+$/.test(name) || /rigidbody_?\d+$/.test(name) || /^rb_?\d+$/.test(name)) return "rigid";
  if (/刚体/.test(original)) return "rigid";
  if (/skeleton_\d+_/.test(name)) return "skeleton-marker";
  if (/unlabeled_?\d+/.test(name) || /(^|_)marker_?\d+$/.test(name) || /标记|光点/.test(original)) return "marker";
  return null;
}

function rigidMarkerGroups(root: THREE.Object3D) {
  const groups = new Map<string, THREE.Object3D[]>();
  root.traverse((obj) => {
    const key = rigidMarkerKey(captureLabel(obj));
    if (!key) return;
    const list = groups.get(key) ?? [];
    list.push(obj);
    groups.set(key, list);
  });
  return groups;
}

function captureSizes(height: number) {
  const centimeter = height > 20;
  const marker = Math.max(height * 0.012, centimeter ? 0.8 : 0.01);
  const body = Math.max(height * 0.045, centimeter ? 2.4 : 0.03);
  // Centimetre captures keep the old 4 mm floor. A metre-scale robot file
  // must not reuse that 0.4 as 40 cm, or the paddle disc covers the hand.
  const thickness = centimeter ? Math.max(body * 0.08, 0.4) : Math.max(body * 0.08, 0.004);
  return { marker, body, thickness };
}

function displayMeshes(root: THREE.Object3D) {
  const meshes: THREE.Mesh[] = [];
  const self = root as THREE.Mesh;
  if (self.isMesh && !self.name.startsWith("__") && self.geometry?.attributes?.position?.count) meshes.push(self);
  const visit = (obj: THREE.Object3D) => {
    obj.children.forEach((child) => {
      if (captureRole(child)) return;
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh && !mesh.name.startsWith("__") && mesh.geometry?.attributes?.position?.count) meshes.push(mesh);
      visit(child);
    });
  };
  visit(root);
  return meshes;
}

function rigidColor(name: string) {
  const match = name.match(/rigid_body_(\d+)/);
  if (match) return RIGID_COLORS[(Math.max(1, Number(match[1])) - 1) % RIGID_COLORS.length];
  let hash = 0;
  for (const char of name) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return RIGID_COLORS[hash % RIGID_COLORS.length];
}

function findLabeled(root: THREE.Object3D, label: string) {
  let found: THREE.Object3D | null = null;
  root.traverse((obj) => {
    if (!found && captureLabel(obj) === label) found = obj;
  });
  return found;
}

function orderPlanar(points: THREE.Vector3[]) {
  const center = new THREE.Vector3();
  points.forEach((point) => center.add(point));
  center.multiplyScalar(1 / points.length);
  const variance = [0, 0, 0];
  for (const point of points) {
    variance[0] += (point.x - center.x) ** 2;
    variance[1] += (point.y - center.y) ** 2;
    variance[2] += (point.z - center.z) ** 2;
  }
  const normal = variance.indexOf(Math.min(...variance));
  const u = normal === 0 ? 1 : 0;
  const v = normal === 2 ? 1 : 2;
  const coord = (point: THREE.Vector3, axis: number) =>
    axis === 0 ? point.x : axis === 1 ? point.y : point.z;
  return [...points].sort((left, right) => {
    const leftAngle = Math.atan2(coord(left, v) - coord(center, v), coord(left, u) - coord(center, u));
    const rightAngle = Math.atan2(coord(right, v) - coord(center, v), coord(right, u) - coord(center, u));
    return leftAngle - rightAngle;
  });
}

function addCaptureDot(parent: THREE.Object3D, radius: number, color: number, name: string) {
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 12, 10),
    new THREE.MeshBasicMaterial({ color, depthTest: false })
  );
  dot.name = name;
  dot.frustumCulled = false;
  dot.renderOrder = 4;
  parent.add(dot);
}

function dedupePoints(points: THREE.Vector3[], tolerance: number) {
  const unique: THREE.Vector3[] = [];
  const limit = tolerance * tolerance;
  for (const point of points) {
    if (!unique.some((kept) => kept.distanceToSquared(point) <= limit)) unique.push(point);
  }
  return unique;
}

/**
 * 盒子的每个角会沿三条互相垂直的棱连到另外三个角。
 * 只保留双方都认可的棱，就能把贴在一起的几块箱子拆开。
 */
function orthogonalPieces(points: THREE.Vector3[]) {
  const count = points.length;
  if (count < 4 || count > 24) return [points];
  const chosen: number[][] = Array.from({ length: count }, () => []);
  const dotMax = 0.15;
  const ids = Array.from({ length: count }, (_, index) => index);
  for (let i = 0; i < count; i += 1) {
    let bestScore = Infinity;
    let bestLength = Infinity;
    let best: number[] | null = null;
    const others = ids.filter((index) => index !== i);
    for (let a = 0; a < others.length; a += 1) {
      for (let b = a + 1; b < others.length; b += 1) {
        for (let c = b + 1; c < others.length; c += 1) {
          const comb = [others[a], others[b], others[c]];
          const dirs: THREE.Vector3[] = [];
          let length = 0;
          let valid = true;
          for (const index of comb) {
            const edge = points[index].clone().sub(points[i]);
            const edgeLength = edge.length();
            if (edgeLength < 1e-4) {
              valid = false;
              break;
            }
            length += edgeLength;
            dirs.push(edge.multiplyScalar(1 / edgeLength));
          }
          if (!valid) continue;
          const dots = [
            Math.abs(dirs[0].dot(dirs[1])),
            Math.abs(dirs[0].dot(dirs[2])),
            Math.abs(dirs[1].dot(dirs[2])),
          ];
          const worst = Math.max(...dots);
          if (worst > dotMax) continue;
          const score = dots[0] + dots[1] + dots[2];
          if (score < bestScore - 1e-6 || (Math.abs(score - bestScore) <= 1e-6 && length < bestLength)) {
            bestScore = score;
            bestLength = length;
            best = comb;
          }
        }
      }
    }
    if (best) chosen[i] = best;
  }
  const parent = Array.from({ length: count }, (_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index])));
  for (let i = 0; i < count; i += 1) {
    for (const other of chosen[i]) {
      if (!chosen[other].includes(i)) continue;
      const left = find(i);
      const right = find(other);
      if (left !== right) parent[left] = right;
    }
  }
  const groups = new Map<number, THREE.Vector3[]>();
  points.forEach((point, index) => {
    const root = find(index);
    const list = groups.get(root) ?? [];
    list.push(point);
    groups.set(root, list);
  });
  const clusters = [...groups.values()];
  const solids = clusters.filter((group) => group.length >= 4);
  const loose = clusters.flatMap((group) => (group.length >= 4 ? [] : group));
  const parts = [...solids];
  if (loose.length >= 4) parts.push(loose);
  return parts.length ? parts : [points];
}

function geometryFromPoints(points: THREE.Vector3[]) {
  try {
    const hull = new ConvexGeometry(points);
    if (hull.getAttribute("position")?.count) return hull;
    hull.dispose();
  } catch {
    // 共面时没有体积，铺成多边形。
  }
  const ordered = orderPlanar(points);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(ordered.flatMap((point) => [point.x, point.y, point.z]), 3)
  );
  const index: number[] = [];
  for (let i = 1; i < ordered.length - 1; i += 1) index.push(0, i, i + 1);
  geometry.setIndex(index);
  return geometry;
}

function solidFromPoints(points: THREE.Vector3[]) {
  const unique = dedupePoints(points, 1e-3);
  if (unique.length < 4) return null;
  const parts = orthogonalPieces(unique);
  const geometries: THREE.BufferGeometry[] = [];
  for (const part of parts) {
    const body = dedupePoints(part, 1e-3);
    if (body.length < 4) continue;
    geometries.push(geometryFromPoints(body));
  }
  if (!geometries.length) return null;
  if (geometries.length === 1) return geometries[0];
  const triangles = geometries.map((geometry) => {
    if (!geometry.index) return geometry;
    const expanded = geometry.toNonIndexed();
    geometry.dispose();
    return expanded;
  });
  const merged = mergeGeometries(triangles);
  triangles.forEach((geometry) => geometry.dispose());
  return merged ?? null;
}

function markerPositions(root: THREE.Object3D, markers: THREE.Object3D[]) {
  root.updateWorldMatrix(true, true);
  return markers.map((marker) => {
    const point = new THREE.Vector3();
    marker.getWorldPosition(point);
    root.worldToLocal(point);
    return point;
  });
}

function attachCaptureProps(root: THREE.Object3D, height: number) {
  const { marker: markerRadius, body: bodyRadius } = captureSizes(height);
  const tableMarkers: THREE.Object3D[] = [];
  const rigidGroups = rigidMarkerGroups(root);
  rigidGroups.forEach((markers, key) => {
    const label = rigidPrettyName(String(markers[0].userData.originalName || markers[0].name || ""), key);
    markers.forEach((marker) => {
      marker.userData.rigidLabel = label;
    });
    const pivot = findLabeled(root, key);
    if (pivot) {
      pivot.userData.nameKind = "rigid";
      pivot.userData.rigidLabel = pivot.userData.rigidLabel || label;
    }
  });
  const hulled = new Set<string>();
  rigidGroups.forEach((markers, key) => {
    if (markers.length < 4) return;
    const pivot = findLabeled(root, key);
    if (pivot && displayMeshes(pivot).length) return;
    hulled.add(key);
  });
  root.traverse((obj) => {
    const role = captureRole(obj);
    if (!role || obj.userData.__capture) return;
    obj.userData.__capture = role;
    const label = captureLabel(obj);
    if (role === "table-marker") {
      tableMarkers.push(obj);
      addCaptureDot(obj, markerRadius, 0xf8f9fa, "__capture_marker");
      return;
    }
    if (role === "table") {
      addCaptureDot(obj, markerRadius * 1.35, 0xfff3bf, "__capture_marker");
      return;
    }
    if (role === "skeleton-marker") {
      addCaptureDot(obj, markerRadius * 0.85, 0x66d9e8, "__capture_marker");
      return;
    }
    if (role === "marker") {
      addCaptureDot(obj, markerRadius * 0.7, 0xdee2e6, "__capture_marker");
      return;
    }
    const color = rigidColor(label);
    if (role === "rigid-marker") {
      addCaptureDot(obj, markerRadius * 0.85, color, "__capture_marker");
      return;
    }
    const meshes = displayMeshes(obj);
    if (meshes.length) {
      const material = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.45,
        metalness: 0.06,
        side: THREE.DoubleSide,
      });
      meshes.forEach((mesh) => {
        mesh.material = material;
        mesh.visible = true;
        mesh.frustumCulled = false;
      });
      return;
    }
    if (hulled.has(label)) return;
    const paddle = new THREE.Mesh(
      new THREE.CylinderGeometry(bodyRadius, bodyRadius, captureSizes(height).thickness, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.82, side: THREE.DoubleSide })
    );
    paddle.geometry.rotateX(Math.PI / 2);
    paddle.name = "__capture_body";
    paddle.frustumCulled = false;
    obj.add(paddle);
  });
  const hulls: CaptureHull[] = [];
  hulled.forEach((key) => {
    const markers = rigidGroups.get(key);
    if (!markers) return;
    const color = rigidColor(key);
    const mesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.42,
        metalness: 0.04,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    mesh.name = "__capture_hull";
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    const edges = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xfff6e8, depthTest: false, transparent: true })
    );
    edges.name = "__capture_hull_edge";
    edges.frustumCulled = false;
    edges.renderOrder = 3;
    root.add(mesh);
    root.add(edges);
    hulls.push({ key, markers, mesh, edges });
  });
  if (hulls.length) {
    root.userData.__captureHulls = hulls;
    updateCaptureHulls(root);
  }
  const links: CaptureLink[] = [];
  rigidGroups.forEach((markers, key) => {
    if (markers.length < 2) return;
    const material = new LineMaterial({
      linewidth: 2.5,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    material.color.set(rigidColor(key));
    const lines = new LineSegments2(new LineSegmentsGeometry(), material);
    lines.name = "__capture_link";
    lines.frustumCulled = false;
    lines.renderOrder = 3;
    root.add(lines);
    links.push({ markers, lines });
  });
  if (links.length) {
    root.userData.__captureLinks = links;
    updateCaptureLinks(root);
  }

  if (tableMarkers.length >= 4) {
    const surfaceAttr = new THREE.BufferAttribute(new Float32Array(12), 3);
    const edgeAttr = new THREE.BufferAttribute(new Float32Array(12), 3);
    const surface = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0x2b8a3e,
        transparent: true,
        opacity: 0.62,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    surface.geometry.setAttribute("position", surfaceAttr);
    surface.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    surface.name = "__capture_table";
    surface.frustumCulled = false;
    const edge = new THREE.LineLoop(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xf4fce3 })
    );
    edge.geometry.setAttribute("position", edgeAttr);
    edge.name = "__capture_table_edge";
    edge.frustumCulled = false;
    root.add(surface);
    root.add(edge);
    root.userData.__captureTable = { markers: tableMarkers, surface: surfaceAttr, edge: edgeAttr } satisfies CaptureTable;
    updateCaptureTable(root);
  }
}

function updateCaptureTable(root: THREE.Object3D) {
  const table = root.userData.__captureTable as CaptureTable | undefined;
  if (!table || table.markers.length < 4) return;
  root.updateWorldMatrix(true, true);
  const points = table.markers.slice(0, 4).map((marker) => {
    const point = new THREE.Vector3();
    marker.getWorldPosition(point);
    root.worldToLocal(point);
    return point;
  });
  const ordered = orderPlanar(points);
  ordered.forEach((point, index) => {
    table.surface.setXYZ(index, point.x, point.y, point.z);
    table.edge.setXYZ(index, point.x, point.y, point.z);
  });
  table.surface.needsUpdate = true;
  table.edge.needsUpdate = true;
}

function updateCaptureHulls(root: THREE.Object3D) {
  const hulls = root.userData.__captureHulls as CaptureHull[] | undefined;
  if (!hulls) return;
  root.updateWorldMatrix(true, true);
  for (const hull of hulls) {
    const geometry = solidFromPoints(markerPositions(root, hull.markers));
    if (!geometry) {
      const positions = hull.mesh.geometry.getAttribute("position");
      if (!positions?.count) {
        hull.mesh.visible = false;
        hull.edges.visible = false;
      }
      continue;
    }
    const previousMesh = hull.mesh.geometry;
    const previousEdge = hull.edges.geometry;
    hull.mesh.geometry = geometry;
    hull.edges.geometry = new THREE.EdgesGeometry(geometry, 1);
    hull.mesh.visible = true;
    hull.edges.visible = true;
    previousMesh.dispose();
    previousEdge.dispose();
  }
}

function updateCaptureLinks(root: THREE.Object3D) {
  const links = root.userData.__captureLinks as CaptureLink[] | undefined;
  if (!links) return;
  root.updateWorldMatrix(true, true);
  for (const link of links) {
    const points = markerPositions(root, link.markers);
    const data: number[] = [];
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        data.push(points[i].x, points[i].y, points[i].z, points[j].x, points[j].y, points[j].z);
      }
    }
    if (data.length < 6) {
      link.lines.visible = false;
      continue;
    }
    (link.lines.geometry as LineSegmentsGeometry).setPositions(data);
    link.lines.visible = true;
  }
}

function syncCaptureLineResolution(root: THREE.Object3D, width: number, height: number) {
  root.traverse((obj) => {
    const material = (obj as THREE.Mesh).material as LineMaterial | undefined;
    if (!material?.isLineMaterial) return;
    material.resolution.set(width, height);
  });
}

function setCaptureHullVisible(root: THREE.Object3D, visible: boolean) {
  const hulls = root.userData.__captureHulls as CaptureHull[] | undefined;
  hulls?.forEach((hull) => {
    hull.mesh.visible = visible;
    hull.edges.visible = visible;
  });
}

function capturePoints(root: THREE.Object3D) {
  const points: LayoutPoint[] = [];
  root.updateWorldMatrix(true, true);
  root.traverse((obj) => {
    if (!captureRole(obj)) return;
    const point = new THREE.Vector3();
    obj.getWorldPosition(point);
    root.worldToLocal(point);
    points.push({ x: point.x, y: point.y, z: point.z });
  });
  return points;
}

function detachCaptureProps(root: THREE.Object3D | null) {
  if (!root) return;
  const doomed: THREE.Object3D[] = [];
  root.traverse((obj) => {
    if (
      obj.name === "__capture_marker" ||
      obj.name === "__capture_body" ||
      obj.name === "__capture_table" ||
      obj.name === "__capture_table_edge" ||
      obj.name === "__capture_hull" ||
      obj.name === "__capture_hull_edge" ||
      obj.name === "__capture_link"
    ) {
      doomed.push(obj);
    }
    if (obj.userData.__capture) delete obj.userData.__capture;
  });
  doomed.forEach((obj) => {
    obj.parent?.remove(obj);
    const mesh = obj as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else material?.dispose();
  });
  delete root.userData.__captureTable;
  delete root.userData.__captureHulls;
  delete root.userData.__captureLinks;
}

function prepareRobotMergedMeshes(root: THREE.Object3D) {
  const robotMat = new THREE.MeshStandardMaterial({
    color: 0xd7dbe2,
    roughness: 0.48,
    metalness: 0.08,
  });
  const wood = new THREE.MeshStandardMaterial({
    color: 0xd7b98a,
    roughness: 0.55,
    metalness: 0.04,
    emissive: 0x4a3218,
    emissiveIntensity: 0.28,
    side: THREE.FrontSide,
  });
  const markerMat = new THREE.MeshStandardMaterial({
    color: 0xffd43b,
    roughness: 0.4,
    metalness: 0.05,
    emissive: 0x8a6a10,
    emissiveIntensity: 0.35,
  });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0xfff3df });
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.attributes?.position?.count) return;
    const label = `${mesh.name} ${mesh.parent?.name || ""}`.toLowerCase();
    const obstacle = /obstacle/.test(label);
    if (obstacle) faceMeshOutward(mesh.geometry);
    mesh.geometry.computeVertexNormals();
    const marker = /marker/.test(label);
    mesh.material = obstacle ? wood : marker ? markerMat : robotMat;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    if (obstacle && !mesh.getObjectByName("__obstacle_edges")) {
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 15), edgeMat);
      edges.name = "__obstacle_edges";
      mesh.add(edges);
    }
  });
}

function applyFbxMeshMaterials(root: THREE.Object3D, height: number) {
  const rigidPivots = new Set(rigidMarkerGroups(root).keys());
  const meshMat = new THREE.MeshStandardMaterial({
    color: 0x8a9aa8,
    metalness: 0.2,
    roughness: 0.6,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
  });
  const markerMat = new THREE.MeshBasicMaterial({
    color: 0xff8800,
    transparent: true,
    opacity: 0.85,
  });
  const dotRadius = captureSizes(height).marker;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && mesh.name !== "__joint_dot" && !isObstacleMesh(mesh)) {
      if (!mesh.geometry || !mesh.geometry.attributes?.position?.count) return;
      mesh.material = meshMat;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.visible = true;
      return;
    }
    if (mesh.isMesh) return;
    if ((obj as THREE.Bone).isBone) return;
    if (obj === root) return;
    if (captureRole(obj)) return;
    if (rigidPivots.has(captureLabel(obj))) return;
    if (obj.children.length > 0) return;
    if (obj.userData.__marker_added) return;
    obj.userData.__marker_added = true;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(dotRadius, 10, 8), markerMat);
    dot.name = "__fbx_marker";
    dot.frustumCulled = false;
    obj.add(dot);
  });
}

function detachFbxMarkers(root: THREE.Object3D | null) {
  if (!root) return;
  let disposedGeo: THREE.BufferGeometry | null = null;
  let disposedMat: THREE.Material | null = null;
  root.traverse((obj) => {
    if (!obj.userData.__marker_added) return;
    obj.userData.__marker_added = false;
    obj.children
      .filter((child) => child.name === "__fbx_marker")
      .forEach((child) => {
        obj.remove(child);
        if (child.geometry && child.geometry !== disposedGeo) {
          disposedGeo = child.geometry;
          disposedGeo.dispose();
        }
        if (child.material && child.material !== disposedMat) {
          disposedMat = child.material as THREE.Material;
          disposedMat.dispose();
        }
      });
  });
}

function rootHasNamedSkeleton(root: THREE.Object3D) {
  let found = false;
  root.traverse((obj) => {
    if (found) return;
    if ((obj as THREE.Bone).isBone && isNamedSkeletonBone(obj.name)) found = true;
  });
  return found;
}

function attachJointDots(
  root: THREE.Object3D,
  height: number,
  look?: { joint: string; jointEmissive: string }
) {
  const jointRadius = Math.max((height || 1) * 0.022, 1e-4);
  const jointGeo = new THREE.SphereGeometry(jointRadius, 10, 10);
  const jointMat = new THREE.MeshBasicMaterial({
    color: look?.joint ?? 0xffb454,
    depthTest: false,
  });
  const named = rootHasNamedSkeleton(root);
  root.traverse((obj) => {
    if (!(obj as THREE.Bone).isBone) return;
    if (/_bone$/.test(captureLabel(obj))) return;
    if (named && !isNamedSkeletonBone(obj.name)) return;
    const dot = new THREE.Mesh(jointGeo, jointMat);
    dot.name = "__joint_dot";
    dot.renderOrder = 8;
    obj.add(dot);
  });
}

function detachJointDots(root: THREE.Object3D | null) {
  if (!root) return;
  let disposedGeo: THREE.BufferGeometry | null = null;
  let disposedMat: THREE.Material | null = null;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.name !== "__joint_dot") return;
    if (mesh.parent) mesh.parent.remove(mesh);
    if (mesh.geometry && mesh.geometry !== disposedGeo) {
      disposedGeo = mesh.geometry;
      disposedGeo.dispose();
    }
    if (mesh.material && mesh.material !== disposedMat) {
      disposedMat = mesh.material as THREE.Material;
      disposedMat.dispose();
    }
  });
}

type HoverItem = {
  target: THREE.Object3D;
  text: string;
  kind: "joint" | "point";
};

function collectHoverItems(root: THREE.Object3D): HoverItem[] {
  const items: HoverItem[] = [];
  const named = Boolean(root.userData.__namedSkeleton);
  root.traverse((obj) => {
    if (obj.name.startsWith("__")) return;
    if ((obj as THREE.Bone).isBone) {
      if (/_bone$/i.test(obj.name)) return;
      if (named && !isNamedSkeletonBone(obj.name)) return;
      const text = skeletonJointName(String(obj.userData.originalName || obj.name || ""));
      if (!text) return;
      items.push({ target: obj, text, kind: "joint" });
      return;
    }
    const role = obj.userData.__capture as CaptureRole | undefined;
    if (
      role === "rigid-marker" ||
      role === "skeleton-marker" ||
      role === "marker" ||
      role === "table-marker"
    ) {
      const text = pointDisplayName(String(obj.userData.originalName || obj.name || ""));
      if (!text) return;
      items.push({ target: obj, text, kind: "point" });
    }
  });
  return items;
}

function HoverTag({ item }: { item: HoverItem }) {
  const group = useRef<THREE.Group>(null);
  const world = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    const node = group.current;
    const parent = node?.parent;
    if (!node || !parent) return;
    item.target.getWorldPosition(world);
    parent.worldToLocal(world);
    node.position.copy(world);
  });
  return (
    <group ref={group}>
      <Html center zIndexRange={[40, 0]} style={{ pointerEvents: "none" }}>
        <span className={`viz-name-label is-${item.kind}`}>{item.text}</span>
      </Html>
    </group>
  );
}

/** 鼠标靠近时显示这个点或关节的名字。骨架名、刚体名仍由播放条上的开关控制。 */
function HoverNames({ root }: { root: THREE.Object3D | null }) {
  const gl = useThree((state) => state.gl);
  const items = useRef<HoverItem[]>([]);
  const pointer = useRef({ x: 0, y: 0, inside: false, dragging: false });
  const hitId = useRef("");
  const [hit, setHit] = useState<HoverItem | null>(null);
  const world = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    items.current = root ? collectHoverItems(root) : [];
    hitId.current = "";
    setHit(null);
  }, [root]);

  useEffect(() => {
    const el = gl.domElement;
    const onMove = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      pointer.current.inside = true;
      pointer.current.dragging = event.buttons !== 0;
      pointer.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    };
    const onLeave = () => {
      pointer.current.inside = false;
      pointer.current.dragging = false;
    };
    const onUp = () => {
      pointer.current.dragging = false;
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, [gl]);

  useFrame((state) => {
    const cursor = pointer.current;
    if (!root || !cursor.inside || cursor.dragging || !items.current.length) {
      if (hitId.current) {
        hitId.current = "";
        setHit(null);
      }
      return;
    }
    const width = state.size.width || gl.domElement.clientWidth;
    const height = state.size.height || gl.domElement.clientHeight;
    const mx = (cursor.x * 0.5 + 0.5) * width;
    const my = (-cursor.y * 0.5 + 0.5) * height;
    let best: HoverItem | null = null;
    let bestDistance = 24 * 24;
    for (const item of items.current) {
      item.target.getWorldPosition(world);
      world.project(state.camera);
      if (world.z < -1 || world.z > 1) continue;
      const sx = (world.x * 0.5 + 0.5) * width;
      const sy = (-world.y * 0.5 + 0.5) * height;
      const distance = (sx - mx) ** 2 + (sy - my) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = item;
      }
    }
    const id = best ? `${best.kind}:${best.target.uuid}` : "";
    if (id !== hitId.current) {
      hitId.current = id;
      setHit(best);
    }
  });

  if (!hit) return null;
  return <HoverTag item={hit} />;
}

export function FbxScene({
  url,
  time,
  duration = 1,
  onDuration,
  viewNonce = 0,
  rotationX = 0,
  unitMode = "auto",
  followRoot = false,
  robotMerged = false,
  names = NAMES_OFF,
  showRigidHull = true,
  onDetectedUpAxis,
  onDetectedLengthUnit,
}: {
  url: string;
  time: number;
  duration?: number;
  onDuration?: (sec: number) => void;
  viewNonce?: number;
  rotationX?: number;
  unitMode?: LengthUnitMode;
  followRoot?: boolean;
  /** 机器人合并 FBX 已是米、Z-up，只画网格，不套人体标记。 */
  robotMerged?: boolean;
  names?: NameFlags;
  showRigidHull?: boolean;
  onDetectedUpAxis?: (up: UpAxis) => void;
  onDetectedLengthUnit?: (unit: LengthUnit) => void;
}) {
  const centerRef = useRef<THREE.Group>(null);
  const objectRef = useRef<THREE.Group | null>(null);
  const helperRef = useRef<THREE.SkeletonHelper | null>(null);
  const mixer = useRef<THREE.AnimationMixer | null>(null);
  const action = useRef<THREE.AnimationAction | null>(null);
  const fixedOffset = useRef(new THREE.Vector3());
  const offsetReady = useRef(false);
  const onDurationRef = useRef(onDuration);
  onDurationRef.current = onDuration;
  const onDetectedRef = useRef(onDetectedUpAxis);
  onDetectedRef.current = onDetectedUpAxis;
  const onDetectedUnitRef = useRef(onDetectedLengthUnit);
  onDetectedUnitRef.current = onDetectedLengthUnit;
  const samplesRef = useRef<{ points: LayoutPoint[]; roots: LayoutPoint[] }>({ points: [], roots: [] });
  const [layoutNonce, setLayoutNonce] = useState(0);
  const [detectedUnit, setDetectedUnit] = useState<LengthUnit>("m");
  const [object, setObject] = useState<THREE.Group | null>(null);
  const [helper, setHelper] = useState<THREE.SkeletonHelper | null>(null);
  const [scale, setScale] = useState(0.01);
  const [axisLength, setAxisLength] = useState(1);
  const [offset, setOffset] = useState<[number, number, number]>([0, 0, 0]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const look = useViewerLook();
  const rootRef = useRef<THREE.Object3D | null>(null);
  const followRef = useRef(followRoot);
  const hullRef = useRef(showRigidHull);
  const lastRoot = useRef(new THREE.Vector3());
  const hasLastRoot = useRef(false);
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as
    | { target: THREE.Vector3; update: () => void }
    | undefined;
  followRef.current = followRoot;
  hullRef.current = showRigidHull;

  useEffect(() => {
    hasLastRoot.current = false;
  }, [followRoot, url, rotationX]);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError("");
    setObject(null);
    hasLastRoot.current = false;
    rootRef.current = null;
    setHelper(null);
    setOffset([0, 0, 0]);
    objectRef.current = null;
    mixer.current = null;
    action.current = null;
    offsetReady.current = false;
    fixedOffset.current.set(0, 0, 0);
    samplesRef.current = { points: [], roots: [] };
    if (helperRef.current) {
      helperRef.current.geometry.dispose();
      (helperRef.current.material as THREE.Material).dispose();
      helperRef.current = null;
    }

    const loader = new FBXLoader();
    fetchBinary(url)
      .then((buf) => {
        if (cancelled) return;
        const obj = loader.parse(buf, "");
        let meshCount = 0;
        let boneCount = 0;
        obj.traverse((item) => {
          if ((item as THREE.Bone).isBone) boneCount += 1;
          const mesh = item as THREE.Mesh;
          if (mesh.isMesh && mesh.geometry?.attributes?.position?.count) {
            meshCount += 1;
          }
        });
        if (!boneCount && !meshCount) {
          throw new Error("FBX 中没有可显示的网格或骨骼");
        }

        const clip = obj.animations?.[0];
        const probeMixer = clip ? new THREE.AnimationMixer(obj) : null;
        const probeAction = clip && probeMixer ? probeMixer.clipAction(clip) : null;
        if (probeAction && probeMixer) {
          probeAction.play();
          probeAction.paused = true;
        }

        const clipDur = clip?.duration || 1;
        let spanY = 0;
        let spanZ = 0;
        const poseFrames: LayoutPoint[][] = [];
        const roots: LayoutPoint[] = [];
        const points: LayoutPoint[] = [];
        const measureRoot = primaryBoneRoot(obj) ?? obj;
        const n = probeAction && probeMixer ? 24 : 1;
        for (let i = 0; i < n; i++) {
          if (probeAction && probeMixer) {
            probeAction.time = (i / Math.max(n - 1, 1)) * clipDur;
            probeMixer.update(0);
          }
          const pose = collectPoseSamples(obj);
          if (pose.length >= 3) poseFrames.push(pose);
          points.push(...pose);
          expandSkeletonBox(measureRoot, _bvhBox);
          if (_bvhBox.isEmpty()) continue;
          const mid = _bvhBox.getCenter(_bvhHips);
          roots.push({ x: mid.x, y: mid.y, z: mid.z });
          spanY = Math.max(spanY, _bvhBox.max.y - _bvhBox.min.y);
          spanZ = Math.max(spanZ, _bvhBox.max.z - _bvhBox.min.z);
        }
        const skelHeight = Math.max(spanY, spanZ);
        expandMeshBox(obj, _meshBox);
        if (!_meshBox.isEmpty()) {
          const xs = [_meshBox.min.x, _meshBox.max.x];
          const ys = [_meshBox.min.y, _meshBox.max.y];
          const zs = [_meshBox.min.z, _meshBox.max.z];
          for (const x of xs) {
            for (const y of ys) {
              for (const z of zs) points.push({ x, y, z });
            }
          }
        }
        const meshSpan = _meshBox.isEmpty()
          ? { x: 0, y: 0, z: 0 }
          : {
              x: _meshBox.max.x - _meshBox.min.x,
              y: _meshBox.max.y - _meshBox.min.y,
              z: _meshBox.max.z - _meshBox.min.z,
            };
        // Robot merged files are metres and Z-up. Two performers stand metres
        // apart, so the long horizontal span must not be used as body height
        // or every marker grows with the court.
        const meshHeight = robotMerged
          ? meshSpan.z
          : Math.max(meshSpan.x, meshSpan.y, meshSpan.z);
        onDetectedRef.current?.(robotMerged ? "z" : detectUpAxisFromPointFrames(poseFrames));
        const unit = robotMerged ? "m" : detectLengthUnitFromExtents(skelHeight, meshHeight);
        setDetectedUnit(unit);
        onDetectedUnitRef.current?.(unit);
        const charHeight = skelHeight > 1e-6 ? skelHeight : meshHeight;
        setAxisLength(charHeight > 1e-6 ? charHeight : 1);
        samplesRef.current = { points, roots };
        setLayoutNonce((value) => value + 1);
        // Marker size follows one body, not the gap between the two performers.
        const propHeight = robotMerged ? (meshHeight > 1e-6 ? meshHeight : 1.6) : charHeight || 1;

        if (robotMerged) {
          prepareRobotMergedMeshes(obj);
        } else if (meshCount) {
          applyFbxMeshMaterials(obj, charHeight || 1);
          styleObstacleMeshes(obj);
        }
        attachCaptureProps(obj, propHeight);
        points.push(...capturePoints(obj));
        const namedSkeleton = rootHasNamedSkeleton(obj);
        obj.userData.__namedSkeleton = namedSkeleton;
        if (boneCount) attachJointDots(obj, charHeight || 1, look);
        let nextHelper: THREE.SkeletonHelper | null = null;
        if (boneCount && !namedSkeleton) {
          nextHelper = styleSkeletonHelper(new THREE.SkeletonHelper(obj), look);
          helperRef.current = nextHelper;
        }

        objectRef.current = obj;
        rootRef.current = robotMerged
          ? (obj.getObjectByName("base_link") ?? obj)
          : (primaryBoneRoot(obj) ?? obj);
        mixer.current = probeMixer;
        action.current = probeAction;
        if (clip && clip.duration > 0) onDurationRef.current?.(clip.duration);
        setObject(obj);
        setHelper(nextHelper);
        setStatus("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        console.error(e);
        setStatus("error");
        setError(e instanceof Error ? e.message : "FBX 加载失败");
      });

    return () => {
      cancelled = true;
      if (helperRef.current) {
        helperRef.current.geometry.dispose();
        (helperRef.current.material as THREE.Material).dispose();
        helperRef.current = null;
      }
      detachJointDots(objectRef.current);
      detachFbxMarkers(objectRef.current);
      detachCaptureProps(objectRef.current);
      rootRef.current = null;
    };
  }, [url, robotMerged]);

  useEffect(() => {
    if (robotMerged) {
      fixedOffset.current.set(0, 0, 0);
      offsetReady.current = true;
      setScale(1);
      setOffset([0, 0, 0]);
      return;
    }
    const nextScale = lengthUnitToScale(resolveLengthUnit(unitMode, detectedUnit));
    const next = uprightGroundOffset(
      samplesRef.current.points,
      samplesRef.current.roots,
      rotationX,
      nextScale,
    );
    fixedOffset.current.set(next[0], next[1], next[2]);
    offsetReady.current = samplesRef.current.points.length > 0;
    setScale(nextScale);
    setOffset(next);
  }, [unitMode, detectedUnit, rotationX, layoutNonce, robotMerged]);

  useEffect(() => {
    applyViewerFigureColors(helperRef.current, objectRef.current, look);
  }, [look, object, status]);

  useFrame((state) => {
    const center = centerRef.current;
    if (mixer.current && action.current) {
      const clipDur = action.current.getClip().duration || duration || 1;
      action.current.time = Math.min(Math.max(time, 0), clipDur);
      mixer.current.update(0);
    }
    if (objectRef.current) {
      updateCaptureTable(objectRef.current);
      updateCaptureHulls(objectRef.current);
      updateCaptureLinks(objectRef.current);
      setCaptureHullVisible(objectRef.current, hullRef.current);
      const dpr = state.viewport.dpr || 1;
      syncCaptureLineResolution(objectRef.current, state.size.width * dpr, state.size.height * dpr);
    }
    if (center && offsetReady.current) {
      center.position.copy(fixedOffset.current);
    }
    const root = rootRef.current;
    if (!root) return;
    root.getWorldPosition(_followPoint);
    shiftCameraWithPoint(
      _followPoint,
      camera,
      controls,
      lastRoot.current,
      hasLastRoot,
      followRef.current,
    );
  });

  const namedSkeleton = Boolean(object?.userData.__namedSkeleton);
  return (
    <>
      {helper && !namedSkeleton && <primitive object={helper} />}
      <SkeletonLines
        root={object}
        color={look.bone}
        include={namedSkeleton ? (bone) => isNamedSkeletonBone(bone.name) : undefined}
      />
      <HoverNames root={object} />
      <group ref={centerRef} position={offset}>
        <group rotation={[rotationX, 0, 0]}>
          {object && (
            <group scale={scale}>
              <DataOriginAxes length={axisLength} />
              <primitive object={object} />
              <SceneNameLabels root={object} names={names} />
            </group>
          )}
        </group>
        <FrameFigure
          objectRef={centerRef}
          ready={status === "ready" && !!object}
          resetKey={`${url}:${scale}:${offset.join(",")}:${rotationX}`}
          nonce={viewNonce}
        />
        {status === "loading" && (
          <Html center style={{ pointerEvents: "none" }}>
            <div className="muted animation-format-status">FBX 加载中…</div>
          </Html>
        )}
        {status === "error" && (
          <Html center style={{ pointerEvents: "none" }}>
            <div className="error animation-format-status">{error || "FBX 可视化失败"}</div>
          </Html>
        )}
      </group>
    </>
  );
}

/** Motive 厘米、Y 轴向上，转到米、Z 轴向上。还没有镜像，也没有对齐朝向。 */
const FBX_CM_TO_Z_UP_M = new THREE.Matrix4().set(
  0.01, 0, 0, 0,
  0, 0, 0.01, 0,
  0, 0.01, 0, 0,
  0, 0, 0, 1
);

/** 上面的换算再镜像 X，和重定向里 Motive 到机器人的左右约定一致。 */
const FBX_CM_TO_ROBOT_M = new THREE.Matrix4().makeScale(-1, 1, 1).multiply(FBX_CM_TO_Z_UP_M);

type FbxHipsSample = {
  name: string;
  point: THREE.Vector3;
  spine: THREE.Vector3 | null;
  left: THREE.Vector3 | null;
  right: THREE.Vector3 | null;
};

type RobotBodyPose = {
  position: [number, number, number];
  quaternion: [number, number, number, number];
};

export type RobotTrackFrame = {
  root: [number, number, number];
  quat: [number, number, number, number];
};

const EMPTY_TRACK: RobotTrackFrame[] = [];

function baseYaw(quat: [number, number, number, number]) {
  const [x, y, z, w] = quat;
  return Math.atan2(2 * (x * y + w * z), 1 - 2 * (y * y + z * z));
}

/** Older holosoma heading rules leave a CSV about 166° off the recorded frame. */
const OLD_HEADING_RULE_MIN_RAD = (60 * Math.PI) / 180;

/**
 * 不同版本的 holosoma 摆放朝向的规则不同，库里的 CSV 新旧都有。
 * 用这条 CSV 自己的机身朝向和根轨迹，求出它相对当前规则多转的角度和平移。
 * 按当前规则生成的 CSV 不修正：机器人被障碍物挡住时根轨迹本来就会偏离人体，
 * 拿它去拟合会把障碍物挪离求解时的位置。
 */
function trackCorrection(item: RetargetFrameSkeleton, scale: number, robot: RobotTrackFrame[]) {
  const track = item.track;
  if (!track || !robot.length) return null;
  const count = Math.min(track.hips_xy.length, track.yaw.length, robot.length);
  if (count < 2) return null;
  let sin = 0;
  let cos = 0;
  for (let index = 0; index < count; index += 1) {
    const diff = baseYaw(robot[index].quat) - track.yaw[index];
    sin += Math.sin(diff);
    cos += Math.cos(diff);
  }
  const delta = Math.atan2(sin, cos);
  if (Math.abs(delta) < OLD_HEADING_RULE_MIN_RAD) return null;
  const c = Math.cos(delta);
  const s = Math.sin(delta);
  let tx = 0;
  let ty = 0;
  for (let index = 0; index < count; index += 1) {
    const [hx, hy] = track.hips_xy[index];
    const px = scale * hx;
    const py = scale * hy;
    tx += robot[index].root[0] - (c * px - s * py);
    ty += robot[index].root[1] - (s * px + c * py);
  }
  return new THREE.Matrix4()
    .makeTranslation(tx / count, ty / count, 0)
    .multiply(new THREE.Matrix4().makeRotationZ(delta));
}

function skeletonPrefix(hipsName: string) {
  return hipsName.replace(/(hips|hip|pelvis)$/, "");
}

const SIDE_TAILS = {
  left: ["leftshoulder", "leftarm", "leftupleg", "lshoulder", "l_shoulder"],
  right: ["rightshoulder", "rightarm", "rightupleg", "rshoulder", "r_shoulder"],
} as const;

function sidePoint(root: THREE.Object3D, hipsName: string, side: "left" | "right") {
  const prefix = skeletonPrefix(hipsName);
  const tails = SIDE_TAILS[side];
  let bestRank = 99;
  let best: THREE.Vector3 | null = null;
  root.traverse((obj) => {
    if (!(obj as THREE.Bone).isBone) return;
    const name = captureLabel(obj);
    if (prefix && !name.startsWith(prefix)) return;
    const rank = tails.findIndex((tail) => name === `${prefix}${tail}` || name.endsWith(tail));
    if (rank < 0 || rank >= bestRank) return;
    bestRank = rank;
    best = new THREE.Vector3();
    obj.getWorldPosition(best);
  });
  return best;
}

function spinePoint(root: THREE.Object3D, hipsName: string) {
  const prefix = skeletonPrefix(hipsName);
  const rankOf = (name: string) => {
    if (prefix && !name.startsWith(prefix)) return 99;
    if (name === `${prefix}spine1` || name.endsWith("spine1")) return 0;
    if (name === `${prefix}spine` || /spine$/.test(name)) return 1;
    if (name.endsWith("spine2")) return 2;
    if (name.endsWith("chest")) return 3;
    return 99;
  };
  let bestRank = 99;
  let best: THREE.Vector3 | null = null;
  root.traverse((obj) => {
    if (!(obj as THREE.Bone).isBone) return;
    const rank = rankOf(captureLabel(obj));
    if (rank >= bestRank) return;
    bestRank = rank;
    best = new THREE.Vector3();
    obj.getWorldPosition(best);
  });
  return best;
}

function sampleFbxHips(root: THREE.Object3D): FbxHipsSample[] {
  const found: FbxHipsSample[] = [];
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    if (!(obj as THREE.Bone).isBone) return;
    const name = captureLabel(obj);
    if (!name.includes("hips") && !name.endsWith("_hip") && !name.endsWith("pelvis")) return;
    const point = new THREE.Vector3();
    obj.getWorldPosition(point);
    found.push({ name, point, spine: null, left: null, right: null });
  });
  // Motive 会把同一个髋部导出成重合的多层节点。位置重合的算同一个人。
  const people: FbxHipsSample[] = [];
  for (const item of found) {
    if (people.some((other) => other.point.distanceTo(item.point) < 5)) continue;
    people.push({
      ...item,
      spine: spinePoint(root, item.name),
      left: sidePoint(root, item.name, "left"),
      right: sidePoint(root, item.name, "right"),
    });
  }
  return people;
}

function anatomicalPoint(point: THREE.Vector3) {
  return point.clone().applyMatrix4(FBX_CM_TO_Z_UP_M).applyMatrix4(
    new THREE.Matrix4().makeScale(-1, 1, 1)
  );
}

function humanBodyAxes(sample: FbxHipsSample) {
  if (!sample.left || !sample.right) return null;
  const origin = anatomicalPoint(sample.point);
  const up = new THREE.Vector3(0, 0, 1);
  if (sample.spine) {
    const along = anatomicalPoint(sample.spine).sub(origin);
    if (along.lengthSq() > 1e-8) up.copy(along.normalize());
  }
  const lateral = anatomicalPoint(sample.left).sub(anatomicalPoint(sample.right));
  lateral.addScaledVector(up, -lateral.dot(up));
  if (lateral.lengthSq() < 1e-6) return null;
  lateral.normalize();
  const forward = new THREE.Vector3().crossVectors(lateral, up);
  if (forward.lengthSq() < 1e-8) return null;
  forward.normalize();
  const left = new THREE.Vector3().crossVectors(up, forward).normalize();
  return { origin, forward, left, up };
}

/** 把人体机身坐标轴对齐到这台机器人的机身坐标轴：前向 +X，左侧 +Y，上方 +Z。 */
function bodyFrameBasis(sample: FbxHipsSample, pose: RobotBodyPose) {
  const human = humanBodyAxes(sample);
  const quaternion = new THREE.Quaternion(
    pose.quaternion[0],
    pose.quaternion[1],
    pose.quaternion[2],
    pose.quaternion[3]
  );
  if (!human || quaternion.lengthSq() < 1e-8) return null;
  quaternion.normalize();
  const robotForward = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
  const robotLeft = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
  const robotUp = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
  const humanFrame = new THREE.Matrix4().makeBasis(human.forward, human.left, human.up);
  const robotFrame = new THREE.Matrix4().makeBasis(robotForward, robotLeft, robotUp);
  const rotation = robotFrame.multiply(humanFrame.clone().invert());
  const anatomical = new THREE.Matrix4().makeScale(-1, 1, 1).multiply(FBX_CM_TO_Z_UP_M);
  const movedOrigin = human.origin.clone().applyMatrix4(rotation);
  const translation = new THREE.Vector3(...pose.position).sub(movedOrigin);
  return new THREE.Matrix4()
    .makeTranslation(translation.x, translation.y, translation.z)
    .multiply(rotation)
    .multiply(anatomical);
}

function skeletonToken(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * holosoma 的世界变换：先用重定向时实测的仿射（单位、轴向、朝向、镜像、原点），
 * 再把脚趾地面降到 z = 0，最后按 ROBOT_HEIGHT / 人体身高 缩放。物体和人体关节走同一条变换。
 */
function retargetFrameMatrix(
  frame: RetargetFrame,
  robotStyle: string,
  pose: RobotBodyPose | null | undefined,
  hipsHint: string | null | undefined,
  robotTrack: RobotTrackFrame[]
) {
  const robotHeight = frame.robot_heights[robotStyle];
  if (!robotHeight || !frame.skeletons.length) return null;
  const scaleOf = (item: RetargetFrameSkeleton) => robotHeight / Math.max(item.height, 1e-6);
  const hint = skeletonToken(hipsHint || "");
  let chosen = hint
    ? frame.skeletons.find((item) => item.skeleton && skeletonToken(item.skeleton).endsWith(hint))
    : undefined;
  if (!chosen && pose) {
    let best = Number.POSITIVE_INFINITY;
    for (const item of frame.skeletons) {
      const scale = scaleOf(item);
      const dx = scale * item.hips0[0] - pose.position[0];
      const dy = scale * item.hips0[1] - pose.position[1];
      const distance = dx * dx + dy * dy;
      if (distance < best) {
        best = distance;
        chosen = item;
      }
    }
  }
  chosen ??= frame.skeletons[frame.skeletons.length - 1];
  const [r0, r1, r2] = chosen.affine;
  const affine = new THREE.Matrix4().set(
    r0[0], r0[1], r0[2], r0[3],
    r1[0], r1[1], r1[2], r1[3],
    r2[0], r2[1], r2[2], r2[3],
    0, 0, 0, 1
  );
  const scale = scaleOf(chosen);
  const placed = new THREE.Matrix4()
    .makeScale(scale, scale, scale)
    .multiply(new THREE.Matrix4().makeTranslation(0, 0, -chosen.floor_z))
    .multiply(affine);
  const correction = trackCorrection(chosen, scale, robotTrack);
  return correction ? correction.multiply(placed) : placed;
}

function fbxPropsMatrix(
  hips: FbxHipsSample[],
  pose: RobotBodyPose | null | undefined,
  hipsHint: string | null | undefined,
  frame?: RetargetFrame | null,
  robotStyle?: string,
  robotTrack: RobotTrackFrame[] = []
) {
  if (frame && robotStyle) {
    const measured = retargetFrameMatrix(frame, robotStyle, pose, hipsHint, robotTrack);
    if (measured) return measured;
  }
  if (!pose || !hips.length) return FBX_CM_TO_ROBOT_M.clone();
  const hint = (hipsHint || "").toLowerCase();
  let chosen = hint ? hips.find((item) => item.name.includes(hint)) : undefined;
  const target = new THREE.Vector3(pose.position[0], pose.position[1], pose.position[2]);
  if (!chosen) {
    let best = Number.POSITIVE_INFINITY;
    for (const item of hips) {
      const distance = anatomicalPoint(item.point).distanceTo(target);
      if (distance < best) {
        best = distance;
        chosen = item;
      }
    }
  }
  if (!chosen) return FBX_CM_TO_ROBOT_M.clone();
  return bodyFrameBasis(chosen, pose) ?? FBX_CM_TO_ROBOT_M.clone();
}

/** 人体 FBX 里的场景物体，叠到机器人坐标系里，不画人体骨架。 */
export function FbxSceneObjects({
  url,
  time,
  alignPose = null,
  hipsHint = null,
  retargetFrame = null,
  robotStyle = "",
  robotTrack = EMPTY_TRACK,
  onReady,
}: {
  url: string;
  time: number;
  alignPose?: RobotBodyPose | null;
  hipsHint?: string | null;
  retargetFrame?: RetargetFrame | null;
  robotStyle?: string;
  robotTrack?: RobotTrackFrame[];
  onReady?: () => void;
}) {
  const objectRef = useRef<THREE.Group | null>(null);
  const mixer = useRef<THREE.AnimationMixer | null>(null);
  const action = useRef<THREE.AnimationAction | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const [object, setObject] = useState<THREE.Group | null>(null);
  const [hips, setHips] = useState<FbxHipsSample[]>([]);
  const matrix = useMemo(
    () => fbxPropsMatrix(hips, alignPose, hipsHint, retargetFrame, robotStyle, robotTrack),
    [hips, alignPose, hipsHint, retargetFrame, robotStyle, robotTrack]
  );

  useEffect(() => {
    let cancelled = false;
    setObject(null);
    setHips([]);
    objectRef.current = null;
    mixer.current = null;
    action.current = null;
    const loader = new FBXLoader();
    fetchBinary(url)
      .then((buf) => {
        if (cancelled) return;
        const obj = loader.parse(buf, "");
        const clip = obj.animations?.[0];
        const probeMixer = clip ? new THREE.AnimationMixer(obj) : null;
        const probeAction = clip && probeMixer ? probeMixer.clipAction(clip) : null;
        if (probeAction && probeMixer) {
          probeAction.play();
          probeAction.paused = true;
          probeAction.time = 0;
          probeMixer.update(0);
        }
        const measureRoot = primaryBoneRoot(obj) ?? obj;
        expandSkeletonBox(measureRoot, _bvhBox);
        const spanY = _bvhBox.isEmpty() ? 0 : _bvhBox.max.y - _bvhBox.min.y;
        const spanZ = _bvhBox.isEmpty() ? 0 : _bvhBox.max.z - _bvhBox.min.z;
        const charHeight = Math.max(spanY, spanZ, 1);
        const samples = sampleFbxHips(obj);
        styleObstacleMeshes(obj);
        attachCaptureProps(obj, charHeight);
        attachJointDots(obj, charHeight);
        objectRef.current = obj;
        mixer.current = probeMixer;
        action.current = probeAction;
        setHips(samples);
        setObject(obj);
        onReadyRef.current?.();
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("[preview] 场景物体加载失败", err);
      });
    return () => {
      cancelled = true;
      detachCaptureProps(objectRef.current);
      objectRef.current = null;
      mixer.current = null;
      action.current = null;
    };
  }, [url]);

  useFrame((state) => {
    if (action.current && mixer.current) {
      const clipDur = action.current.getClip().duration || 1;
      action.current.time = Math.min(Math.max(time, 0), clipDur);
      mixer.current.update(0);
    }
    if (objectRef.current) {
      updateCaptureTable(objectRef.current);
      updateCaptureHulls(objectRef.current);
      updateCaptureLinks(objectRef.current);
      const dpr = state.viewport.dpr || 1;
      syncCaptureLineResolution(objectRef.current, state.size.width * dpr, state.size.height * dpr);
    }
  });

  if (!object) return null;
  return (
    <group matrix={matrix} matrixAutoUpdate={false}>
      <primitive object={object} />
    </group>
  );
}

export function animationFormatOf(file: { format?: string; name?: string }) {
  const fmt = (file.format || "").toLowerCase().replace(/^\./, "");
  const ext = (file.name || "").split(".").pop()?.toLowerCase() || "";
  if (fmt === "bvh" || ext === "bvh") return "bvh";
  if (fmt === "fbx" || ext === "fbx" || isFbxFileName(file.name || "")) return "fbx";
  return null;
}

export function isRobotMergedFbx(file: { path?: string; ontology?: string; format?: string; annotation?: { motion_kind?: string } | null }) {
  const path = (file.path || "").replace(/\\/g, "/");
  const fmt = (file.format || path.split(".").pop() || "").toLowerCase();
  return (
    (file.ontology === "robot" || path.includes("/robot/")) &&
    fmt === "fbx" &&
    (path.includes("/merged/") || file.annotation?.motion_kind === "merged")
  );
}

export function AnimationFormatPreview({
  url,
  format,
  durationHint,
  robotMerged = false,
}: {
  url: string;
  format: "bvh" | "fbx";
  durationHint?: number | null;
  robotMerged?: boolean;
}) {
  const [names] = useNameFlags();
  const [showRigidHull, setShowRigidHull] = useState(true);
  const [time, setTime] = useState(0);
  useReportPlayback(time);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [glProblem, setGlProblem] = useState("");
  const [viewNonce, setViewNonce] = useState(0);
  const [followRoot, setFollowRoot] = useState(true);
  const [upAxisMode, setUpAxisMode] = useUpAxisMode();
  const [detectedUp, setDetectedUp] = useState<UpAxis>("y");
  const [unitMode, setUnitMode] = useLengthUnitMode();
  const [detectedUnit, setDetectedUnit] = useState<LengthUnit>("m");
  const duration = mediaDuration || durationHint || 1;
  const rotationX = robotMerged
    ? upAxisToRotationX("z")
    : upAxisToRotationX(resolveUpAxis(upAxisMode, detectedUp));

  useEffect(() => {
    setTime(0);
    setPlaying(true);
    setMediaDuration(0);
    setGlProblem("");
    setDetectedUp("y");
    setDetectedUnit("m");
    setUpAxisMode("auto");
    setUnitMode("auto");
  }, [url]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = ((now - last) / 1000) * speed;
      last = now;
      setTime((current) => {
        const next = current + dt;
        return next > duration ? 0 : next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration, speed]);

  return (
    <div
      className="animation-format-preview"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="viewer-panel animation-format-canvas">
        {glProblem ? (
          <div className="storage-preview-empty">
            {glProblem}
            <br />
            请刷新页面；若反复出现，重启浏览器或检查浏览器「硬件加速」设置
          </div>
        ) : null}
        <CanvasErrorBoundary>
        <Canvas
          key={url}
          camera={{ position: [2.4, 1.8, 3.2], fov: 50 }}
          style={{ width: "100%", height: "100%", display: "block" }}
          resize={{ debounce: 0 }}
          shadows
          gl={{ antialias: true, alpha: false }}
          onCreated={({ gl }) => {
            try {
              const ctx = gl.getContext();
              const dbg = ctx.getExtension("WEBGL_debug_renderer_info");
              const renderer = dbg
                ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
                : ctx.getParameter(ctx.RENDERER);
              console.info(`[preview] WebGL 渲染器: ${renderer}`);
            } catch {
              /* ignore */
            }
            gl.domElement.addEventListener("webglcontextlost", (event) => {
              event.preventDefault();
              console.error("[preview] WebGL 上下文丢失");
              setGlProblem("浏览器的 3D 渲染上下文丢失（WebGL context lost）");
            });
            gl.domElement.addEventListener("webglcontextrestored", () => {
              setGlProblem("");
            });
          }}
        >
          <ViewerSceneChrome />
          {format === "bvh" ? (
            <BvhScene
              url={url}
              time={time}
              duration={duration}
              onDuration={setMediaDuration}
              viewNonce={viewNonce}
              rotationX={rotationX}
              unitMode={unitMode}
              followRoot={followRoot}
              names={names}
              onDetectedUpAxis={setDetectedUp}
              onDetectedLengthUnit={setDetectedUnit}
            />
          ) : (
            <FbxScene
              url={url}
              time={time}
              duration={duration}
              onDuration={setMediaDuration}
              viewNonce={viewNonce}
              rotationX={rotationX}
              unitMode={robotMerged ? "m" : unitMode}
              followRoot={followRoot}
              robotMerged={robotMerged}
              names={names}
              showRigidHull={showRigidHull}
              onDetectedUpAxis={setDetectedUp}
              onDetectedLengthUnit={setDetectedUnit}
            />
          )}
          <OrbitControls makeDefault />
        </Canvas>
        </CanvasErrorBoundary>
      </div>
      <div className="playback-controls animation-format-controls">
        <button
          type="button"
          className="play-button"
          onClick={() => setPlaying((current) => !current)}
          title={playing ? "暂停" : "播放"}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => {
            setPlaying(false);
            setTime(0);
          }}
          title="回到开始"
        >
          ⏮
        </button>
        <span className="frame-readout muted">
          {time.toFixed(2)}s / {duration.toFixed(2)}s
        </span>
        <input
          className="timeline-slider"
          type="range"
          min={0}
          max={duration}
          step={0.01}
          value={Math.min(time, duration)}
          onChange={(event) => {
            setPlaying(false);
            setTime(Number(event.target.value));
          }}
        />
        <select
          className="speed-select"
          value={speed}
          onChange={(event) => setSpeed(Number(event.target.value))}
          title="倍速"
        >
          <option value={0.5}>0.5×</option>
          <option value={1}>1×</option>
          <option value={1.5}>1.5×</option>
          <option value={2}>2×</option>
        </select>
        <button
          type="button"
          className="follow-root-toggle secondary"
          title="重新把骨架对准到画面中央"
          onClick={() => setViewNonce((n) => n + 1)}
        >
          复位视角
        </button>
        <button
          type="button"
          className={`follow-root-toggle secondary ${followRoot ? "is-on" : ""}`}
          title="打开后，相机保持当前相对位置，并随人体根节点一起移动"
          aria-pressed={followRoot}
          onClick={() => setFollowRoot((current) => !current)}
        >
          跟随视角
        </button>
        {robotMerged ? (
          <span
            className="follow-root-toggle secondary is-static"
            title="合并数据不重置原点。机器人和物体都在动捕原点的 Z-up 坐标系里，只做了朝向转换"
          >
            坐标系·共用原点
          </span>
        ) : (
          <>
            <button
              type="button"
              className="follow-root-toggle secondary"
              title="切换坐标系方向：自动识别 / Y-up / Z-up"
              onClick={() => {
                setUpAxisMode(cycleUpAxisMode(upAxisMode));
                setViewNonce((n) => n + 1);
              }}
            >
              {upAxisModeLabel(upAxisMode, detectedUp)}
            </button>
            <button
              type="button"
              className="follow-root-toggle secondary"
              title="切换长度单位：自动识别 / 米 / 厘米 / 毫米"
              onClick={() => {
                setUnitMode(cycleLengthUnitMode(unitMode));
                setViewNonce((n) => n + 1);
              }}
            >
              {lengthUnitModeLabel(unitMode, detectedUnit)}
            </button>
          </>
        )}
        <NameToggleButtons />
        {format === "fbx" && (
          <button
            type="button"
            className={`follow-root-toggle secondary${showRigidHull ? " is-on" : ""}`}
            aria-pressed={showRigidHull}
            title="用同一个刚体的标记点生成凸包。关掉后仍显示这些点和它们之间的连线"
            onClick={() => setShowRigidHull((current) => !current)}
          >
            刚体凸包
          </button>
        )}
      </div>
    </div>
  );
}
