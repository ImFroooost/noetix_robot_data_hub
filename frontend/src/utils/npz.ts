import { unzipSync } from "fflate";

export type NpyArray = {
  shape: number[];
  data: Float32Array | Uint8Array;
};

function readHeader(bytes: Uint8Array) {
  if (bytes.length < 10 || bytes[0] !== 0x93 || bytes[1] !== 0x4e || bytes[2] !== 0x55 || bytes[3] !== 0x4d) {
    throw new Error("不是 npy 数组");
  }
  const major = bytes[6];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerStart = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLen));
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1] || "";
  const shape = (/shape['"]?\s*:\s*\(([^)]*)\)/.exec(header)?.[1] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(Number)
    .filter((item) => Number.isFinite(item));
  return { descr, shape, offset: headerStart + headerLen };
}

export function parseNpy(bytes: Uint8Array): NpyArray {
  const { descr, shape, offset } = readHeader(bytes);
  const count = shape.reduce((product, item) => product * item, 1) || 0;
  const raw = bytes.subarray(offset);
  if (descr === "|u1" || descr === "<u1") {
    return { shape, data: raw.slice(0, count) };
  }
  if (descr === "<f8" || descr === "|f8") {
    const copy = raw.slice(0, count * 8);
    const wide = new Float64Array(copy.buffer, copy.byteOffset, count);
    const narrow = new Float32Array(count);
    for (let i = 0; i < count; i += 1) narrow[i] = wide[i];
    return { shape, data: narrow };
  }
  if (descr !== "<f4" && descr !== "|f4") {
    throw new Error(`暂不支持的数组类型 ${descr}`);
  }
  const copy = raw.slice(0, count * 4);
  return { shape, data: new Float32Array(copy.buffer, copy.byteOffset, count) };
}

export function parseNpz(buffer: ArrayBuffer): Record<string, NpyArray> {
  const entries = unzipSync(new Uint8Array(buffer));
  const arrays: Record<string, NpyArray> = {};
  for (const [name, bytes] of Object.entries(entries)) {
    if (!name.endsWith(".npy")) continue;
    arrays[name.slice(0, -4)] = parseNpy(bytes);
  }
  return arrays;
}

export function npzMeta(arrays: Record<string, NpyArray>): Record<string, unknown> {
  const meta = arrays.meta?.data;
  if (!(meta instanceof Uint8Array)) throw new Error("npz 缺少 meta");
  return JSON.parse(new TextDecoder().decode(meta)) as Record<string, unknown>;
}
