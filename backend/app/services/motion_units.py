"""Fold a mocap folder into one data unit per clip.

Capture folders keep the same motion in ``bvh/``, ``fbx/``, ``npz/`` and so on.
BVH names often add an actor and a ``_Skeleton`` suffix. A hub batch stores
each clip once per format, under the shared clip name, the way
``human/motion/<format>/<batch>/`` already does.

Directories that only sort files by format, and a single wrapper around those
directories, are not part of the unit. A real content tree such as
``CMU/102/`` stays in the unit name.
"""

from __future__ import annotations

import re
from collections import defaultdict
from pathlib import PurePosixPath

from .unit_names import normalize_unit_stem

# Directory names that mean "this format", not a content folder.
# A folder may also be named like ``2026-10-15-B类-BVH``: the format is the last piece.
FORMAT_BUCKETS = frozenset(
    {
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
    }
)
_FORMAT_TAIL = re.compile(
    r"(?:^|[\s._-])(?:"
    + "|".join(sorted((FORMAT_BUCKETS - {"temp"}), key=len, reverse=True))
    + r")$",
    re.I,
)
_SKIP_EXT = frozenset({"zip", "rar", "7z", "gz"})
_ACTOR_TOKEN = re.compile(r"^(?:[A-Za-z]{2,20})$")


def _posix(rel: str) -> str:
    return str(rel or "").replace("\\", "/").lstrip("/")


def _suffix(name: str) -> str:
    lower = name.lower()
    if lower.endswith(".ser.pkl"):
        return name[lower.rfind(".ser.pkl") :]
    return PurePosixPath(name).suffix


def _ext_key(name: str) -> str:
    return _suffix(name).lower().lstrip(".")


def _is_container(name: str) -> bool:
    low = name.lower()
    if low in FORMAT_BUCKETS:
        return True
    return _FORMAT_TAIL.search(low) is not None


def clip_stem(filename: str) -> str:
    """Clip name with the role suffix removed and spaces folded to underscores."""
    name = PurePosixPath(filename).name
    suffix = _suffix(name)
    stem = name[: -len(suffix)] if suffix else name
    stem = normalize_unit_stem(stem) or stem
    stem = re.sub(r"\s+", "_", stem.strip())
    stem = re.sub(r"_+", "_", stem).strip("._")
    return stem or PurePosixPath(filename).stem


def _skip_reason(rel: str) -> str:
    path = PurePosixPath(_posix(rel))
    if _ext_key(path.name) in _SKIP_EXT:
        return "压缩包不入库，使用其中已经解开的文件"
    if any(part.lower() == "temp" for part in path.parts[:-1]):
        return "临时文件不入库"
    return ""


def _wrapper_prefixes(rels: list[str]) -> set[tuple[str, ...]]:
    """Directories that only exist to hold format folders."""
    under: dict[tuple[str, ...], list[tuple[str, ...]]] = defaultdict(list)
    for rel in rels:
        if _skip_reason(rel):
            continue
        parts = PurePosixPath(rel).parts[:-1]
        for index in range(len(parts)):
            under[parts[: index + 1]].append(parts)
    wrappers: set[tuple[str, ...]] = set()
    for prefix, nested in under.items():
        if all(
            any(_is_container(seg) for seg in parts[len(prefix) :])
            for parts in nested
        ):
            wrappers.add(prefix)
    return wrappers


def _content_dirs(rel: str, wrappers: set[tuple[str, ...]]) -> tuple[str, ...]:
    parts = PurePosixPath(_posix(rel)).parts[:-1]
    kept: list[str] = []
    for index, part in enumerate(parts):
        prefix = parts[: index + 1]
        if prefix in wrappers or _is_container(part):
            continue
        kept.append(part)
    return tuple(kept)


def _joinable(extra: str, longer_exts: set[str], shorter_exts: set[str]) -> bool:
    if not extra or "_" in extra:
        return False
    if longer_exts & shorter_exts:
        return False
    if _ACTOR_TOKEN.match(extra):
        return True
    # ``跑步LK_001_1.bvh`` next to ``跑步LK_001.fbx``.
    return extra.isdigit() and len(extra) == 1 and longer_exts <= {"bvh"}


def _merge_actor_suffixes(keys: dict[str, set[str]]) -> dict[str, str]:
    """Map a longer BVH key onto the shorter clip key used by the other formats."""
    parent: dict[str, str] = {}
    for key, exts in keys.items():
        candidates: list[str] = []
        for other, other_exts in keys.items():
            if other == key or not key.startswith(other + "_"):
                continue
            extra = key[len(other) + 1 :]
            if _joinable(extra, exts, other_exts):
                candidates.append(other)
        if candidates:
            parent[key] = max(candidates, key=len)
    resolved: dict[str, str] = {}
    for key in keys:
        seen: set[str] = set()
        current = key
        while current in parent and current not in seen:
            seen.add(current)
            current = parent[current]
        resolved[key] = current
    return resolved


def plan_followed_paths(
    rel_paths: list[str],
    *,
    strip_common_root: bool,
) -> dict[str, dict[str, str]]:
    """Keep each file's directory and filename.

    Folder picks include the chosen folder as the first segment. That segment
    is the batch name, so it is removed. A zip keeps the paths inside the
    archive.
    """
    rels = [_posix(rel) for rel in rel_paths if _posix(rel)]
    kept = [rel for rel in rels if not _ext_key(PurePosixPath(rel).name) in _SKIP_EXT]
    firsts = {PurePosixPath(rel).parts[0] for rel in kept if PurePosixPath(rel).parts}
    drop_root = strip_common_root and len(firsts) == 1 and all(
        len(PurePosixPath(rel).parts) > 1 for rel in kept
    )
    root_name = next(iter(firsts)) if drop_root else ""
    plan: dict[str, dict[str, str]] = {}
    for rel in rels:
        name = PurePosixPath(rel).name
        if _ext_key(name) in _SKIP_EXT:
            plan[rel] = {
                "unit_name": "",
                "sub_path": "",
                "stored_name": "",
                "skip": "压缩包不入库，使用其中已经解开的文件",
            }
            continue
        parts = PurePosixPath(rel).parts
        if drop_root and parts and parts[0] == root_name:
            parts = parts[1:]
        sub_path = "/".join(parts[:-1])
        stem = clip_stem(name)
        unit = f"{sub_path.replace('/', '_')}_{stem}" if sub_path else stem
        plan[rel] = {
            "unit_name": unit,
            "sub_path": sub_path,
            "stored_name": name,
            "skip": "",
        }
    return plan


def plan_clip_units(rel_paths: list[str]) -> dict[str, dict[str, str]]:
    """Plan how each uploaded relative path is stored.

    ``skip`` is set for zip archives and ``temp/`` files. Otherwise
    ``unit_name`` is the data-unit name, ``sub_path`` is empty when the
    folder was only a format layout, and ``stored_name`` is the filename
    written into the batch.
    """
    rels = [_posix(rel) for rel in rel_paths if _posix(rel)]
    wrappers = _wrapper_prefixes(rels)
    located: list[tuple[str, tuple[str, ...], str, str]] = []
    by_place: dict[tuple[str, ...], dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for rel in rels:
        if _skip_reason(rel):
            continue
        name = PurePosixPath(rel).name
        place = _content_dirs(rel, wrappers)
        # The selected folder name is the batch, not part of the clip.
        if place and all(
            _content_dirs(other, wrappers)[:1] == place[:1]
            for other in rels
            if not _skip_reason(other)
        ):
            place = place[1:]
        key = clip_stem(name)
        ext = _ext_key(name)
        located.append((rel, place, key, ext))
        by_place[place][key].add(ext)

    # One shared directory left means a zip-extract wrapper, not a content tree.
    nonempty = {place for place in by_place if place}
    if len(nonempty) == 1:
        relocated: list[tuple[str, tuple[str, ...], str, str]] = []
        by_place = defaultdict(lambda: defaultdict(set))
        for rel, _place, key, ext in located:
            relocated.append((rel, (), key, ext))
            by_place[()][key].add(ext)
        located = relocated

    canon_by_place = {place: _merge_actor_suffixes(keys) for place, keys in by_place.items()}
    used: dict[tuple[str, str], int] = {}
    plan: dict[str, dict[str, str]] = {}
    for rel in rels:
        reason = _skip_reason(rel)
        if reason:
            plan[rel] = {"unit_name": "", "sub_path": "", "stored_name": "", "skip": reason}
            continue
        name = PurePosixPath(rel).name
        place, key, _ext = next(item[1:] for item in located if item[0] == rel)
        key = canon_by_place.get(place, {}).get(key, key)
        suffix = _suffix(name)
        sub_path = "/".join(place)
        clip = key
        unit = f"{sub_path.replace('/', '_')}_{clip}" if sub_path else clip
        slot = (sub_path, clip, suffix.lower())
        used[slot] = used.get(slot, 0) + 1
        if used[slot] > 1:
            clip = f"{clip}_{used[slot]}"
            unit = f"{sub_path.replace('/', '_')}_{clip}" if sub_path else clip
        plan[rel] = {
            "unit_name": unit,
            "sub_path": sub_path,
            "stored_name": f"{clip}{suffix}",
            "skip": "",
        }
    return plan
