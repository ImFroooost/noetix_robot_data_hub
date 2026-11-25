import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import URDFLoader, { type URDFRobot } from "urdf-loader";
import { api } from "../api";
import type { ModelInstance, StorageFile } from "../types";
import { fetchAuth, fetchRepoMesh } from "../utils/repoMesh";
import { npzMeta, parseNpz, type NpyArray } from "../utils/npz";
import { normalizeRobotVersion, robotDescriptionVersions } from "./RobotStyleFields";
import { DataOriginAxes, FrameFigure, ViewerSceneChrome } from "./ViewerSceneChrome";
import { NAMES_OFF, NameToggleButtons, SceneNameLabels, useNameFlags, type NameFlags } from "./NameLabels";
import { upAxisToRotationX } from "../viewerUpAxis";
import { useReportPlayback } from "../playbackClock";

const ROTATION_X = upAxisToRotationX("z");
const _robotBox = new THREE.Box3();
const _robotSize = new THREE.Vector3();
const _rootPos = new THREE.Vector3();
const _rootDelta = new THREE.Vector3();
const _robotMat = new THREE.MeshStandardMaterial({
  color: 0xd7dbe2,
  roughness: 0.48,
  metalness: 0.08,
});
const _wood = new THREE.MeshStandardMaterial({
  color: 0xd7b98a,
  roughness: 0.55,
  metalness: 0.04,
  emissive: 0x4a3218,
  emissiveIntensity: 0.28,
  side: THREE.DoubleSide,
});
const _edge = new THREE.LineBasicMaterial({ color: 0xfff3df });
const _marker = new THREE.MeshStandardMaterial({
  color: 0xffd43b,
  roughness: 0.4,
  metalness: 0.05,
  emissive: 0x8a6a10,
  emissiveIntensity: 0.35,
});

type HoiBody = {
  id: string;
  kind: "rigid" | "marker";
  size: [number, number, number];
  center: [number, number, number];
  radius: number;
};

type HoiClip = {
  fps: number;
  frames: number;
  duration: number;
  jointNames: string[];
  rootPos: Float32Array;
  rootQuat: Float32Array;
  jointPos: Float32Array;
  bodies: HoiBody[];
  bodyPos: Float32Array;
  bodyQuat: Float32Array;
};

export function isRobotMergedNpz(file: {
  path?: string;
  ontology?: string;
  format?: string;
  annotation?: { motion_kind?: string } | null;
}) {
  const path = (file.path || "").replace(/\\/g, "/");
  const fmt = (file.format || path.split(".").pop() || "").toLowerCase();
  return (
    (file.ontology === "robot" || path.includes("/robot/")) &&
    fmt === "npz" &&
    (path.includes("/merged/") || file.annotation?.motion_kind === "merged")
  );
}

function floats(array: NpyArray | undefined, label: string) {
  if (!array || !(array.data instanceof Float32Array)) throw new Error(`npz 缺少 ${label}`);
  return array.data;
}

function readClip(arrays: Record<string, NpyArray>): HoiClip {
  const meta = npzMeta(arrays);
  const robot = (meta.robot || {}) as { joint_names?: string[] };
  const fps = Number(meta.fps) || 30;
  const rootPos = floats(arrays.robot_root_pos, "robot_root_pos");
  const rootQuat = floats(arrays.robot_root_quat, "robot_root_quat");
  const jointPos = floats(arrays.robot_joint_pos, "robot_joint_pos");
  const frames = arrays.robot_root_pos?.shape?.[0] || 0;
  if (!frames) throw new Error("npz 没有动作帧");
  const rawBodies = Array.isArray(meta.bodies) ? meta.bodies : [];
  const bodies: HoiBody[] = rawBodies.map((item, index) => {
    const body = (item || {}) as Record<string, unknown>;
    const size = Array.isArray(body.size_m) ? body.size_m.map(Number) : [1, 1, 1];
    const center = Array.isArray(body.center_m) ? body.center_m.map(Number) : [0, 0, 0];
    return {
      id: String(body.id || `body_${index}`),
      kind: body.kind === "marker" ? "marker" : "rigid",
      size: [size[0] || 1, size[1] || 1, size[2] || 1],
      center: [center[0] || 0, center[1] || 0, center[2] || 0],
      radius: Number(body.radius_m) || 0.02,
    };
  });
  return {
    fps,
    frames,
    duration: Number(meta.duration_sec) || frames / fps,
    jointNames: Array.isArray(robot.joint_names) ? robot.joint_names.map(String) : [],
    rootPos,
    rootQuat,
    jointPos,
    bodies,
    bodyPos: bodies.length ? floats(arrays.body_pos, "body_pos") : new Float32Array(),
    bodyQuat: bodies.length ? floats(arrays.body_quat, "body_quat") : new Float32Array(),
  };
}

function paintRobot(model: URDFRobot) {
  model.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = _robotMat;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });
}

function HoiBodies({ clip, time }: { clip: HoiClip; time: number }) {
  const groups = useRef<(THREE.Group | null)[]>([]);
  const timeRef = useRef(time);
  timeRef.current = time;
  const geometries = useMemo(
    () =>
      clip.bodies.map((body) => {
        if (body.kind === "marker") return null;
        const geometry = new THREE.BoxGeometry(body.size[0], body.size[1], body.size[2]);
        geometry.translate(body.center[0], body.center[1], body.center[2]);
        geometry.computeVertexNormals();
        return { geometry, edges: new THREE.EdgesGeometry(geometry, 15) };
      }),
    [clip]
  );
  useEffect(
    () => () => {
      geometries.forEach((item) => {
        item?.geometry.dispose();
        item?.edges.dispose();
      });
    },
    [geometries]
  );
  useFrame(() => {
    const frame = Math.min(Math.max(Math.floor(timeRef.current * clip.fps), 0), clip.frames - 1);
    clip.bodies.forEach((_body, index) => {
      const group = groups.current[index];
      if (!group) return;
      const base = (frame * clip.bodies.length + index) * 3;
      const quatBase = (frame * clip.bodies.length + index) * 4;
      group.position.set(clip.bodyPos[base], clip.bodyPos[base + 1], clip.bodyPos[base + 2]);
      group.quaternion.set(
        clip.bodyQuat[quatBase],
        clip.bodyQuat[quatBase + 1],
        clip.bodyQuat[quatBase + 2],
        clip.bodyQuat[quatBase + 3]
      ).normalize();
    });
  });
  return (
    <>
      {clip.bodies.map((body, index) => (
        <group
          key={body.id}
          name={body.id}
          userData={{ nameKind: body.kind }}
          ref={(node) => {
            groups.current[index] = node;
          }}
        >
          {body.kind === "marker" || !geometries[index] ? (
            <mesh material={_marker} castShadow>
              <sphereGeometry args={[body.radius, 12, 10]} />
            </mesh>
          ) : (
            <mesh geometry={geometries[index]!.geometry} material={_wood} castShadow receiveShadow>
              <lineSegments geometry={geometries[index]!.edges} material={_edge} />
            </mesh>
          )}
        </group>
      ))}
    </>
  );
}

function HoiScene({
  npzUrl,
  urdfPath,
  packageRoot,
  time,
  viewNonce,
  followRoot,
  names = NAMES_OFF,
  onReady,
  onError,
}: {
  npzUrl: string;
  urdfPath: string;
  packageRoot: string;
  time: number;
  viewNonce: number;
  followRoot: boolean;
  names?: NameFlags;
  onReady: (info: { duration: number; note: string }) => void;
  onError: (message: string) => void;
}) {
  const robotRef = useRef<URDFRobot | null>(null);
  const robotSubjectRef = useRef<THREE.Group | null>(null);
  const figureRef = useRef<THREE.Group | null>(null);
  const [labelRoot, setLabelRoot] = useState<THREE.Group | null>(null);
  const clipRef = useRef<HoiClip | null>(null);
  const [robot, setRobot] = useState<URDFRobot | null>(null);
  const [meshesReady, setMeshesReady] = useState(false);
  const [clip, setClip] = useState<HoiClip | null>(null);
  const [axisLength, setAxisLength] = useState(1.2);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const followRef = useRef(followRoot);
  const lastRoot = useRef(new THREE.Vector3());
  const hasLastRoot = useRef(false);
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as
    | { target: THREE.Vector3; update: () => void }
    | undefined;
  onReadyRef.current = onReady;
  onErrorRef.current = onError;
  followRef.current = followRoot;

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setRobot(null);
    setMeshesReady(false);
    setClip(null);
    robotRef.current = null;
    clipRef.current = null;
    hasLastRoot.current = false;
    const root = packageRoot.replace(/\/?$/, "/");
    Promise.all([
      fetchAuth(npzUrl, { cache: "no-cache" }).then((res) => res.arrayBuffer()),
      fetchAuth(api.storageFileUrl(urdfPath)).then((res) => res.text()),
    ])
      .then(([buffer, urdfText]) => {
        if (cancelled) return;
        const parsed = readClip(parseNpz(buffer));
        let pendingMeshes = 0;
        let parseFinished = false;
        let modelRefLocal: URDFRobot | null = null;
        const finalizeMeshes = () => {
          if (!parseFinished || pendingMeshes > 0 || cancelled || !modelRefLocal) return;
          paintRobot(modelRefLocal);
          modelRefLocal.updateMatrixWorld(true);
          _robotBox.setFromObject(modelRefLocal);
          if (!_robotBox.isEmpty()) {
            _robotBox.getSize(_robotSize);
            const span = Math.max(_robotSize.x, _robotSize.y, _robotSize.z);
            setAxisLength(span > 0.05 ? span : 1.2);
          }
          setMeshesReady(true);
        };
        const loader = new URDFLoader();
        loader.workingPath = root;
        loader.parseVisual = true;
        loader.parseCollision = false;
        loader.loadMeshCb = (path, manager, done) => {
          pendingMeshes += 1;
          manager.itemStart(path);
          fetchRepoMesh(path, packageRoot, urdfPath)
            .then(({ path: repoPath, buffer: meshBuffer }) => {
              if (!/\.stl$/i.test(repoPath)) throw new Error(`不支持的网格格式：${repoPath}`);
              const geom = new STLLoader().parse(meshBuffer);
              geom.computeBoundingBox();
              done(new THREE.Mesh(geom, _robotMat));
            })
            .catch((err) => done(null, err))
            .finally(() => {
              manager.itemEnd(path);
              pendingMeshes -= 1;
              finalizeMeshes();
            });
        };
        const model = loader.parse(urdfText);
        modelRefLocal = model;
        // 预先应用第 0 帧位姿与关节角，保证初始视角对准真实的起始位置
        const joints0 = parsed.jointPos.length / parsed.frames;
        model.position.set(parsed.rootPos[0], parsed.rootPos[1], parsed.rootPos[2]);
        model.quaternion
          .set(parsed.rootQuat[0], parsed.rootQuat[1], parsed.rootQuat[2], parsed.rootQuat[3])
          .normalize();
        parsed.jointNames.forEach((name, index) => {
          if (index >= joints0) return;
          try {
            model.setJointValue(name, parsed.jointPos[index]);
          } catch {
            /* ignore */
          }
        });
        paintRobot(model);
        parseFinished = true;
        finalizeMeshes();
        clipRef.current = parsed;
        robotRef.current = model;
        setClip(parsed);
        setRobot(model);
        setStatus("ready");
        const jointCount = parsed.jointPos.length / parsed.frames;
        onReadyRef.current({
          duration: parsed.duration,
          note:
            parsed.jointNames.length === jointCount
              ? "模型来自 3D 模型库，动作来自 npz"
              : `关节名 ${parsed.jointNames.length} 个，数值 ${jointCount} 列`,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "机器人 npz 加载失败";
        setError(message);
        setStatus("error");
        onErrorRef.current(message);
      });
    return () => {
      cancelled = true;
    };
  }, [npzUrl, urdfPath, packageRoot]);

  useEffect(() => {
    hasLastRoot.current = false;
  }, [followRoot, npzUrl]);

  useFrame(() => {
    const model = robotRef.current;
    const current = clipRef.current;
    if (!model || !current) return;
    const frame = Math.min(Math.max(Math.floor(time * current.fps), 0), current.frames - 1);
    const joints = current.jointPos.length / current.frames;
    model.position.set(
      current.rootPos[frame * 3],
      current.rootPos[frame * 3 + 1],
      current.rootPos[frame * 3 + 2]
    );
    model.quaternion
      .set(
        current.rootQuat[frame * 4],
        current.rootQuat[frame * 4 + 1],
        current.rootQuat[frame * 4 + 2],
        current.rootQuat[frame * 4 + 3]
      )
      .normalize();
    current.jointNames.forEach((name, index) => {
      if (index >= joints) return;
      const value = current.jointPos[frame * joints + index];
      try {
        model.setJointValue(name, value);
      } catch {
        /* this URDF does not have the joint */
      }
    });
    model.updateMatrixWorld(true);
    model.getWorldPosition(_rootPos);
    if (followRef.current && hasLastRoot.current) {
      _rootDelta.subVectors(_rootPos, lastRoot.current);
      if (_rootDelta.lengthSq() > 1e-12) {
        camera.position.add(_rootDelta);
        if (controls) {
          controls.target.add(_rootDelta);
          controls.update();
        }
      }
    }
    lastRoot.current.copy(_rootPos);
    hasLastRoot.current = true;
  });

  return (
    <group
      ref={(node) => {
        figureRef.current = node;
        setLabelRoot((current) => (current === node ? current : node));
      }}
    >
      <group rotation={[ROTATION_X, 0, 0]}>
        <DataOriginAxes length={axisLength} />
        <group ref={robotSubjectRef}>
          {robot && <primitive object={robot} />}
        </group>
        {clip && <HoiBodies clip={clip} time={time} />}
        <SceneNameLabels root={labelRoot} names={names} />
      </group>
      <FrameFigure
        objectRef={robotSubjectRef}
        fallbackRef={figureRef}
        ready={status === "ready" && meshesReady}
        resetKey={npzUrl}
        nonce={viewNonce}
      />
      {status === "loading" && (
        <Html center style={{ pointerEvents: "none" }}>
          <div className="muted animation-format-status">合并数据加载中…</div>
        </Html>
      )}
      {status === "error" && (
        <Html center style={{ pointerEvents: "none" }}>
          <div className="error animation-format-status">{error}</div>
        </Html>
      )}
    </group>
  );
}

export function RobotHoiNpzPreview({ file }: { file: StorageFile }) {
  const [names] = useNameFlags();
  const [instances, setInstances] = useState<ModelInstance[]>([]);
  const [modelsError, setModelsError] = useState("");
  const [time, setTime] = useState(0);
  useReportPlayback(time);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [note, setNote] = useState("");
  const [viewNonce, setViewNonce] = useState(0);
  const [followRoot, setFollowRoot] = useState(true);
  const duration = mediaDuration || file.duration_sec || 1;
  const style = String(file.robot_style || file.annotation?.robot_style || "");
  const instance = instances.find((item) => item.name === style);
  const versions = robotDescriptionVersions(instance);
  const defaultFile = String(instance?.meta?.default_description_file || "");
  const version = normalizeRobotVersion(versions, String(file.annotation?.robot_version || ""), defaultFile);
  const urdfFile =
    versions.find((item) => item.relative_path === version || item.name === version) ||
    (versions.length === 1
      ? versions[0]
      : defaultFile
        ? versions.find((item) => item.relative_path === defaultFile || item.name === defaultFile)
        : undefined);
  const packageRoot = urdfFile
    ? urdfFile.path.slice(0, urdfFile.path.length - urdfFile.relative_path.length).replace(/\/$/, "")
    : "";

  useEffect(() => {
    let cancelled = false;
    api
      .storageModels({ quiet: true })
      .then((data) => {
        if (!cancelled) setInstances(data.instances.filter((item) => item.ontology === "robot"));
      })
      .catch((err) => {
        if (!cancelled) setModelsError(err instanceof Error ? err.message : "机器人模型加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setTime(0);
    setPlaying(true);
    setMediaDuration(0);
    setNote("");
  }, [file.path]);

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

  const missingStyle = !style || !urdfFile;
  return (
    <div className="animation-format-preview" onClick={(event) => event.stopPropagation()}>
      <div className="viewer-panel animation-format-canvas">
        {modelsError ? (
          <div className="storage-preview-empty">{modelsError}</div>
        ) : missingStyle ? (
          <div className="storage-preview-empty">请先在右侧选择机器人款式，保存后再预览</div>
        ) : (
          <Canvas
            camera={{ position: [2.4, 1.6, 3.2], fov: 50 }}
            style={{ width: "100%", height: "100%", display: "block" }}
            resize={{ debounce: 0 }}
            gl={{ antialias: true, alpha: false }}
          >
            <ViewerSceneChrome />
            <HoiScene
              key={`${file.path}:${urdfFile.path}`}
              npzUrl={file.path.startsWith("blob:") ? file.path : api.storageFileUrl(file.path)}
              urdfPath={urdfFile.path}
              packageRoot={packageRoot}
              time={time}
              viewNonce={viewNonce}
              followRoot={followRoot}
              names={names}
              onReady={({ duration: nextDuration, note: nextNote }) => {
                setMediaDuration(nextDuration);
                setNote(nextNote);
              }}
              onError={() => undefined}
            />
            <OrbitControls makeDefault />
          </Canvas>
        )}
      </div>
      <div className="playback-controls animation-format-controls">
        <button
          type="button"
          className="play-button"
          disabled={missingStyle}
          onClick={() => setPlaying((current) => !current)}
          title={playing ? "暂停" : "播放"}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <button
          type="button"
          className="icon-button"
          disabled={missingStyle}
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
          disabled={missingStyle}
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
          title="重新把机器人对准到画面中央"
          disabled={missingStyle}
          onClick={() => setViewNonce((value) => value + 1)}
        >
          复位视角
        </button>
        <button
          type="button"
          className={`follow-root-toggle secondary ${followRoot ? "is-on" : ""}`}
          title="打开后，相机保持当前相对位置，并随机器人根节点一起移动"
          aria-pressed={followRoot}
          disabled={missingStyle}
          onClick={() => setFollowRoot((current) => !current)}
        >
          跟随视角
        </button>
        <span
          className="follow-root-toggle secondary is-static"
          title="合并数据不重置原点。机器人和物体都在动捕原点的 Z-up 坐标系里，模型来自 3D 模型库"
        >
          坐标系·共用原点
        </span>
        <NameToggleButtons />
      </div>
      {note ? <div className="muted animation-format-note">{note}</div> : null}
    </div>
  );
}
