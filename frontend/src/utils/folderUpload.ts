import { zipSync, strToU8 } from "fflate";

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

export async function listZipEntryNames(file: File): Promise<string[]> {
  const size = file.size;
  if (size < 22) throw new Error("不是有效的 zip");
  const tailLen = Math.min(size, 22 + 65535);
  const tailBuf = await file.slice(size - tailLen).arrayBuffer();
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
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new Error("这个 zip 过大，请改用文件夹上传");
  }
  const cdBuf = await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer();
  const bytes = new Uint8Array(cdBuf);
  const directory = new DataView(cdBuf);
  const names: string[] = [];
  let cursor = 0;
  while (cursor + 46 <= bytes.length) {
    if (directory.getUint32(cursor, true) !== 0x02014b50) break;
    const flags = directory.getUint16(cursor + 8, true);
    const nameLen = directory.getUint16(cursor + 28, true);
    const extraLen = directory.getUint16(cursor + 30, true);
    const commentLen = directory.getUint16(cursor + 32, true);
    const raw = bytes.subarray(cursor + 46, cursor + 46 + nameLen);
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
    if (name && !name.endsWith("/") && !name.startsWith("__MACOSX/")) names.push(name);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  if (!names.length) throw new Error("zip 里没有文件");
  return names;
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
