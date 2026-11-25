import { inflateSync, zipSync, strToU8 } from "fflate";
import { pairFbxAndC3dPaths } from "./motionUnits";

export type RelFile = { path: string; file: File };

type FileSystemEntryLike = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath?: string;
  file: (ok: (f: File) => void, err?: (e: Error) => void) => void;
  createReader: () => {
    readEntries: (
      ok: (entries: FileSystemEntryLike[]) => void,
      err?: (e: Error) => void
    ) => void;
  };
};

function readFileEntry(entry: FileSystemEntryLike, pathPrefix: string): Promise<RelFile> {
  return new Promise((resolve, reject) => {
    entry.file(
      (file) => resolve({ path: `${pathPrefix}${file.name}`.replace(/^\//, ""), file }),
      reject
    );
  });
}

async function readDirectoryEntry(
  entry: FileSystemEntryLike,
  pathPrefix: string
): Promise<RelFile[]> {
  const reader = entry.createReader();
  const out: RelFile[] = [];
  const readBatch = (): Promise<FileSystemEntryLike[]> =>
    new Promise((resolve, reject) => reader.readEntries(resolve, reject));

  // readEntries may return partial batches
  for (;;) {
    const batch = await readBatch();
    if (!batch.length) break;
    for (const child of batch) {
      const next = `${pathPrefix}${entry.name}/`;
      if (child.isFile) out.push(await readFileEntry(child, next));
      else if (child.isDirectory) out.push(...(await readDirectoryEntry(child, next)));
    }
  }
  return out;
}

/** Collect files from a drag-and-drop of folders/files. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<RelFile[]> {
  const items = Array.from(dt.items || []);
  const out: RelFile[] = [];
  for (const item of items) {
    const entry = (
      (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null })
        .webkitGetAsEntry?.() || null
    ) as unknown as FileSystemEntryLike | null;
    if (!entry) continue;
    if (entry.isFile) out.push(await readFileEntry(entry, ""));
    else if (entry.isDirectory) out.push(...(await readDirectoryEntry(entry, "")));
  }
  // fallback: plain files without directory API
  if (!out.length && dt.files?.length) {
    for (const file of Array.from(dt.files)) {
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      out.push({ path: rel.replace(/^\//, ""), file });
    }
  }
  return out;
}

/** Collect files from <input webkitdirectory>. */
export function filesFromFileList(list: FileList | null): RelFile[] {
  if (!list) return [];
  return Array.from(list).map((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    return { path: rel.replace(/^\//, ""), file };
  });
}

export function folderHasUrdf(files: RelFile[]): boolean {
  return files.some((f) => /\.(urdf|xacro)$/i.test(f.path));
}

function unwrapSingleRoot(paths: string[]): string[] {
  let parts = paths
    .map((item) => item.replace(/\\/g, "/").replace(/^\/+/, ""))
    .filter((item) => item && !item.split("/").some((seg) => !seg || seg.startsWith(".") || seg === "__MACOSX"))
    .map((item) => item.split("/").filter(Boolean));
  while (
    parts.length > 0 &&
    parts.every((item) => item.length > 1) &&
    new Set(parts.map((item) => item[0])).size === 1
  ) {
    parts = parts.map((item) => item.slice(1));
  }
  return parts.map((item) => item.join("/"));
}

/** URDF / Xacro / MJCF paths after stripping one wrapping directory, matching the server. */
export function descriptionCandidates(paths: string[]): string[] {
  return unwrapSingleRoot(paths)
    .filter((item) => /\.(urdf|xacro|xml)$/i.test(item))
    .sort((a, b) => a.localeCompare(b, "zh"));
}

type ZipCdEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

async function readZipCentralDirectory(file: File): Promise<ZipCdEntry[]> {
  const size = file.size;
  if (size < 22) throw new Error("不是有效的 zip");
  const tailLen = Math.min(size, 22 + 65535);
  const tailStart = size - tailLen;
  const tailBuf = await file.slice(tailStart).arrayBuffer();
  const tail = new Uint8Array(tailBuf);
  let eocd = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (
      tail[index] === 0x50 &&
      tail[index + 1] === 0x4b &&
      tail[index + 2] === 0x05 &&
      tail[index + 3] === 0x06
    ) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 zip");
  const view = new DataView(tailBuf);
  let cdSize = view.getUint32(eocd + 12, true);
  let cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    // Check Zip64 EOCD locator right before EOCD (20 bytes)
    if (eocd >= 20 && view.getUint32(eocd - 20, true) === 0x07064b50) {
      const zip64EocdOffset = Number(view.getBigUint64(eocd - 12, true));
      const z64Buf = await file.slice(zip64EocdOffset, zip64EocdOffset + 56).arrayBuffer();
      const z64View = new DataView(z64Buf);
      if (z64View.getUint32(0, true) === 0x06064b50) {
        cdSize = Number(z64View.getBigUint64(40, true));
        cdOffset = Number(z64View.getBigUint64(48, true));
      }
    }
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      throw new Error("这个 zip 过大，请改用文件夹或服务器路径上传");
    }
  }
  const cdBuf = await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer();
  const bytes = new Uint8Array(cdBuf);
  const directory = new DataView(cdBuf);
  const entries: ZipCdEntry[] = [];
  let cursor = 0;
  while (cursor + 46 <= bytes.length) {
    if (directory.getUint32(cursor, true) !== 0x02014b50) break;
    const flags = directory.getUint16(cursor + 8, true);
    const method = directory.getUint16(cursor + 10, true);
    let compressedSize = directory.getUint32(cursor + 20, true);
    let uncompressedSize = directory.getUint32(cursor + 24, true);
    const nameLen = directory.getUint16(cursor + 28, true);
    const extraLen = directory.getUint16(cursor + 30, true);
    const commentLen = directory.getUint16(cursor + 32, true);
    let localHeaderOffset = directory.getUint32(cursor + 42, true);
    const raw = bytes.subarray(cursor + 46, cursor + 46 + nameLen);
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      const extraStart = cursor + 46 + nameLen;
      const extraEnd = extraStart + extraLen;
      let ep = extraStart;
      while (ep + 4 <= extraEnd && ep + 4 <= bytes.length) {
        const headerId = directory.getUint16(ep, true);
        const dataSize = directory.getUint16(ep + 2, true);
        if (headerId === 0x0001) {
          let zp = ep + 4;
          if (uncompressedSize === 0xffffffff && zp + 8 <= ep + 4 + dataSize) {
            uncompressedSize = Number(directory.getBigUint64(zp, true));
            zp += 8;
          }
          if (compressedSize === 0xffffffff && zp + 8 <= ep + 4 + dataSize) {
            compressedSize = Number(directory.getBigUint64(zp, true));
            zp += 8;
          }
          if (localHeaderOffset === 0xffffffff && zp + 8 <= ep + 4 + dataSize) {
            localHeaderOffset = Number(directory.getBigUint64(zp, true));
          }
          break;
        }
        ep += 4 + dataSize;
      }
    }
    let name = "";
    if (flags & 0x800) name = new TextDecoder("utf-8").decode(raw);
    else {
      try {
        name = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      } catch {
        name = new TextDecoder("latin1").decode(raw);
      }
    }
    name = name.replace(/\\/g, "/");
    if (name && !name.endsWith("/") && !name.startsWith("__MACOSX/")) {
      entries.push({
        name,
        method,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
    }
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.length) throw new Error("zip 里没有文件");
  return entries;
}

export async function listZipEntryNames(file: File): Promise<string[]> {
  const entries = await readZipCentralDirectory(file);
  return entries.map((item) => item.name);
}

const TOKEN_C3D_COLON = strToU8("C3D:");
const TOKEN_OPTICAL_MARKER = strToU8("OpticalMarker");
const TOKEN_OPTICAL_ATTR = new Uint8Array([
  ...strToU8("Optical"),
  0x00,
  0x01,
  ...strToU8("NodeAttribute"),
]);
const TOKEN_ASCII_OPTICAL = strToU8('"Optical"');

function containsSubarray(haystack: Uint8Array, needle: Uint8Array): boolean {
  const nLen = needle.length;
  if (!nLen || haystack.length < nLen) return false;
  const first = needle[0];
  const limit = haystack.length - nLen;
  for (let i = 0; i <= limit; i += 1) {
    if (haystack[i] !== first) continue;
    let match = true;
    for (let j = 1; j < nLen; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/** Check whether an FBX file buffer already contains C3D optical marker nodes. */
export function fbxBytesHaveC3d(bytes: Uint8Array): boolean {
  if (!bytes.length) return false;
  return (
    containsSubarray(bytes, TOKEN_C3D_COLON) ||
    containsSubarray(bytes, TOKEN_OPTICAL_MARKER) ||
    containsSubarray(bytes, TOKEN_OPTICAL_ATTR) ||
    containsSubarray(bytes, TOKEN_ASCII_OPTICAL)
  );
}

export async function detectFolderMergeableC3dPairs(
  files: Array<{ rel: string; file: File }>
): Promise<Array<{ fbxRel: string; c3dRel: string }>> {
  const candidates = pairFbxAndC3dPaths(files.map((item) => item.rel));
  if (!candidates.length) return [];
  const byRel = new Map(files.map((item) => [item.rel, item.file]));
  const mergeable: Array<{ fbxRel: string; c3dRel: string }> = [];
  for (const pair of candidates) {
    const fbxFile = byRel.get(pair.fbxRel);
    if (!fbxFile) continue;
    try {
      const buf = new Uint8Array(await fbxFile.arrayBuffer());
      if (!fbxBytesHaveC3d(buf)) {
        mergeable.push(pair);
      }
    } catch {
      // ignore unreadable file
    }
  }
  return mergeable;
}

async function readZipEntryBytes(file: File, entry: ZipCdEntry): Promise<Uint8Array | null> {
  const headerSlice = await file
    .slice(entry.localHeaderOffset, entry.localHeaderOffset + 30)
    .arrayBuffer();
  if (headerSlice.byteLength < 30) return null;
  const headerView = new DataView(headerSlice);
  if (headerView.getUint32(0, true) !== 0x04034b50) return null;
  const fileNameLen = headerView.getUint16(26, true);
  const extraFieldLen = headerView.getUint16(28, true);
  const dataStart = entry.localHeaderOffset + 30 + fileNameLen + extraFieldLen;
  const rawSlice = new Uint8Array(
    await file.slice(dataStart, dataStart + entry.compressedSize).arrayBuffer()
  );
  if (entry.method === 0) return rawSlice;
  if (entry.method === 8) return inflateSync(rawSlice);
  return null;
}

export async function inspectZipForImport(file: File): Promise<{
  names: string[];
  mergeablePairs: Array<{ fbxRel: string; c3dRel: string }>;
}> {
  const entries = await readZipCentralDirectory(file);
  const names = entries.map((item) => item.name);
  const candidates = pairFbxAndC3dPaths(names);
  if (!candidates.length) {
    return { names, mergeablePairs: [] };
  }
  const byName = new Map(entries.map((item) => [item.name, item]));
  const mergeablePairs: Array<{ fbxRel: string; c3dRel: string }> = [];
  for (const pair of candidates) {
    const fbxEntry = byName.get(pair.fbxRel);
    if (!fbxEntry) continue;
    try {
      const bytes = await readZipEntryBytes(file, fbxEntry);
      if (bytes && !fbxBytesHaveC3d(bytes)) {
        mergeablePairs.push(pair);
      }
    } catch {
      // ignore decompression errors during pre-check
    }
  }
  return { names, mergeablePairs };
}

/** Zip relative files in-browser for upload to existing zip API. */
export async function zipRelFiles(files: RelFile[]): Promise<Blob> {
  if (!files.length) throw new Error("文件夹为空");
  const entries: Record<string, Uint8Array> = {};
  for (const { path, file } of files) {
    const buf = new Uint8Array(await file.arrayBuffer());
    entries[path] = buf;
  }
  // ensure non-empty zip even if somehow empty names
  if (!Object.keys(entries).length) {
    entries[".keep"] = strToU8("");
  }
  const zipped = zipSync(entries, { level: 1 });
  return new Blob([zipped.buffer as ArrayBuffer], { type: "application/zip" });
}

export function guessFolderName(files: RelFile[]): string {
  const first = files[0]?.path || "";
  const seg = first.split("/").filter(Boolean)[0];
  return seg || "robot";
}

/** ZIP 文件名 → 目标文件夹名（去掉 .zip） */
export function folderNameFromZip(filename: string): string {
  const base = filename.split(/[/\\]/).filter(Boolean).pop() || "upload";
  return base.replace(/\.zip$/i, "").trim() || "upload";
}

export function formatFromFileName(filename: string): string {
  const name = (filename || "").toLowerCase();
  if (name.endsWith(".ser.pkl")) return "ser.pkl";
  if (name.endsWith(".npz") || name.endsWith(".npy")) return "smpl";
  const match = name.match(/\.([^.]+)$/);
  return match?.[1] || "";
}
