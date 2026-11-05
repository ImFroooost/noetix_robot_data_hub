"""Fold an upload into one data unit per clip.

``plan_clip_units`` ignores directories. Each extension is stored in its own
format directory, and files that share a clip name share one data unit.
``plan_followed_paths`` keeps the uploaded directories.
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


def _redundant_clip_dir(dirname: str, clip: str) -> bool:
    """A folder that only renames one clip, plus an optional short take number, is not a content tree."""
    if not dirname or not clip or not any(char.isalpha() for char in dirname):
        return False
    if clip == dirname:
        return True
    prefix = dirname + "_"
    if not clip.startswith(prefix):
        return False
    extra = clip[len(prefix) :]
    return extra.isdigit() and 1 <= len(extra) <= 4


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
    """Ignore every directory and group files by clip name.

    Used when the upload does not follow paths. Format stays out of the unit
    path; storage writes each extension into its own format directory, and
    files that share a clip name share one data unit.
    """
    rels = [_posix(rel) for rel in rel_paths if _posix(rel)]
    keys: dict[str, set[str]] = defaultdict(set)
    located: list[tuple[str, str]] = []
    for rel in rels:
        if _skip_reason(rel):
            continue
        name = PurePosixPath(rel).name
        key = clip_stem(name)
        located.append((rel, key))
        keys[key].add(_ext_key(name))
    canon = _merge_actor_suffixes(keys)
    used: dict[tuple[str, str], int] = {}
    plan: dict[str, dict[str, str]] = {}
    for rel in rels:
        reason = _skip_reason(rel)
        if reason:
            plan[rel] = {"unit_name": "", "sub_path": "", "stored_name": "", "skip": reason}
            continue
        name = PurePosixPath(rel).name
        key = next(item[1] for item in located if item[0] == rel)
        clip = canon.get(key, key)
        suffix = _suffix(name)
        slot = (clip, suffix.lower())
        used[slot] = used.get(slot, 0) + 1
        if used[slot] > 1:
            clip = f"{clip}_{used[slot]}"
        plan[rel] = {
            "unit_name": clip,
            "sub_path": "",
            "stored_name": f"{clip}{suffix}",
            "skip": "",
        }
    return plan
