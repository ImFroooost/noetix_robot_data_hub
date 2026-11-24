import type { StorageFile } from "../types";

export const ORIGINAL_FILE_VERSION = "原版";

export type FileVersionInfo = {
  name: string;
  order: number;
  created_at?: string;
};

export function fileVersionName(file: { file_version?: string | null }) {
  const name = String(file.file_version || "").trim();
  return name || ORIGINAL_FILE_VERSION;
}

export function normalizeFileVersions(
  listed: FileVersionInfo[] | undefined,
  files: { file_version?: string | null; file_version_order?: number | null }[]
): FileVersionInfo[] {
  const byName = new Map<string, FileVersionInfo>();
  byName.set(ORIGINAL_FILE_VERSION, { name: ORIGINAL_FILE_VERSION, order: 0 });
  for (const item of listed || []) {
    const name = String(item?.name || "").trim();
    if (!name) continue;
    const order = Number(item.order);
    byName.set(name, {
      name,
      order: Number.isFinite(order) ? order : 0,
      created_at: item.created_at,
    });
  }
  let extra = Math.max(0, ...[...byName.values()].map((item) => item.order));
  for (const file of files) {
    const name = fileVersionName(file);
    if (byName.has(name)) continue;
    extra += 1;
    const order = Number(file.file_version_order);
    byName.set(name, {
      name,
      order: Number.isFinite(order) && order > 0 ? order : extra,
    });
  }
  return [...byName.values()].sort(
    (a, b) => a.order - b.order || a.name.localeCompare(b.name, "zh")
  );
}

export function logicalFileKey(file: {
  ontology?: string | null;
  modality?: string | null;
  channel?: string | null;
  format?: string | null;
  name?: string | null;
  sub_path?: string | null;
  robot_style?: string | null;
  robot_acquire_method?: string | null;
  annotation?: { motion_kind?: string | null } | null;
}) {
  return [
    file.ontology || "",
    file.modality || "",
    file.channel || "",
    file.format || "",
    file.name || "",
    file.sub_path || "",
    file.robot_style || "",
    file.robot_acquire_method || "",
    file.annotation?.motion_kind || "",
  ].join("\0");
}

export function filesForVersion<T extends StorageFile>(
  files: T[],
  versions: FileVersionInfo[],
  selected: string
): T[] {
  const orderOf = new Map(versions.map((item) => [item.name, item.order]));
  const cap = orderOf.get(selected) ?? 0;
  const best = new Map<string, { file: T; order: number }>();
  for (const file of files) {
    const name = fileVersionName(file);
    const order = orderOf.get(name) ?? (name === ORIGINAL_FILE_VERSION ? 0 : cap + 1);
    if (order > cap) continue;
    const key = logicalFileKey(file);
    const prev = best.get(key);
    if (!prev || order >= prev.order) best.set(key, { file, order });
  }
  return [...best.values()].map((item) => item.file);
}

export function latestVersionName(versions: FileVersionInfo[]) {
  return versions[versions.length - 1]?.name || ORIGINAL_FILE_VERSION;
}
