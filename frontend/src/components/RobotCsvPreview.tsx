import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import URDFLoader, { type URDFRobot } from "urdf-loader";
import { api } from "../api";
import { fetchAuth, fetchRepoMesh } from "../utils/repoMesh";
import {
  normalizeRobotVersion,
  robotDescriptionVersions,
} from "./RobotStyleFields";
import type { ModelInstance, RetargetFrame, StorageFile } from "../types";
import { parseCsvFps } from "../types";
import { FbxSceneObjects, type RobotTrackFrame } from "./AnimationFormatPreview";
import { usePreview } from "../preview/PreviewContext";
import { DataOriginAxes, FrameFigure, ViewerSceneChrome } from "./ViewerSceneChrome";
import { upAxisToRotationX } from "../viewerUpAxis";

/** holosoma / MuJoCo robot CSVs are always Z-up: base xyz, quat xyzw, joints. */
const ROBOT_CSV_ROTATION_X = upAxisToRotationX("z");

const _robotBox = new THREE.Box3();
const _robotSize = new THREE.Vector3();
const _rootPos = new THREE.Vector3();
const _rootDelta = new THREE.Vector3();

function centerFromFrames(frames: RobotCsvFrame[], rotationX: number): [number, number, number] {
  let sumX = 0;
  let sumZ = 0;
  const c = Math.cos(rotationX);
  const s = Math.sin(rotationX);
  for (const frame of frames) {
    const [x, y, z] = frame.root;
    sumX += x;
    sumZ += y * s + z * c;
  }
  const n = frames.length || 1;
  return [-sumX / n, 0, -sumZ / n];
}

const ROOT_COLS = 7;
const FLOATING_JOINT = /floor_2_base|floating_base|floatingbase|root_joint|base_joint|world_to_/i;
const ACTUATED = new Set(["revolute", "continuous", "prismatic"]);

type RobotCsvFrame = {
  root: [number, number, number];
  quat: [number, number, number, number];
  joints: number[];
};

function fileVersionToken(path: string) {
  return path.match(/\.file_versions\/([^/]+)\//)?.[1] || "";
}

function humanSceneScore(file: StorageFile, stem: string, version: string) {
  const path = file.path || "";
  const name = (file.name || path).replace(/\.fbx$/i, "");
  let score = 0;
  if (name === stem || name.startsWith(`${stem}_`) || name.startsWith(`${stem}.`)) score += 4;
  if (version && fileVersionToken(path) === version) score += 2;
  if (!fileVersionToken(path)) score += 1;
  if (path.includes("/merged/") || file.annotation?.motion_kind === "merged") score += 8;
  return score;
}

/** 同一数据单元里的人体 FBX，优先用带场景物体的合并数据。 */
export function humanSceneFbx(files: StorageFile[], csv: StorageFile): StorageFile | null {
  const fbxs = files.filter((item) => {
    const path = item.path || "";
    const name = item.name || path;
    const human = item.ontology === "human" || path.includes("/human/");
    const motion = !item.modality || item.modality === "motion" || path.includes("/motion/");
    const fbx = (item.format || "").toLowerCase() === "fbx" || name.toLowerCase().endsWith(".fbx");
    return human && motion && fbx;
  });
  if (!fbxs.length) return null;
  const stem = (csv.name || csv.path).replace(/\.csv$/i, "").replace(/_skeleton_.*$/i, "");
  const version = fileVersionToken(csv.path || "");
  return [...fbxs].sort(
    (left, right) => humanSceneScore(right, stem, version) - humanSceneScore(left, stem, version)
  )[0];
}

export function robotCsvHipsHint(name: string) {
  const match = name.match(/skeleton[_\s]+(skeleton[_\s]*\d+)/i);
  return match ? match[1].toLowerCase().replace(/\s+/g, "_") : null;
}

export function isRobotMotionCsv(file: StorageFile) {
  return (
    file.ontology === "robot" &&
    file.modality === "motion" &&
    (file.format || "").toLowerCase() === "csv"
  );
}

function parseRobotCsv(text: string): { frames: RobotCsvFrame[]; fps: number | null } {
  let fps: number | null = null;
  const frames: RobotCsvFrame[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const match = /fps\s*[:=]\s*([0-9.]+)/i.exec(line);
      if (match) fps = Number(match[1]);
      continue;
    }
    const parts = line.split(",").map((item) => item.trim());
    if (parts.some((item) => item !== "" && Number.isNaN(Number(item)))) continue;
    const values = parts.map(Number);
    if (values.length < ROOT_COLS || values.some((item) => Number.isNaN(item))) continue;
    frames.push({
      root: [values[0], values[1], values[2]],
      quat: [values[3], values[4], values[5], values[6]],
      joints: values.slice(ROOT_COLS),
    });
  }
  return { frames, fps };
}

function extractActuatedJoints(urdf: string): string[] {
  const names: string[] = [];
  const tagRe = /<joint\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(urdf))) {
    const tag = match[1];
    const name = /name\s*=\s*"([^"]+)"/i.exec(tag)?.[1];
    const type = /type\s*=\s*"([^"]+)"/i.exec(tag)?.[1]?.toLowerCase();
    if (!name || !type || !ACTUATED.has(type) || FLOATING_JOINT.test(name)) continue;
    names.push(name);
  }
  return names;
}

function applyFrame(robot: URDFRobot, frame: RobotCsvFrame, jointNames: string[]) {
  robot.position.set(frame.root[0], frame.root[1], frame.root[2]);
  robot.quaternion.set(frame.quat[0], frame.quat[1], frame.quat[2], frame.quat[3]).normalize();
  jointNames.forEach((name, index) => {
    const value = frame.joints[index];
    if (value == null) return;
    try {
      robot.setJointValue(name, value);
    } catch {
      /* joint missing in this URDF */
    }
  });
}

function RobotCsvScene({
  csvUrl,
  urdfPath,
  packageRoot,
  fpsHint,
  durationHint,
  time,
  rotationX = 0,
  viewNonce = 0,
  followRoot = false,
  propsUrl = "",
  hipsHint = null,
  retargetFrame = null,
  robotStyle = "",
  onReady,
  onError,
}: {
  retargetFrame?: RetargetFrame | null;
  robotStyle?: string;
  csvUrl: string;
  urdfPath: string;
  packageRoot: string;
  fpsHint?: number | null;
  durationHint?: number | null;
  time: number;
  rotationX?: number;
  viewNonce?: number;
  followRoot?: boolean;
  propsUrl?: string;
  hipsHint?: string | null;
  onReady: (info: { duration: number; fps: number; jointCount: number; note: string }) => void;
  onError: (message: string) => void;
}) {
  const robotRef = useRef<URDFRobot | null>(null);
  const figureRef = useRef<THREE.Group>(null);
  const framesRef = useRef<RobotCsvFrame[]>([]);
  const namesRef = useRef<string[]>([]);
  const fpsRef = useRef(30);
  const [robot, setRobot] = useState<URDFRobot | null>(null);
  const [center, setCenter] = useState<[number, number, number]>([0, 0, 0]);
  const [alignPose, setAlignPose] = useState<{
    position: [number, number, number];
    quaternion: [number, number, number, number];
  } | null>(null);
  const [axisLength, setAxisLength] = useState(1.2);
  const [robotTrack, setRobotTrack] = useState<RobotTrackFrame[]>([]);
  const [propsNonce, setPropsNonce] = useState(0);
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
    setError("");
    setRobot(null);
    setAlignPose(null);
    setRobotTrack([]);
    robotRef.current = null;
    framesRef.current = [];
    hasLastRoot.current = false;

    const root = packageRoot.replace(/\/?$/, "/");
    Promise.all([
      fetchAuth(csvUrl, { cache: "no-cache" }).then((res) => res.text()),
      fetchAuth(api.storageFileUrl(urdfPath)).then((res) => res.text()),
    ])
      .then(([csvText, urdfText]) => {
        if (cancelled) return;
        const parsed = parseRobotCsv(csvText);
        if (!parsed.frames.length) throw new Error("CSV 中没有可解析的数值帧");
        const jointNames = extractActuatedJoints(urdfText);
        if (!jointNames.length) throw new Error("URDF 中没有可驱动关节");

        const loader = new URDFLoader();
        loader.workingPath = root;
        loader.parseVisual = true;
        loader.parseCollision = false;
        loader.loadMeshCb = (path, manager, done) => {
          manager.itemStart(path);
          fetchRepoMesh(path, packageRoot, urdfPath)
            .then(({ path: repoPath, buffer }) => {
              if (!/\.stl$/i.test(repoPath)) {
                throw new Error(`不支持的网格格式：${repoPath}`);
              }
              const geometry = new STLLoader().parse(buffer);
              done(new THREE.Mesh(geometry, new THREE.MeshPhongMaterial()));
            })
            .catch((err) => done(null, err))
            .finally(() => manager.itemEnd(path));
        };

        const model = loader.parse(urdfText);
        applyFrame(model, parsed.frames[0], jointNames);
        model.updateMatrixWorld(true);
        _robotBox.setFromObject(model);
        if (!_robotBox.isEmpty()) {
          _robotBox.getSize(_robotSize);
          const span = Math.max(_robotSize.x, _robotSize.y, _robotSize.z);
          setAxisLength(span > 0.05 ? span : 1.2);
        }
        const fps = fpsHint || parsed.fps || 30;
        const duration =
          durationHint && durationHint > 0
            ? durationHint
            : parsed.frames.length / Math.max(fps, 1);
        setCenter(centerFromFrames(parsed.frames, rotationX));
        setAlignPose({
          position: parsed.frames[0].root,
          quaternion: parsed.frames[0].quat,
        });
        setRobotTrack(parsed.frames);

        framesRef.current = parsed.frames;
        namesRef.current = jointNames;
        fpsRef.current = fps;
        robotRef.current = model;
        setRobot(model);
        setStatus("ready");
        const csvJoints = parsed.frames[0].joints.length;
        onReadyRef.current({
          duration,
          fps,
          jointCount: Math.min(csvJoints, jointNames.length),
          note:
            csvJoints === jointNames.length
              ? ""
              : `关节列 ${csvJoints}，URDF 可动关节 ${jointNames.length}，已按顺序对齐`,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "机器人 CSV 加载失败";
        setError(message);
        setStatus("error");
        onErrorRef.current(message);
      });

    return () => {
      cancelled = true;
    };
  }, [csvUrl, urdfPath, packageRoot, fpsHint, durationHint]);

  useEffect(() => {
    if (!framesRef.current.length) return;
    setCenter(centerFromFrames(framesRef.current, rotationX));
  }, [rotationX, robot]);

  useEffect(() => {
    hasLastRoot.current = false;
  }, [followRoot, csvUrl, rotationX]);

  useFrame(() => {
    const model = robotRef.current;
    const frames = framesRef.current;
    if (!model || !frames.length) return;
    const idx = Math.min(
      Math.max(Math.floor(time * fpsRef.current), 0),
      frames.length - 1
    );
    applyFrame(model, frames[idx], namesRef.current);
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
    <group ref={figureRef} position={center}>
      <group rotation={[rotationX, 0, 0]}>
        <DataOriginAxes length={axisLength} />
        {robot && <primitive object={robot} />}
        {propsUrl ? (
          <FbxSceneObjects
            url={propsUrl}
            time={time}
            alignPose={alignPose}
            hipsHint={hipsHint}
            retargetFrame={retargetFrame}
            robotStyle={robotStyle}
            robotTrack={robotTrack}
            onReady={() => setPropsNonce((value) => value + 1)}
          />
        ) : null}
      </group>
      <FrameFigure
        objectRef={figureRef}
        ready={status === "ready"}
        resetKey={`${csvUrl}:${rotationX}:${propsUrl}`}
        nonce={viewNonce + propsNonce}
      />
      {status === "loading" && (
        <Html center style={{ pointerEvents: "none" }}>
          <div className="muted animation-format-status">机器人 CSV 加载中…</div>
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

export function RobotCsvPreview({ file }: { file: StorageFile }) {
  const preview = usePreview();
  const sceneFbx = humanSceneFbx(
    preview.filesForUnit(file.batch || "", file.unit_name || ""),
    file
  );
  const propsUrl = sceneFbx ? api.storageFileUrl(sceneFbx.path) : "";
  const hipsHint = robotCsvHipsHint(file.name || file.path || "");
  const scenePath = sceneFbx?.path || "";
  const [retargetFrame, setRetargetFrame] = useState<RetargetFrame | null>(null);
  useEffect(() => {
    setRetargetFrame(null);
    if (!scenePath) return;
    let cancelled = false;
    api
      .storageRetargetFrame(scenePath)
      .then((frame) => {
        if (!cancelled) setRetargetFrame(frame);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [scenePath]);
  const [instances, setInstances] = useState<ModelInstance[]>([]);
  const [modelsError, setModelsError] = useState("");
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [note, setNote] = useState("");
  const [viewNonce, setViewNonce] = useState(0);
  const [followRoot, setFollowRoot] = useState(true);
  const duration = mediaDuration || file.duration_sec || 1;
  const rotationX = ROBOT_CSV_ROTATION_X;
  const contentStamp = `${file.modified_at || ""}:${file.size ?? ""}`;
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
      .storageModels()
      .then((data) => {
        if (!cancelled) {
          setInstances(data.instances.filter((item) => item.ontology === "robot"));
        }
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
  }, [file.path, style, version]);

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
  const handleReady = ({
    duration: nextDuration,
    note: nextNote,
  }: {
    duration: number;
    fps: number;
    jointCount: number;
    note: string;
  }) => {
    setMediaDuration(nextDuration);
    setNote(nextNote);
  };

  return (
    <div className="animation-format-preview" onClick={(event) => event.stopPropagation()}>
      <div className="viewer-panel animation-format-canvas">
        {modelsError ? (
          <div className="storage-preview-empty">{modelsError}</div>
        ) : missingStyle ? (
          <div className="storage-preview-empty">
            请先在右侧选择机器人款式
            {versions.length > 1 ? "和版本" : ""}
            ，保存后再预览
          </div>
        ) : (
          <Canvas
            camera={{ position: [2.4, 1.6, 3.2], fov: 50 }}
            style={{ width: "100%", height: "100%", display: "block" }}
            resize={{ debounce: 0 }}
            gl={{ antialias: true, alpha: false }}
          >
            <ViewerSceneChrome />
            <RobotCsvScene
              key={`${file.path}:${contentStamp}:${urdfFile.path}:${parseCsvFps(file.annotation?.fps ?? file.fps)}`}
              csvUrl={api.storageFileUrl(file.path)}
              urdfPath={urdfFile.path}
              packageRoot={packageRoot}
              fpsHint={parseCsvFps(file.annotation?.fps ?? file.fps)}
              durationHint={null}
              time={time}
              rotationX={rotationX}
              viewNonce={viewNonce}
              followRoot={followRoot}
              propsUrl={propsUrl}
              hipsHint={hipsHint}
              retargetFrame={retargetFrame}
              robotStyle={style}
              onReady={handleReady}
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
          onClick={() => setViewNonce((n) => n + 1)}
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
          title="机器人动作 CSV 由 holosoma 按 MuJoCo 坐标系导出，固定为 Z-up（米），不需要切换"
        >
          坐标系·Z-up
        </span>
      </div>
      {note ? <div className="muted animation-format-note">{note}</div> : null}
    </div>
  );
}
