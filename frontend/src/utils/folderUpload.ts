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
