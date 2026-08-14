import type { RelFile } from "./folderUpload";

export interface StemFile {
  stem: string;
  path: string;
  file: File;
  ext: string;
}

export interface MatchedSet {
  stem: string;
  /** 同一动作的多种人体格式（bvh/csv/fbx/tak…） */
  humans: StemFile[];
  robot: StemFile | null;
  slice: StemFile | null;
}

export interface MatchReport {
  ok: boolean;
  matched: MatchedSet[];
  issues: string[];
  humanCount: number;
  robotCount: number;
  sliceCount: number;
  hasRobot: boolean;
  hasSlice: boolean;
  formatCounts: Record<string, number>;
}

const IGNORE_NAME = /^(?:\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function fileStem(name: string): string {
  const base = basename(name);
  const i = base.lastIndexOf(".");
  return (i > 0 ? base.slice(0, i) : base).trim();
}

/** 归一化动作名：去掉 BVH 常见的 _Skeleton 后缀，便于与 csv/fbx/tak 对齐 */
export function normalizeMotionStem(name: string): string {
  return fileStem(name).replace(/_Skeleton$/i, "").trim();
}

export function fileExt(name: string): string {
  const base = basename(name);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

function isIgnored(path: string): boolean {
  const base = basename(path);
  return !base || base.startsWith(".") || IGNORE_NAME.test(base);
}

export function filterRoleFiles(files: RelFile[], acceptExts: string[]): RelFile[] {
  const allow = new Set(acceptExts.map((e) => e.toLowerCase().replace(/^\./, "")));
  return files.filter((f) => {
    if (isIgnored(f.path)) return false;
    if (!allow.size) return true;
    return allow.has(fileExt(f.path));
  });
}

function indexByStem(files: RelFile[], normalize = false): {
  byStem: Map<string, StemFile[]>;
  duplicates: string[];
} {
  const byStem = new Map<string, StemFile[]>();
  for (const { path, file } of files) {
    if (isIgnored(path)) continue;
    const rawStem = normalize ? normalizeMotionStem(path) : fileStem(path);
    const stem = rawStem.toLowerCase();
    if (!stem) continue;
    const entry: StemFile = {
      stem: rawStem,
      path,
      file,
      ext: fileExt(path),
    };
    const list = byStem.get(stem) || [];
    list.push(entry);
    byStem.set(stem, list);
  }
  const duplicates: string[] = [];
  for (const [stem, list] of byStem) {
    const byExt = new Map<string, StemFile[]>();
    for (const item of list) {
      const arr = byExt.get(item.ext) || [];
      arr.push(item);
      byExt.set(item.ext, arr);
    }
    for (const [ext, same] of byExt) {
      if (same.length > 1) {
        duplicates.push(
          `「${stem}」.${ext} 重复：${same.map((x) => x.path).join("、")}`
        );
      }
    }
  }
  return { byStem, duplicates };
}

export const HUMAN_EXTS = [
  "bvh",
  "smpl",
  "csv",
  "fbx",
  "tak",
  "npz",
  "npy",
  "pkl",
  "txt",
];
export const ROBOT_EXTS = ["csv", "pkl", "npz", "json", "bin", "txt", "npy"];
export const SLICE_EXTS = ["json"];

export function inferHumanFormat(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "npz" || e === "npy") return "smpl";
  if (["bvh", "csv", "fbx", "tak", "smpl", "pkl"].includes(e)) return e;
  return e || "bvh";
}

export function inferRobotFormat(ext: string): string {
  const e = ext.toLowerCase();
  if (["csv", "pkl", "npz", "json", "bin", "txt"].includes(e)) return e;
  return e || "csv";
}

function sideEqualsHuman(
  label: string,
  humanKeys: Set<string>,
  sideKeys: Set<string>,
  issues: string[]
): boolean {
  let ok = true;
  for (const stem of [...humanKeys].sort()) {
    if (!sideKeys.has(stem)) {
      issues.push(`文件名「${stem}」：人体有，缺少${label}`);
      ok = false;
    }
  }
  for (const stem of [...sideKeys].sort()) {
    if (!humanKeys.has(stem)) {
      issues.push(`文件名「${stem}」：${label}有，但人体文件夹中没有同名文件`);
      ok = false;
    }
  }
  return ok;
}

/**
 * Human folder is required. Robot / slice folders are optional;
 * when provided, their filename stems must 1:1 match the human set.
 * Multiple human formats sharing a normalized stem are merged into one clip.
 */
export function matchMotionFolders(
  humanFiles: RelFile[],
  robotFiles: RelFile[],
  sliceFiles: RelFile[]
): MatchReport {
  const human = filterRoleFiles(humanFiles, HUMAN_EXTS);
  const robot = filterRoleFiles(robotFiles, ROBOT_EXTS);
  const slice = filterRoleFiles(sliceFiles, SLICE_EXTS);

  const hIdx = indexByStem(human, true);
  const rIdx = indexByStem(robot, true);
  const sIdx = indexByStem(slice, true);

  const issues: string[] = [];
  for (const d of hIdx.duplicates) issues.push(`人体文件夹：${d}`);
  for (const d of rIdx.duplicates) issues.push(`机器人文件夹：${d}`);
  for (const d of sIdx.duplicates) issues.push(`切片文件夹：${d}`);

  if (!human.length) {
    issues.push("请先选择人体数据文件夹（支持 bvh/csv/fbx/tak/npz 等）");
  }

  const hasRobot = robot.length > 0;
  const hasSlice = slice.length > 0;
  const humanKeys = new Set(hIdx.byStem.keys());

  const hasDup =
    hIdx.duplicates.length > 0 || rIdx.duplicates.length > 0 || sIdx.duplicates.length > 0;

  let sidesOk = true;
  if (hasRobot) {
    sidesOk =
      sideEqualsHuman("机器人", humanKeys, new Set(rIdx.byStem.keys()), issues) && sidesOk;
  }
  if (hasSlice) {
    sidesOk =
      sideEqualsHuman("切片", humanKeys, new Set(sIdx.byStem.keys()), issues) && sidesOk;
  }

  const formatCounts: Record<string, number> = {};
  const matched: MatchedSet[] = [];
  if (human.length && !hasDup && sidesOk) {
    for (const stem of [...humanKeys].sort()) {
      const humans = hIdx.byStem.get(stem)!;
      // dedupe by format (keep first)
      const byFmt = new Map<string, StemFile>();
      for (const h of humans) {
        const fmt = inferHumanFormat(h.ext);
        if (!byFmt.has(fmt)) byFmt.set(fmt, h);
      }
      const list = [...byFmt.values()];
      for (const h of list) {
        const fmt = inferHumanFormat(h.ext);
        formatCounts[fmt] = (formatCounts[fmt] || 0) + 1;
      }
      matched.push({
        stem: list[0]?.stem || stem,
        humans: list,
        robot: hasRobot ? rIdx.byStem.get(stem)![0] : null,
        slice: hasSlice ? sIdx.byStem.get(stem)![0] : null,
      });
    }
  }

  const ok = matched.length > 0 && !hasDup && sidesOk;

  return {
    ok,
    matched: ok ? matched : [],
    issues: ok ? [] : issues,
    humanCount: human.length,
    robotCount: robot.length,
    sliceCount: slice.length,
    hasRobot,
    hasSlice,
    formatCounts,
  };
}
