import { Grid } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from "react";
import * as THREE from "three";
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

const _fitBox = new THREE.Box3();
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

function expandVisibleBox(root: THREE.Object3D, box: THREE.Box3) {
  box.makeEmpty();
  root.updateWorldMatrix(true, true);
  root.traverse((obj) => {
    if ((obj as THREE.Bone).isBone) {
      obj.getWorldPosition(_fitPt);
      box.expandByPoint(_fitPt);
      return;
    }
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && mesh.visible && mesh.geometry) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const local = mesh.geometry.boundingBox;
      if (!local || local.isEmpty()) return;
      box.expandByPoint(_fitPt.copy(local.min).applyMatrix4(mesh.matrixWorld));
      box.expandByPoint(_fitPt.copy(local.max).applyMatrix4(mesh.matrixWorld));
    }
  });
  if (box.isEmpty()) box.setFromObject(root);
}

/** 按骨骼世界坐标画线，不依赖 SkeletonHelper，避免只剩空画布。 */
export function SkeletonLines({
  root,
  color,
}: {
  root: THREE.Object3D | null;
  color: string;
}) {
  const geom = useMemo(() => new THREE.BufferGeometry(), []);
  const mat = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color,
        depthTest: false,
        depthWrite: false,
        transparent: false,
      }),
    [color]
  );

  const lines = useMemo(() => {
    const obj = new THREE.LineSegments(geom, mat);
    obj.frustumCulled = false;
    return obj;
  }, [geom, mat]);

  useEffect(() => {
    mat.color.set(color);
  }, [color, mat]);

  useEffect(() => {
    return () => {
      geom.dispose();
      mat.dispose();
    };
  }, [geom, mat]);

  useFrame(() => {
    if (!root) {
      geom.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
      return;
    }
    root.updateWorldMatrix(true, true);
    const positions: number[] = [];
    root.traverse((obj) => {
      const bone = obj as THREE.Bone;
      if (!bone.isBone || !obj.parent) return;
      bone.getWorldPosition(_lineA);
      obj.parent.getWorldPosition(_lineB);
      if (![..._lineA.toArray(), ..._lineB.toArray()].every(Number.isFinite)) return;
      if (_lineA.distanceTo(_lineB) < 1e-6) return;
      positions.push(_lineB.x, _lineB.y, _lineB.z, _lineA.x, _lineA.y, _lineA.z);
    });
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geom.computeBoundingSphere();
  });

  return <primitive object={lines} />;
}

/** 模型入场后再对准相机，避免角色在画面外或缩成一个点。nonce 变化时重新取景（复位视角）。 */
export function FrameFigure({
  objectRef,
  ready,
  resetKey,
  nonce = 0,
}: {
  objectRef: RefObject<THREE.Object3D | null>;
  ready: boolean;
  resetKey: string;
  nonce?: number;
}) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const controls = useThree((state) => state.controls) as
    | { target: THREE.Vector3; update: () => void }
    | undefined;
  const framed = useRef("");
  const waits = useRef(0);

  useEffect(() => {
    framed.current = "";
    waits.current = 0;
  }, [resetKey, ready, nonce]);

  useFrame(() => {
    if (!ready || framed.current === resetKey) return;
    const obj = objectRef.current;
    if (!obj) return;
    expandVisibleBox(obj, _fitBox);
    if (_fitBox.isEmpty()) return;
    _fitBox.getSize(_fitSize);
    if (_fitSize.length() < 1e-4) return;
    waits.current += 1;
    const span = _fitSize.length();
    // 等缩放/居中生效：厘米骨架未缩时对角线可达数百，这时取景会把相机甩飞。
    if ((span < 0.25 || span > 12) && waits.current < 45) return;
    if (waits.current < 4) return;
    if (!controls && waits.current < 12) return;
    const center = _fitBox.getCenter(_fitCenter);
    const radius = Math.max(_fitSize.length() * 0.5, 0.2);
    const fov = ((camera.fov || 50) * Math.PI) / 180;
    const dist = (radius / Math.max(Math.sin(fov / 2), 1e-4)) * 1.05;
    camera.position.set(center.x + dist * 0.72, center.y + dist * 0.42, center.z + dist * 0.88);
    camera.near = Math.max(dist / 400, 0.01);
    camera.far = Math.max(dist * 80, 80);
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    if (controls) {
      controls.target.copy(center);
      controls.update();
    }
    framed.current = resetKey;
  });

  return null;
}

export function useViewerLook() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme);
  return useMemo(() => viewerLook(theme), [theme]);
}

export function ViewerSceneChrome({ hemisphere = false }: { hemisphere?: boolean }) {
  const look = useViewerLook();
  return (
    <>
      <color attach="background" args={[look.background]} />
      <ambientLight intensity={look.ambient} />
      <directionalLight position={[3, 5, 2]} intensity={look.directional} />
      {hemisphere ? <hemisphereLight args={[look.hemiSky, look.hemiGround, 0.4]} /> : null}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.002, 0]}>
        <planeGeometry args={[24, 24]} />
        <meshBasicMaterial color={look.hemiGround} />
      </mesh>
      <Grid
        args={[20, 20]}
        cellSize={0.5}
        cellThickness={0.7}
        sectionSize={1}
        sectionThickness={1.15}
        cellColor={look.cell}
        sectionColor={look.section}
        fadeDistance={48}
        infiniteGrid
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
