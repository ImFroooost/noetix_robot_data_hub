import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { api } from "../api";
import { fetchAuth } from "../utils/repoMesh";
import { DataOriginAxes, FrameFigure, ViewerSceneChrome } from "./ViewerSceneChrome";
import { NameToggleButtons, SceneNameLabels, useNameFlags } from "./NameLabels";
import { upAxisToRotationX } from "../viewerUpAxis";
import { useReportPlayback } from "../playbackClock";
import { faceMeshOutward } from "../utils/faceOutward";

type SceneBody = {
  id: string;
  kind: "rigid" | "marker";
  geometry: THREE.BufferGeometry | null;
  edges: THREE.BufferGeometry | null;
  /** 模型上写的默认位姿，XML 单独打开时用，不读轨迹。 */
  rest: [number, number, number, number, number, number, number];
};

type SceneClip = {
  fps: number;
  bodies: SceneBody[];
  /** frames × bodies × 7: x y z qx qy qz qw */
  poses: Float32Array;
  frames: number;
};

const _quat = new THREE.Quaternion();
const _wood = new THREE.MeshStandardMaterial({
  color: 0xd7b98a,
  roughness: 0.55,
  metalness: 0.04,
  emissive: 0x4a3218,
  emissiveIntensity: 0.28,
  side: THREE.FrontSide,
  // XML 只有 8 个共享顶点，光滑法线会把棱照成圆弧。按面着色才是长方体。
  flatShading: true,
});
const _edge = new THREE.LineBasicMaterial({ color: 0xfff3df });
const _marker = new THREE.MeshStandardMaterial({
  color: 0xffd43b,
  roughness: 0.4,
  metalness: 0.05,
  emissive: 0x8a6a10,
  emissiveIntensity: 0.35,
});

function num(value: string | null): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSceneXml(text: string): { fps: number; bodies: SceneBody[] } {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("物体 XML 无法解析");
  const scene = doc.querySelector("scene");
  const fps = num(scene?.getAttribute("fps") || "") || 30;
  const bodies: SceneBody[] = [];
  scene?.querySelectorAll(":scope > body").forEach((body) => {
    const id = body.getAttribute("id") || body.getAttribute("name") || "";
    if (!id) return;
    const kind = body.getAttribute("kind") === "marker" ? "marker" : "rigid";
    const rest: SceneBody["rest"] = body.hasAttribute("x")
      ? [
          num(body.getAttribute("x")),
          num(body.getAttribute("y")),
          num(body.getAttribute("z")),
          num(body.getAttribute("qx")),
          num(body.getAttribute("qy")),
          num(body.getAttribute("qz")),
          num(body.getAttribute("qw")) || 1,
        ]
      : [0, 0, 0, 0, 0, 0, 1];
    const vertices = [...body.querySelectorAll("vertices > v")].map(
      (node) => [num(node.getAttribute("x")), num(node.getAttribute("y")), num(node.getAttribute("z"))] as const
    );
    const faces = [...body.querySelectorAll("faces > f")].map(
      (node) => [num(node.getAttribute("a")), num(node.getAttribute("b")), num(node.getAttribute("c"))] as const
    );
    let geometry: THREE.BufferGeometry | null = null;
    let edges: THREE.BufferGeometry | null = null;
    if (vertices.length >= 3 && faces.length) {
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices.flat(), 3));
      geometry.setIndex(faces.flat());
      faceMeshOutward(geometry);
      const flat = geometry.toNonIndexed();
      flat.computeVertexNormals();
      geometry.dispose();
      geometry = flat;
      edges = new THREE.EdgesGeometry(geometry, 15);
    }
    bodies.push({ id, kind, geometry, edges, rest });
  });
  if (!bodies.length) throw new Error("物体 XML 里没有刚体或 marker");
  return { fps, bodies };
}

function parseSceneCsv(text: string, bodies: SceneBody[]): { poses: Float32Array; frames: number } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const header = (lines.shift() || "").split(",").map((item) => item.trim());
  const columns = bodies.map((body) => {
    const start = header.indexOf(`${body.id}_x`);
    if (start < 0 || header[start + 6] !== `${body.id}_qw`) {
      throw new Error(`物体 CSV 缺少 ${body.id} 的位姿列`);
    }
    return start;
  });
  const frames = lines.length;
  const poses = new Float32Array(frames * bodies.length * 7);
  lines.forEach((line, frame) => {
    const cells = line.split(",");
    columns.forEach((start, body) => {
      const offset = (frame * bodies.length + body) * 7;
      for (let axis = 0; axis < 7; axis += 1) poses[offset + axis] = Number(cells[start + axis]) || 0;
    });
  });
  if (!frames) throw new Error("物体 CSV 没有位姿帧");
  return { poses, frames };
}

function BodyView({ body }: { body: SceneBody }) {
  if (body.kind === "marker" || !body.geometry) {
    return (
      <mesh material={_marker} castShadow>
        <sphereGeometry args={[body.kind === "marker" ? 0.015 : 0.04, 12, 10]} />
      </mesh>
    );
  }
  return (
    <mesh geometry={body.geometry} material={_wood} castShadow receiveShadow>
      {body.edges ? <lineSegments geometry={body.edges} material={_edge} /> : null}
    </mesh>
  );
}

/** 物体 XML + CSV，与机器人骨架在同一个 Z-up 世界里，不再相对 root 摆放。 */
function restClip(parsed: { fps: number; bodies: SceneBody[] }): SceneClip {
  const poses = new Float32Array(parsed.bodies.length * 7);
  parsed.bodies.forEach((body, index) => poses.set(body.rest, index * 7));
  return { fps: 1, bodies: parsed.bodies, poses, frames: 1 };
}

export function SceneObjectLayer({
  xmlUrl,
  csvUrl = "",
  time,
  onReady,
  onDuration,
}: {
  xmlUrl: string;
  csvUrl?: string;
  time: number;
  onReady?: () => void;
  onDuration?: (seconds: number, fps?: number) => void;
}) {
  const groups = useRef<(THREE.Group | null)[]>([]);
  const clip = useRef<SceneClip | null>(null);
  const onReadyRef = useRef(onReady);
  const onDurationRef = useRef(onDuration);
  onReadyRef.current = onReady;
  onDurationRef.current = onDuration;
  const timeRef = useRef(time);
  timeRef.current = time;
  const [bodies, setBodies] = useState<SceneBody[]>([]);

  useEffect(() => {
    let cancelled = false;
    clip.current = null;
    setBodies([]);
    const xmlTask = fetchAuth(xmlUrl, { cache: "no-cache" }).then((res) => res.text());
    const csvTask = csvUrl
      ? fetchAuth(csvUrl, { cache: "no-cache" }).then((res) => res.text())
      : Promise.resolve("");
    Promise.all([xmlTask, csvTask])
      .then(([xmlText, csvText]) => {
        const parsed = parseSceneXml(xmlText);
        if (cancelled) {
          parsed.bodies.forEach((body) => {
            body.geometry?.dispose();
            body.edges?.dispose();
          });
          return;
        }
        if (csvText) {
          const table = parseSceneCsv(csvText, parsed.bodies);
          clip.current = { fps: parsed.fps, bodies: parsed.bodies, poses: table.poses, frames: table.frames };
          onDurationRef.current?.(table.frames / Math.max(parsed.fps, 1), parsed.fps);
        } else {
          clip.current = restClip(parsed);
          onDurationRef.current?.(0);
        }
        setBodies(parsed.bodies);
        onReadyRef.current?.();
      })
      .catch((err: unknown) => {
        console.error("[preview] 物体数据加载失败", err);
      });
    return () => {
      cancelled = true;
      clip.current?.bodies.forEach((body) => {
        body.geometry?.dispose();
        body.edges?.dispose();
      });
      clip.current = null;
    };
  }, [xmlUrl, csvUrl]);

  useFrame(() => {
    const current = clip.current;
    if (!current) return;
    const frame = Math.min(Math.max(Math.floor(timeRef.current * current.fps), 0), current.frames - 1);
    current.bodies.forEach((_body, index) => {
      const group = groups.current[index];
      if (!group) return;
      const offset = (frame * current.bodies.length + index) * 7;
      const pose = current.poses;
      group.position.set(pose[offset], pose[offset + 1], pose[offset + 2]);
      _quat.set(pose[offset + 3], pose[offset + 4], pose[offset + 5], pose[offset + 6]).normalize();
      group.quaternion.copy(_quat);
    });
  });

  if (!bodies.length) return null;
  return (
    <>
      {bodies.map((body, index) => (
        <group
          key={body.id}
          name={body.id}
          userData={{ nameKind: body.kind }}
          ref={(node) => {
            groups.current[index] = node;
          }}
        >
          <BodyView body={body} />
        </group>
      ))}
    </>
  );
}

const OBJECT_ROTATION_X = upAxisToRotationX("z");

/** 只看物体：XML 是模型，CSV 才叠轨迹。不画机器人。 */
export function ObjectScenePreview({
  xmlPath,
  csvPath = "",
}: {
  xmlPath: string;
  csvPath?: string;
}) {
  const [names] = useNameFlags();
  const moving = Boolean(csvPath);
  const [time, setTime] = useState(0);
  const [fps, setFps] = useState(30);
  useReportPlayback(time, moving ? fps : 0);
  const [playing, setPlaying] = useState(moving);
  const [speed, setSpeed] = useState(1);
  const [duration, setDuration] = useState(0);
  const [viewNonce, setViewNonce] = useState(0);
  const figureRef = useRef<THREE.Group | null>(null);
  const [labelRoot, setLabelRoot] = useState<THREE.Group | null>(null);

  useEffect(() => {
    setTime(0);
    setPlaying(moving);
    setDuration(0);
  }, [xmlPath, csvPath, moving]);

  useEffect(() => {
    if (!playing || !moving) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = ((now - last) / 1000) * speed;
      last = now;
      setTime((current) => {
        const next = current + dt;
        return duration > 0 && next > duration ? 0 : next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration, speed, moving]);

  return (
    <div className="animation-format-preview" onClick={(event) => event.stopPropagation()}>
      <div className="viewer-panel animation-format-canvas">
        <Canvas
          camera={{ position: [2.4, 1.6, 3.2], fov: 50 }}
          style={{ width: "100%", height: "100%", display: "block" }}
          resize={{ debounce: 0 }}
          gl={{ antialias: true, alpha: false }}
        >
          <ViewerSceneChrome />
          <group
            ref={(node) => {
              figureRef.current = node;
              setLabelRoot((current) => (current === node ? current : node));
            }}
            rotation={[OBJECT_ROTATION_X, 0, 0]}
          >
            <DataOriginAxes length={1.2} />
            <SceneObjectLayer
              xmlUrl={xmlPath.startsWith("blob:") ? xmlPath : api.storageFileUrl(xmlPath)}
              csvUrl={csvPath ? (csvPath.startsWith("blob:") ? csvPath : api.storageFileUrl(csvPath)) : ""}
              time={time}
              onDuration={(seconds, nextFps) => {
                setDuration(seconds);
                if (nextFps && nextFps > 0) setFps(nextFps);
              }}
              onReady={() => setViewNonce((value) => value + 1)}
            />
            <SceneNameLabels root={labelRoot} names={names} />
          </group>
          <FrameFigure objectRef={figureRef} ready resetKey={`${xmlPath}:${csvPath}`} nonce={viewNonce} />
          <OrbitControls makeDefault />
        </Canvas>
      </div>
      {moving ? (
        <div className="playback-controls animation-format-controls">
          <button type="button" className="play-button" onClick={() => setPlaying((current) => !current)} title={playing ? "暂停" : "播放"}>
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
            max={duration || 1}
            step={0.01}
            value={Math.min(time, duration || 1)}
            onChange={(event) => {
              setPlaying(false);
              setTime(Number(event.target.value));
            }}
          />
          <select className="speed-select" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} title="倍速">
            <option value={0.5}>0.5×</option>
            <option value={1}>1×</option>
            <option value={1.5}>1.5×</option>
            <option value={2}>2×</option>
          </select>
          <button type="button" className="follow-root-toggle secondary" onClick={() => setViewNonce((value) => value + 1)}>
            复位视角
          </button>
          <span className="follow-root-toggle secondary is-static" title="物体模型和轨迹，不显示机器人">
            物体轨迹
          </span>
          <NameToggleButtons />
        </div>
      ) : (
        <div className="playback-controls animation-format-controls">
          <button type="button" className="follow-root-toggle secondary" onClick={() => setViewNonce((value) => value + 1)}>
            复位视角
          </button>
          <span className="follow-root-toggle secondary is-static" title="只显示 XML 里的模型，不读取轨迹">
            模型·无轨迹
          </span>
          <NameToggleButtons />
        </div>
      )}
    </div>
  );
}

export function robotObjectPaths(file: { path?: string; ontology?: string; format?: string; annotation?: { motion_kind?: string } | null }): {
  xml: string;
  csv: string;
} | null {
  const path = (file.path || "").replace(/\\/g, "/");
  if (file.ontology !== "robot" || !path.includes("/object/")) return null;
  const fmt = (file.format || "").toLowerCase();
  if (path.includes("/object/xml/") || fmt === "xml") {
    return { xml: path, csv: "" };
  }
  if (path.includes("/object/csv/") || (fmt === "csv" && file.annotation?.motion_kind === "object")) {
    return {
      xml: path.replace("/object/csv/", "/object/xml/").replace(/\.csv$/i, ".xml"),
      csv: path,
    };
  }
  return null;
}
