import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import { api, fetchJsonAuth } from "../api";
import type { ModelInstance, StorageFile } from "../types";
import {
  DEFAULT_HUMAN_MODEL,
  resolveHumanModelFile,
  resolveHumanModelName,
} from "./HumanModelFields";
import { useViewerLook, ViewerSceneChrome } from "./ViewerSceneChrome";
import {
  cycleUpAxisMode,
  detectUpAxisFromExtents,
  upAxisModeLabel,
  upAxisToRotationX,
  useUpAxisMode,
  type UpAxis,
  type UpAxisMode,
} from "../viewerUpAxis";

/**
 * SMPL / SMPL-X / SMPL-H 动作骨架播放。
 * 用标准 SMPL 24 关节运动树做正向运动学（FK），把轴角姿态转成关节世界坐标画骨架。
 * 不需要官方身体模型（蒙皮网格才需要），动作形态清晰可见。
 */

// SMPL 24 关节的父节点（运动树）
const PARENTS = [
  -1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 12, 12, 13, 14, 16, 17, 18, 19, 20, 21,
];

// 各关节相对父节点的静止偏移（T-pose，米，Y 轴向上，手臂沿 ±X 展开）
const REST_OFFSET: [number, number, number][] = [
  [0, 0, 0], // 0 Pelvis（根，位置由 trans 决定）
  [0.065, -0.08, 0], // 1 L_Hip
  [-0.065, -0.08, 0], // 2 R_Hip
  [0, 0.1, 0], // 3 Spine1
  [0.01, -0.37, 0], // 4 L_Knee
  [-0.01, -0.37, 0], // 5 R_Knee
  [0, 0.1, 0], // 6 Spine2
  [0, -0.39, 0], // 7 L_Ankle
  [0, -0.39, 0], // 8 R_Ankle
  [0, 0.11, 0], // 9 Spine3
  [0, -0.06, 0.1], // 10 L_Foot
  [0, -0.06, 0.1], // 11 R_Foot
  [0, 0.12, 0], // 12 Neck
  [0.09, 0.1, 0], // 13 L_Collar
  [-0.09, 0.1, 0], // 14 R_Collar
  [0, 0.1, 0], // 15 Head
  [0.08, 0.05, 0], // 16 L_Shoulder
  [-0.08, 0.05, 0], // 17 R_Shoulder
  [0.28, 0, 0], // 18 L_Elbow
  [-0.28, 0, 0], // 19 R_Elbow
  [0.25, 0, 0], // 20 L_Wrist
  [-0.25, 0, 0], // 21 R_Wrist
  [0.07, 0, 0], // 22 L_Hand
  [-0.07, 0, 0], // 23 R_Hand
];

const JOINT_COUNT = PARENTS.length;
const BONES: [number, number][] = PARENTS.map((p, i) => [p, i] as [number, number]).filter(
  ([p]) => p >= 0
);

const _quat = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _scale = new THREE.Vector3(1, 1, 1);
const _frameQuats = Array.from({ length: JOINT_COUNT }, () => new THREE.Quaternion());

export type { UpAxis, UpAxisMode };
export { useUpAxisMode };

/** 自动识别：采样多帧，看「头 − 双脚中点」连线主要沿哪个轴，那就是竖直方向。 */
function detectUpAxis(motion: SmplMotion): UpAxis {
  const positions = Array.from({ length: JOINT_COUNT }, () => new THREE.Vector3());
  const frameCount = motion.poses.length;
  const n = Math.min(24, frameCount);
  if (!n) return "y";
  let absY = 0;
  let absZ = 0;
  let midY = 0;
  let midZ = 0;
  for (let i = 0; i < n; i++) {
    const f = Math.min(Math.floor((i / Math.max(n - 1, 1)) * (frameCount - 1)), frameCount - 1);
    computeFrame(motion, f, positions);
    const head = positions[15];
    const feetY = (positions[7].y + positions[8].y) / 2;
    const feetZ = (positions[7].z + positions[8].z) / 2;
    const dy = head.y - feetY;
    const dz = head.z - feetZ;
    absY += Math.abs(dy);
    absZ += Math.abs(dz);
    midY += dy;
    midZ += dz;
  }
  return detectUpAxisFromExtents(absY, absZ, midY, midZ);
}

export type SmplMotion = {
  poses: number[][];
  trans?: number[][];
  fps: number;
  frame_count: number;
};

type SmplBody = {
  vertices: number[][];
  faces: number[][];
  weights?: number[][] | null;
  joints?: number[][] | null;
};

const _local = new THREE.Matrix4();
const _invRest = new THREE.Matrix4();
const _worldMats = Array.from({ length: JOINT_COUNT }, () => new THREE.Matrix4());
const _skinMats = Array.from({ length: JOINT_COUNT }, () => new THREE.Matrix4());

function restJointsOf(body?: SmplBody | null): THREE.Vector3[] | null {
  if (!body?.joints?.length) return null;
  return body.joints.slice(0, JOINT_COUNT).map((item) =>
    new THREE.Vector3(item[0] || 0, item[1] || 0, item[2] || 0)
  );
}

function poseToQuat(pose: number[], index: number, target: THREE.Quaternion) {
  const a = pose[index * 3] || 0;
  const b = pose[index * 3 + 1] || 0;
  const c = pose[index * 3 + 2] || 0;
  const angle = Math.sqrt(a * a + b * b + c * c);
  if (angle > 1e-8) {
    _axis.set(a / angle, b / angle, c / angle);
    target.setFromAxisAngle(_axis, angle);
  } else {
    target.identity();
  }
}

function computeSkinMatrices(
  motion: SmplMotion,
  frame: number,
  restJoints: THREE.Vector3[]
) {
  const pose = motion.poses[frame] || [];
  for (let i = 0; i < JOINT_COUNT; i++) {
    poseToQuat(pose, i, _quat);
    const parent = PARENTS[i];
    const rest = restJoints[i] || _offset.set(0, 0, 0);
    if (parent < 0) {
      _local.compose(rest, _quat, _scale);
      _worldMats[i].copy(_local);
    } else {
      const parentRest = restJoints[parent];
      _offset.copy(rest);
      if (parentRest) _offset.sub(parentRest);
      _local.compose(_offset, _quat, _scale);
      _worldMats[i].multiplyMatrices(_worldMats[parent], _local);
    }
    _invRest.makeTranslation(
      -(restJoints[i]?.x || 0),
      -(restJoints[i]?.y || 0),
      -(restJoints[i]?.z || 0)
    );
    _skinMats[i].multiplyMatrices(_worldMats[i], _invRest);
  }
  return _skinMats;
}

type Vec3Array = THREE.Vector3[];

/** 计算某一帧所有关节的世界坐标，写进 outPos。 */
function computeFrame(motion: SmplMotion, frame: number, outPos: Vec3Array) {
  const pose = motion.poses[frame] || [];
  const trans = motion.trans?.[frame];
  for (let i = 0; i < JOINT_COUNT; i++) {
    const a = pose[i * 3] || 0;
    const b = pose[i * 3 + 1] || 0;
    const c = pose[i * 3 + 2] || 0;
    const angle = Math.sqrt(a * a + b * b + c * c);
    if (angle > 1e-8) {
      _axis.set(a / angle, b / angle, c / angle);
      _quat.setFromAxisAngle(_axis, angle);
    } else {
      _quat.identity();
    }
    const parent = PARENTS[i];
    if (parent < 0) {
      _frameQuats[i].copy(_quat);
      outPos[i].set(
        (trans?.[0] ?? 0) + REST_OFFSET[0][0],
        (trans?.[1] ?? 0) + REST_OFFSET[0][1],
        (trans?.[2] ?? 0) + REST_OFFSET[0][2]
      );
      continue;
    }
    _frameQuats[i].copy(_frameQuats[parent]).multiply(_quat);
    _offset.set(...REST_OFFSET[i]).applyQuaternion(_frameQuats[parent]);
    outPos[i].copy(outPos[parent]).add(_offset);
  }
}

/** 依据当前关节坐标把相机对准骨架（复位视角 / 载入后）。 */
function FrameSmpl({
  positionsRef,
  ready,
  nonce,
  rotationX,
}: {
  positionsRef: RefObject<Vec3Array>;
  ready: boolean;
  nonce: number;
  rotationX: number;
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree((s) => s.controls) as
    | { target: THREE.Vector3; update: () => void }
    | undefined;
  const framed = useRef(-1);
  const waits = useRef(0);
  const box = useMemo(() => new THREE.Box3(), []);
  const size = useMemo(() => new THREE.Vector3(), []);
  const center = useMemo(() => new THREE.Vector3(), []);
  const rot = useMemo(() => new THREE.Quaternion(), []);
  const tmp = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    framed.current = -1;
    waits.current = 0;
  }, [nonce, ready, rotationX]);

  useFrame(() => {
    if (!ready || framed.current === nonce) return;
    const positions = positionsRef.current;
    if (!positions?.length) return;
    waits.current += 1;
    if (waits.current < 3) return;
    rot.setFromAxisAngle(_axis.set(1, 0, 0), rotationX);
    box.makeEmpty();
    positions.forEach((p) => box.expandByPoint(tmp.copy(p).applyQuaternion(rot)));
    if (box.isEmpty()) return;
    box.getSize(size);
    if (size.length() < 1e-4) return;
    box.getCenter(center);
    const radius = Math.max(size.length() * 0.5, 0.3);
    const fov = ((camera.fov || 50) * Math.PI) / 180;
    const dist = (radius / Math.max(Math.sin(fov / 2), 1e-4)) * 1.2;
    camera.position.set(center.x + dist * 0.7, center.y + dist * 0.4, center.z + dist * 0.9);
    camera.near = Math.max(dist / 400, 0.01);
    camera.far = Math.max(dist * 80, 80);
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    if (controls) {
      controls.target.copy(center);
      controls.update();
    }
    framed.current = nonce;
  });

  return null;
}

function SmplFigure({
  motion,
  time,
  positionsRef,
  rotationX,
  visible = true,
}: {
  motion: SmplMotion;
  time: number;
  positionsRef: RefObject<Vec3Array>;
  rotationX: number;
  visible?: boolean;
}) {
  const look = useViewerLook();
  const frameCount = motion.poses.length;
  const fps = motion.fps || 30;

  const jointPositions = useMemo(
    () => Array.from({ length: JOINT_COUNT }, () => new THREE.Vector3()),
    []
  );
  const lineGeom = useMemo(() => new THREE.BufferGeometry(), []);
  const lineObj = useMemo(() => {
    const mat = new THREE.LineBasicMaterial({
      color: look.bone,
      depthTest: false,
      depthWrite: false,
    });
    const obj = new THREE.LineSegments(lineGeom, mat);
    obj.frustumCulled = false;
    return obj;
  }, [lineGeom, look.bone]);
  const dotsRef = useRef<THREE.InstancedMesh>(null);
  const dotMatrix = useMemo(() => new THREE.Matrix4(), []);

  useEffect(() => {
    (positionsRef as { current?: Vec3Array }).current = jointPositions;
  }, [jointPositions, positionsRef]);

  useEffect(() => {
    return () => {
      lineGeom.dispose();
      (lineObj.material as THREE.Material).dispose();
    };
  }, [lineGeom, lineObj]);

  useEffect(() => {
    (lineObj.material as THREE.LineBasicMaterial).color.set(look.bone);
  }, [look.bone, lineObj]);

  useFrame(() => {
    if (!frameCount) return;
    const idx = Math.min(Math.max(Math.floor(time * fps), 0), frameCount - 1);
    computeFrame(motion, idx, jointPositions);

    const positions: number[] = [];
    for (const [p, i] of BONES) {
      const a = jointPositions[p];
      const b = jointPositions[i];
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    lineGeom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    lineGeom.computeBoundingSphere();

    const dots = dotsRef.current;
    if (dots) {
      for (let i = 0; i < JOINT_COUNT; i++) {
        dotMatrix.makeTranslation(jointPositions[i].x, jointPositions[i].y, jointPositions[i].z);
        dots.setMatrixAt(i, dotMatrix);
      }
      dots.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group rotation={[rotationX, 0, 0]} visible={visible}>
      <primitive object={lineObj} />
      <instancedMesh ref={dotsRef} args={[undefined, undefined, JOINT_COUNT]} frustumCulled={false}>
        <sphereGeometry args={[0.022, 10, 10]} />
        <meshBasicMaterial color={look.joint} />
      </instancedMesh>
    </group>
  );
}

function SmplBodyMesh({
  motion,
  body,
  time,
  rotationX,
}: {
  motion: SmplMotion;
  body: SmplBody;
  time: number;
  rotationX: number;
}) {
  const rest = useMemo(() => {
    const arr = new Float32Array(body.vertices.length * 3);
    body.vertices.forEach((item, index) => {
      arr[index * 3] = item[0] || 0;
      arr[index * 3 + 1] = item[1] || 0;
      arr[index * 3 + 2] = item[2] || 0;
    });
    return arr;
  }, [body.vertices]);
  const faces = useMemo(() => body.faces.flat(), [body.faces]);
  const weightJointCount = body.weights?.[0]?.length || 0;
  const weights = useMemo(() => {
    if (!body.weights?.length) return null;
    const arr = new Float32Array(body.weights.length * weightJointCount);
    body.weights.forEach((row, index) => {
      for (let j = 0; j < weightJointCount; j++) arr[index * weightJointCount + j] = row[j] || 0;
    });
    return arr;
  }, [body.weights, weightJointCount]);
  const restJoints = useMemo(() => restJointsOf(body), [body]);
  const geometry = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(rest.slice(), 3));
    geom.setIndex(faces);
    geom.computeVertexNormals();
    return geom;
  }, [faces, rest]);
  const canSkin = Boolean(weights && restJoints && restJoints.length >= 2);

  useEffect(() => {
    return () => geometry.dispose();
  }, [geometry]);

  useFrame(() => {
    const attr = geometry.getAttribute("position") as THREE.BufferAttribute;
    const out = attr.array as Float32Array;
    const frameCount = motion.poses.length;
    if (!frameCount) return;
    const idx = Math.min(Math.max(Math.floor(time * (motion.fps || 30)), 0), frameCount - 1);
    const trans = motion.trans?.[idx];
    if (canSkin && weights && restJoints) {
      const mats = computeSkinMatrices(motion, idx, restJoints);
      const used = Math.min(JOINT_COUNT, weightJointCount);
      for (let v = 0; v < rest.length / 3; v++) {
        const rx = rest[v * 3];
        const ry = rest[v * 3 + 1];
        const rz = rest[v * 3 + 2];
        let x = 0;
        let y = 0;
        let z = 0;
        for (let j = 0; j < used; j++) {
          const w = weights[v * weightJointCount + j];
          if (!w) continue;
          const e = mats[j].elements;
          x += w * (e[0] * rx + e[4] * ry + e[8] * rz + e[12]);
          y += w * (e[1] * rx + e[5] * ry + e[9] * rz + e[13]);
          z += w * (e[2] * rx + e[6] * ry + e[10] * rz + e[14]);
        }
        out[v * 3] = x + (trans?.[0] || 0);
        out[v * 3 + 1] = y + (trans?.[1] || 0);
        out[v * 3 + 2] = z + (trans?.[2] || 0);
      }
    } else {
      const pose = motion.poses[idx] || [];
      poseToQuat(pose, 0, _quat);
      for (let v = 0; v < rest.length / 3; v++) {
        _offset.set(rest[v * 3], rest[v * 3 + 1], rest[v * 3 + 2]).applyQuaternion(_quat);
        out[v * 3] = _offset.x + (trans?.[0] || 0);
        out[v * 3 + 1] = _offset.y + (trans?.[1] || 0);
        out[v * 3 + 2] = _offset.z + (trans?.[2] || 0);
      }
    }
    attr.needsUpdate = true;
    geometry.computeVertexNormals();
  });

  return (
    <mesh geometry={geometry} rotation={[rotationX, 0, 0]} frustumCulled={false}>
      <meshStandardMaterial color="#d8b4a0" roughness={0.65} metalness={0.02} />
    </mesh>
  );
}

function SmplScene({
  url,
  modelUrl,
  time,
  viewNonce,
  upAxisMode,
  onDuration,
  onStatus,
  onDetectedUpAxis,
}: {
  url: string;
  modelUrl?: string;
  time: number;
  viewNonce: number;
  upAxisMode: UpAxisMode;
  onDuration?: (sec: number) => void;
  onStatus?: (status: "loading" | "ready" | "error", message?: string) => void;
  onDetectedUpAxis?: (up: UpAxis) => void;
}) {
  const [motion, setMotion] = useState<SmplMotion | null>(null);
  const [body, setBody] = useState<SmplBody | null>(null);
  const [error, setError] = useState("");
  const [detected, setDetected] = useState<UpAxis>("y");
  const positionsRef = useRef<Vec3Array>([]);
  const onDurationRef = useRef(onDuration);
  onDurationRef.current = onDuration;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const onDetectedRef = useRef(onDetectedUpAxis);
  onDetectedRef.current = onDetectedUpAxis;

  useEffect(() => {
    let cancelled = false;
    setMotion(null);
    setError("");
    onStatusRef.current?.("loading");
    fetchJsonAuth(url)
      .then((data) => {
        if (cancelled) return;
        const m = data as SmplMotion;
        if (!m.poses?.length) {
          setError("SMPL 动作数据为空");
          onStatusRef.current?.("error", "SMPL 动作数据为空");
          return;
        }
        const up = detectUpAxis(m);
        setDetected(up);
        onDetectedRef.current?.(up);
        setMotion(m);
        onStatusRef.current?.("ready");
        if (m.frame_count && m.fps) onDurationRef.current?.(m.frame_count / m.fps);
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "SMPL 加载失败";
        setError(msg);
        onStatusRef.current?.("error", msg);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    let cancelled = false;
    setBody(null);
    if (!modelUrl) return;
    fetchJsonAuth(modelUrl)
      .then((data) => {
        if (cancelled) return;
        const next = data as SmplBody;
        if (!next.vertices?.length || !next.faces?.length) return;
        setBody(next);
      })
      .catch(() => {
        if (!cancelled) setBody(null);
      });
    return () => {
      cancelled = true;
    };
  }, [modelUrl]);

  const effectiveUp: UpAxis = upAxisMode === "auto" ? detected : upAxisMode;
  const rotationX = upAxisToRotationX(effectiveUp);

  return (
    <group>
      {motion && body && (
        <SmplBodyMesh motion={motion} body={body} time={time} rotationX={rotationX} />
      )}
      {motion && (
        <SmplFigure
          motion={motion}
          time={time}
          positionsRef={positionsRef}
          rotationX={rotationX}
          visible={!body}
        />
      )}
      <FrameSmpl positionsRef={positionsRef} ready={!!motion} nonce={viewNonce} rotationX={rotationX} />
      {!motion && !error && (
        <Html center style={{ pointerEvents: "none" }}>
          <div className="muted animation-format-status">SMPL 加载中…</div>
        </Html>
      )}
      {error && (
        <Html center style={{ pointerEvents: "none" }}>
          <div className="error animation-format-status">{error}</div>
        </Html>
      )}
    </group>
  );
}

/** 完整 SMPL 动作预览（画布 + 播放条），用于存储页同屏预览。 */
export function SmplPreview({ file }: { file: StorageFile }) {
  const url = api.storageSmplMotionUrl(file.path);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [duration, setDuration] = useState(0);
  const [viewNonce, setViewNonce] = useState(0);
  const [upAxisMode, setUpAxisMode] = useUpAxisMode();
  const [detectedUp, setDetectedUp] = useState<UpAxis>("y");
  const [instances, setInstances] = useState<ModelInstance[]>([]);
  const savedModel = resolveHumanModelName(file.annotation?.human_model);
  const savedModelFile = String(file.annotation?.human_model_file || "");
  const [modelName, setModelName] = useState(savedModel);
  const [modelFilePath, setModelFilePath] = useState(savedModelFile);

  useEffect(() => {
    let cancelled = false;
    api
      .storageModels()
      .then((data) => {
        if (!cancelled) setInstances(data.instances.filter((item) => item.ontology === "human"));
      })
      .catch(() => {
        if (!cancelled) setInstances([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setModelName(savedModel);
    setModelFilePath(savedModelFile);
  }, [file.path, savedModel, savedModelFile]);

  const instance = modelName
    ? instances.find((item) => item.name === modelName) ||
      instances.find((item) => item.name === DEFAULT_HUMAN_MODEL)
    : undefined;
  const modelFile = resolveHumanModelFile(instance, modelFilePath);
  const modelUrl = modelFile ? api.smplModelUrl(modelFile.path) : "";

  useEffect(() => {
    setTime(0);
    setPlaying(true);
    setDuration(0);
  }, [url, modelUrl]);

  useEffect(() => {
    setUpAxisMode("auto");
  }, [file.path]);

  const upAxisLabel = upAxisModeLabel(upAxisMode, detectedUp);
  const cycleUpAxis = () => {
    setUpAxisMode(cycleUpAxisMode(upAxisMode));
    setViewNonce((n) => n + 1);
  };

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
        <Canvas
          key={`${url}:${modelUrl}`}
          camera={{ position: [2.4, 1.8, 3.2], fov: 50 }}
          style={{ width: "100%", height: "100%", display: "block" }}
          resize={{ debounce: 0 }}
          gl={{ antialias: true, alpha: false }}
        >
          <ViewerSceneChrome hemisphere />
          <SmplScene
            url={url}
            modelUrl={modelUrl || undefined}
            time={time}
            viewNonce={viewNonce}
            upAxisMode={upAxisMode}
            onDuration={setDuration}
            onDetectedUpAxis={setDetectedUp}
          />
          <OrbitControls makeDefault />
        </Canvas>
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
        <select
          className="speed-select"
          value={modelName}
          title="选择 3D 模型中的人体实例"
          onChange={(event) => {
            const next = event.target.value;
            const nextFiles = instances.find((item) => item.name === next);
            const only = nextFiles
              ? resolveHumanModelFile(nextFiles, "")
              : undefined;
            setModelName(next);
            setModelFilePath(only?.relative_path || "");
            setViewNonce((n) => n + 1);
          }}
        >
          <option value="">仅骨架</option>
          {[
            ...new Set([DEFAULT_HUMAN_MODEL, ...instances.map((item) => item.name)]),
          ].map((name) => (
            <option key={name} value={name}>
              {name === DEFAULT_HUMAN_MODEL ? `${name}（默认）` : name}
            </option>
          ))}
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
          onClick={cycleUpAxis}
        >
          {upAxisLabel}
        </button>
      </div>
      <div className="muted animation-format-note">
        {modelFile
          ? `人体模型：${instance?.name || modelName}${modelFile.name !== (instance?.name || modelName) ? ` / ${modelFile.name}` : ""}`
          : modelName
            ? `正在加载人体模型 ${modelName}…`
            : "当前显示骨架"}
      </div>
    </div>
  );
}
