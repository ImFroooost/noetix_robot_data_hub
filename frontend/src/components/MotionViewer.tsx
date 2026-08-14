import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Grid, Html, Line } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { BVHLoader } from "three/examples/jsm/loaders/BVHLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import URDFLoader from "urdf-loader";
import { api, fetchJsonAuth, getToken } from "../api";
import type { Clip, HumanFile, RobotFile, RobotModel, RobotStage } from "../types";
import {
  STAGE_LABEL,
  isPlayableHumanFormat,
  isPlayableRobotFormat,
  processStatusLabel,
} from "../types";

const _bvhHips = new THREE.Vector3();
const _bvhBox = new THREE.Box3();
const _bvhPt = new THREE.Vector3();

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
  const points = useMemo(
    () => positions.map((p) => new THREE.Vector3(p[0] * 0.01, p[1] * 0.01, (p[2] ?? 0) * 0.01)),
    [positions]
  );
  if (points.length < 2) return null;
  return <Line points={points} color="#6cb2ff" lineWidth={2} />;
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
  const idx = timeToFrame(time, fps, frames.length);
  const vals = frames[idx] || [];
  const pts = [];
  for (let i = 0; i + 2 < Math.min(vals.length, 60); i += 3) {
    pts.push(
      <mesh key={i} position={[vals[i] * 0.01, vals[i + 1] * 0.01, vals[i + 2] * 0.01]}>
        <sphereGeometry args={[0.03, 12, 12]} />
        <meshStandardMaterial color="#ffb454" />
      </mesh>
    );
  }
  // if not XYZ triplets, show as 2D strip
  if (pts.length === 0 && vals.length > 0) {
    for (let i = 0; i < Math.min(vals.length, 24); i++) {
      pts.push(
        <mesh key={i} position={[i * 0.08 - 1, vals[i] * 0.2, 0]}>
          <boxGeometry args={[0.05, 0.05, 0.05]} />
          <meshStandardMaterial color="#7dd3fc" />
        </mesh>
      );
    }
  }
  return <group>{pts}</group>;
}

/**
 * Three.js SkeletonHelper 会把 matrix 绑到 root.matrixWorld，且假定自身父节点
 * 世界矩阵为单位阵。若挂到带 scale/offset 的父节点下，会双重变换导致骨架消失。
 * 因此 helper 必须 scene.add，骨骼则放在缩放/居中组里。
 */
function BvhScene({
  url,
  time,
  duration,
  onDuration,
}: {
  url: string;
  time: number;
  duration: number;
  onDuration?: (sec: number) => void;
}) {
  const { scene } = useThree();
  const centerRef = useRef<THREE.Group>(null);
  const boneRootRef = useRef<THREE.Bone | null>(null);
  const helperRef = useRef<THREE.SkeletonHelper | null>(null);
  const mixer = useRef<THREE.AnimationMixer | null>(null);
  const action = useRef<THREE.AnimationAction | null>(null);
  /** 只计算一次的固定偏移：保留根节点位移，避免每帧钉死髋部 */
  const fixedOffset = useRef(new THREE.Vector3());
  const offsetReady = useRef(false);
  const onDurationRef = useRef(onDuration);
  onDurationRef.current = onDuration;
  const [boneRoot, setBoneRoot] = useState<THREE.Bone | null>(null);
  const [scale, setScale] = useState(0.01);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError("");
    setBoneRoot(null);
    boneRootRef.current = null;
    mixer.current = null;
    action.current = null;
    offsetReady.current = false;
    fixedOffset.current.set(0, 0, 0);
    if (helperRef.current) {
      scene.remove(helperRef.current);
      helperRef.current.geometry.dispose();
      (helperRef.current.material as THREE.Material).dispose();
      helperRef.current = null;
    }

    const loader = new BVHLoader();
    const token = getToken();
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(async (r) => {
        if (!r.ok) throw new Error(`BVH 下载失败（${r.status}）`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        if (cancelled) return;
        const text = new TextDecoder().decode(buf);
        if (!/HIERARCHY/i.test(text) || !/MOTION/i.test(text)) {
          throw new Error("不是有效的 BVH 文件");
        }
        const result = loader.parse(text);
        const bone0 = result.skeleton?.bones?.[0];
        if (!bone0) throw new Error("BVH 中没有骨骼根节点");

        // 在尚未挂到缩放节点前采样（原始单位），再换算到米制偏移。
        // 若等挂载后再用世界坐标采样，容易把「厘米位移」当成「米」导致人物飞出视野。
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
        let maxHeight = 0;
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
            maxHeight = Math.max(maxHeight, _bvhBox.max.y - _bvhBox.min.y);
          }
        }
        const meanX = samples ? sumX / samples : 0;
        const meanZ = samples ? sumZ / samples : 0;
        if (!Number.isFinite(minY)) minY = 0;
        // 身高 > 8 视为厘米单位
        const nextScale = maxHeight > 8 ? 0.01 : 1;
        // center 在 scale 组之外：world ≈ scale * raw + offset
        fixedOffset.current.set(
          -meanX * nextScale,
          -minY * nextScale,
          -meanZ * nextScale
        );
        offsetReady.current = true;

        // 关节点小球：Line 在部分环境下偏淡时仍能看见
        const jointGeo = new THREE.SphereGeometry(2.2, 10, 10);
        const jointMat = new THREE.MeshStandardMaterial({
          color: 0xffb454,
          emissive: 0x663300,
          roughness: 0.55,
        });
        bone0.traverse((obj) => {
          if (!(obj as THREE.Bone).isBone) return;
          const dot = new THREE.Mesh(jointGeo, jointMat);
          dot.name = "__bvh_joint_dot";
          obj.add(dot);
        });

        const helper = new THREE.SkeletonHelper(bone0);
        const mat = helper.material as THREE.LineBasicMaterial;
        mat.depthTest = false;
        mat.depthWrite = false;
        mat.transparent = true;
        mat.opacity = 1;
        helper.frustumCulled = false;
        // 必须挂到 scene 根，不能挂到带 scale 的父节点
        scene.add(helper);
        helperRef.current = helper;

        boneRootRef.current = bone0;
        mixer.current = probeMixer;
        action.current = probeAction;
        if (clipDur > 0) onDurationRef.current?.(clipDur);
        setScale(nextScale);
        setBoneRoot(bone0);
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
        scene.remove(helperRef.current);
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
  }, [url, scene]);

  useFrame(() => {
    const center = centerRef.current;
    if (!mixer.current || !action.current || !center) return;

    const clipDur = action.current.getClip().duration || duration || 1;
    action.current.time = Math.min(Math.max(time, 0), clipDur);
    mixer.current.update(0);
    // 固定偏移：轨迹居中 + 贴地，同时保留根节点相对位移
    if (offsetReady.current) {
      center.position.copy(fixedOffset.current);
    }
  });

  return (
    <group>
      <group ref={centerRef}>
        {boneRoot && (
          <group scale={scale}>
            <primitive object={boneRoot} />
          </group>
        )}
      </group>
      {status === "loading" && (
        <Html center style={{ pointerEvents: "none" }}>
          <div
            className="muted"
            style={{ whiteSpace: "nowrap", background: "#0b0d12cc", padding: "6px 10px" }}
          >
            BVH 加载中…
          </div>
        </Html>
      )}
      {status === "error" && (
        <Html center style={{ pointerEvents: "none" }}>
          <div
            className="error"
            style={{ whiteSpace: "nowrap", background: "#0b0d12cc", padding: "6px 10px" }}
          >
            {error || "BVH 可视化失败"}
          </div>
        </Html>
      )}
    </group>
  );
}

function FbxScene({
  url,
  time,
  onDuration,
}: {
  url: string;
  time: number;
  onDuration?: (sec: number) => void;
}) {
  const root = useRef<THREE.Group>(null);
  const mixer = useRef<THREE.AnimationMixer | null>(null);
  const action = useRef<THREE.AnimationAction | null>(null);
  const onDurationRef = useRef(onDuration);
  onDurationRef.current = onDuration;

  useEffect(() => {
    let cancelled = false;
    const loader = new FBXLoader();
    const token = getToken();
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (cancelled) return;
        const obj = loader.parse(buf, "");
        obj.scale.setScalar(0.01);
        if (root.current) {
          root.current.clear();
          root.current.add(obj);
        }
        if (obj.animations?.length) {
          mixer.current = new THREE.AnimationMixer(obj);
          action.current = mixer.current.clipAction(obj.animations[0]);
          action.current.play();
          action.current.paused = true;
          const dur = obj.animations[0].duration || 0;
          if (dur > 0) onDurationRef.current?.(dur);
        }
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [url]);

  useFrame(() => {
    if (!mixer.current || !action.current) return;
    const clipDur = action.current.getClip().duration || 1;
    action.current.time = Math.min(time, clipDur);
    mixer.current.update(0);
  });

  return <group ref={root} />;
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
        robot.rotation.x = -Math.PI / 2;
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
  return <primitive object={robotRef.current} />;
}

function SceneContent({
  humanFile,
  humanPreview,
  robotFile,
  robotPreview,
  robotModel,
  time,
  duration,
  onMediaDuration,
}: {
  humanFile: HumanFile | null;
  humanPreview: HumanPreview | null;
  robotFile: RobotFile | null;
  robotPreview: RobotPreview | null;
  robotModel: RobotModel | null;
  time: number;
  duration: number;
  onMediaDuration?: (sec: number) => void;
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
  return (
    <>
      <ambientLight intensity={0.7} />
      <directionalLight position={[3, 5, 2]} intensity={1.1} />
      <Grid args={[10, 10]} cellColor="#334" sectionColor="#556" fadeDistance={20} />
      <group position={[humanX, 0, 0]}>
        {humanIsBvh && humanFile && (
          <BvhScene
            url={api.fileUrl("human", humanFile.id)}
            time={time}
            duration={duration}
            onDuration={onMediaDuration}
          />
        )}
        {humanIsFbx && humanFile && (
          <FbxScene
            url={api.fileUrl("human", humanFile.id)}
            time={time}
            onDuration={onMediaDuration}
          />
        )}
        {humanIsSmpl && humanPreview?.pose_preview && (
          <JointDots
            frames={humanPreview.pose_preview}
            fps={humanPreview.fps || humanFile?.fps || 30}
            time={time}
          />
        )}
        {humanIsSmpl && humanPreview?.frames && (
          <JointDots
            frames={humanPreview.frames}
            fps={humanPreview.fps || humanFile?.fps || 30}
            time={time}
          />
        )}
      </group>
      <group position={[robotX, 0, 0]}>
        {robotPlayable && robotModel && (
          <UrdfRobot model={robotModel} preview={robotPreview} time={time} />
        )}
        {robotPlayable && !robotModel && robotPreview?.frames && (
          <JointDots
            frames={robotPreview.frames}
            fps={robotPreview.fps || robotFile?.fps || 30}
            time={time}
          />
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
        <Canvas camera={{ position: [2.5, 2, 3.5], fov: 50 }}>
          <color attach="background" args={["#0b0d12"]} />
          <SceneContent
            humanFile={humanFile}
            humanPreview={humanPreview}
            robotFile={robotFile}
            robotPreview={robotPreview}
            robotModel={robotModel}
            time={time}
            duration={duration}
            onMediaDuration={setMediaDuration}
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
