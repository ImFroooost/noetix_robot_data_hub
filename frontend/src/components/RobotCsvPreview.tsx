import { Canvas, useFrame } from "@react-three/fiber";
import { Grid, Html, OrbitControls } from "@react-three/drei";
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
import type { ModelInstance, StorageFile } from "../types";

const ROOT_COLS = 7;
const FLOATING_JOINT = /floor_2_base|floating_base|floatingbase|root_joint|base_joint|world_to_/i;
const ACTUATED = new Set(["revolute", "continuous", "prismatic"]);

type RobotCsvFrame = {
  root: [number, number, number];
  quat: [number, number, number, number];
  joints: number[];
};

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
  onReady,
  onError,
}: {
  csvUrl: string;
  urdfPath: string;
  packageRoot: string;
  fpsHint?: number | null;
  durationHint?: number | null;
  time: number;
  onReady: (info: { duration: number; fps: number; jointCount: number; note: string }) => void;
  onError: (message: string) => void;
}) {
  const robotRef = useRef<URDFRobot | null>(null);
  const framesRef = useRef<RobotCsvFrame[]>([]);
  const namesRef = useRef<string[]>([]);
  const fpsRef = useRef(30);
  const [robot, setRobot] = useState<URDFRobot | null>(null);
  const [center, setCenter] = useState<[number, number, number]>([0, 0, 0]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  onReadyRef.current = onReady;
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError("");
    setRobot(null);
    robotRef.current = null;
    framesRef.current = [];

    const root = packageRoot.replace(/\/?$/, "/");
    Promise.all([
      fetchAuth(csvUrl).then((res) => res.text()),
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
        const fps = parsed.fps || fpsHint || 30;
        const duration =
          durationHint && durationHint > 0
            ? durationHint
            : parsed.frames.length / Math.max(fps, 1);
        let sumX = 0;
        let sumZ = 0;
        parsed.frames.forEach((frame) => {
          sumX += frame.root[0];
          sumZ += -frame.root[1];
        });
        setCenter([-sumX / parsed.frames.length, 0, -sumZ / parsed.frames.length]);

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

  useFrame(() => {
    const model = robotRef.current;
    const frames = framesRef.current;
    if (!model || !frames.length) return;
    const idx = Math.min(
      Math.max(Math.floor(time * fpsRef.current), 0),
      frames.length - 1
    );
    applyFrame(model, frames[idx], namesRef.current);
  });

  return (
    <group position={center}>
      <group rotation={[-Math.PI / 2, 0, 0]}>{robot && <primitive object={robot} />}</group>
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
  const [instances, setInstances] = useState<ModelInstance[]>([]);
  const [modelsError, setModelsError] = useState("");
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [note, setNote] = useState("");
  const duration = mediaDuration || file.duration_sec || 1;
  const style = String(file.annotation?.robot_style || "");
  const instance = instances.find((item) => item.name === style);
  const versions = robotDescriptionVersions(instance);
  const version = normalizeRobotVersion(versions, String(file.annotation?.robot_version || ""));
  const urdfFile =
    versions.find((item) => item.relative_path === version || item.name === version) ||
    (versions.length === 1 ? versions[0] : undefined);
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
    setPlaying(false);
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
          <Canvas camera={{ position: [2.4, 1.6, 3.2], fov: 50 }}>
            <color attach="background" args={["#0b0d12"]} />
            <ambientLight intensity={0.75} />
            <directionalLight position={[3, 5, 2]} intensity={1.15} />
            <Grid args={[10, 10]} cellColor="#334" sectionColor="#556" fadeDistance={20} />
            <RobotCsvScene
              key={`${file.path}:${urdfFile.path}`}
              csvUrl={api.storageFileUrl(file.path)}
              urdfPath={urdfFile.path}
              packageRoot={packageRoot}
              fpsHint={file.fps}
              durationHint={file.duration_sec}
              time={time}
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
      </div>
      {note ? <div className="muted animation-format-note">{note}</div> : null}
    </div>
  );
}
