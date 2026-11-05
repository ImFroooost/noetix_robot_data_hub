/** Keep in step with backend/app/services/motion_units.py */

const FORMAT_BUCKETS = new Set([
  "bvh",
  "fbx",
  "fbx1",
  "npz",
  "npy",
  "csv",
  "tak",
  "smpl",
  "temp",
  "pkl",
  "c3d",
  "fmdata",
  "trc",
]);
const FORMAT_TAIL = new RegExp(
  `(?:^|[\\s._-])(${[...FORMAT_BUCKETS].filter((item) => item !== "temp").sort((a, b) => b.length - a.length).join("|")})$`,
  "i"
);
const SKIP_EXT = new Set(["zip", "rar", "7z", "gz"]);
const ACTOR_TOKEN = /^[A-Za-z]{2,20}$/;
const ROLE_SUFFIX =
  /(?:[\s._-]+|\.[A-Za-z0-9]{1,8}[\s._-]*)(?:skeleton|rigid[\s._-]*bod(?:y|ies)|marker|merged).*$/i;

export type ClipPlan = {
  unitName: string;
  subPath: string;
  storedName: string;
  skip: string;
};

function posix(rel: string) {
  return (rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function partsOf(rel: string) {
  return posix(rel).split("/").filter(Boolean);
}

function suffixOf(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".ser.pkl")) return name.slice(lower.lastIndexOf(".ser.pkl"));
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

function extKey(name: string) {
  return suffixOf(name).toLowerCase().replace(/^\./, "");
}

function isContainer(name: string) {
  const low = name.toLowerCase();
  if (FORMAT_BUCKETS.has(low)) return true;
  return FORMAT_TAIL.test(low);
}

function clipStem(filename: string) {
  const name = partsOf(filename).pop() || filename;
  const suffix = suffixOf(name);
  let stem = suffix ? name.slice(0, -suffix.length) : name;
  const cleaned = stem.replace(ROLE_SUFFIX, "").replace(/[ ._\t]+$/, "");
  stem = cleaned || stem;
  stem = stem.trim().replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^[._]+|[._]+$/g, "");
  return stem || name;
}

function skipReason(rel: string) {
  const parts = partsOf(rel);
  const name = parts[parts.length - 1] || "";
  if (SKIP_EXT.has(extKey(name))) return "压缩包不入库，使用其中已经解开的文件";
  if (parts.slice(0, -1).some((part) => part.toLowerCase() === "temp")) return "临时文件不入库";
  return "";
}

function wrapperPrefixes(rels: string[]) {
  const under = new Map<string, string[][]>();
  for (const rel of rels) {
    if (skipReason(rel)) continue;
    const parts = partsOf(rel).slice(0, -1);
    for (let index = 0; index < parts.length; index += 1) {
      const key = parts.slice(0, index + 1).join("/");
      const list = under.get(key) || [];
      list.push(parts);
      under.set(key, list);
    }
  }
  const wrappers = new Set<string>();
  for (const [prefix, nested] of under) {
    const depth = prefix.split("/").length;
    if (
      nested.every((parts) =>
        parts.slice(depth).some((seg) => isContainer(seg))
      )
    ) {
      wrappers.add(prefix);
    }
  }
  return wrappers;
}

function contentDirs(rel: string, wrappers: Set<string>) {
  const parts = partsOf(rel).slice(0, -1);
  const kept: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index + 1).join("/");
    if (wrappers.has(prefix) || isContainer(parts[index])) continue;
    kept.push(parts[index]);
  }
  return kept;
}

function joinable(extra: string, longer: Set<string>, shorter: Set<string>) {
  if (!extra || extra.includes("_")) return false;
  for (const ext of longer) if (shorter.has(ext)) return false;
  if (ACTOR_TOKEN.test(extra)) return true;
  return /^\d$/.test(extra) && longer.size > 0 && [...longer].every((ext) => ext === "bvh");
}

function mergeActorSuffixes(keys: Map<string, Set<string>>) {
  const parent = new Map<string, string>();
  for (const [key, exts] of keys) {
    const candidates: string[] = [];
    for (const [other, otherExts] of keys) {
      if (other === key || !key.startsWith(`${other}_`)) continue;
      const extra = key.slice(other.length + 1);
      if (joinable(extra, exts, otherExts)) candidates.push(other);
    }
    if (candidates.length) {
      parent.set(key, candidates.reduce((best, item) => (item.length > best.length ? item : best)));
    }
  }
  const resolved = new Map<string, string>();
  for (const key of keys.keys()) {
    const seen = new Set<string>();
    let current = key;
    while (parent.has(current) && !seen.has(current)) {
      seen.add(current);
      current = parent.get(current) || current;
    }
    resolved.set(key, current);
  }
  return resolved;
}

function redundantClipDir(dirname: string, clip: string) {
  if (!dirname || !clip || !/[A-Za-z]/.test(dirname)) return false;
  if (clip === dirname) return true;
  const prefix = `${dirname}_`;
  if (!clip.startsWith(prefix)) return false;
  return /^\d{1,4}$/.test(clip.slice(prefix.length));
}

export function planFollowedPaths(
  relPaths: string[],
  stripCommonRoot: boolean
): Map<string, ClipPlan> {
  const rels = relPaths.map(posix).filter(Boolean);
  const kept = rels.filter((rel) => !SKIP_EXT.has(extKey(partsOf(rel).pop() || "")));
  const firsts = new Set(kept.map((rel) => partsOf(rel)[0]).filter(Boolean));
  const dropRoot =
    stripCommonRoot &&
    firsts.size === 1 &&
    kept.every((rel) => partsOf(rel).length > 1);
  const rootName = dropRoot ? [...firsts][0] : "";
  const plan = new Map<string, ClipPlan>();
  for (const rel of rels) {
    const name = partsOf(rel).pop() || rel;
    if (SKIP_EXT.has(extKey(name))) {
      plan.set(rel, {
        unitName: "",
        subPath: "",
        storedName: "",
        skip: "压缩包不入库，使用其中已经解开的文件",
      });
      continue;
    }
    let parts = partsOf(rel);
    if (dropRoot && parts[0] === rootName) parts = parts.slice(1);
    const subPath = parts.slice(0, -1).join("/");
    const stem = clipStem(name);
    const unit = subPath ? `${subPath.replace(/\//g, "_")}_${stem}` : stem;
    plan.set(rel, { unitName: unit, subPath, storedName: name, skip: "" });
  }
  return plan;
}

export function planClipUnits(relPaths: string[]): Map<string, ClipPlan> {
  const rels = relPaths.map(posix).filter(Boolean);
  const keys = new Map<string, Set<string>>();
  const located: { rel: string; key: string }[] = [];
  for (const rel of rels) {
    if (skipReason(rel)) continue;
    const name = partsOf(rel).pop() || rel;
    const key = clipStem(name);
    const exts = keys.get(key) || new Set<string>();
    exts.add(extKey(name));
    keys.set(key, exts);
    located.push({ rel, key });
  }
  const canon = mergeActorSuffixes(keys);
  const used = new Map<string, number>();
  const plan = new Map<string, ClipPlan>();
  const locatedByRel = new Map(located.map((item) => [item.rel, item.key]));
  for (const rel of rels) {
    const reason = skipReason(rel);
    if (reason) {
      plan.set(rel, { unitName: "", subPath: "", storedName: "", skip: reason });
      continue;
    }
    const name = partsOf(rel).pop() || rel;
    let clip = canon.get(locatedByRel.get(rel) || clipStem(name)) || clipStem(name);
    const suffix = suffixOf(name);
    const slot = `${clip}\0${suffix.toLowerCase()}`;
    const count = (used.get(slot) || 0) + 1;
    used.set(slot, count);
    if (count > 1) clip = `${clip}_${count}`;
    plan.set(rel, { unitName: clip, subPath: "", storedName: `${clip}${suffix}`, skip: "" });
  }
  return plan;
}
