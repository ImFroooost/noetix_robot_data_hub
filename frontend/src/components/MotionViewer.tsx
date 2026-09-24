import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Line } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import URDFLoader from "urdf-loader";
import { api, fetchJsonAuth } from "../api";
import { BvhScene, FbxScene } from "./AnimationFormatPreview";
import { useViewerLook, ViewerSceneChrome } from "./ViewerSceneChrome";
import {
  cycleUpAxisMode,
  detectUpAxisFromJointFrames,
  resolveUpAxis,
  upAxisModeLabel,
  upAxisToRotationX,
  useUpAxisMode,
  type UpAxis,
} from "../viewerUpAxis";
import {
  cycleLengthUnitMode,
  lengthUnitModeLabel,
  useLengthUnitMode,
  type LengthUnit,
  type LengthUnitMode,
} from "../viewerUnits";
import type { Clip, HumanFile, RobotFile, RobotModel, RobotStage } from "../types";
import {
  STAGE_LABEL,
  isPlayableHumanFormat,
  isPlayableRobotFormat,
  processStatusLabel,
} from "../types";

interface Props {
  clip: Clip;
  robotModels: RobotModel[];
  /** 锁定只看某个人体文件（Tab 工作区用） */
  humanFileId?: number;
  /** 锁定某个机器人文件 */
  robotFileId?: number;
  /** 不显示机器人 */
  hideRobot?: boolean;
  /** 紧凑控件（小高度） */
  compact?: boolean;
  /** 大预览高度（对齐 Motion Eval ~560px） */
  tall?: boolean;
  /** 隐藏文件选择下拉，只保留播放条 */
  controlsOnly?: boolean;
}

type HumanPreview = {
  positions?: number[][];
  joints?: string[];
  frames?: number[][];
  joint_names?: string[];
  pose_preview?: number[][];
  fps?: number;
  frame_count?: number;
  type?: string;
};

type RobotPreview = {
  frames?: number[][];
  joint_names?: string[];
  fps?: number;
  frame_count?: number;
};

function timeToFrame(t: number, fps: number, frameCount: number) {
  if (!fps || !frameCount) return 0;
  const idx = Math.floor(t * fps);
  return Math.min(Math.max(idx, 0), frameCount - 1);
}

function PathTrail({ positions }: { positions: number[][] }) {
  const look = useViewerLook();
  const points = useMemo(
    () => positions.map((p) => new THREE.Vector3(p[0] * 0.01, p[1] * 0.01, (p[2] ?? 0) * 0.01)),
    [positions]
  );
  if (points.length < 2) return null;
  return <Line points={points} color={look.trail} lineWidth={2} />;
}

function JointDots({
  frames,
  fps,
  time,
}: {
  frames: number[][];
  fps: number;
  time: number;
}) {
  const look = useViewerLook();
  const idx = timeToFrame(time, fps, frames.length);
  const vals = frames[idx] || [];
  const pts = [];
  for (let i = 0; i + 2 < Math.min(vals.length, 60); i += 3) {
    pts.push(
      <mesh key={i} position={[vals[i] * 0.01, vals[i + 1] * 0.01, vals[i + 2] * 0.01]}>
        <sphereGeometry args={[0.03, 12, 12]} />
        <meshStandardMaterial color={look.joint} />
      </mesh>
    );
  }
  // if not XYZ triplets, show as 2D strip
  if (pts.length === 0 && vals.length > 0) {
    for (let i = 0; i < Math.min(vals.length, 24); i++) {
      pts.push(
        <mesh key={i} position={[i * 0.08 - 1, vals[i] * 0.2, 0]}>
          <boxGeometry args={[0.05, 0.05, 0.05]} />
          <meshStandardMaterial color={look.marker} />
        </mesh>
      );
    }
  }
  return <group>{pts}</group>;
}

function UrdfRobot({
  model,
  preview,
  time,
}: {
  model: RobotModel;
  preview: RobotPreview | null;
  time: number;
}) {
  const robotRef = useRef<any>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const loader = new URDFLoader();
    const packageUrl = api.mediaUrl(model.package_path).replace(/\/?$/, "/");
    const urdfDir = model.urdf_path.includes("/")
      ? model.urdf_path.slice(0, model.urdf_path.lastIndexOf("/") + 1)
      : "";
    (loader as any).workingPath = api.mediaUrl(urdfDir);
    loader.packages = {
      "": packageUrl,
      package: packageUrl,
    };
    loader.load(
      api.mediaUrl(model.urdf_path),
      (robot) => {
        if (cancelled) return;
        robotRef.current = robot;
        setReady(true);
      },
      undefined,
      console.error
    );
    return () => {
      cancelled = true;
    };
  }, [model.id, model.urdf_path, model.package_path]);

  useFrame(() => {
    const robot = robotRef.current;
    if (!robot || !preview?.frames?.length) return;
    const fps = preview.fps || 30;
    const idx = timeToFrame(time, fps, preview.frames.length);
    const vals = preview.frames[idx];
    const names =
      preview.joint_names && preview.joint_names.length
        ? preview.joint_names
        : model.joint_names || Object.keys(robot.joints || {});
    names.forEach((name, i) => {
      if (vals[i] == null) return;
      try {
        robot.setJointValue?.(name, vals[i]);
      } catch {
        /* joint missing */
      }
    });
  });

  if (!ready || !robotRef.current) return null;
  return (
    <group>
      <primitive object={robotRef.current} />
    </group>
  );
}

function SceneContent({
  humanFile,
  humanPreview,
  robotFile,
  robotPreview,
  robotModel,
  time,
  duration,
  rotationX,
  unitMode,
  onMediaDuration,
  onDetectedUpAxis,
  onDetectedLengthUnit,
}: {
  humanFile: HumanFile | null;
  humanPreview: HumanPreview | null;
  robotFile: RobotFile | null;
  robotPreview: RobotPreview | null;
  robotModel: RobotModel | null;
  time: number;
  duration: number;
  rotationX: number;
  unitMode: LengthUnitMode;
  onMediaDuration?: (sec: number) => void;
  onDetectedUpAxis?: (up: UpAxis) => void;
  onDetectedLengthUnit?: (unit: LengthUnit) => void;
}) {
  const fmt = (humanFile?.format || "").toLowerCase();
  const humanIsBvh = fmt === "bvh";
  const humanIsFbx = fmt === "fbx";
  const humanIsSmpl = fmt === "smpl";
  const robotPlayable = isPlayableRobotFormat(robotFile?.format);
  const showRobot =
    robotPlayable && Boolean(robotModel || robotPreview?.frames?.length);
  const showHuman = Boolean(humanFile && (humanIsBvh || humanIsFbx || humanIsSmpl));
  // 仅人体时居中；人机同屏时左右分列
  const humanX = showHuman && showRobot ? -1.2 : 0;
  const robotX = showHuman && showRobot ? 1.2 : 0;

  useEffect(() => {
    if (humanIsBvh || humanIsFbx) return;
    const humanFrames = humanPreview?.pose_preview || humanPreview?.frames;
    if (humanFrames?.length) {
      onDetectedUpAxis?.(detectUpAxisFromJointFrames(humanFrames));
      return;
    }
    if (robotPreview?.frames?.length) {
      onDetectedUpAxis?.(detectUpAxisFromJointFrames(robotPreview.frames));
      return;
    }
    if (robotModel) onDetectedUpAxis?.("z");
  }, [humanIsBvh, humanIsFbx, humanPreview, robotPreview, robotModel, onDetectedUpAxis]);

  return (
    <>
      <ViewerSceneChrome />
      <group position={[humanX, 0, 0]}>
        {humanIsBvh && humanFile && (
          <BvhScene
            url={api.fileUrl("human", humanFile.id)}
            time={time}
            duration={duration}
            onDuration={onMediaDuration}
            rotationX={rotationX}
            unitMode={unitMode}
            onDetectedUpAxis={onDetectedUpAxis}
            onDetectedLengthUnit={onDetectedLengthUnit}
          />
        )}
        {humanIsFbx && humanFile && (
          <FbxScene
            url={api.fileUrl("human", humanFile.id)}
            time={time}
            onDuration={onMediaDuration}
            rotationX={rotationX}
            unitMode={unitMode}
            onDetectedUpAxis={onDetectedUpAxis}
            onDetectedLengthUnit={onDetectedLengthUnit}
          />
        )}
        {humanIsSmpl && humanPreview?.pose_preview && (
          <group rotation={[rotationX, 0, 0]}>
            <JointDots
              frames={humanPreview.pose_preview}
              fps={humanPreview.fps || humanFile?.fps || 30}
              time={time}
            />
          </group>
        )}
        {humanIsSmpl && humanPreview?.frames && (
          <group rotation={[rotationX, 0, 0]}>
            <JointDots
              frames={humanPreview.frames}
              fps={humanPreview.fps || humanFile?.fps || 30}
              time={time}
            />
          </group>
        )}
      </group>
      <group position={[robotX, 0, 0]}>
        {robotPlayable && robotModel && (
          <group rotation={[rotationX, 0, 0]}>
            <UrdfRobot
              model={robotModel}
              preview={robotPreview}
              time={time}
            />
          </group>
        )}
        {robotPlayable && !robotModel && robotPreview?.frames && (
          <group rotation={[rotationX, 0, 0]}>
            <JointDots
              frames={robotPreview.frames}
              fps={robotPreview.fps || robotFile?.fps || 30}
              time={time}
            />
          </group>
        )}
      </group>
      <OrbitControls makeDefault />
    </>
  );
}

export function MotionViewer({
  clip,
  robotModels,
  humanFileId,
  robotFileId,
  hideRobot = false,
  compact = false,
  tall = false,
  controlsOnly = false,
}: Props) {
  const humanFiles = clip.human_files.filter((f) => isPlayableHumanFormat(f.format));
  const robotFiles = hideRobot
    ? []
    : clip.robot_files.filter((f) => isPlayableRobotFormat(f.format));
  const lockedRobot = robotFiles.find((f) => f.id === robotFileId) || null;
  const initialHuman =
    (humanFileId != null && humanFiles.some((f) => f.id === humanFileId)
      ? humanFileId
      : null) ??
    humanFiles[0]?.id ??
    0;
  const [humanId, setHumanId] = useState(initialHuman);
  const [stage, setStage] = useState<RobotStage | "">(
    (lockedRobot?.stage as RobotStage) || (robotFiles[0]?.stage as RobotStage) || ""
  );
  const [robotModelId, setRobotModelId] = useState(
    lockedRobot?.robot_model_id ?? robotFiles[0]?.robot_model_id ?? 0
  );
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [humanPreview, setHumanPreview] = useState<HumanPreview | null>(null);
  const [robotPreview, setRobotPreview] = useState<RobotPreview | null>(null);
  /** BVH/FBX 解析出的真实时长（元数据未写入时也能播完） */
  const [mediaDuration, setMediaDuration] = useState(0);
  const [upAxisMode, setUpAxisMode] = useUpAxisMode();
  const [detectedUp, setDetectedUp] = useState<UpAxis>("y");
  const [unitMode, setUnitMode] = useLengthUnitMode();
  const [detectedUnit, setDetectedUnit] = useState<LengthUnit>("m");
  const rotationX = upAxisToRotationX(resolveUpAxis(upAxisMode, detectedUp));

  const lockedHuman = humanFileId != null;
  const lockedRobotSelect = robotFileId != null;
  const hideFileSelects =
    controlsOnly || (lockedHuman && (hideRobot || lockedRobotSelect));

  useEffect(() => {
    if (humanFileId != null && humanFiles.some((f) => f.id === humanFileId)) {
      setHumanId(humanFileId);
    } else if (!humanFiles.some((f) => f.id === humanId)) {
      setHumanId(humanFiles[0]?.id ?? 0);
    }
  }, [humanFileId, humanFiles.map((f) => f.id).join(",")]);

  useEffect(() => {
    if (lockedRobot) {
      setRobotModelId(lockedRobot.robot_model_id);
      setStage(lockedRobot.stage as RobotStage);
    }
  }, [lockedRobot?.id]);

  // Tab 切换：回到起点并播放
  useEffect(() => {
    setTime(0);
    setPlaying(true);
    setMediaDuration(0);
    setDetectedUp("y");
    setDetectedUnit("m");
    setUpAxisMode("auto");
    setUnitMode("auto");
  }, [humanFileId, robotFileId, humanId]);

  const humanFile =
    humanFiles.find((f) => f.id === humanId) ||
    (humanFileId != null
      ? clip.human_files.find(
          (f) => f.id === humanFileId && isPlayableHumanFormat(f.format)
        ) || null
      : null);
  const robotFile = hideRobot
    ? null
    : lockedRobot ||
      robotFiles.find(
        (f) => f.robot_model_id === robotModelId && (!stage || f.stage === stage)
      ) ||
      robotFiles.find((f) => f.robot_model_id === robotModelId) ||
      null;
  const robotModel = robotModels.find((m) => m.id === (robotFile?.robot_model_id || robotModelId)) || null;
  const canVisualize = Boolean(humanFile || robotFile);

  const duration = useMemo(() => {
    const fromMeta = [
      clip.duration_sec || 0,
      humanFile?.fps && humanFile.frame_count ? humanFile.frame_count / humanFile.fps : 0,
      robotFile?.fps && robotFile.frame_count ? robotFile.frame_count / robotFile.fps : 0,
      mediaDuration || 0,
    ];
    return Math.max(...fromMeta, 0.001);
  }, [clip.duration_sec, humanFile, robotFile, mediaDuration]);

  useEffect(() => {
    if (!humanFile || !isPlayableHumanFormat(humanFile.format)) {
      setHumanPreview(null);
      return;
    }
    // bvh/fbx 走原始文件加载，无需 preview JSON；smpl 需要 pose_preview
    if ((humanFile.format || "").toLowerCase() !== "smpl") {
      setHumanPreview(null);
      return;
    }
    fetchJsonAuth(api.previewUrl("human", humanFile.id))
      .then(setHumanPreview)
      .catch(() => setHumanPreview(null));
  }, [humanFile?.id, humanFile?.format]);

  useEffect(() => {
    if (!robotFile || !isPlayableRobotFormat(robotFile.format)) {
      setRobotPreview(null);
      return;
    }
    fetchJsonAuth(api.previewUrl("robot", robotFile.id))
      .then(setRobotPreview)
      .catch(() => setRobotPreview(null));
  }, [robotFile?.id, robotFile?.format]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = ((now - last) / 1000) * speed;
      last = now;
      setTime((t) => {
        const next = t + dt;
        return next > duration ? 0 : next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration, speed]);

  const stages = Array.from(new Set(robotFiles.map((f) => f.stage)));
  const modelIds = Array.from(new Set(robotFiles.map((f) => f.robot_model_id)));
  const fps =
    humanFile?.fps ||
    robotFile?.fps ||
    humanPreview?.fps ||
    robotPreview?.fps ||
    30;
  const stepFrame = (dir: 1 | -1) => {
    setPlaying(false);
    setTime((t) => {
      const next = t + dir / fps;
      if (next < 0) return 0;
      if (next > duration) return duration;
      return next;
    });
  };

  const panelClass = [
    "viewer-panel",
    compact ? "viewer-panel-compact" : "",
    tall ? "viewer-panel-tall" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (!canVisualize) {
    return (
      <div className="muted" style={{ padding: "1rem 0.25rem" }}>
        无可视化数据（人体仅 bvh / fbx / smpl，机器人仅 csv）。
      </div>
    );
  }

  return (
    <div className="stack motion-viewer">
      {!hideFileSelects && (
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          {!lockedHuman && !!humanFiles.length && (
            <label style={{ minWidth: compact ? 120 : 160 }}>
              人体版本
              <select
                value={humanId}
                onChange={(e) => setHumanId(Number(e.target.value))}
              >
                {humanFiles.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.format}/{f.label || "v1"}
                    {f.fps ? `（${f.fps}fps）` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!hideRobot && !lockedRobotSelect && !!robotFiles.length && (
            <>
              <label style={{ minWidth: compact ? 120 : 160 }}>
                机器人型号
                <select
                  value={robotModelId}
                  onChange={(e) => setRobotModelId(Number(e.target.value))}
                >
                  {modelIds.map((id) => {
                    const m = robotModels.find((x) => x.id === id);
                    return (
                      <option key={id} value={id}>
                        {m?.name || id}
                      </option>
                    );
                  })}
                  {!modelIds.length && <option value={0}>无</option>}
                </select>
              </label>
              <label style={{ minWidth: compact ? 120 : 160 }}>
                数据阶段
                <select value={stage} onChange={(e) => setStage(e.target.value as RobotStage)}>
                  {stages.map((s) => (
                    <option key={s} value={s}>
                      {STAGE_LABEL[s]}
                    </option>
                  ))}
                  {!stages.length && <option value="">无</option>}
                </select>
              </label>
            </>
          )}
        </div>
      )}

      <div className={panelClass}>
        <Canvas
          camera={{ position: [2.5, 2, 3.5], fov: 50 }}
          style={{ width: "100%", height: "100%", display: "block" }}
          resize={{ debounce: 0 }}
          gl={{ antialias: true, alpha: false }}
        >
          <SceneContent
            humanFile={humanFile}
            humanPreview={humanPreview}
            robotFile={robotFile}
            robotPreview={robotPreview}
            robotModel={robotModel}
            time={time}
            duration={duration}
            rotationX={rotationX}
            unitMode={unitMode}
            onMediaDuration={setMediaDuration}
            onDetectedUpAxis={setDetectedUp}
            onDetectedLengthUnit={setDetectedUnit}
          />
        </Canvas>
      </div>

      <div className="playback-controls">
        <button
          type="button"
          className="play-button"
          onClick={() => setPlaying((p) => !p)}
          title={playing ? "暂停" : "播放"}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => stepFrame(1)}
          title="下一帧"
        >
          ⏭
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
          onChange={(e) => {
            setPlaying(false);
            setTime(Number(e.target.value));
          }}
        />
        <select
          className="speed-select"
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
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
          title="切换坐标系方向：自动识别 / Y-up / Z-up"
          onClick={() => setUpAxisMode(cycleUpAxisMode(upAxisMode))}
        >
          {upAxisModeLabel(upAxisMode, detectedUp)}
        </button>
        <button
          type="button"
          className="follow-root-toggle secondary"
          title="切换长度单位：自动识别 / 米 / 厘米 / 毫米"
          onClick={() => setUnitMode(cycleLengthUnitMode(unitMode))}
        >
          {lengthUnitModeLabel(unitMode, detectedUnit)}
        </button>
      </div>

      {!compact && !controlsOnly && (
        <div className="muted" style={{ fontSize: "0.85rem" }}>
          人体：
          {humanFile
            ? `${humanFile.format}/${humanFile.label || "v1"} / ${processStatusLabel(humanFile.process_status)}`
            : "无"}
          ；机器人：
          {robotFile
            ? `${robotFile.robot_model_name || robotModel?.name} / ${STAGE_LABEL[robotFile.stage]} / ${robotFile.label || "v1"} / ${processStatusLabel(robotFile.process_status)}`
            : "无"}
          {humanFile?.process_message && `；警告：${humanFile.process_message}`}
          {robotFile?.process_message && `；警告：${robotFile.process_message}`}
        </div>
      )}
    </div>
  );
}
