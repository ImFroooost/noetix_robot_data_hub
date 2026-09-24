import type { StorageFile } from "../types";
import { isSmplFormat, isSmplMotionFile } from "../types";

export type PreviewCategory = "merged" | "skeleton" | "tpv" | "fpv" | "other";

const CATEGORY_RANK: Record<PreviewCategory, number> = {
  merged: 0,
  skeleton: 1,
  tpv: 2,
  fpv: 3,
  other: 4,
};

const SKELETON_FORMAT_RANK: Record<string, number> = {
  fbx: 0,
  bvh: 1,
  smpl: 2,
};

export function previewFormatKey(file: {
  format?: string | null;
  name?: string | null;
}): string {
  if (isSmplFormat(file.format, file.name)) return "smpl";
  const fmt = String(file.format || "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
  if (fmt) return fmt.split(/[,\s]+/)[0] || fmt;
  return String(file.name || "").split(".").pop()?.toLowerCase() || "";
}

export function previewCategory(file: StorageFile): PreviewCategory {
  const modality = String(file.modality || "").toLowerCase();
  if (modality === "fpv_video" || modality.includes("fpv")) return "fpv";
  if (
    modality === "tpv_video" ||
    modality === "video" ||
    modality.includes("tpv") ||
    modality.includes("video")
  ) {
    return "tpv";
  }
  const kind = String(file.annotation?.motion_kind || "").toLowerCase();
  if (kind === "merged") return "merged";
  const format = previewFormatKey(file);
  if (kind === "skeleton" || format === "fbx" || format === "bvh" || format === "smpl") {
    return "skeleton";
  }
  return "other";
}

export function isVisualizableStorageFile(file: StorageFile): boolean {
  const format = previewFormatKey(file);
  if (format === "bvh" || format === "fbx") return true;
  if (isSmplMotionFile(file)) return true;
  if (
    file.ontology === "robot" &&
    String(file.modality || "").toLowerCase() === "motion" &&
    format === "csv"
  ) {
    return true;
  }
  const modality = String(file.modality || "").toLowerCase();
  return modality.includes("video");
}

export function previewRobotStyle(file: StorageFile): string {
  return String(file.robot_style || file.annotation?.robot_style || "").trim();
}

/** 在一个数据单元里选出要自动播放的文件。 */
export function pickPreviewFile(
  files: StorageFile[],
  previous: StorageFile | null
): StorageFile | null {
  const candidates = files.filter(isVisualizableStorageFile);
  if (!candidates.length) return null;
  const prevStyle = previous && previous.ontology === "robot" ? previewRobotStyle(previous) : "";
  const hasSameStyle =
    !!prevStyle &&
    candidates.some(
      (file) => file.ontology === "robot" && previewRobotStyle(file) === prevStyle
    );
  const prevCategory = previous ? previewCategory(previous) : null;
  const prevFormat = previous ? previewFormatKey(previous) : "";

  const ranked = candidates
    .map((file) => {
      const category = previewCategory(file);
      const format = previewFormatKey(file);
      const sameKind =
        !!previous && prevCategory === category && prevFormat === format;
      const styleMiss =
        hasSameStyle &&
        !(file.ontology === "robot" && previewRobotStyle(file) === prevStyle);
      return {
        file,
        kindMiss: sameKind ? 0 : 1,
        styleMiss: styleMiss ? 1 : 0,
        category: CATEGORY_RANK[category],
        format: category === "skeleton" ? (SKELETON_FORMAT_RANK[format] ?? 9) : 0,
        ontology: file.ontology === "robot" ? 0 : 1,
      };
    })
    .sort(
      (left, right) =>
        left.kindMiss - right.kindMiss ||
        left.styleMiss - right.styleMiss ||
        left.category - right.category ||
        left.format - right.format ||
        left.ontology - right.ontology ||
        left.file.name.localeCompare(right.file.name, "zh")
    );
  return ranked[0]?.file ?? null;
}
