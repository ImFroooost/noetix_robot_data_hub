import { decompress } from "fzstd";

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** `.fbx` 和 zstd 压缩的 `.fbx.zst` 都按 FBX 预览。 */
export function isFbxFileName(name: string) {
  const lower = name.toLowerCase();
  return lower.endsWith(".fbx") || lower.endsWith(".fbx.zst");
}

export function isZstd(data: ArrayBuffer | Uint8Array) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data, 0, Math.min(4, data.byteLength));
  return bytes.length >= 4 && ZSTD_MAGIC.every((value, index) => bytes[index] === value);
}

/** 普通 FBX 原样返回。zstd 帧先解开，再交给 FBXLoader。 */
export function inflateFbxBuffer(data: ArrayBuffer) {
  if (!isZstd(data)) return data;
  const inflated = decompress(new Uint8Array(data));
  return inflated.buffer.slice(inflated.byteOffset, inflated.byteOffset + inflated.byteLength) as ArrayBuffer;
}
