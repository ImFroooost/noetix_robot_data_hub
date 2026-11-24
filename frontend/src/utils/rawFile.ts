import { unzipSync } from "fflate";
import { parseNpz, type NpyArray } from "./npz";

const TEXT_LIMIT = 8000;

export type FrameSlice = {
  index: number;
  count: number;
  text: string;
};

export type FrameDoc = {
  preamble: string;
  frameAt: (time: number, fps?: number) => FrameSlice;
};

function clipText(text: string) {
  if (text.length <= TEXT_LIMIT) return text;
  return `${text.slice(0, TEXT_LIMIT)}\n…`;
}

function nums(data: Float32Array, start: number, count: number) {
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const value = data[start + i];
    parts.push(Number.isFinite(value) ? String(Math.round(value * 1e6) / 1e6) : String(value));
  }
  return parts.join(", ");
}

function clampFrame(time: number, fps: number, count: number) {
  if (count <= 0) return 0;
  const index = Math.floor(Math.max(time, 0) * Math.max(fps, 1e-6));
  return Math.min(index, count - 1);
}

function rateOf(native: number, fps?: number) {
  return fps && fps > 0 ? fps : native;
}

function staticDoc(text: string): FrameDoc {
  return {
    preamble: text,
    frameAt: () => ({ index: 0, count: 0, text }),
  };
}

function xmlFps(text: string) {
  const match = /<scene\b[^>]*\bfps\s*=\s*["']([0-9.]+)["']/i.exec(text);
  const value = Number(match?.[1]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function scalar(array: NpyArray | undefined) {
  if (!array || !(array.data instanceof Float32Array) || array.data.length !== 1) return 0;
  return array.data[0];
}

function isFrameArray(array: NpyArray, count: number) {
  return array.data instanceof Float32Array && count > 1 && array.shape[0] === count && array.shape.length >= 1;
}

function fullArrayText(name: string, array: NpyArray) {
  const shape = `shape=(${array.shape.join(", ")})`;
  if (array.data instanceof Uint8Array) {
    const text = new TextDecoder().decode(array.data);
    try {
      return `${name}  ${shape}\n${JSON.stringify(JSON.parse(text), null, 2)}`;
    } catch {
      return `${name}  ${shape}\n${clipText(text)}`;
    }
  }
  if (!(array.data instanceof Float32Array)) return `${name}  ${shape}`;
  if (array.data.length <= 64) return `${name}  ${shape}\n${nums(array.data, 0, array.data.length)}`;
  return `${name}  ${shape}\n${nums(array.data, 0, 64)}\n… 共 ${array.data.length} 个数`;
}

function writeArray(
  lines: string[],
  name: string,
  array: NpyArray | undefined,
  index: number,
  names: string[] = [],
  bodies: unknown[] = []
) {
  if (!array || !(array.data instanceof Float32Array) || !array.shape.length) return;
  const data = array.data;
  const shape = array.shape;
  lines.push("", `${name}  shape=(${shape.join(", ")})`);
  if (shape.length === 1) {
    lines.push(`#${index}  ${nums(data, index, 1)}`);
    return;
  }
  if (shape.length === 2) {
    const width = shape[1];
    const named = names.length === width && width <= 64;
    if (!named) lines.push(`#${index}  ${nums(data, index * width, width)}`);
    if (named) {
      names.forEach((joint, jointIndex) => {
        lines.push(`${joint} = ${nums(data, index * width + jointIndex, 1)}`);
      });
    }
    return;
  }
  const bodyCount = shape[1];
  const width = shape[2];
  lines.push(`#${index}`);
  for (let body = 0; body < bodyCount; body += 1) {
    const id = String((bodies[body] as { id?: string } | undefined)?.id ?? body);
    lines.push(`[${body}] ${id}  ${nums(data, (index * bodyCount + body) * width, width)}`);
  }
}

function npzDoc(buffer: ArrayBuffer, label: string): FrameDoc {
  const arrays = parseNpz(buffer);
  let meta: Record<string, unknown> = {};
  try {
    const raw = arrays.meta?.data;
    if (raw instanceof Uint8Array) meta = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  } catch {
    meta = {};
  }
  const nativeFps = Number(meta.fps) || scalar(arrays.mocap_framerate) || scalar(arrays.fps) || 30;
  const jointNames = Array.isArray((meta.robot as { joint_names?: unknown } | undefined)?.joint_names)
    ? (meta.robot as { joint_names: unknown[] }).joint_names.map(String)
    : [];
  const bodies = Array.isArray(meta.bodies) ? meta.bodies : [];
  const named = ["robot_root_pos", "robot_root_quat", "robot_joint_pos", "body_pos", "body_quat"];
  const series = Object.values(arrays).filter((array) => array.data instanceof Float32Array && array.shape.length >= 2);
  const count = series.length ? Math.max(...series.map((array) => array.shape[0])) : 0;
  return {
    preamble: label,
    frameAt(time) {
      const lines = [label];
      if (arrays.meta) lines.push(fullArrayText("meta", arrays.meta));
      else if (Object.keys(meta).length) lines.push(JSON.stringify(meta, null, 2));
      Object.entries(arrays).forEach(([name, array]) => {
        if (name === "meta" || isFrameArray(array, count)) return;
        lines.push("", fullArrayText(name, array));
      });
      if (!count) {
        if (lines.length === 1) lines.push("这个 npz 里没有逐帧数组。");
        return { index: 0, count: 0, text: lines.join("\n") };
      }
      const rate = nativeFps;
      const index = clampFrame(time, rate, count);
      lines.push("", `第 ${index} 帧 / 共 ${count} 帧    ${(index / rate).toFixed(3)}s`);
      const emitted = new Set<string>();
      named.forEach((name) => {
        if (!arrays[name] || !isFrameArray(arrays[name], count)) return;
        emitted.add(name);
        writeArray(lines, name, arrays[name], index, name === "robot_joint_pos" ? jointNames : [], bodies);
      });
      Object.entries(arrays).forEach(([name, array]) => {
        if (emitted.has(name) || name === "meta" || !isFrameArray(array, count)) return;
        writeArray(lines, name, array, index);
      });
      return { index, count, text: lines.join("\n") };
    },
  };
}

function csvDoc(text: string, label: string, fpsHint = 0): FrameDoc {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const header = lines[0] || "";
  const headerIsText = /[A-Za-z_\u4e00-\u9fff]/.test(header);
  const rows = headerIsText ? lines.slice(1) : lines;
  let fps = fpsHint > 0 ? fpsHint : 30;
  if (!fpsHint && headerIsText) {
    const timeCol = header.split(",").findIndex((item) => /time/i.test(item));
    if (timeCol >= 0 && rows.length > 2) {
      const a = Number(rows[0].split(",")[timeCol]);
      const b = Number(rows[1].split(",")[timeCol]);
      if (b > a) {
        const inferred = 1 / (b - a);
        const rounded = Math.round(inferred);
        fps = Math.abs(inferred - rounded) < 0.05 ? rounded : inferred;
      }
    }
  }
  const intro = `${label}\n${rows.length} 行数据${headerIsText ? `\n${header}` : "\nbase_x, base_y, base_z, qx, qy, qz, qw, joints"}`;
  return {
    preamble: intro,
    frameAt(time, fpsOverride) {
      const rate = rateOf(fps, fpsOverride);
      const index = clampFrame(time, rate, rows.length);
      return {
        index,
        count: rows.length,
        text: `${intro}\n第 ${index} 帧 / 共 ${rows.length} 帧    ${(index / rate).toFixed(3)}s\n${rows[index] || ""}`,
      };
    },
  };
}

function bvhDoc(text: string, label: string): FrameDoc {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const motionAt = lines.findIndex((line) => line.trim() === "MOTION");
  if (motionAt < 0) return staticDoc(`${label}\n\n${clipText(text)}`);
  const frameTimeLine = lines.find((line) => line.trim().startsWith("Frame Time:"));
  const frameTime = Number(frameTimeLine?.split(":")[1]) || 1 / 30;
  const rows = lines.slice(motionAt + 1).filter((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("Frames:") && !trimmed.startsWith("Frame Time:");
  });
  const hierarchy = clipText(lines.slice(0, motionAt).join("\n"));
  return {
    preamble: `${label}\n\n${hierarchy}`,
    frameAt(time) {
      const index = clampFrame(time, 1 / frameTime, rows.length);
      return {
        index,
        count: rows.length,
        text: `${label}\n\n${hierarchy}\n\n第 ${index} 帧 / 共 ${rows.length} 帧    ${(index * frameTime).toFixed(3)}s\n${rows[index] || ""}`,
      };
    },
  };
}

async function oneDoc(file: File, fpsHint = 0): Promise<FrameDoc> {
  const label = `${file.name}  ${(file.size / 1024).toFixed(1)} KB`;
  const lowerName = file.name.toLowerCase();
  const ext = lowerName.endsWith(".fbx.zst") ? "fbx" : file.name.split(".").pop()?.toLowerCase() || "";
  if (ext === "npz") {
    try {
      return npzDoc(await file.arrayBuffer(), label);
    } catch (err) {
      return staticDoc(`${label}\n\n${err instanceof Error ? err.message : "这个 npz 暂时不能按帧展开"}`);
    }
  }
  if (ext === "zip") {
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const names = Object.keys(entries).sort();
    let packedFps = fpsHint;
    const docs: FrameDoc[] = [];
    for (const name of names) {
      if (name.toLowerCase().endsWith(".xml")) packedFps = xmlFps(new TextDecoder().decode(entries[name])) || packedFps;
    }
    for (const name of names) {
      const lower = name.toLowerCase();
      const bytes = entries[name];
      if (lower.endsWith(".csv")) docs.push(csvDoc(new TextDecoder().decode(bytes), name, packedFps));
      else if (lower.endsWith(".xml")) docs.push(staticDoc(`${name}\n\n${clipText(new TextDecoder().decode(bytes))}`));
    }
    return mergeDocs(`${label}\n${names.map((name) => `- ${name}`).join("\n")}`, docs);
  }
  if (ext === "csv") return csvDoc(await file.text(), label, fpsHint);
  if (ext === "bvh") return bvhDoc(await file.text(), label);
  if (ext === "xml") {
    const text = await file.text();
    return staticDoc(`${label}\n\n${clipText(text)}`);
  }
  if (ext === "txt" || ext === "json") return staticDoc(`${label}\n\n${clipText(await file.text())}`);
  if (ext === "fbx") return staticDoc(`${label}\n\n二进制 FBX。逐帧曲线包在文件里，上面的窗口正在播放它。`);
  return staticDoc(`${label}\n\n这个格式没有按帧排列的文本。`);
}

function mergeDocs(preamble: string, docs: FrameDoc[]): FrameDoc {
  if (!docs.length) return staticDoc(preamble);
  return {
    preamble: [preamble, ...docs.map((doc) => doc.preamble)].filter(Boolean).join("\n\n"),
    frameAt(time, fps) {
      const slices = docs.map((doc) => doc.frameAt(time, fps));
      const moving = slices.filter((item) => item.count > 1);
      const lead = moving[0] || slices[0];
      return {
        index: lead?.index || 0,
        count: moving.length ? Math.max(...moving.map((item) => item.count)) : 0,
        text: [preamble, ...slices.map((item) => item.text)].filter(Boolean).join("\n\n"),
      };
    },
  };
}

export async function loadFrameDoc(files: File[]) {
  let fpsHint = 0;
  for (const file of files) {
    if ((file.name.split(".").pop() || "").toLowerCase() !== "xml") continue;
    fpsHint = xmlFps(await file.text()) || fpsHint;
  }
  const docs = await Promise.all(files.map((file) => oneDoc(file, fpsHint)));
  return mergeDocs("", docs);
}
