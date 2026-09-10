"""Group multi-format human motion files from a ZIP (or directory tree)."""

from __future__ import annotations

import re
import zipfile
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from .zip_names import decode_zip_filename


def folder_name_from_zip_filename(filename: str | None) -> str:
    """``260729.zip`` → ``260729``; sanitize path separators."""
    base = Path(filename or "upload").name
    if base.lower().endswith(".zip"):
        base = base[:-4]
    base = base.strip().strip(".")
    base = re.sub(r"[/\\]+", "_", base)
    base = re.sub(r"\s+", " ", base).strip()
    return base or "upload"

HUMAN_EXTS = frozenset(
    {"bvh", "csv", "fbx", "tak", "smpl", "npz", "npy", "pkl", "txt", "ser.pkl"}
)
_SKIP_EXTS = frozenset({"", "zip", "ds_store"})

# BVH exports often append _Skeleton0 / .bvh_Skeleton0 / " Skeleton 001".
_STRIP_SUFFIXES = (
    re.compile(r"(?:\.[A-Za-z0-9]{1,8})?[\s_]+Skeleton(?:[\s._-]?\d+)?$", re.I),
    re.compile(r"[\s_]*Skeleton(?:\s+\d+)?$", re.I),
)

_IGNORE_NAMES = re.compile(r"^(?:\.DS_Store|Thumbs\.db|desktop\.ini)$", re.I)


@dataclass
class GroupedMotion:
    """One logical clip with one or more human format files."""

    key: str
    display_stem: str
    files: dict[str, Path] = field(default_factory=dict)  # format -> path


def normalize_motion_stem(filename: str) -> str:
    stem = Path(filename).stem.strip()
    for pat in _STRIP_SUFFIXES:
        stem = pat.sub("", stem)
    return stem.strip()


def infer_human_format(ext: str) -> str:
    e = (ext or "").lower().lstrip(".")
    if e in ("npz", "npy"):
        return "smpl"
    if e in ("ser.pkl", "ser_pkl"):
        return "ser.pkl"
    return e


def human_format_from_filename(filename: str) -> str:
    """Resolve format from filename; ``*.ser.pkl`` stays distinct from ``*.pkl``."""
    name = (filename or "").lower()
    if name.endswith(".ser.pkl"):
        return "ser.pkl"
    return infer_human_format(Path(filename).suffix)


def is_importable_filename(filename: str) -> bool:
    if _is_ignored(Path(filename)):
        return False
    fmt = human_format_from_filename(filename)
    return bool(fmt) and fmt not in _SKIP_EXTS


def _is_ignored(path: Path) -> bool:
    name = path.name
    return (not name) or name.startswith(".") or bool(_IGNORE_NAMES.match(name))


def group_human_files(paths: list[Path]) -> tuple[list[GroupedMotion], list[str]]:
    """Group files by normalized stem. Same format twice → warning, last wins."""
    warnings: list[str] = []
    buckets: dict[str, dict[str, Path]] = defaultdict(dict)
    display: dict[str, str] = {}

    for path in paths:
        if not path.is_file() or _is_ignored(path):
            continue
        name_l = path.name.lower()
        if name_l.endswith(".ser.pkl"):
            ext = "ser.pkl"
        else:
            ext = path.suffix.lower().lstrip(".")
        if not is_importable_filename(path.name):
            continue
        key = normalize_motion_stem(path.name).lower()
        if not key:
            continue
        # For *.ser.pkl, stem ends with .ser after Path.stem — normalize again
        if ext == "ser.pkl" and key.endswith(".ser"):
            key = key[: -len(".ser")]
        fmt = infer_human_format(ext)
        if fmt in buckets[key]:
            warnings.append(
                f"「{display.get(key, key)}」重复 {fmt}："
                f"{buckets[key][fmt].name} 与 {path.name}，保留后者"
            )
        buckets[key][fmt] = path
        # Prefer non-Skeleton basename for display
        stem = normalize_motion_stem(path.name)
        prev = display.get(key, "")
        if (not prev) or ("_Skeleton" in Path(prev).name if prev else False):
            display[key] = stem
        elif "_Skeleton" not in path.stem:
            display[key] = stem

    groups = [
        GroupedMotion(key=k, display_stem=display.get(k, k), files=dict(files))
        for k, files in sorted(buckets.items(), key=lambda kv: kv[0])
    ]
    return groups, warnings


def iter_zip_human_members(zf: zipfile.ZipFile) -> list[tuple[zipfile.ZipInfo, str]]:
    out: list[tuple[zipfile.ZipInfo, str]] = []
    for info in zf.infolist():
        if info.is_dir():
            continue
        name = decode_zip_filename(info)
        base = Path(name).name
        if _is_ignored(Path(base)):
            continue
        if is_importable_filename(base):
            out.append((info, name))
    return out


def safe_extract_member(
    zf: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    dest_dir: Path,
    *,
    filename: str | None = None,
) -> Path:
    """Extract one member with zip-slip guard. Returns absolute extracted path."""
    dest_dir = dest_dir.resolve()
    member = filename or decode_zip_filename(info)
    rel = Path(member.replace("\\", "/"))
    if rel.is_absolute() or ".." in rel.parts:
        raise ValueError(f"非法 zip 路径: {member}")
    target = (dest_dir / rel).resolve()
    if not str(target).startswith(str(dest_dir)):
        raise ValueError(f"非法 zip 路径: {member}")
    target.parent.mkdir(parents=True, exist_ok=True)
    with zf.open(info) as src, target.open("wb") as out:
        while True:
            chunk = src.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
    return target


def extract_and_group_zip(zip_path: Path, work_dir: Path) -> tuple[list[GroupedMotion], list[str]]:
    warnings: list[str] = []
    work_dir.mkdir(parents=True, exist_ok=True)
    extracted: list[Path] = []
    with zipfile.ZipFile(zip_path) as zf:
        members = iter_zip_human_members(zf)
        if not members:
            return [], ["ZIP 中未找到可导入文件（按后缀识别格式，如 bvh/csv/fbx/tak 或新后缀）"]
        for info, name in members:
            try:
                extracted.append(safe_extract_member(zf, info, work_dir, filename=name))
            except Exception as e:
                warnings.append(f"解压失败 {name}: {e}")
    groups, gw = group_human_files(extracted)
    warnings.extend(gw)
    return groups, warnings
