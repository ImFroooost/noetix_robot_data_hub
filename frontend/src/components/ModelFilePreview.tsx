import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid, Html, OrbitControls } from "@react-three/drei";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import URDFLoader, { type URDFRobot } from "urdf-loader";
import { api } from "../api";
import { fetchAuth, fetchRepoMesh, normalizeRepoPath } from "../utils/repoMesh";
import { AnimationFormatPreview } from "./AnimationFormatPreview";
import type { ModelInstance, ModelInstanceFile } from "../types";

export type ModelPreviewKind =
  | "stl"
  | "obj"
  | "ply"
  | "dae"
  | "gltf"
  | "fbx"
  | "bvh"
  | "urdf"
  | "mjcf"
  | "unsupported";

function fileExt(name: string) {
  return name.split(".").pop()?.toLowerCase() || "";
}

export function modelPreviewKind(file: {
  name: string;
  relative_path?: string;
  kind?: string;
}): ModelPreviewKind {
  const ext = fileExt(file.name);
  const rel = (file.relative_path || "").replace(/\\/g, "/").toLowerCase();
  if (ext === "stl") return "stl";
  if (ext === "obj") return "obj";
  if (ext === "ply") return "ply";
  if (ext === "dae") return "dae";
  if (ext === "gltf" || ext === "glb") return "gltf";
  if (ext === "fbx") return "fbx";
  if (ext === "bvh") return "bvh";
  if (ext === "urdf") return "urdf";
  if (ext === "mjcf" || rel.includes("/mjcf/") || rel.startsWith("mjcf/")) return "mjcf";
  if (ext === "xml") return "mjcf";
  return "unsupported";
}

function packageRootOf(file: ModelInstanceFile) {
  if (!file.relative_path || !file.path.endsWith(file.relative_path)) {
    return file.path.replace(/\/[^/]+$/, "");
  }
  return file.path.slice(0, file.path.length - file.relative_path.length).replace(/\/$/, "");
}

function wrapForView(object: THREE.Object3D, rotateZUp = false) {
  const inner = new THREE.Group();
  if (rotateZUp) inner.rotation.x = -Math.PI / 2;
  if (object.parent) object.parent.remove(object);
  inner.add(object);
  inner.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(inner);
  const outer = new THREE.Group();
  outer.add(inner);
  if (!box.isEmpty()) {
    const center = box.getCenter(new THREE.Vector3());
    outer.position.set(-center.x, -box.min.y, -center.z);
  }
  return outer;
}

function FrameToObject({ object }: { object: THREE.Object3D }) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const controls = useThree((state) => state.controls) as
    | { target: THREE.Vector3; update: () => void }
    | undefined;
  const invalidate = useThree((state) => state.invalidate);
  const framed = useRef<THREE.Object3D | null>(null);

  useFrame(() => {
    if (framed.current === object) return;
    object.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.5, 0.02);
    const fov = ((camera.fov || 45) * Math.PI) / 180;
    const dist = (radius / Math.max(Math.sin(fov / 2), 1e-4)) * 1.2;
    camera.position.set(
      center.x + dist * 0.75,
      center.y + dist * 0.45,
      center.z + dist * 0.85
    );
    camera.near = Math.max(dist / 200, 0.001);
    camera.far = Math.max(dist * 50, 20);
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    if (controls) {
      controls.target.copy(center);
      controls.update();
    }
    framed.current = object;
    invalidate();
  });

  return null;
}

function meshMaterial(color = 0xc5ced8) {
  return new THREE.MeshPhongMaterial({
    color,
    specular: 0x333333,
    shininess: 40,
    side: THREE.DoubleSide,
  });
}

function applyDefaultMaterial(root: THREE.Object3D) {
  root.traverse((item) => {
    const mesh = item as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!mesh.material) mesh.material = meshMaterial();
    const geometry = mesh.geometry;
    if (geometry && !geometry.getAttribute("normal")) {
      geometry.computeVertexNormals();
    }
  });
}

function parseMeshObject(repoPath: string, buffer: ArrayBuffer) {
  if (/\.stl$/i.test(repoPath)) {
    const geometry = new STLLoader().parse(buffer);
    if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, new THREE.MeshPhongMaterial());
  }
  if (/\.dae$/i.test(repoPath)) {
    return new ColladaLoader().parse(new TextDecoder().decode(buffer), repoPath).scene;
  }
  if (/\.obj$/i.test(repoPath)) {
    return new OBJLoader().parse(new TextDecoder().decode(buffer));
  }
  throw new Error(`不支持的网格格式：${repoPath}`);
}

function SceneStatus({
  status,
  loading,
  error,
}: {
  status: "loading" | "ready" | "error";
  loading: string;
  error: string;
}) {
  if (status === "loading") {
    return (
      <Html center style={{ pointerEvents: "none" }}>
        <div className="muted animation-format-status">{loading}</div>
      </Html>
    );
  }
  if (status === "error") {
    return (
      <Html center style={{ pointerEvents: "none" }}>
        <div className="error animation-format-status">{error}</div>
      </Html>
    );
  }
  return null;
}

function FittedModel({
  object,
  rotateZUp,
}: {
  object: THREE.Object3D;
  rotateZUp: boolean;
}) {
  const wrapped = useMemo(() => wrapForView(object, rotateZUp), [object, rotateZUp]);
  return (
    <>
      <primitive object={wrapped} />
      <FrameToObject object={wrapped} />
    </>
  );
}

function StaticModelScene({
  url,
  format,
  rotateZUp,
  onStatus,
}: {
  url: string;
  format: Exclude<ModelPreviewKind, "fbx" | "bvh" | "urdf" | "mjcf" | "unsupported">;
  rotateZUp: boolean;
  onStatus?: (status: "loading" | "ready" | "error", message?: string) => void;
}) {
  const [object, setObject] = useState<THREE.Object3D | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError("");
    setObject(null);
    onStatus?.("loading");

    fetchAuth(url)
      .then(async (res) => {
        const buffer = await res.arrayBuffer();
        if (cancelled) return;
        let next: THREE.Object3D;
        if (format === "stl") {
          const geometry = new STLLoader().parse(buffer);
          if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
          next = new THREE.Mesh(geometry, meshMaterial());
        } else if (format === "obj") {
          next = new OBJLoader().parse(new TextDecoder().decode(buffer));
          applyDefaultMaterial(next);
        } else if (format === "ply") {
          const geometry = new PLYLoader().parse(buffer);
          if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
          next = new THREE.Mesh(geometry, meshMaterial());
        } else if (format === "dae") {
          next = new ColladaLoader().parse(new TextDecoder().decode(buffer), url).scene;
          applyDefaultMaterial(next);
        } else {
          next = await new Promise<THREE.Object3D>((resolve, reject) => {
            new GLTFLoader().parse(buffer, "", (gltf) => resolve(gltf.scene), reject);
          });
        }
        if (cancelled) return;
        setObject(next);
        setStatus("ready");
        onStatus?.("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "模型加载失败";
        setError(message);
        setStatus("error");
        onStatus?.("error", message);
      });

    return () => {
      cancelled = true;
    };
  }, [url, format, onStatus]);

  return (
    <group>
      {object && <FittedModel object={object} rotateZUp={rotateZUp} />}
      <SceneStatus status={status} loading="模型加载中…" error={error} />
    </group>
  );
}

function UrdfModelScene({
  urdfPath,
  packageRoot,
  onStatus,
}: {
  urdfPath: string;
  packageRoot: string;
  onStatus?: (status: "loading" | "ready" | "error", message?: string) => void;
}) {
  const [robot, setRobot] = useState<URDFRobot | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError("");
    setRobot(null);
    onStatus?.("loading");

    fetchAuth(api.storageFileUrl(urdfPath))
      .then((res) => res.text())
      .then(async (urdfText) => {
        if (cancelled) return;
        const manager = new THREE.LoadingManager();
        let started = false;
        const meshesDone = new Promise<void>((resolve) => {
          manager.onStart = () => {
            started = true;
          };
          manager.onLoad = () => resolve();
          manager.onError = () => resolve();
        });
        const loader = new URDFLoader(manager);
        loader.workingPath = `${packageRoot.replace(/\/?$/, "/")}`;
        loader.parseVisual = true;
        loader.parseCollision = false;
        loader.loadMeshCb = (path, meshManager, done) => {
          meshManager.itemStart(path);
          fetchRepoMesh(path, packageRoot, urdfPath)
            .then(({ path: repoPath, buffer }) => done(parseMeshObject(repoPath, buffer)))
            .catch((err) => done(null, err))
            .finally(() => meshManager.itemEnd(path));
        };
        const model = loader.parse(urdfText);
        if (started) {
          await Promise.race([
            meshesDone,
            new Promise((resolve) => window.setTimeout(resolve, 15000)),
          ]);
        }
        if (cancelled) return;
        let meshCount = 0;
        model.traverse((item) => {
          if ((item as THREE.Mesh).isMesh) meshCount += 1;
        });
        if (!meshCount) {
          throw new Error("URDF 网格未加载成功，请确认 meshes 目录存在");
        }
        setRobot(model);
        setStatus("ready");
        onStatus?.("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "URDF 加载失败";
        setError(message);
        setStatus("error");
        onStatus?.("error", message);
      });

    return () => {
      cancelled = true;
    };
  }, [urdfPath, packageRoot, onStatus]);

  return (
    <group>
      {robot && <FittedModel object={robot} rotateZUp />}
      <SceneStatus status={status} loading="URDF 加载中…" error={error} />
    </group>
  );
}

function parseMjcfVec(value: string | null, fallback: number[] = [0, 0, 0]) {
  if (!value) return fallback;
  const nums = value.trim().split(/\s+/).map(Number);
  return fallback.map((item, index) =>
    Number.isFinite(nums[index]) ? nums[index] : item
  );
}

function applyMjcfPose(object: THREE.Object3D, el: Element) {
  const [x, y, z] = parseMjcfVec(el.getAttribute("pos"));
  object.position.set(x, y, z);
  const quat = el.getAttribute("quat");
  const euler = el.getAttribute("euler");
  if (quat) {
    const [w, qx, qy, qz] = parseMjcfVec(quat, [1, 0, 0, 0]);
    object.quaternion.set(qx, qy, qz, w).normalize();
    return;
  }
  if (euler) {
    const [rx, ry, rz] = parseMjcfVec(euler);
    object.rotation.set(rx, ry, rz, "ZYX");
  }
}

function rgbaColor(value: string | null) {
  const [r, g, b, a] = parseMjcfVec(value, [0.72, 0.74, 0.78, 1]);
  return { color: new THREE.Color(r, g, b), opacity: a };
}

function walkMjcfBody(
  el: Element,
  parent: THREE.Object3D,
  meshes: Map<string, THREE.BufferGeometry>
) {
  const group = new THREE.Group();
  applyMjcfPose(group, el);
  parent.add(group);
  Array.from(el.children).forEach((child) => {
    const tag = child.tagName.toLowerCase();
    if (tag === "body") {
      walkMjcfBody(child, group, meshes);
      return;
    }
    if (tag !== "geom") return;
    const type = (child.getAttribute("type") || "").toLowerCase();
    const groupId = child.getAttribute("group");
    if (type === "plane" || groupId === "3") return;
    if (type !== "mesh") return;
    const meshName = child.getAttribute("mesh") || "";
    const geometry = meshes.get(meshName);
    if (!geometry) return;
    const { color, opacity } = rgbaColor(child.getAttribute("rgba"));
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshPhongMaterial({
        color,
        opacity,
        transparent: opacity < 0.999,
        side: THREE.DoubleSide,
        specular: 0x333333,
        shininess: 40,
      })
    );
    applyMjcfPose(mesh, child);
    group.add(mesh);
  });
}

function MjcfModelScene({
  mjcfPath,
  packageRoot,
  onStatus,
}: {
  mjcfPath: string;
  packageRoot: string;
  onStatus?: (status: "loading" | "ready" | "error", message?: string) => void;
}) {
  const [object, setObject] = useState<THREE.Object3D | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError("");
    setObject(null);
    onStatus?.("loading");

    fetchAuth(api.storageFileUrl(mjcfPath))
      .then((res) => res.text())
      .then(async (xmlText) => {
        const doc = new DOMParser().parseFromString(xmlText, "application/xml");
        if (doc.querySelector("parsererror")) {
          throw new Error("MJCF 不是有效的 XML");
        }
        const compiler = doc.querySelector("compiler");
        const meshdir = compiler?.getAttribute("meshdir") || "../meshes";
        const assets = Array.from(doc.querySelectorAll("asset > mesh"));
        if (!assets.length) throw new Error("MJCF 中没有 mesh 资源");
        const geometries = new Map<string, THREE.BufferGeometry>();
        for (const asset of assets) {
          if (cancelled) return;
          const name = asset.getAttribute("name") || asset.getAttribute("file") || "";
          const file = asset.getAttribute("file") || `${name}.STL`;
          const { path, buffer } = await fetchRepoMesh(
            normalizeRepoPath(`${meshdir}/${file}`),
            packageRoot,
            mjcfPath
          );
          if (!/\.stl$/i.test(path)) {
            throw new Error(`暂不支持的 MJCF 网格：${path}`);
          }
          const geometry = new STLLoader().parse(buffer);
          if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
          geometries.set(name, geometry);
        }
        const root = new THREE.Group();
        const world = doc.querySelector("worldbody");
        if (!world) throw new Error("MJCF 缺少 worldbody");
        Array.from(world.children).forEach((child) => {
          if (child.tagName.toLowerCase() === "body") {
            walkMjcfBody(child, root, geometries);
          }
        });
        let meshCount = 0;
        root.traverse((item) => {
          if ((item as THREE.Mesh).isMesh) meshCount += 1;
        });
        if (!meshCount) throw new Error("MJCF 网格未加载成功");
        if (cancelled) return;
        setObject(root);
        setStatus("ready");
        onStatus?.("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "MJCF 加载失败";
        setError(message);
        setStatus("error");
        onStatus?.("error", message);
      });

    return () => {
      cancelled = true;
    };
  }, [mjcfPath, packageRoot, onStatus]);

  return (
    <group>
      {object && <FittedModel object={object} rotateZUp />}
      <SceneStatus status={status} loading="MJCF 加载中…" error={error} />
    </group>
  );
}

function ModelPreviewCanvas({
  children,
  status,
  message,
  resetKey,
}: {
  children: ReactNode;
  status: "loading" | "ready" | "error";
  message: string;
  resetKey: string;
}) {
  return (
    <div className="storage-model-canvas">
      {status !== "ready" && (
        <div
          className={`storage-model-canvas-status ${
            status === "error" ? "error" : "muted"
          }`}
        >
          {message}
        </div>
      )}
      <Canvas
        key={resetKey}
        camera={{ position: [2.2, 1.4, 2.6], fov: 45 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: false }}
        style={{ width: "100%", height: "100%", display: "block" }}
      >
        <color attach="background" args={["#0b0d12"]} />
        <ambientLight intensity={0.8} />
        <directionalLight position={[3, 5, 2]} intensity={1.2} />
        <hemisphereLight args={["#dfe8ff", "#2a3140", 0.4]} />
        <Grid args={[10, 10]} cellColor="#334" sectionColor="#556" fadeDistance={20} />
        {children}
        <OrbitControls makeDefault />
      </Canvas>
    </div>
  );
}

function unsupportedHint(file: ModelInstanceFile) {
  const ext = fileExt(file.name);
  if (ext === "blend") return "Blender 源文件无法在浏览器中预览，请下载后用 Blender 打开。";
  if (ext === "pkl" || ext === "npy" || ext === "npz" || file.kind === "smpl") {
    return "SMPL 参数文件暂不支持网页预览。";
  }
  return `暂不支持预览 .${ext || "该"} 文件，请选择网格、URDF、MJCF、FBX 或 BVH。`;
}

export function ModelFilePreview({
  file,
  instance,
}: {
  file: ModelInstanceFile;
  instance: ModelInstance;
}) {
  const kind = useMemo(() => modelPreviewKind(file), [file.name, file.relative_path]);
  const url = api.storageFileUrl(file.path);
  const packageRoot = packageRootOf(file);
  const rotateZUp = instance.ontology === "robot" || kind === "stl";
  const [banner, setBanner] = useState<{
    status: "loading" | "ready" | "error";
    message: string;
  }>({ status: "loading", message: "模型加载中…" });
  const onStatus = useCallback(
    (status: "loading" | "ready" | "error", message?: string) => {
      setBanner({
        status,
        message:
          message ||
          (status === "loading" ? "模型加载中…" : status === "error" ? "模型加载失败" : ""),
      });
    },
    []
  );

  useEffect(() => {
    setBanner({ status: "loading", message: "模型加载中…" });
  }, [file.path]);

  if (kind === "unsupported") {
    return <div className="storage-preview-empty">{unsupportedHint(file)}</div>;
  }

  if (kind === "fbx" || kind === "bvh") {
    return (
      <div className="storage-model-canvas is-animated">
        <AnimationFormatPreview url={url} format={kind} />
      </div>
    );
  }

  return (
    <ModelPreviewCanvas
      status={banner.status}
      message={banner.message}
      resetKey={file.path}
    >
      {kind === "urdf" ? (
        <UrdfModelScene
          key={`${instance.key}:${file.path}`}
          urdfPath={file.path}
          packageRoot={packageRoot}
          onStatus={onStatus}
        />
      ) : kind === "mjcf" ? (
        <MjcfModelScene
          key={`${instance.key}:${file.path}`}
          mjcfPath={file.path}
          packageRoot={packageRoot}
          onStatus={onStatus}
        />
      ) : (
        <StaticModelScene
          key={`${instance.key}:${file.path}`}
          url={url}
          format={kind}
          rotateZUp={rotateZUp}
          onStatus={onStatus}
        />
      )}
    </ModelPreviewCanvas>
  );
}
