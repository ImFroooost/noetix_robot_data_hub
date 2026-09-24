import { Canvas, useFrame } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { BVHLoader } from "three/examples/jsm/loaders/BVHLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { getToken } from "../api";
import {
  applyViewerFigureColors,
  FrameFigure,
  SkeletonLines,
  useViewerLook,
  ViewerSceneChrome,
} from "./ViewerSceneChrome";
import {
  cycleUpAxisMode,
  detectUpAxisFromExtents,
  resolveUpAxis,
  upAxisModeLabel,
  upAxisToRotationX,
  useUpAxisMode,
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

const _bvhHips = new THREE.Vector3();
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
  return res.arrayBuffer();
}

export function BvhScene({
  url,
  time,
  duration,
  onDuration,
  viewNonce = 0,
  rotationX = 0,
  unitMode = "auto",
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
  const layoutRef = useRef({ x: 0, minY: 0, z: 0 });
  const [detectedUnit, setDetectedUnit] = useState<LengthUnit>("m");
  const [boneRoot, setBoneRoot] = useState<THREE.Bone | null>(null);
  const [helper, setHelper] = useState<THREE.SkeletonHelper | null>(null);
  const [scale, setScale] = useState(0.01);
  const [offset, setOffset] = useState<[number, number, number]>([0, 0, 0]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const look = useViewerLook();

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError("");
    setBoneRoot(null);
    setHelper(null);
    setOffset([0, 0, 0]);
    boneRootRef.current = null;
    mixer.current = null;
    action.current = null;
    offsetReady.current = false;
    fixedOffset.current.set(0, 0, 0);
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
        let sumX = 0;
        let sumZ = 0;
        let samples = 0;
        let minY = Infinity;
        let spanY = 0;
        let spanZ = 0;
        let midY = 0;
        let midZ = 0;
        const n = 24;
        for (let i = 0; i < n; i++) {
          probeAction.time = (i / Math.max(n - 1, 1)) * clipDur;
          probeMixer.update(0);
          bone0.updateMatrixWorld(true);
          bone0.getWorldPosition(_bvhHips);
          sumX += _bvhHips.x;
          sumZ += _bvhHips.z;
          samples++;
          _bvhBox.makeEmpty();
          bone0.traverse((obj) => {
            if ((obj as THREE.Bone).isBone) {
              obj.getWorldPosition(_bvhPt);
              _bvhBox.expandByPoint(_bvhPt);
            }
          });
          if (!_bvhBox.isEmpty()) {
            minY = Math.min(minY, _bvhBox.min.y);
            const sy = _bvhBox.max.y - _bvhBox.min.y;
            const sz = _bvhBox.max.z - _bvhBox.min.z;
            spanY = Math.max(spanY, sy);
            spanZ = Math.max(spanZ, sz);
            midY += (_bvhBox.max.y + _bvhBox.min.y) / 2;
            midZ += (_bvhBox.max.z + _bvhBox.min.z) / 2;
          }
        }
        const meanX = samples ? sumX / samples : 0;
        const meanZ = samples ? sumZ / samples : 0;
        if (!Number.isFinite(minY)) minY = 0;
        const maxHeight = Math.max(spanY, spanZ);
        onDetectedRef.current?.(detectUpAxisFromExtents(spanY, spanZ, midY / Math.max(samples, 1), midZ / Math.max(samples, 1)));
        const unit = detectLengthUnit(maxHeight);
        setDetectedUnit(unit);
        onDetectedUnitRef.current?.(unit);
        const nextScale = lengthUnitToScale(resolveLengthUnit(unitMode, unit));
        layoutRef.current = { x: meanX, minY, z: meanZ };
        fixedOffset.current.set(
          -meanX * nextScale,
          -minY * nextScale,
          -meanZ * nextScale
        );
        offsetReady.current = true;

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
        setScale(nextScale);
        setOffset([
          fixedOffset.current.x,
          fixedOffset.current.y,
          fixedOffset.current.z,
        ]);
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
    const { x, minY, z } = layoutRef.current;
    fixedOffset.current.set(-x * nextScale, -minY * nextScale, -z * nextScale);
    setScale(nextScale);
    setOffset([fixedOffset.current.x, fixedOffset.current.y, fixedOffset.current.z]);
  }, [unitMode, detectedUnit]);

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
  });

  return (
    <>
      {helper && <primitive object={helper} />}
      <SkeletonLines root={boneRoot} color={look.bone} />
      <group rotation={[rotationX, 0, 0]}>
        <group ref={centerRef} position={offset}>
          {boneRoot && (
            <group scale={scale}>
              <primitive object={boneRoot} />
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

function applyFbxMeshMaterials(root: THREE.Object3D, look: { bone: string; joint: string }) {
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
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && mesh.name !== "__joint_dot") {
      if (!mesh.geometry || !mesh.geometry.attributes?.position?.count) return;
      mesh.material = meshMat;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      return;
    }
    // 非 Mesh、非 Bone 的节点（FBX 里的 Null/Empty/Marker）画一个小球标位
    if ((obj as THREE.Bone).isBone) return;
    if (obj === root) return;
    if (obj.children.length > 0) return; // 只给叶子空节点加标记
    // 排除已添加的标记
    if (obj.userData.__marker_added) return;
    obj.userData.__marker_added = true;
    const markerGeo = new THREE.SphereGeometry(1, 8, 8);
    const dot = new THREE.Mesh(markerGeo, markerMat);
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

function attachJointDots(
  root: THREE.Object3D,
  height: number,
  look?: { joint: string; jointEmissive: string }
) {
  const jointRadius = Math.max((height || 1) * 0.016, 1e-4);
  const jointGeo = new THREE.SphereGeometry(jointRadius, 10, 10);
  const jointMat = new THREE.MeshBasicMaterial({
    color: look?.joint ?? 0xffb454,
  });
  root.traverse((obj) => {
    if (!(obj as THREE.Bone).isBone) return;
    const dot = new THREE.Mesh(jointGeo, jointMat);
    dot.name = "__joint_dot";
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

export function FbxScene({
  url,
  time,
  duration = 1,
  onDuration,
  viewNonce = 0,
  rotationX = 0,
  unitMode = "auto",
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
  const layoutRef = useRef({ x: 0, minY: 0, z: 0 });
  const [detectedUnit, setDetectedUnit] = useState<LengthUnit>("m");
  const [object, setObject] = useState<THREE.Group | null>(null);
  const [helper, setHelper] = useState<THREE.SkeletonHelper | null>(null);
  const [scale, setScale] = useState(0.01);
  const [offset, setOffset] = useState<[number, number, number]>([0, 0, 0]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const look = useViewerLook();

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError("");
    setObject(null);
    setHelper(null);
    setOffset([0, 0, 0]);
    objectRef.current = null;
    mixer.current = null;
    action.current = null;
    offsetReady.current = false;
    fixedOffset.current.set(0, 0, 0);
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
        let sumX = 0;
        let sumZ = 0;
        let samples = 0;
        let minY = Infinity;
        let spanY = 0;
        let spanZ = 0;
        let midY = 0;
        let midZ = 0;
        const measureRoot = primaryBoneRoot(obj) ?? obj;
        const n = probeAction && probeMixer ? 24 : 1;
        for (let i = 0; i < n; i++) {
          if (probeAction && probeMixer) {
            probeAction.time = (i / Math.max(n - 1, 1)) * clipDur;
            probeMixer.update(0);
          }
          expandSkeletonBox(measureRoot, _bvhBox);
          if (_bvhBox.isEmpty()) continue;
          const mid = _bvhBox.getCenter(_bvhHips);
          sumX += mid.x;
          sumZ += mid.z;
          samples += 1;
          minY = Math.min(minY, _bvhBox.min.y);
          const sy = _bvhBox.max.y - _bvhBox.min.y;
          const sz = _bvhBox.max.z - _bvhBox.min.z;
          spanY = Math.max(spanY, sy);
          spanZ = Math.max(spanZ, sz);
          midY += (_bvhBox.max.y + _bvhBox.min.y) / 2;
          midZ += (_bvhBox.max.z + _bvhBox.min.z) / 2;
        }
        const meanX = samples ? sumX / samples : 0;
        const meanZ = samples ? sumZ / samples : 0;
        if (!Number.isFinite(minY)) minY = 0;
        const skelHeight = Math.max(spanY, spanZ);
        expandMeshBox(obj, _meshBox);
        const meshHeight = _meshBox.isEmpty()
          ? 0
          : Math.max(
              _meshBox.max.x - _meshBox.min.x,
              _meshBox.max.y - _meshBox.min.y,
              _meshBox.max.z - _meshBox.min.z
            );
        onDetectedRef.current?.(
          detectUpAxisFromExtents(spanY, spanZ, midY / Math.max(samples, 1), midZ / Math.max(samples, 1))
        );
        const unit = detectLengthUnitFromExtents(skelHeight, meshHeight);
        setDetectedUnit(unit);
        onDetectedUnitRef.current?.(unit);
        const nextScale = lengthUnitToScale(resolveLengthUnit(unitMode, unit));
        const charHeight = skelHeight > 1e-6 ? skelHeight : meshHeight;
        layoutRef.current = { x: meanX, minY, z: meanZ };
        if (_meshBox.isEmpty() && Number.isFinite(minY)) {
          /* keep bone-based floor */
        } else if (!_meshBox.isEmpty()) {
          minY = Math.min(minY, _meshBox.min.y);
          layoutRef.current.minY = minY;
        }
        fixedOffset.current.set(
          -meanX * nextScale,
          -minY * nextScale,
          -meanZ * nextScale
        );
        offsetReady.current = true;

        const skelMeters = skelHeight * nextScale;
        const meshMeters = meshHeight * nextScale;
        if (meshCount) {
          applyFbxMeshMaterials(obj, look);
        }
        if (boneCount) {
          attachJointDots(obj, charHeight || 1, look);
        }
        let nextHelper: THREE.SkeletonHelper | null = null;
        if (boneCount) {
          nextHelper = styleSkeletonHelper(new THREE.SkeletonHelper(obj), look);
          helperRef.current = nextHelper;
        }

        objectRef.current = obj;
        mixer.current = probeMixer;
        action.current = probeAction;
        if (clip && clip.duration > 0) onDurationRef.current?.(clip.duration);
        setScale(nextScale);
        setOffset([
          fixedOffset.current.x,
          fixedOffset.current.y,
          fixedOffset.current.z,
        ]);
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
    };
  }, [url]);

  useEffect(() => {
    const nextScale = lengthUnitToScale(resolveLengthUnit(unitMode, detectedUnit));
    const { x, minY, z } = layoutRef.current;
    fixedOffset.current.set(-x * nextScale, -minY * nextScale, -z * nextScale);
    setScale(nextScale);
    setOffset([fixedOffset.current.x, fixedOffset.current.y, fixedOffset.current.z]);
  }, [unitMode, detectedUnit]);

  useEffect(() => {
    applyViewerFigureColors(helperRef.current, objectRef.current, look);
  }, [look, object, status]);

  useFrame(() => {
    const center = centerRef.current;
    if (mixer.current && action.current) {
      const clipDur = action.current.getClip().duration || duration || 1;
      action.current.time = Math.min(Math.max(time, 0), clipDur);
      mixer.current.update(0);
    }
    if (center && offsetReady.current) {
      center.position.copy(fixedOffset.current);
    }
  });

  return (
    <>
      {helper && <primitive object={helper} />}
      <SkeletonLines root={object} color={look.bone} />
      <group rotation={[rotationX, 0, 0]}>
        <group ref={centerRef} position={offset}>
          {object && (
            <group scale={scale}>
              <primitive object={object} />
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

export function animationFormatOf(file: { format?: string; name?: string }) {
  const fmt = (file.format || "").toLowerCase().replace(/^\./, "");
  const ext = (file.name || "").split(".").pop()?.toLowerCase() || "";
  if (fmt === "bvh" || ext === "bvh") return "bvh";
  if (fmt === "fbx" || ext === "fbx") return "fbx";
  return null;
}

export function AnimationFormatPreview({
  url,
  format,
  durationHint,
}: {
  url: string;
  format: "bvh" | "fbx";
  durationHint?: number | null;
}) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [glProblem, setGlProblem] = useState("");
  const [viewNonce, setViewNonce] = useState(0);
  const [upAxisMode, setUpAxisMode] = useUpAxisMode();
  const [detectedUp, setDetectedUp] = useState<UpAxis>("y");
  const [unitMode, setUnitMode] = useLengthUnitMode();
  const [detectedUnit, setDetectedUnit] = useState<LengthUnit>("m");
  const duration = mediaDuration || durationHint || 1;
  const rotationX = upAxisToRotationX(resolveUpAxis(upAxisMode, detectedUp));

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
              unitMode={unitMode}
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
      </div>
    </div>
  );
}
