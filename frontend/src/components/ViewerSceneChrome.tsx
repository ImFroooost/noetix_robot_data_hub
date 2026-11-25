import { Grid, Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from "react";
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { viewerLook, type Theme, type ViewerLook } from "../viewerTheme";

// Canvas 内是独立 React 根，ThemeContext 传不进来；直接订阅 <html data-theme>。
function subscribeTheme(callback: () => void) {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

function readTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

const _followDelta = new THREE.Vector3();
const _fitBox = new THREE.Box3();
const _meshWorldBox = new THREE.Box3();
const _fitSize = new THREE.Vector3();
const _fitCenter = new THREE.Vector3();
const _fitPt = new THREE.Vector3();
const _lineA = new THREE.Vector3();
const _lineB = new THREE.Vector3();

/** 把任意单位的骨架缩到约 1.7m，避免厘米/毫米文件在固定相机下看不见。 */
export function figureScale(maxHeight: number) {
  if (!Number.isFinite(maxHeight) || maxHeight < 1e-6) return 1;
  return Math.min(Math.max(1.7 / maxHeight, 0.001), 200);
}

function walkVisibleBox(node: THREE.Object3D, box: THREE.Box3) {
  // 跳过隐藏子树以及数据原点坐标轴辅助器（避免角色离开原点后包围盒被拉大到原点）。
  if (!node.visible || node.name === "__data_origin") return;
  if ((node as THREE.Bone).isBone) {
    node.getWorldPosition(_fitPt);
    if (Number.isFinite(_fitPt.x) && Number.isFinite(_fitPt.y) && Number.isFinite(_fitPt.z)) {
      box.expandByPoint(_fitPt);
    }
  } else {
    const mesh = node as THREE.Mesh;
    if (
      mesh.isMesh &&
      mesh.geometry &&
      mesh.name !== "__joint_dot" &&
      mesh.name !== "__bvh_joint_dot"
    ) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const local = mesh.geometry.boundingBox;
      if (local && !local.isEmpty()) {
        _meshWorldBox.copy(local).applyMatrix4(mesh.matrixWorld);
        if (!_meshWorldBox.isEmpty()) {
          box.union(_meshWorldBox);
        }
      }
    }
  }
  for (const child of node.children) {
    walkVisibleBox(child, box);
  }
}

export function expandVisibleBox(root: THREE.Object3D, box: THREE.Box3) {
  box.makeEmpty();
  root.updateWorldMatrix(true, true);
  walkVisibleBox(root, box);
}

/** 按骨骼世界坐标画线。只连接上下两节骨骼，避免从场景原点拉一条线到髋部。 */
export function SkeletonLines({
  root,
  color,
  include,
}: {
  root: THREE.Object3D | null;
  color: string;
  /** 为真时只画人体骨架。刚体上的 `_Bone` 不画进这棵骨架。 */
  include?: (bone: THREE.Object3D) => boolean;
}) {
  const geom = useMemo(() => new LineSegmentsGeometry(), []);
  const mat = useMemo(() => {
    const material = new LineMaterial({
      linewidth: 4,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 1,
    });
    material.color.set(color);
    return material;
  }, [color]);
  const lines = useMemo(() => {
    const obj = new LineSegments2(geom, mat);
    obj.frustumCulled = false;
    obj.renderOrder = 6;
    return obj;
  }, [geom, mat]);
  const size = useThree((state) => state.size);
  const dpr = useThree((state) => state.viewport.dpr);

  useEffect(() => {
    mat.color.set(color);
  }, [color, mat]);

  useEffect(() => {
    mat.resolution.set(size.width * dpr, size.height * dpr);
  }, [size, dpr, mat]);

  useEffect(() => {
    return () => {
      geom.dispose();
      mat.dispose();
    };
  }, [geom, mat]);

  useFrame(() => {
    if (!root) {
      lines.visible = false;
      return;
    }
    root.updateWorldMatrix(true, true);
    const positions: number[] = [];
    root.traverse((obj) => {
      const bone = obj as THREE.Bone;
      const parent = obj.parent as THREE.Bone | null;
      if (!bone.isBone || !parent?.isBone) return;
      if (include && !include(bone)) return;
      bone.getWorldPosition(_lineA);
      parent.getWorldPosition(_lineB);
      if (![..._lineA.toArray(), ..._lineB.toArray()].every(Number.isFinite)) return;
      if (_lineA.distanceTo(_lineB) < 1e-6) return;
      positions.push(_lineB.x, _lineB.y, _lineB.z, _lineA.x, _lineA.y, _lineA.z);
    });
    if (positions.length < 6) {
      lines.visible = false;
      return;
    }
    geom.setPositions(positions);
    lines.visible = true;
  });

  return <primitive object={lines} />;
}

/** 把相机和观察点平移同样的位移，使角色根节点留在画面中的相对位置不变。 */
export function shiftCameraWithPoint(
  worldPos: THREE.Vector3,
  camera: THREE.Camera,
  controls: { target: THREE.Vector3; update: () => void } | null | undefined,
  last: THREE.Vector3,
  hasLast: { current: boolean },
  enabled: boolean,
) {
  if (enabled && hasLast.current) {
    _followDelta.subVectors(worldPos, last);
    if (_followDelta.lengthSq() > 1e-12) {
      camera.position.add(_followDelta);
      if (controls) {
        controls.target.add(_followDelta);
        controls.update();
      }
    }
  }
  last.copy(worldPos);
  hasLast.current = true;
}

/** 模型入场后再对准相机，避免角色在画面外或缩成一个点。nonce 变化时重新取景（复位视角），与初始视角逻辑完全一致。 */
export function FrameFigure({
  objectRef,
  fallbackRef,
  ready,
  resetKey,
  nonce = 0,
}: {
  objectRef: RefObject<THREE.Object3D | null>;
  fallbackRef?: RefObject<THREE.Object3D | null>;
  ready: boolean;
  resetKey: string;
  nonce?: number;
}) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const controls = useThree((state) => state.controls) as
    | { target: THREE.Vector3; update: () => void }
    | undefined;
  const framedToken = useRef("");
  const lastResetKey = useRef("");
  const waits = useRef(0);

  const token = `${resetKey}::${nonce}`;

  useEffect(() => {
    waits.current = 0;
  }, [token, ready]);

  useFrame(() => {
    if (!ready || framedToken.current === token) return;
    const primary = objectRef.current;
    const secondary = fallbackRef?.current ?? null;
    if (!primary && !secondary) return;
    if (primary) {
      expandVisibleBox(primary, _fitBox);
    } else {
      _fitBox.makeEmpty();
    }
    if (_fitBox.isEmpty() && secondary) {
      expandVisibleBox(secondary, _fitBox);
    }
    if (_fitBox.isEmpty()) return;
    _fitBox.getSize(_fitSize);
    if (_fitSize.length() < 1e-4) return;
    waits.current += 1;
    const isInitialForScene = lastResetKey.current !== resetKey;
    const span = _fitSize.length();
    if (isInitialForScene) {
      // 首次入场等缩放/偏移矩阵与 OrbitControls 生效（厘米骨架未缩时对角线可达数百）。
      if ((span < 0.25 || span > 12) && waits.current < 20) return;
      if (waits.current < 2) return;
      if (!controls && waits.current < 10) return;
    } else if (!controls && waits.current < 4) {
      return;
    }
    const center = _fitBox.getCenter(_fitCenter);
    const radius = Math.max(_fitSize.length() * 0.5, 0.2);
    const fov = ((camera.fov || 50) * Math.PI) / 180;
    const dist = (radius / Math.max(Math.sin(fov / 2), 1e-4)) * 1.05;
    camera.up.set(0, 1, 0);
    camera.position.set(center.x + dist * 0.72, center.y + dist * 0.42, center.z + dist * 0.88);
    camera.near = Math.max(dist / 400, 0.01);
    camera.far = Math.max(dist * 80, 80);
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    if (controls) {
      controls.target.copy(center);
      controls.update();
    }
    lastResetKey.current = resetKey;
    framedToken.current = token;
  });

  return null;
}

export function useViewerLook() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme);
  return useMemo(() => viewerLook(theme), [theme]);
}

function GroundFloor({ color }: { color: string }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ camera }) => {
    const floor = ref.current;
    if (!floor) return;
    floor.position.x = camera.position.x;
    floor.position.z = camera.position.z;
  });
  return (
    <mesh
      ref={ref}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -0.02, 0]}
      renderOrder={-1}
      receiveShadow
    >
      <planeGeometry args={[240, 240]} />
      <meshStandardMaterial
        color={color}
        roughness={1}
        metalness={0}
        polygonOffset
        polygonOffsetFactor={2}
        polygonOffsetUnits={2}
      />
    </mesh>
  );
}

/** 数据原点的坐标轴。父级已经带上单位缩放和朝上校正，长度用数据单位。 */
export function DataOriginAxes({ length }: { length: number }) {
  const axisLen = Math.max(length * 0.42, 1e-4);
  const group = useMemo(() => {
    const root = new THREE.Group();
    root.name = "__data_origin";
    const head = axisLen * 0.16;
    const width = Math.max(axisLen * 0.028, 1e-4);
    const axes: Array<[THREE.Vector3, number]> = [
      [new THREE.Vector3(1, 0, 0), 0xe23b3b],
      [new THREE.Vector3(0, 1, 0), 0x2f9e44],
      [new THREE.Vector3(0, 0, 1), 0x3b6fe2],
    ];
    for (const [dir, color] of axes) {
      root.add(new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), axisLen, color, head, width));
    }
    return root;
  }, [axisLen]);
  const label = {
    fontSize: "12px",
    fontWeight: 700,
    lineHeight: "1",
    textShadow: "0 1px 2px rgba(0,0,0,0.45)",
  };
  return (
    <group>
      <primitive object={group} />
      <Html position={[axisLen * 1.08, 0, 0]} center style={{ ...label, color: "#e23b3b" }}>
        X
      </Html>
      <Html position={[0, axisLen * 1.08, 0]} center style={{ ...label, color: "#2f9e44" }}>
        Y
      </Html>
      <Html position={[0, 0, axisLen * 1.08]} center style={{ ...label, color: "#3b6fe2" }}>
        Z
      </Html>
    </group>
  );
}

/** 近裁剪面切到地面时，斜视角下会缺一块网格；把 near/far 收在相机距离附近。 */
function CameraClip() {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  useFrame(() => {
    const dist = Math.max(camera.position.length(), 0.5);
    const nextNear = Math.min(0.08, Math.max(0.01, dist / 2500));
    const nextFar = Math.max(240, dist * 30);
    if (Math.abs(camera.near - nextNear) > 1e-4 || Math.abs(camera.far - nextFar) > 1) {
      camera.near = nextNear;
      camera.far = nextFar;
      camera.updateProjectionMatrix();
    }
  });
  return null;
}

export function ViewerSceneChrome({ hemisphere = false }: { hemisphere?: boolean }) {
  const look = useViewerLook();
  const gridRef = useRef<THREE.Mesh>(null);
  useEffect(() => {
    const mat = gridRef.current?.material as THREE.Material | undefined;
    if (!mat) return;
    mat.depthWrite = false;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;
  }, [look]);
  return (
    <>
      <color attach="background" args={[look.background]} />
      <CameraClip />
      <ambientLight intensity={look.ambient} />
      <hemisphereLight args={[look.hemiSky, look.hemiGround, 0.35]} />
      <directionalLight
        position={[4.2, 8.5, 5.4]}
        intensity={look.directional}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={0.2}
        shadow-camera-far={28}
        shadow-camera-left={-7}
        shadow-camera-right={7}
        shadow-camera-top={7}
        shadow-camera-bottom={-7}
        shadow-bias={-0.0006}
      />
      {hemisphere ? <hemisphereLight args={[look.hemiSky, look.hemiGround, 0.25]} /> : null}
      <GroundFloor color={look.hemiGround} />
      <Grid
        ref={gridRef}
        args={[12, 12]}
        side={THREE.DoubleSide}
        followCamera
        infiniteGrid
        cellSize={0.5}
        cellThickness={0.7}
        sectionSize={1}
        sectionThickness={1.15}
        cellColor={look.cell}
        sectionColor={look.section}
        fadeDistance={24}
        fadeStrength={1.35}
        renderOrder={1}
      />
    </>
  );
}

export function applyViewerFigureColors(
  helper: THREE.SkeletonHelper | null,
  root: THREE.Object3D | null,
  look: ViewerLook
) {
  if (helper) {
    const mat = helper.material as THREE.LineBasicMaterial;
    mat.vertexColors = false;
    mat.color.set(look.bone);
    mat.needsUpdate = true;
  }
  if (!root) return;
  root.traverse((obj) => {
    if (obj.name !== "__bvh_joint_dot" && obj.name !== "__joint_dot") return;
    const mat = (obj as THREE.Mesh).material as THREE.MeshBasicMaterial;
    if (!mat?.color) return;
    mat.color.set(look.joint);
  });
}
