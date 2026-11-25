"""Move motion files under skeleton / object / merged, then rewrite index paths.

Old:  data/human/motion/<format>/<batch>/...
      data/robot/<style>/motion/<acquire>/<format>/<batch>/...
New:  the same path with skeleton, object or merged inserted before <format>.
"""

from __future__ import annotations

import os
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.services.unit_names import normalize_unit_stem, split_file_version  # noqa: E402

HUB = ROOT / "data" / "hub_repo"
KINDS = ("skeleton", "object", "merged")
KIND_SET = set(KINDS)
ACQUIRE = {"omniretarget", "umr", "gmr", "frax"}
PATH_RE = re.compile(
    r'"(data/(?:human/motion|robot/[^"]+/motion)/[^"]*)"'
)
EMBEDDED_RE = re.compile(
    r'"([^"]*::)(data/(?:human/motion|robot/[^"]+/motion)/[^"]*)"'
)


def insert_at(parts: list[str]) -> int | None:
    """Index of the format segment in a motion path that still lacks a kind."""
    if len(parts) < 5 or parts[0] != "data":
        return None
    if parts[1] == "human" and parts[2] == "motion":
        idx = 3
    elif parts[1] == "robot" and len(parts) > 5 and parts[3] == "motion":
        idx = 4
        if idx < len(parts) and parts[idx] in ACQUIRE:
            idx += 1
    else:
        return None
    if idx >= len(parts) or parts[idx] in KIND_SET:
        return None
    return idx


def batch_and_unit(rel: str) -> tuple[str, str]:
    parts = rel.split("/")
    idx = insert_at(parts)
    if idx is None or idx + 1 >= len(parts):
        return "", ""
    batch = parts[idx + 1]
    version, rest = split_file_version(parts[idx + 2 :])
    del version
    if not rest:
        return batch, ""
    sub = "/".join(rest[:-1])
    stem = Path(rest[-1]).stem
    raw = f"{sub}_{stem}" if sub else stem
    unit = normalize_unit_stem(raw.replace("/", "_")) or raw.replace("/", "_")
    return batch, unit


def kind_of(rel: str, files: dict, units: dict) -> str:
    row = files.get(rel) if isinstance(files.get(rel), dict) else {}
    stored = str(((row or {}).get("annotation") or {}).get("motion_kind") or "").strip().lower()
    if stored in KIND_SET:
        return stored
    if Path(rel).stem.lower().endswith("_merged"):
        return "merged"
    batch, unit = batch_and_unit(rel)
    unit_row = units.get(f"{batch}::{unit}") if batch and unit else None
    if isinstance(unit_row, dict):
        unit_kind = str((unit_row.get("annotation") or {}).get("motion_kind") or "").strip().lower()
        if unit_kind in KIND_SET:
            return unit_kind
    return "skeleton"


def new_rel(rel: str, kind: str) -> str:
    parts = rel.split("/")
    idx = insert_at(parts)
    if idx is None:
        return rel
    parts.insert(idx, kind if kind in KIND_SET else "skeleton")
    return "/".join(parts)


def iter_motion_files() -> list[Path]:
    found: list[Path] = []
    human = HUB / "data" / "human" / "motion"
    robot = HUB / "data" / "robot"
    roots = [human]
    if robot.is_dir():
        roots.extend(path / "motion" for path in robot.iterdir() if (path / "motion").is_dir())
    for base in roots:
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [name for name in dirnames if not name.startswith(".")]
            # Still walk .file_versions; it is a dot directory we must not skip.
            hidden = [
                name
                for name in os.listdir(dirpath)
                if name.startswith(".") and (Path(dirpath) / name).is_dir()
            ]
            for name in hidden:
                if name == ".file_versions" and name not in dirnames:
                    dirnames.append(name)
            for name in filenames:
                if name.startswith("."):
                    continue
                found.append(Path(dirpath) / name)
    return found


def rewrite_text(text: str, mapping: dict[str, str]) -> str:
    def quoted(match: re.Match[str]) -> str:
        path = match.group(1)
        return '"' + mapping.get(path, path) + '"'

    def embedded(match: re.Match[str]) -> str:
        path = match.group(2)
        return '"' + match.group(1) + mapping.get(path, path) + '"'

    text = EMBEDDED_RE.sub(embedded, text)
    return PATH_RE.sub(quoted, text)


def rewrite_file(path: Path, mapping: dict[str, str]) -> int:
    if not path.is_file():
        return 0
    original = path.read_text(encoding="utf-8")
    updated = rewrite_text(original, mapping)
    if updated == original:
        return 0
    tmp = path.with_suffix(path.suffix + ".motion-kind-tmp")
    tmp.write_text(updated, encoding="utf-8")
    tmp.replace(path)
    return updated.count("motion/skeleton/") + updated.count("motion/object/") + updated.count(
        "motion/merged/"
    )


def remove_empty_dirs() -> int:
    removed = 0
    bases = [HUB / "data" / "human" / "motion"]
    robot = HUB / "data" / "robot"
    if robot.is_dir():
        bases.extend(path / "motion" for path in robot.iterdir() if (path / "motion").is_dir())
    for base in bases:
        for dirpath, dirnames, filenames in os.walk(base, topdown=False):
            current = Path(dirpath)
            if current == base:
                continue
            dirnames[:] = dirnames
            if not filenames and not any(current.iterdir()):
                current.rmdir()
                removed += 1
    return removed


def main() -> None:
    import json

    meta_path = HUB / "index" / "repository.json"
    print("reading repository.json", flush=True)
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    files_meta = meta.get("files") if isinstance(meta.get("files"), dict) else {}
    units_meta = meta.get("units") if isinstance(meta.get("units"), dict) else {}
    del meta

    print("listing motion files", flush=True)
    paths = iter_motion_files()
    print(f"files {len(paths)}", flush=True)
    map_path = HUB / "index" / "motion_kind_move_map.json"
    previous: dict[str, str] = {}
    if map_path.is_file():
        loaded = json.loads(map_path.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            previous = {str(key): str(value) for key, value in loaded.items()}
    mapping: dict[str, str] = {}
    counts: Counter[str] = Counter()
    for src in paths:
        rel = src.relative_to(HUB).as_posix()
        kind = kind_of(rel, files_meta, units_meta)
        dest_rel = new_rel(rel, kind)
        if dest_rel == rel:
            continue
        mapping[rel] = dest_rel
        counts[kind] += 1
    print("to move", dict(counts), "total", len(mapping), flush=True)
    combined = {**previous, **mapping}
    map_path.write_text(json.dumps(combined, ensure_ascii=False), encoding="utf-8")

    moved = 0
    for src_rel, dest_rel in mapping.items():
        src = HUB / src_rel
        dest = HUB / dest_rel
        if not src.exists() and dest.exists():
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            raise SystemExit(f"目标已存在，停止：{dest_rel}")
        os.rename(src, dest)
        moved += 1
        if moved % 5000 == 0:
            print(f"moved {moved}", flush=True)
    print(f"moved {moved}", flush=True)
    mapping = combined

    for name in (
        "repository.json",
        "catalog.json",
        "catalog_delta.json",
        "auto_retarget_state.json",
    ):
        path = HUB / "index" / name
        print(f"rewriting {name}", flush=True)
        rewrite_file(path, mapping)
    removed = remove_empty_dirs()
    print(f"removed empty dirs {removed}", flush=True)
    map_path.unlink(missing_ok=True)
    print("done", flush=True)


if __name__ == "__main__":
    main()
