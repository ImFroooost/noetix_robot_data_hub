"""Choose which human motion file to retarget, and which robot styles are missing."""

from __future__ import annotations

from pathlib import Path

from .unit_names import normalize_unit_stem

KIND_RANK = {"skeleton": 0, "merged": 1, "object": 2}
FORMAT_RANK = {"fbx": 0, "bvh": 1, "smpl": 2}
SOURCE_FORMATS = frozenset(FORMAT_RANK)


def file_format(name: str, fmt: str = "") -> str:
    raw = (fmt or Path(name).suffix.lstrip(".")).strip().lower()
    if raw == "npz":
        return "smpl"
    return raw


def motion_kind(annotation: dict | None) -> str:
    kind = str((annotation or {}).get("motion_kind") or "").strip().lower()
    if kind in KIND_RANK:
        return kind
    return "skeleton"


def is_human_retarget_source(record: dict) -> bool:
    if str(record.get("ontology") or "") != "human":
        return False
    if str(record.get("modality") or "") != "motion":
        return False
    return file_format(str(record.get("name") or ""), str(record.get("format") or "")) in SOURCE_FORMATS


def source_sort_key(record: dict) -> tuple:
    kind = motion_kind(record.get("annotation"))
    fmt = file_format(str(record.get("name") or ""), str(record.get("format") or ""))
    return (
        KIND_RANK.get(kind, 9),
        FORMAT_RANK.get(fmt, 9),
        str(record.get("name") or ""),
    )


def choose_human_source(files: list[dict]) -> dict | None:
    candidates = [item for item in files if is_human_retarget_source(item)]
    if not candidates:
        return None
    return min(candidates, key=source_sort_key)


def robot_styles_present(files: list[dict]) -> set[str]:
    styles: set[str] = set()
    for item in files:
        if str(item.get("ontology") or "") != "robot":
            continue
        if str(item.get("modality") or "") != "motion":
            continue
        if file_format(str(item.get("name") or ""), str(item.get("format") or "")) != "csv":
            continue
        style = str(item.get("robot_style") or "").strip()
        if style:
            styles.add(style)
    return styles


def missing_robot_styles(files: list[dict], styles: list[str]) -> list[str]:
    if choose_human_source(files) is None:
        return []
    present = robot_styles_present(files)
    return [style for style in styles if style not in present]


def output_stem(source_name: str, skeleton: str | None = None) -> str:
    stem = Path(source_name).stem
    base = normalize_unit_stem(stem) or stem
    token = str(skeleton or "").strip()
    if not token:
        return base
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in token).strip("_")
    # ``_skeleton_`` is stripped by normalize_unit_stem, so extra armatures stay in this unit.
    return f"{base}_skeleton_{safe}" if safe else base


def human_height_m(annotation: dict | None) -> float | None:
    raw = str((annotation or {}).get("height") or "").strip()
    if not raw:
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    if value > 3:
        value = value / 100.0
    if 0.8 <= value <= 2.5:
        return value
    return None
