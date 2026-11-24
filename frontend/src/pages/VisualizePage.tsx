import { useEffect, useRef, useState } from "react";
import { unzipSync } from "fflate";
import { api, getToken } from "../api";
import type { ModelInstance, MotionKind, StorageFile } from "../types";
import { AnimationFormatPreview } from "../components/AnimationFormatPreview";
import { ObjectScenePreview } from "../components/SceneObjectLayer";
import { RobotCsvPreview } from "../components/RobotCsvPreview";
import { RobotHoiNpzPreview } from "../components/RobotHoiNpzPreview";
import { RobotMergedZipPreview } from "../components/RobotMergedZipPreview";
import { SmplPreview } from "../components/SmplSkeleton";
import { npzMeta, parseNpz } from "../utils/npz";
import { PlaybackClockProvider } from "../playbackClock";
import { SyncedRaw } from "../components/SyncedRaw";
import { SplitHandle, clampPane, useStoredNumber } from "../components/SplitHandle";

type Ontology = "human" | "robot";

type Choice = {
  ontology: Ontology;
  modality: "motion" | "video" | "audio" | "text" | "image";
  motionKind?: MotionKind;
  format: string;
};

type Kind =
  | "human-bvh"
  | "human-fbx"
  | "human-csv"
  | "human-smpl"
  | "robot-csv"
  | "robot-object-xml"
  | "robot-object-csv"
  | "robot-merged-fbx"
  | "robot-merged-npz"
  | "robot-merged-zip"
  | "video"
  | "audio"
  | "image"
  | "text";

type Prepared = {
  title: string;
  kind: Kind;
  file: StorageFile;
  sources?: { csvUrl: string; objectXmlUrl: string; objectCsvUrl: string };
  motionUrl?: string;
  mediaUrl?: string;
  text?: string;
  sourceFiles: File[];
};

const HUMAN_ROWS: { label: string; modality: Choice["modality"]; motionKind?: MotionKind; formats: string[] }[] = [
  { label: "骨架数据", modality: "motion", motionKind: "skeleton", formats: ["bvh", "csv", "fbx", "smpl"] },
  { label: "合并数据", modality: "motion", motionKind: "merged", formats: ["fbx"] },
  { label: "视频", modality: "video", formats: ["mp4"] },
  { label: "音频", modality: "audio", formats: ["wav"] },
  { label: "文本", modality: "text", formats: ["txt"] },
  { label: "图片", modality: "image", formats: ["png"] },
];

const ROBOT_ROWS: typeof HUMAN_ROWS = [
  { label: "骨架数据", modality: "motion", motionKind: "skeleton", formats: ["csv"] },
  { label: "物体数据", modality: "motion", motionKind: "object", formats: ["csv", "xml"] },
  { label: "合并数据", modality: "motion", motionKind: "merged", formats: ["fbx", "npz", "zip"] },
  { label: "视频", modality: "video", formats: ["mp4"] },
  { label: "音频", modality: "audio", formats: ["wav"] },
  { label: "文本", modality: "text", formats: ["txt"] },
  { label: "图片", modality: "image", formats: ["png"] },
];

const EXT: Record<string, string[]> = {
  bvh: ["bvh"],
  csv: ["csv"],
  fbx: ["fbx"],
  smpl: ["npz"],
  npz: ["npz"],
  zip: ["zip"],
  xml: ["xml"],
  mp4: ["mp4", "webm", "mov"],
  wav: ["wav", "mp3", "ogg"],
  txt: ["txt", "json", "log", "md"],
  png: ["png", "jpg", "jpeg", "webp", "gif"],
};

function choiceKey(choice: Choice) {
  return `${choice.ontology}|${choice.motionKind || choice.modality}|${choice.format}`;
}

function extOf(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".fbx.zst")) return "fbx";
  return lower.split(".").pop() || "";
}

function blobOf(file: File) {
  return URL.createObjectURL(file);
}

function localFile(file: File, ontology: Ontology, format: string, motionKind: MotionKind | undefined, style: string): StorageFile {
  return {
    id: `local:${file.name}:${file.size}`,
    path: blobOf(file),
    name: file.name,
    unit_name: "本地文件",
    size: file.size,
    modified_at: new Date(file.lastModified).toISOString(),
    ontology,
    modality: "motion",
    channel: "",
    format,
    batch: "",
    robot_style: style,
    uploader: null,
    annotation: {
      motion_kind: motionKind,
      robot_style: style,
      world_frame: ontology === "robot" && motionKind === "merged" ? "capture_z_up" : undefined,
      fps: 30,
    },
  };
}

async function readText(file: File, limit = 8000) {
  return (await file.slice(0, limit).text()).replace(/^\uFEFF/, "");
}

function csvKind(text: string): "object" | "robot" | "text" {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const header = lines[0] || "";
  if (/time_s/i.test(header) && /_qx/i.test(header)) return "object";
  const numeric = lines.filter((line) => !line.startsWith("#") && line.split(",").every((item) => item.trim() !== "" && !Number.isNaN(Number(item))));
  if (numeric.length && numeric[0].split(",").length >= 7) return "robot";
  return "text";
}

async function isRobotFbx(file: File) {
  const head = (await file.slice(0, 2_000_000).text()).toLowerCase();
  const capture = /rigid[\s_-]*body|rigidbody|unlabeled[\s_-]*\d|skeleton_\d|marker[\s_-]*\d/.test(head);
  const robot =
    head.includes("base_link") &&
    (head.includes("obstacle") || /l_leg_|r_leg_|hip_pitch|ankle_roll/.test(head));
  return robot && !capture;
}

async function isHubHoi(file: File) {
  try {
    const arrays = parseNpz(await file.arrayBuffer());
    if (!arrays.meta) return false;
    return npzMeta(arrays).format === "hub-hoi";
  } catch {
    return false;
  }
}

async function isMergedZip(file: File) {
  try {
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const names = Object.keys(entries).map((item) => item.replace(/\\/g, "/").toLowerCase());
    return names.some((item) => item.startsWith("skeleton/") && item.endsWith(".csv")) && names.some((item) => item.startsWith("object/") && item.endsWith(".xml"));
  } catch {
    return false;
  }
}

function kindTitle(kind: Kind) {
  const labels: Record<Kind, string> = {
    "human-bvh": "人体 · 骨架数据 · bvh",
    "human-fbx": "人体 · FBX",
    "human-csv": "人体 · 骨架数据 · csv",
    "human-smpl": "人体 · 骨架数据 · smpl",
    "robot-csv": "机器人 · 骨架数据 · csv",
    "robot-object-xml": "机器人 · 物体数据 · xml",
    "robot-object-csv": "机器人 · 物体数据 · csv",
    "robot-merged-fbx": "机器人 · 合并数据 · fbx",
    "robot-merged-npz": "机器人 · 合并数据 · npz",
    "robot-merged-zip": "机器人 · 合并数据 · zip",
    video: "视频",
    audio: "音频",
    image: "图片",
    text: "文本",
  };
  return labels[kind];
}

function choiceToKind(choice: Choice): Kind {
  if (choice.modality === "video") return "video";
  if (choice.modality === "audio") return "audio";
  if (choice.modality === "image") return "image";
  if (choice.modality === "text") return "text";
  if (choice.ontology === "human" && choice.format === "bvh") return "human-bvh";
  if (choice.ontology === "human" && choice.format === "csv") return "human-csv";
  if (choice.ontology === "human" && choice.format === "smpl") return "human-smpl";
  if (choice.ontology === "human" && choice.format === "fbx") return "human-fbx";
  if (choice.ontology === "robot" && choice.motionKind === "object" && choice.format === "xml") return "robot-object-xml";
  if (choice.ontology === "robot" && choice.motionKind === "object") return "robot-object-csv";
  if (choice.ontology === "robot" && choice.motionKind === "merged" && choice.format === "fbx") return "robot-merged-fbx";
  if (choice.ontology === "robot" && choice.motionKind === "merged" && choice.format === "npz") return "robot-merged-npz";
  if (choice.ontology === "robot" && choice.motionKind === "merged" && choice.format === "zip") return "robot-merged-zip";
  return "robot-csv";
}

async function pickAuto(list: File[]): Promise<{ file: File; kind: Kind }> {
  for (const file of list) {
    const ext = extOf(file.name);
    if (ext === "zip" && (await isMergedZip(file))) return { file, kind: "robot-merged-zip" };
    if (ext === "npz" && (await isHubHoi(file))) return { file, kind: "robot-merged-npz" };
    if (ext === "fbx" && file.name.toLowerCase().endsWith(".fbx.zst")) return { file, kind: "human-fbx" };
    if (ext === "fbx" && (await isRobotFbx(file))) return { file, kind: "robot-merged-fbx" };
    if (ext === "bvh") return { file, kind: "human-bvh" };
    if (ext === "fbx") return { file, kind: "human-fbx" };
    if (ext === "npz") return { file, kind: "human-smpl" };
  }
  let skeleton: File | undefined;
  let objectCsv: File | undefined;
  for (const file of list) {
    if (extOf(file.name) !== "csv") continue;
    const kind = csvKind(await readText(file));
    if (kind === "robot" && !skeleton) skeleton = file;
    if (kind === "object") objectCsv = file;
  }
  const xml = list.find((file) => extOf(file.name) === "xml");
  if (skeleton) return { file: skeleton, kind: "robot-csv" };
  if (objectCsv) return { file: objectCsv, kind: "robot-object-csv" };
  if (xml) return { file: xml, kind: "robot-object-xml" };
  return { file: list[0], kind: await detectKind(list[0]) };
}

async function detectKind(file: File): Promise<Kind> {
  const ext = extOf(file.name);
  if (ext === "bvh") return "human-bvh";
  if (ext === "fbx") {
    if (file.name.toLowerCase().endsWith(".fbx.zst")) return "human-fbx";
    return (await isRobotFbx(file)) ? "robot-merged-fbx" : "human-fbx";
  }
  if (ext === "xml") return "robot-object-xml";
  if (ext === "zip") return (await isMergedZip(file)) ? "robot-merged-zip" : "text";
  if (ext === "npz") return (await isHubHoi(file)) ? "robot-merged-npz" : "human-smpl";
  if (EXT.png.includes(ext)) return "image";
  if (EXT.mp4.includes(ext)) return "video";
  if (EXT.wav.includes(ext)) return "audio";
  if (ext === "csv") {
    const kind = csvKind(await readText(file));
    if (kind === "object") return "robot-object-csv";
    if (kind === "robot") return "robot-csv";
    return "human-csv";
  }
  return "text";
}

function matchesChoice(file: File, choice: Choice) {
  return (EXT[choice.format] || [choice.format]).includes(extOf(file.name));
}

async function uploadSmpl(file: File) {
  const token = getToken();
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/storage/smpl-motion", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail || "SMPL 解析失败");
  }
  const json = await res.json();
  return URL.createObjectURL(new Blob([JSON.stringify(json)], { type: "application/json" }));
}

export function VisualizePage() {
  const [styles, setStyles] = useState<string[]>([]);
  const [style, setStyle] = useState("noetix_e2");
  const [choice, setChoice] = useState<Choice | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<Prepared | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const typesRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const held = useRef<{ xml?: File; objectCsv?: File }>({});
  const urls = useRef<string[]>([]);
  const [typeWidth, setTypeWidth] = useStoredNumber("viz-type-width", 420);
  const [humanHeight, setHumanHeight] = useStoredNumber("viz-human-height", 300);
  const [rawHeight, setRawHeight] = useStoredNumber("viz-raw-height", 240);

  useEffect(() => {
    let cancelled = false;
    api
      .storageModels({ quiet: true })
      .then((data) => {
        if (cancelled) return;
        const names = data.instances
          .filter((item: ModelInstance) => item.ontology === "robot")
          .map((item) => item.name);
        setStyles(names);
        setStyle((current) => (names.includes(current) ? current : names[0] || current));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => urls.current.forEach((url) => URL.revokeObjectURL(url)), []);

  const remember = (url: string) => {
    urls.current.push(url);
    return url;
  };

  const openFiles = async (list: File[]) => {
    if (!list.length) return;
    setLoading(true);
    setError("");
    try {
      urls.current.forEach((url) => URL.revokeObjectURL(url));
      urls.current = [];
      const xml = list.find((file) => extOf(file.name) === "xml");
      const csvs = list.filter((file) => extOf(file.name) === "csv");
      if (xml) held.current.xml = xml;
      for (const csv of csvs) {
        if (csvKind(await readText(csv)) === "object") held.current.objectCsv = csv;
      }
      let primary = list[0];
      let kind: Kind;
      if (choice) {
        primary = list.find((file) => matchesChoice(file, choice)) || list[0];
        if (!matchesChoice(primary, choice)) {
          throw new Error(`当前选择的是 ${choice.format}，拖入的是 ${primary.name}`);
        }
        kind = choiceToKind(choice);
      } else {
        const picked = await pickAuto(list);
        primary = picked.file;
        kind = picked.kind;
      }
      const prepared = await buildView(primary, kind, style, held.current, remember);
      setView(prepared);
      setTitle(`${primary.name} · ${kindTitle(kind)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法可视化这个文件");
    } finally {
      setLoading(false);
      setDragOver(false);
    }
  };

  const clear = () => {
    urls.current.forEach((url) => URL.revokeObjectURL(url));
    urls.current = [];
    setView(null);
    setTitle("");
    setError("");
  };

  return (
    <div className="viz-page" ref={pageRef}>
      <section className="viz-types" ref={typesRef} style={{ width: typeWidth }}>
        <p className="viz-note">点选一种类型后再拖入文件。再点一次已选类型就取消，拖入后按文件内容自动识别。</p>
        <div className="viz-type-split">
          <div className="viz-type-pane" style={{ height: humanHeight }}>
            <TypeCard
              title="人体数据"
              rows={HUMAN_ROWS}
              ontology="human"
              choice={choice}
              onChoose={setChoice}
            />
          </div>
          <SplitHandle
            axis="y"
            onDelta={(delta) =>
              setHumanHeight((current) => {
                const limit = (typesRef.current?.clientHeight || 720) - 180;
                return clampPane(current + delta, 140, Math.max(140, limit));
              })
            }
          />
          <div className="viz-type-pane is-fill">
            <TypeCard
              title="机器人数据"
              rows={ROBOT_ROWS}
              ontology="robot"
              choice={choice}
              onChoose={setChoice}
              styles={styles}
              style={style}
              onStyle={setStyle}
            />
          </div>
        </div>
      </section>
      <SplitHandle
        axis="x"
        onDelta={(delta) =>
          setTypeWidth((current) => {
            const limit = (pageRef.current?.clientWidth || 1200) - 420;
            return clampPane(current + delta, 280, Math.max(280, limit));
          })
        }
      />
      <section
        ref={stageRef}
        className={`viz-stage${dragOver ? " is-over" : ""}${view ? " has-preview" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          void openFiles([...event.dataTransfer.files]);
        }}
      >
        <div className="viz-stage-bar">
          <strong>{title || "可视化窗口"}</strong>
          <span className="muted">{choice ? `已选 ${choice.ontology === "human" ? "人体" : style} · ${choice.format}` : "自动识别"}</span>
          <button type="button" className="secondary" onClick={() => inputRef.current?.click()}>
            选择文件
          </button>
          {view && (
            <button type="button" className="secondary" onClick={clear}>
              清空
            </button>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            void openFiles([...(event.target.files || [])]);
            event.target.value = "";
          }}
        />
        {error ? <div className="storage-preview-empty">{error}</div> : null}
        {!error && loading ? <div className="storage-preview-empty">正在识别文件…</div> : null}
        {!error && !loading && view ? (
          <PlaybackClockProvider>
            <div className="viz-view">
              <PreviewView item={view} />
            </div>
            <SplitHandle
              axis="y"
              onDelta={(delta) =>
                setRawHeight((current) => {
                  const limit = (stageRef.current?.clientHeight || 720) - 200;
                  return clampPane(current - delta, 100, Math.max(100, limit));
                })
              }
            />
            <div className="viz-raw-pane" style={{ height: rawHeight }}>
              <SyncedRaw files={view.sourceFiles} />
            </div>
          </PlaybackClockProvider>
        ) : null}
        {!error && !loading && !view ? (
          <button type="button" className="viz-empty" onClick={() => inputRef.current?.click()}>
            把文件拖到这里
            <span>也可以先在左边选好类型。物体 csv 和 xml 可以一起拖进来。</span>
          </button>
        ) : null}
      </section>
    </div>
  );
}

function TypeCard({
  title,
  rows,
  ontology,
  choice,
  onChoose,
  styles,
  style,
  onStyle,
}: {
  title: string;
  rows: typeof HUMAN_ROWS;
  ontology: Ontology;
  choice: Choice | null;
  onChoose: (choice: Choice | null) => void;
  styles?: string[];
  style?: string;
  onStyle?: (style: string) => void;
}) {
  return (
    <section className="storage-ontology-card">
      <h3>{title}</h3>
      {styles && onStyle && style && (
        <div className="storage-robot-style-tabs">
          {styles.map((item) => (
            <button
              key={item}
              type="button"
              className={`storage-robot-style-tab ${item === style ? "active" : "secondary"}`}
              onClick={() => onStyle(item)}
            >
              {item}
            </button>
          ))}
        </div>
      )}
      {rows.map((row) => (
        <div className="storage-modality-row" key={row.label}>
          <div className="storage-modality-name">{row.label}</div>
          <div className="storage-file-pills">
            {row.formats.map((format) => {
              const next: Choice = {
                ontology,
                modality: row.modality,
                motionKind: row.motionKind,
                format,
              };
              const selected = choice ? choiceKey(choice) === choiceKey(next) : false;
              return (
                <button
                  key={format}
                  type="button"
                  className={selected ? "active" : "secondary"}
                  onClick={() => onChoose(selected ? null : next)}
                >
                  {format}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

async function buildView(
  file: File,
  kind: Kind,
  style: string,
  held: { xml?: File; objectCsv?: File },
  remember: (url: string) => string
): Promise<Prepared> {
  const motionKind: MotionKind | undefined =
    kind.startsWith("robot-merged") ? "merged" : kind === "robot-object-xml" || kind === "robot-object-csv" ? "object" : kind.startsWith("robot") || kind.startsWith("human") ? "skeleton" : undefined;
  const format = extOf(file.name) === "npz" && kind === "human-smpl" ? "smpl" : extOf(file.name);
  const record = localFile(file, kind.startsWith("robot") ? "robot" : "human", format, motionKind, style);
  const mediaUrl = remember(record.path);
  record.path = mediaUrl;
  const sourceFiles = [file];
  if (kind === "robot-csv" || kind === "robot-object-csv" || kind === "robot-object-xml") {
    if (held.xml && held.xml !== file) sourceFiles.push(held.xml);
    if (held.objectCsv && held.objectCsv !== file) sourceFiles.push(held.objectCsv);
  }
  const finish = (extra: Omit<Prepared, "title" | "kind" | "file" | "sourceFiles"> = {}): Prepared => ({
    title: file.name,
    kind,
    file: record,
    sourceFiles,
    ...extra,
  });
  if (kind === "robot-csv" || kind === "robot-object-csv") {
    const xml = held.xml;
    const objectCsv = kind === "robot-object-csv" ? file : held.objectCsv;
    if (kind === "robot-object-csv" && !xml) throw new Error("物体 csv 需要和物体 xml 一起拖进来");
    if (xml && objectCsv && kind === "robot-csv") {
      return finish({
        sources: {
          csvUrl: mediaUrl,
          objectXmlUrl: remember(blobOf(xml)),
          objectCsvUrl: objectCsv === file ? mediaUrl : remember(blobOf(objectCsv)),
        },
      });
    }
    if (kind === "robot-object-csv" && xml) {
      return finish({
        sources: {
          csvUrl: mediaUrl,
          objectXmlUrl: remember(blobOf(xml)),
          objectCsvUrl: mediaUrl,
        },
      });
    }
  }
  if (kind === "human-smpl") {
    return finish({ motionUrl: remember(await uploadSmpl(file)) });
  }
  if (kind === "human-csv" || kind === "text") {
    return finish({ text: await file.text() });
  }
  if (kind === "video" || kind === "audio" || kind === "image") {
    return finish({ mediaUrl });
  }
  return finish({ mediaUrl });
}

function PreviewView({ item }: { item: Prepared }) {
  if (item.kind === "human-bvh" || item.kind === "human-fbx") {
    return <AnimationFormatPreview url={item.file.path} format={item.kind === "human-bvh" ? "bvh" : "fbx"} />;
  }
  if (item.kind === "robot-merged-fbx") {
    return <AnimationFormatPreview url={item.file.path} format="fbx" robotMerged />;
  }
  if (item.kind === "robot-merged-npz") return <RobotHoiNpzPreview file={item.file} />;
  if (item.kind === "robot-merged-zip") return <RobotMergedZipPreview file={item.file} />;
  if (item.kind === "human-smpl" && item.motionUrl) return <SmplPreview file={item.file} motionUrl={item.motionUrl} />;
  if (item.kind === "robot-object-xml") return <ObjectScenePreview xmlPath={item.file.path} />;
  if (item.kind === "robot-object-csv" && item.sources) {
    return <ObjectScenePreview xmlPath={item.sources.objectXmlUrl} csvPath={item.sources.objectCsvUrl} />;
  }
  if (item.kind === "robot-csv") return <RobotCsvPreview file={item.file} sources={item.sources} />;
  if (item.kind === "video" && item.mediaUrl) return <video controls autoPlay src={item.mediaUrl} className="storage-media-preview" />;
  if (item.kind === "audio" && item.mediaUrl) return <audio controls autoPlay src={item.mediaUrl} style={{ width: "90%" }} />;
  if (item.kind === "image" && item.mediaUrl) return <img src={item.mediaUrl} alt={item.file.name} className="storage-media-preview" />;
  return <pre className="storage-text-preview">{item.text || item.file.name}</pre>;
}
