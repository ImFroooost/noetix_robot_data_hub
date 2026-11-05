"""Filesystem-first repository for hub_repo/data, hub_repo/3d_model and index.

The physical files are the source of truth.  ``index/repository.json`` stores
only metadata (annotations, taxonomy tags and empty batches/instances).
``index/catalog.json`` is a full snapshot rebuilt on demand or once a day when
the machine is idle.  ``index/catalog_delta.json`` records uploads, deletions
and renames so browse reads stay current without scanning the whole tree.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
import shutil
import tempfile
import threading
import zipfile
from collections import defaultdict
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO

from ..config import settings
from .media_probe import probe_file, public_media
from .unit_names import (
    FILE_VERSION_DIR,
    ORIGINAL_FILE_VERSION,
    cluster_unit_names,
    file_version_from_path,
    normalize_unit_stem,
    split_file_version,
    stems_same_unit,
)
from .zip_names import decode_zip_filename

ProgressFn = Callable[[str, int, str], None]

DEFAULT_CSV_FPS = 30.0

ONTOLOGIES = ("human", "robot")
MODALITIES = ("tpv_video", "fpv_video", "motion", "text", "audio", "log")
FPV_CHANNELS = ("rgb", "depth")
ROBOT_ACQUIRE_METHODS = ("omniretarget", "umr", "gmr")
DEFAULT_ROBOT_ACQUIRE_METHOD = "omniretarget"
MOTION_KINDS = ("skeleton", "object", "merged")
MODEL_KINDS = {
    "human": ("fbx", "bvh", "smpl", "blend"),
    "robot": ("standard_description", "fbx", "blend"),
}
STANDARD_DESCRIPTION_DIRS = ("meshes", "mjcf", "urdf")

_SAFE_RE = re.compile(r"[^\w\u4e00-\u9fff\-.]+", re.UNICODE)
_INDEX_LOCK = threading.RLock()
_CATALOG_MAX_AGE_SEC = 10 * 60
_catalog_raw: dict[str, Any] | None = None
_catalog_mtime: float | None = None
_catalog_view: dict[str, Any] | None = None
_catalog_view_key: tuple[float | None, float | None] | None = None
_overlay_cache: dict[tuple[Any, ...], dict[str, Any]] = {}
_rebuild_lock = threading.Lock()
_rebuild_running = False
_status_lock = threading.Lock()
_rebuild_status: dict[str, Any] = {
    "status": "idle",
    "phase": "",
    "percent": 0,
    "message": "",
    "stats": None,
    "error": None,
    "started_at": None,
    "finished_at": None,
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _iso_or_empty(value: Any) -> str:
    return str(value or "").strip()


def _min_iso(values: list[str]) -> str:
    items = [item for item in values if item]
    return min(items) if items else ""


def _max_iso(values: list[str]) -> str:
    items = [item for item in values if item]
    return max(items) if items else ""


def _ensure_created_at(row: dict[str, Any], fallback: str | None = None) -> str:
    current = _iso_or_empty(row.get("created_at"))
    if current:
        return current
    stamp = fallback or _now()
    row["created_at"] = stamp
    return stamp


def _file_uploaded_at(rec: dict[str, Any]) -> str:
    uploader = rec.get("uploader") or {}
    return _iso_or_empty(rec.get("uploaded_at")) or _iso_or_empty(uploader.get("uploaded_at"))


def _file_annotated_at(rec: dict[str, Any], metadata: dict[str, Any]) -> str:
    row = (metadata.get("files") or {}).get(rec.get("path")) or {}
    return _iso_or_empty(row.get("updated_at")) or _iso_or_empty(rec.get("annotated_at"))


def _attach_sort_timestamps(
    units: list[dict[str, Any]],
    batches: list[dict[str, Any]],
    metadata: dict[str, Any],
) -> None:
    """Fill created/uploaded/modified times used by the browse sort bar.

    created_at: first time the unit/batch appeared in repository.json
    uploaded_at: latest file upload time inside the unit/batch
    modified_at: latest file upload or annotation-edit time inside the unit/batch
    """
    units_meta = metadata.get("units") or {}
    batches_meta = metadata.get("batches") or {}
    for unit in units:
        files = unit.get("files") or []
        for rec in files:
            rec["uploaded_at"] = _file_uploaded_at(rec)
        key = str(unit.get("key") or unit_key(str(unit.get("batch") or ""), str(unit.get("name") or "")))
        row = units_meta.get(key) or {}
        created = (
            _iso_or_empty(row.get("created_at"))
            or _iso_or_empty((unit.get("meta") or {}).get("created_at"))
            or _iso_or_empty(unit.get("created_at"))
        )
        uploads = [_file_uploaded_at(rec) for rec in files]
        annots = [_file_annotated_at(rec, metadata) for rec in files]
        unit_updated = _iso_or_empty(row.get("updated_at")) or _iso_or_empty(unit.get("updated_at"))
        uploaded = _max_iso(uploads)
        modified = _max_iso([uploaded, *annots, unit_updated])
        if not created:
            created = _min_iso([*uploads, *(_iso_or_empty(rec.get("modified_at")) for rec in files), unit_updated])
        unit["created_at"] = created
        unit["uploaded_at"] = uploaded
        unit["modified_at"] = modified
    for batch in batches:
        row = batches_meta.get(batch.get("name") or "") or {}
        kids = batch.get("units") or []
        created = (
            _iso_or_empty(row.get("created_at"))
            or _iso_or_empty((batch.get("meta") or {}).get("created_at"))
            or _iso_or_empty(batch.get("created_at"))
        )
        uploaded = _max_iso([_iso_or_empty(unit.get("uploaded_at")) for unit in kids])
        modified = _max_iso(
            [*(_iso_or_empty(unit.get("modified_at")) for unit in kids), _iso_or_empty(row.get("updated_at"))]
        )
        if not created:
            created = _min_iso([_iso_or_empty(unit.get("created_at")) for unit in kids])
        batch["created_at"] = created
        batch["uploaded_at"] = uploaded
        batch["modified_at"] = modified


def root() -> Path:
    path = Path(settings.hub_repo_root)
    ensure_layout(path)
    return path


def ensure_layout(base: Path | None = None) -> Path:
    base = Path(base or settings.hub_repo_root)
    (base / "index").mkdir(parents=True, exist_ok=True)
    for ontology in ONTOLOGIES:
        (base / "data" / ontology).mkdir(parents=True, exist_ok=True)
        (base / "3d_model" / ontology).mkdir(parents=True, exist_ok=True)
    if not metadata_path(base).is_file():
        _write_json(
            metadata_path(base),
            {
                "version": 1,
                "updated_at": _now(),
                "batches": {},
                "units": {},
                "models": {},
                "file_uploaders": {},
                "upload_sessions": [],
            },
        )
    return base


def metadata_path(base: Path | None = None) -> Path:
    return Path(base or settings.hub_repo_root) / "index" / "repository.json"


def catalog_path(base: Path | None = None) -> Path:
    return Path(base or settings.hub_repo_root) / "index" / "catalog.json"


def safe_name(value: str, *, label: str = "名称") -> str:
    value = (value or "").strip().strip(".")
    cleaned = _SAFE_RE.sub("_", value)
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    if not cleaned or cleaned in {".", ".."} or "/" in cleaned or "\\" in cleaned:
        raise ValueError(f"{label}无效")
    return cleaned


def clean_motion_kind(value: str) -> str:
    kind = str(value or "").strip().lower()
    if kind in MOTION_KINDS:
        return kind
    return "skeleton"


def clean_file_version(name: str) -> str:
    """Return a storage version name. Empty and 「原版」 stay the original files."""
    text = str(name or "").strip()
    if not text or text == ORIGINAL_FILE_VERSION:
        return ORIGINAL_FILE_VERSION
    if text == FILE_VERSION_DIR or text.startswith(".") or len(text) > 80:
        raise ValueError("文件版本名无效")
    return preserved_segment(text, label="文件版本")


def preserved_segment(value: str, *, label: str = "名称") -> str:
    """Keep an uploaded file or folder name unchanged.

    Only reject empty segments and path separators. Spaces, punctuation and
    the original spelling stay, so the stored tree matches the upload.
    """
    text = str(value or "")
    if (
        not text
        or text in {".", ".."}
        or "\x00" in text
        or "/" in text
        or "\\" in text
    ):
        raise ValueError(f"{label}无效")
    return text


def safe_relative_path(value: str) -> Path:
    p = Path(value)
    if p.is_absolute() or ".." in p.parts:
        raise ValueError("非法相对路径")
    return p


def _write_json(path: Path, data: dict[str, Any], *, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = dict(data)
    payload["updated_at"] = _now()
    tmp = path.with_suffix(path.suffix + ".tmp")
    if compact:
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    else:
        text = json.dumps(payload, ensure_ascii=False, indent=2)
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def _invalidate_overlay_cache() -> None:
    _overlay_cache.clear()


def _invalidate_catalog_cache() -> None:
    global _catalog_raw, _catalog_mtime, _catalog_view, _catalog_view_key
    _catalog_raw = None
    _catalog_mtime = None
    _catalog_view = None
    _catalog_view_key = None
    _invalidate_overlay_cache()


def _invalidate_catalog_view() -> None:
    global _catalog_view, _catalog_view_key
    _catalog_view = None
    _catalog_view_key = None
    _invalidate_overlay_cache()


_metadata_cache: dict[str, Any] | None = None
_metadata_mtime: float | None = None


def read_metadata() -> dict[str, Any]:
    global _metadata_cache, _metadata_mtime
    ensure_layout()
    path = metadata_path()
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = None
    with _INDEX_LOCK:
        if _metadata_cache is not None and _metadata_mtime == mtime:
            return _metadata_cache
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = {}
        data.setdefault("version", 1)
        data.setdefault("batches", {})
        data.setdefault("units", {})
        data.setdefault("models", {})
        data.setdefault("file_uploaders", {})
        data.setdefault("upload_sessions", [])
        data.setdefault("file_media", {})
        data.setdefault("files", {})
        _metadata_cache = data
        _metadata_mtime = mtime
        return data


def update_metadata(mutator) -> dict[str, Any]:
    with _INDEX_LOCK:
        data = read_metadata()
        mutator(data)
        data["version"] = int(data.get("version") or 1) + 1
        _write_json(metadata_path(), data)
        global _metadata_cache, _metadata_mtime, _browse_force_sync, _local_write_gen
        _metadata_cache = None
        _metadata_mtime = None
        _browse_force_sync = True
        _local_write_gen += 1
        _invalidate_overlay_cache()
        return data


def unit_key(batch: str, unit_name: str) -> str:
    return f"{batch}::{unit_name}"


def _unit_meta_for_names(
    metadata: dict[str, Any], batch: str, names: list[str]
) -> dict[str, Any]:
    units = metadata.get("units") or {}
    merged: dict[str, Any] = {}
    for name in names:
        raw = units.get(unit_key(batch, name))
        if not raw:
            continue
        if not merged:
            merged = dict(raw)
            continue
        tags = dict(merged.get("taxonomy_tag_ids") or {})
        tags.update(raw.get("taxonomy_tag_ids") or {})
        merged["taxonomy_tag_ids"] = tags
        notes = dict(merged.get("annotation") or {})
        notes.update(raw.get("annotation") or {})
        merged["annotation"] = notes
        extra = dict(merged.get("meta") or {})
        extra.update(raw.get("meta") or {})
        merged["meta"] = extra
        created = _min_iso([_iso_or_empty(merged.get("created_at")), _iso_or_empty(raw.get("created_at"))])
        if created:
            merged["created_at"] = created
        updated = _max_iso([_iso_or_empty(merged.get("updated_at")), _iso_or_empty(raw.get("updated_at"))])
        if updated:
            merged["updated_at"] = updated
    return merged


def _file_id(rel_path: str) -> str:
    return hashlib.sha1(rel_path.encode("utf-8")).hexdigest()[:20]


def _file_record(path: Path, base: Path, parsed: dict[str, Any]) -> dict[str, Any]:
    stat = path.stat()
    rel = path.relative_to(base).as_posix()
    record: dict[str, Any] = {
        "id": _file_id(rel),
        "path": rel,
        "name": path.name,
        "size": stat.st_size,
        "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
    }
    if "unit_name" in parsed:
        record["unit_name"] = parsed.pop("unit_name")
    else:
        record["unit_name"] = normalize_unit_stem(path.stem) or path.stem
    record.update(parsed)
    return record


def _media_cache_valid(cached: dict[str, Any] | None, path: Path) -> bool:
    if not cached:
        return False
    try:
        stat = path.stat()
    except OSError:
        return False
    return cached.get("size") == stat.st_size and cached.get("mtime") == int(stat.st_mtime)


def _attach_cached_media(record: dict[str, Any], metadata: dict[str, Any], path: Path) -> dict[str, Any]:
    cached = (metadata.get("file_media") or {}).get(record["path"])
    if _media_cache_valid(cached, path):
        record.update(public_media(cached))
    return record


def _tag_fields(row: dict[str, Any] | None) -> dict[str, Any]:
    source = row or {}
    return {
        "taxonomy_tag_ids": dict(source.get("taxonomy_tag_ids") or {}),
        "annotation": dict(source.get("annotation") or {}),
    }


def tag_id_list(value: Any) -> list[int]:
    if value in (None, ""):
        return []
    items = value if isinstance(value, list) else [value]
    out: list[int] = []
    for item in items:
        if isinstance(item, dict):
            item = item.get("id")
        if item in (None, ""):
            continue
        try:
            number = int(item)
        except (TypeError, ValueError):
            continue
        if number > 0 and number not in out:
            out.append(number)
    return out


def _as_tag_ids(raw: Any) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    if not isinstance(raw, dict):
        return out
    for scheme, node_id in raw.items():
        ids = tag_id_list(node_id)
        if ids:
            out[str(scheme)] = ids
    return out


def apply_tag_updates(current: Any, updates: dict[str, Any]) -> dict[str, list[int]]:
    merged = _as_tag_ids(current)
    for scheme, node_ids in updates.items():
        key = str(scheme)
        if node_ids is None:
            merged.pop(key, None)
            continue
        ids = tag_id_list(node_ids)
        if ids:
            merged[key] = ids
        else:
            merged.pop(key, None)
    return merged


def parent_taxonomy_ids(
    batch: str, unit_name: str, metadata: dict[str, Any] | None = None
) -> tuple[dict[str, list[int]], dict[str, list[int]]]:
    """Return (batch_tag_ids, unit_tag_ids), matching clustered unit aliases."""
    data = metadata if metadata is not None else read_metadata()
    batch_tags = _as_tag_ids(
        ((data.get("batches") or {}).get(batch) or {}).get("taxonomy_tag_ids")
    )
    unit_tags: dict[str, list[int]] = {}
    prefix = f"{batch}::"
    for key, row in (data.get("units") or {}).items():
        if not str(key).startswith(prefix):
            continue
        alias = str(key).split("::", 1)[1]
        if alias == unit_name or stems_same_unit(alias, unit_name):
            unit_tags.update(_as_tag_ids((row or {}).get("taxonomy_tag_ids")))
    return batch_tags, unit_tags


def _ensure_path_motion_kind(record: dict[str, Any]) -> None:
    """Keep the motion sub-kind on the file when the directory already says it."""
    if str(record.get("modality") or "") != "motion":
        return
    kind = str(record.get("motion_kind") or "").strip().lower()
    if kind not in MOTION_KINDS:
        return
    annotation = record.get("annotation")
    if not isinstance(annotation, dict):
        annotation = {}
        record["annotation"] = annotation
    stored = str(annotation.get("motion_kind") or "").strip().lower()
    if stored not in MOTION_KINDS:
        annotation["motion_kind"] = kind


def _attach_own_file_tags(record: dict[str, Any], metadata: dict[str, Any]) -> dict[str, Any]:
    record.update(_tag_fields((metadata.get("files") or {}).get(record["path"])))
    _ensure_path_motion_kind(record)
    return record


def _attach_file_tags(record: dict[str, Any], metadata: dict[str, Any]) -> dict[str, Any]:
    _attach_own_file_tags(record, metadata)
    batch_tags, unit_tags = parent_taxonomy_ids(
        str(record.get("batch") or ""),
        str(record.get("unit_name") or ""),
        metadata,
    )
    record["taxonomy_tag_ids"] = {
        **batch_tags,
        **unit_tags,
        **_as_tag_ids(record.get("taxonomy_tag_ids")),
    }
    return record


def _unit_tag_index(
    metadata: dict[str, Any],
) -> tuple[dict[tuple[str, str], dict[str, int]], dict[str, list[tuple[str, dict[str, int]]]], dict[str, dict[str, dict[str, int]]]]:
    exact: dict[tuple[str, str], dict[str, int]] = {}
    by_batch: dict[str, list[tuple[str, dict[str, int]]]] = defaultdict(list)
    normalized: dict[str, dict[str, dict[str, int]]] = defaultdict(dict)
    for key, row in (metadata.get("units") or {}).items():
        if "::" not in str(key):
            continue
        batch, name = str(key).split("::", 1)
        tags = _as_tag_ids((row or {}).get("taxonomy_tag_ids"))
        exact[(batch, name)] = tags
        by_batch[batch].append((name, tags))
        norm = normalize_unit_stem(name) or name
        normalized[batch].setdefault(norm, {}).update(tags)
    return exact, by_batch, normalized


def _lookup_unit_tags(
    exact: dict[tuple[str, str], dict[str, int]],
    by_batch: dict[str, list[tuple[str, dict[str, int]]]],
    batch: str,
    unit_name: str,
    normalized: dict[str, dict[str, dict[str, int]] | None] | None = None,
) -> dict[str, int]:
    tags = dict(exact.get((batch, unit_name)) or {})
    if normalized is not None:
        norm = normalize_unit_stem(unit_name) or unit_name
        norm_tags = (normalized.get(batch) or {}).get(norm)
        if norm_tags:
            tags.update(norm_tags)
    else:
        for name, row_tags in by_batch.get(batch, []):
            if name != unit_name and stems_same_unit(name, unit_name):
                tags.update(row_tags)
    return tags


def _inherit_file_tags(
    units: list[dict[str, Any]],
    metadata: dict[str, Any],
) -> None:
    exact, by_batch, normalized = _unit_tag_index(metadata)
    batch_tags = {
        name: _as_tag_ids((row or {}).get("taxonomy_tag_ids"))
        for name, row in (metadata.get("batches") or {}).items()
    }
    for unit in units:
        unit_tags = _lookup_unit_tags(exact, by_batch, unit["batch"], unit["name"], normalized)
        if unit_tags:
            unit["taxonomy_tag_ids"] = unit_tags
        else:
            unit_tags = _as_tag_ids(unit.get("taxonomy_tag_ids"))
        inherited = {
            **(batch_tags.get(unit["batch"]) or {}),
            **unit_tags,
        }
        if not inherited:
            continue
        for rec in unit.get("files") or []:
            rec["taxonomy_tag_ids"] = {
                **inherited,
                **_as_tag_ids(rec.get("taxonomy_tag_ids")),
            }


def _apply_taxonomy_to_file_rows(
    data: dict[str, Any],
    paths: list[str],
    taxonomy_tag_ids: dict[str, int | None],
) -> None:
    files = data.setdefault("files", {})
    for path in paths:
        rel = str(path or "").strip()
        if not rel:
            continue
        _merge_tag_updates(files.setdefault(rel, {}), taxonomy_tag_ids=taxonomy_tag_ids)


def _file_paths_for_batch(snapshot: dict[str, Any], batch: str) -> list[str]:
    return [
        str(item["path"])
        for item in snapshot.get("files") or []
        if item.get("batch") == batch and item.get("path")
    ]


def _file_paths_for_units(
    snapshot: dict[str, Any], batch: str, unit_names: list[str]
) -> list[str]:
    wanted = [name for name in unit_names if name]
    if not wanted:
        return []
    paths: list[str] = []
    seen: set[str] = set()
    for unit in snapshot.get("units") or []:
        if unit.get("batch") != batch:
            continue
        name = str(unit.get("name") or "")
        if not any(name == item or stems_same_unit(name, item) for item in wanted):
            continue
        for item in unit.get("files") or []:
            path = str(item.get("path") or "")
            if path and path not in seen:
                seen.add(path)
                paths.append(path)
    return paths


def _parse_positive_fps(value: Any) -> float | None:
    try:
        fps = float(value)
    except (TypeError, ValueError):
        return None
    if fps <= 0 or fps > 10000:
        return None
    return fps


def apply_csv_fps(record: dict[str, Any]) -> dict[str, Any]:
    if str(record.get("ontology") or "").lower() != "robot":
        return record
    fmt = str(record.get("format") or "").lower()
    name = str(record.get("name") or "")
    if fmt != "csv" and not name.lower().endswith(".csv"):
        return record
    annotated = _parse_positive_fps((record.get("annotation") or {}).get("fps"))
    record["fps"] = annotated or DEFAULT_CSV_FPS
    try:
        frames = int(record["frame_count"]) if record.get("frame_count") is not None else None
    except (TypeError, ValueError):
        frames = None
    if frames and record["fps"]:
        record["duration_sec"] = frames / record["fps"]
    return record


def _merge_tag_updates(
    row: dict[str, Any],
    *,
    taxonomy_tag_ids: dict[str, int | None] | None = None,
    annotation: dict[str, Any] | None = None,
    meta: dict[str, Any] | None = None,
) -> None:
    if taxonomy_tag_ids is not None:
        row["taxonomy_tag_ids"] = apply_tag_updates(
            row.get("taxonomy_tag_ids"), taxonomy_tag_ids
        )
    if annotation is not None:
        row["annotation"] = {**(row.get("annotation") or {}), **annotation}
    if meta is not None:
        row["meta"] = {**(row.get("meta") or {}), **meta}
    _ensure_created_at(row)
    row["updated_at"] = _now()


def inspect_data_file(rel_path: str) -> dict[str, Any] | None:
    path = resolve_repo_file(rel_path)
    if not path.is_file():
        return None
    record = _parse_data_file(path, root())
    if not record:
        return None
    metadata = read_metadata()
    record["uploader"] = (metadata.get("file_uploaders") or {}).get(record["path"])
    _attach_file_tags(record, metadata)
    return apply_csv_fps(_attach_cached_media(record, metadata, path))


def probe_data_file(rel_path: str, *, force: bool = False) -> dict[str, Any] | None:
    path = resolve_repo_file(rel_path)
    if not path.is_file():
        return None
    record = inspect_data_file(rel_path)
    if not record:
        return None
    metadata = read_metadata()
    cached = (metadata.get("file_media") or {}).get(record["path"])
    if not force and _media_cache_valid(cached, path):
        record.update(public_media(cached))
        return apply_csv_fps(record)

    probed = probe_file(
        path,
        modality=str(record.get("modality") or ""),
        fmt=str(record.get("format") or ""),
    )
    stat = path.stat()
    stored = {
        **probed,
        "size": stat.st_size,
        "mtime": int(stat.st_mtime),
        "probed_at": _now(),
    }

    def mutate(data):
        media = data.setdefault("file_media", {})
        media[record["path"]] = stored

    update_metadata(mutate)
    record.update(public_media(stored))
    return apply_csv_fps(record)


def _parse_data_file(path: Path, base: Path) -> dict[str, Any] | None:
    parts = path.relative_to(base / "data").parts
    if len(parts) < 5:
        return None
    ontology = parts[0]
    if ontology not in ONTOLOGIES:
        return None
    robot_style = ""
    if ontology == "robot" and parts[1] not in MODALITIES:
        robot_style = parts[1]
        modality = parts[2]
        idx = 3
    else:
        modality = parts[1]
        idx = 2
    if modality not in MODALITIES:
        return None
    robot_acquire_method = ""
    if ontology == "robot" and modality == "motion":
        if idx < len(parts) and parts[idx] in ROBOT_ACQUIRE_METHODS:
            robot_acquire_method = parts[idx]
            idx += 1
        else:
            robot_acquire_method = DEFAULT_ROBOT_ACQUIRE_METHOD
    motion_kind = ""
    if modality == "motion":
        if idx >= len(parts) or parts[idx] not in MOTION_KINDS:
            return None
        motion_kind = parts[idx]
        idx += 1
    if modality == "fpv_video":
        if len(parts) < idx + 3 or parts[idx] not in FPV_CHANNELS:
            return None
        channel, fmt, batch = parts[idx], parts[idx + 1], parts[idx + 2]
        rest_start = idx + 3
    else:
        if len(parts) < idx + 3:
            return None
        channel, fmt, batch = "", parts[idx], parts[idx + 1]
        rest_start = idx + 2
    # Everything after batch is an optional file version, then sub_path + filename.
    file_version, remaining = split_file_version(parts[rest_start:])
    if not remaining:
        return None
    sub_path = ""
    if len(remaining) > 1:
        sub_path = "/".join(remaining[:-1])
    filename = remaining[-1]
    stem = Path(filename).stem
    if sub_path:
        unit_name = normalize_unit_stem((sub_path + "/" + stem).replace("/", "_")) or (sub_path + "_" + stem).replace("/", "_")
    else:
        unit_name = normalize_unit_stem(stem) or stem
    parsed = {
        "ontology": ontology,
        "modality": modality,
        "channel": channel,
        "format": fmt,
        "batch": batch,
        "robot_style": robot_style,
        "unit_name": unit_name,
        "sub_path": sub_path,
        "file_version": file_version or ORIGINAL_FILE_VERSION,
    }
    if motion_kind:
        parsed["motion_kind"] = motion_kind
    if robot_acquire_method:
        parsed["robot_acquire_method"] = robot_acquire_method
    return _file_record(path, base, parsed)


def _version_catalog(row: dict[str, Any] | None, files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Ordered file versions for one batch. 「原版」 is always first."""
    versions: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in (row or {}).get("file_versions") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        versions.append(
            {
                "name": name,
                "order": int(item.get("order") or 0),
                "created_at": str(item.get("created_at") or ""),
            }
        )
    if ORIGINAL_FILE_VERSION not in seen:
        versions.insert(
            0,
            {
                "name": ORIGINAL_FILE_VERSION,
                "order": 0,
                "created_at": str((row or {}).get("created_at") or ""),
            },
        )
        seen.add(ORIGINAL_FILE_VERSION)
    extra = max((int(item["order"]) for item in versions), default=0)
    for rec in files:
        name = file_version_from_path(str(rec.get("path") or ""))
        if name == ORIGINAL_FILE_VERSION:
            stored = str(rec.get("file_version") or "").strip()
            if stored:
                name = stored
        if not name or name in seen:
            continue
        extra += 1
        versions.append({"name": name, "order": extra, "created_at": ""})
        seen.add(name)
    versions.sort(key=lambda item: (int(item["order"]), str(item["name"])))
    return versions


def _apply_file_versions(
    files: list[dict[str, Any]], metadata: dict[str, Any]
) -> dict[str, list[dict[str, Any]]]:
    """Stamp file_version from the path and attach each batch's version list."""
    by_batch: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for rec in files:
        by_batch[str(rec.get("batch") or "")].append(rec)
    listed: dict[str, list[dict[str, Any]]] = {}
    batch_rows = metadata.get("batches") or {}
    for batch in set(by_batch) | set(batch_rows):
        row = batch_rows.get(batch) if isinstance(batch_rows.get(batch), dict) else {}
        versions = _version_catalog(row, by_batch.get(batch, []))
        listed[batch] = versions
        orders = {str(item["name"]): int(item["order"]) for item in versions}
        for rec in by_batch.get(batch, []):
            name = file_version_from_path(str(rec.get("path") or ""))
            if name == ORIGINAL_FILE_VERSION:
                stored = str(rec.get("file_version") or "").strip()
                if stored:
                    name = stored
            rec["file_version"] = name or ORIGINAL_FILE_VERSION
            rec["file_version_order"] = int(orders.get(rec["file_version"], 0))
    return listed


def _assemble_data_index(
    files: list[dict[str, Any]],
    metadata: dict[str, Any],
    *,
    include_empty: bool,
    copy: bool = False,
) -> dict[str, Any]:
    """Group parsed file rows into the catalog snapshot shape."""
    if copy:
        copied: list[dict[str, Any]] = []
        for rec in files:
            item = dict(rec)
            if isinstance(item.get("taxonomy_tag_ids"), dict):
                item["taxonomy_tag_ids"] = dict(item["taxonomy_tag_ids"])
            if isinstance(item.get("annotation"), dict):
                item["annotation"] = dict(item["annotation"])
            copied.append(item)
        files = copied

    version_lists = _apply_file_versions(files, metadata)
    stems_by_batch: dict[str, list[str]] = defaultdict(list)
    for rec in files:
        stems_by_batch[rec["batch"]].append(rec["unit_name"])
    canon_by_batch = {
        batch: cluster_unit_names(names) for batch, names in stems_by_batch.items()
    }

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    aliases_by_unit: dict[str, list[str]] = defaultdict(list)
    for rec in files:
        original = rec["unit_name"]
        canon = canon_by_batch.get(rec["batch"], {}).get(original, original)
        rec["unit_name"] = canon
        key = unit_key(rec["batch"], canon)
        grouped[key].append(rec)
        aliases_by_unit[key].append(original)
        if canon != original:
            aliases_by_unit[key].append(canon)
    for batch, mapping in canon_by_batch.items():
        for raw, canon in mapping.items():
            aliases_by_unit[unit_key(batch, canon)].append(raw)

    batch_names = {rec["batch"] for rec in files}
    if include_empty:
        batch_names.update((metadata.get("batches") or {}).keys())
    units = []
    for key, unit_files in sorted(grouped.items()):
        batch, name = key.split("::", 1)
        alias_names = list(dict.fromkeys([name, *aliases_by_unit.get(key, [])]))
        meta = _unit_meta_for_names(metadata, batch, alias_names)
        uploaders = {
            (item["uploader"]["id"], item["uploader"]["username"]): item["uploader"]
            for item in unit_files
            if item.get("uploader")
        }
        units.append(
            {
                "key": key,
                "batch": batch,
                "name": name,
                "file_count": len(unit_files),
                "files": sorted(
                    unit_files,
                    key=lambda f: (
                        f["ontology"],
                        MODALITIES.index(f["modality"]) if f["modality"] in MODALITIES else 0,
                        f["channel"],
                        f["format"],
                    ),
                ),
                "taxonomy_tag_ids": meta.get("taxonomy_tag_ids") or {},
                "annotation": meta.get("annotation") or {},
                "meta": meta.get("meta") or {},
                "alias_names": alias_names,
                "uploaders": list(uploaders.values()),
            }
        )

    units_by_batch: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in units:
        units_by_batch[item["batch"]].append(item)
    batches = [
        {
            "name": name,
            "unit_count": len(units_by_batch.get(name, [])),
            "file_count": sum(u["file_count"] for u in units_by_batch.get(name, [])),
            "units": units_by_batch.get(name, []),
            "file_versions": version_lists.get(name) or _version_catalog(
                (metadata.get("batches") or {}).get(name), []
            ),
            "meta": dict((metadata.get("batches") or {}).get(name) or {}),
            **_tag_fields((metadata.get("batches") or {}).get(name)),
            "uploaders": list(
                {
                    (uploader["id"], uploader["username"]): uploader
                    for unit in units_by_batch.get(name, [])
                    for uploader in unit.get("uploaders", [])
                }.values()
            ),
        }
        for name in sorted(batch_names)
    ]
    uploader_counts: dict[tuple[int, str], dict[str, Any]] = {}
    unknown_count = 0
    for item in files:
        uploader = item.get("uploader")
        if not uploader:
            unknown_count += 1
            continue
        key = (int(uploader["id"]), str(uploader["username"]))
        row = uploader_counts.setdefault(
            key,
            {
                "id": int(uploader["id"]),
                "username": str(uploader["username"]),
                "file_count": 0,
            },
        )
        row["file_count"] += 1
    uploaders = sorted(uploader_counts.values(), key=lambda row: row["username"])
    if unknown_count:
        uploaders.append(
            {"id": -1, "username": "历史数据（上传者未知）", "file_count": unknown_count}
        )
    _inherit_file_tags(units, metadata)
    _attach_sort_timestamps(units, batches, metadata)
    return {
        "updated_at": _now(),
        "modalities": list(MODALITIES),
        "ontologies": list(ONTOLOGIES),
        "uploaders": uploaders,
        "batches": batches,
        "units": units,
        "files": files,
    }


def _scan_data_live(
    *, include_empty: bool = False, on_progress: ProgressFn | None = None
) -> dict[str, Any]:
    """Scan files and group by batch plus filename stem into data units.

    Role suffixes such as ``skeleton``, ``rigid body`` and ``marker`` are
    stripped, so ``XXXX_skeleton_0`` and ``XXXX_marker003`` share unit ``XXXX``.
    """
    base = root()
    metadata = read_metadata()
    files: list[dict[str, Any]] = []
    data_root = base / "data"
    if on_progress:
        on_progress("data", 5, "正在枚举数据文件…")
    seen = 0
    if data_root.is_dir():
        for path in sorted(data_root.rglob("*")):
            if not path.is_file() or path.name.startswith("."):
                continue
            seen += 1
            rec = _parse_data_file(path, base)
            if rec:
                rec["uploader"] = (metadata.get("file_uploaders") or {}).get(
                    rec["path"]
                )
                _attach_cached_media(rec, metadata, path)
                _attach_own_file_tags(rec, metadata)
                apply_csv_fps(rec)
                files.append(rec)
            if on_progress and seen % 40 == 0:
                on_progress(
                    "data",
                    min(55, 8 + seen // 150),
                    f"正在扫描数据文件（已处理 {seen}）…",
                )
    if on_progress:
        on_progress("data", 58, f"正在整理数据索引（{len(files)} 个文件）…")
    return _assemble_data_index(files, metadata, include_empty=include_empty)


def _scan_models_live(*, on_progress: ProgressFn | None = None) -> dict[str, Any]:
    base = root()
    metadata = read_metadata()
    instances: dict[tuple[str, str], dict[str, Any]] = {}
    model_root = base / "3d_model"
    seen = 0
    if on_progress:
        on_progress("models", 62, "正在扫描三维模型…")
    for ontology in ONTOLOGIES:
        ont_root = model_root / ontology
        if not ont_root.is_dir():
            continue
        for kind_dir in sorted(p for p in ont_root.iterdir() if p.is_dir()):
            kind = kind_dir.name
            for instance_dir in sorted(p for p in kind_dir.iterdir() if p.is_dir()):
                key = (ontology, instance_dir.name)
                item = instances.setdefault(
                    key,
                    {
                        "key": f"{ontology}::{instance_dir.name}",
                        "ontology": ontology,
                        "name": instance_dir.name,
                        "kinds": [],
                        "files": [],
                        "meta": dict(
                            (metadata.get("models") or {}).get(
                                f"{ontology}::{instance_dir.name}", {}
                            )
                        ),
                    },
                )
                if kind not in item["kinds"]:
                    item["kinds"].append(kind)
                for file_path in sorted(instance_dir.rglob("*")):
                    if not file_path.is_file() or file_path.name.startswith("."):
                        continue
                    seen += 1
                    rel = file_path.relative_to(base).as_posix()
                    item["files"].append(
                        {
                            "id": _file_id(rel),
                            "path": rel,
                            "name": file_path.name,
                            "kind": kind,
                            "relative_path": file_path.relative_to(instance_dir).as_posix(),
                            "size": file_path.stat().st_size,
                        }
                    )
                    if on_progress and seen % 10 == 0:
                        on_progress(
                            "models",
                            min(88, 62 + seen // 4),
                            f"正在扫描三维模型（已处理 {seen}）…",
                        )
    if on_progress:
        on_progress("models", 90, f"三维模型扫描完成（{seen} 个文件）")
    return {"updated_at": _now(), "instances": list(instances.values())}


_DELTA_LIST_KEYS = (
    "removed_data_paths",
    "upsert_data_files",
    "removed_model_paths",
    "upsert_model_files",
    "removed_model_instances",
)


def catalog_delta_path(base: Path | None = None) -> Path:
    return Path(base or root()) / "index" / "catalog_delta.json"


def _empty_delta() -> dict[str, Any]:
    return {key: [] for key in _DELTA_LIST_KEYS}


def _delta_mtime() -> float | None:
    try:
        return catalog_delta_path().stat().st_mtime
    except OSError:
        return None


def _read_catalog_delta() -> dict[str, Any]:
    delta = _empty_delta()
    try:
        raw = json.loads(catalog_delta_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return delta
    if not isinstance(raw, dict):
        return delta
    for key in _DELTA_LIST_KEYS:
        value = raw.get(key)
        if isinstance(value, list):
            delta[key] = value
    return delta


def _delta_is_empty(delta: dict[str, Any]) -> bool:
    return not any(delta.get(key) for key in _DELTA_LIST_KEYS)


def _write_catalog_delta_unlocked(delta: dict[str, Any]) -> None:
    path = catalog_delta_path()
    if _delta_is_empty(delta):
        try:
            path.unlink()
        except OSError:
            pass
        return
    payload = {"version": 1, "updated_at": _now(), **{key: delta.get(key) or [] for key in _DELTA_LIST_KEYS}}
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    tmp.replace(path)


def _clear_catalog_delta_unlocked() -> None:
    try:
        catalog_delta_path().unlink()
    except OSError:
        pass


def _merge_catalog_delta(
    *,
    removed_data_paths: list[str] | None = None,
    upsert_data_files: list[dict[str, Any]] | None = None,
    removed_model_paths: list[str] | None = None,
    upsert_model_files: list[dict[str, Any]] | None = None,
    removed_model_instances: list[str] | None = None,
) -> None:
    """Persist an incremental index change without rewriting catalog.json."""
    global _browse_force_sync, _local_write_gen
    with _INDEX_LOCK:
        delta = _read_catalog_delta()
        removed_data = {str(path) for path in delta["removed_data_paths"] if path}
        upsert_data = {
            str(item["path"]): item
            for item in delta["upsert_data_files"]
            if isinstance(item, dict) and item.get("path")
        }
        removed_models = {str(path) for path in delta["removed_model_paths"] if path}
        upsert_models = {
            str(item["path"]): item
            for item in delta["upsert_model_files"]
            if isinstance(item, dict) and item.get("path")
        }
        removed_instances = {str(key) for key in delta["removed_model_instances"] if key}

        for path in removed_data_paths or []:
            removed_data.add(str(path))
            upsert_data.pop(str(path), None)
        for rec in upsert_data_files or []:
            path = str(rec.get("path") or "")
            if not path:
                continue
            upsert_data[path] = rec
            removed_data.discard(path)
        for path in removed_model_paths or []:
            removed_models.add(str(path))
            upsert_models.pop(str(path), None)
        fresh_removed_instances = {str(key) for key in (removed_model_instances or []) if key}
        for key in fresh_removed_instances:
            removed_instances.add(key)
            upsert_models = {
                path: rec
                for path, rec in upsert_models.items()
                if f"{rec.get('ontology')}::{rec.get('instance')}" != key
            }
        for rec in upsert_model_files or []:
            path = str(rec.get("path") or "")
            if not path:
                continue
            upsert_models[path] = rec
            removed_models.discard(path)
            key = f"{rec.get('ontology')}::{rec.get('instance')}"
            if key not in fresh_removed_instances:
                removed_instances.discard(key)
        _write_catalog_delta_unlocked(
            {
                "removed_data_paths": sorted(removed_data),
                "upsert_data_files": list(upsert_data.values()),
                "removed_model_paths": sorted(removed_models),
                "upsert_model_files": list(upsert_models.values()),
                "removed_model_instances": sorted(removed_instances),
            }
        )
        _invalidate_catalog_view()
        _browse_force_sync = True
        _local_write_gen += 1


def _apply_model_delta(models: dict[str, Any], delta: dict[str, Any]) -> dict[str, Any]:
    removed_instances = {str(key) for key in delta.get("removed_model_instances") or [] if key}
    removed_paths = {str(path) for path in delta.get("removed_model_paths") or [] if path}
    upserts = [
        item
        for item in (delta.get("upsert_model_files") or [])
        if isinstance(item, dict) and item.get("path")
    ]
    upsert_paths = {str(item["path"]) for item in upserts}
    by_key: dict[str, dict[str, Any]] = {}
    instances: list[dict[str, Any]] = []
    for source in models.get("instances") or []:
        key = str(source.get("key") or "")
        if key in removed_instances:
            continue
        files = [
            dict(item)
            for item in (source.get("files") or [])
            if str(item.get("path") or "") not in removed_paths
            and str(item.get("path") or "") not in upsert_paths
        ]
        if not files:
            continue
        kinds: list[str] = []
        for item in files:
            kind = str(item.get("kind") or "")
            if kind and kind not in kinds:
                kinds.append(kind)
        row = dict(source)
        row["files"] = files
        row["kinds"] = kinds
        instances.append(row)
        by_key[key] = row
    for rec in upserts:
        key = f"{rec.get('ontology')}::{rec.get('instance')}"
        row = by_key.get(key)
        if row is None:
            row = {
                "key": key,
                "ontology": rec.get("ontology"),
                "name": rec.get("instance"),
                "kinds": [],
                "files": [],
                "meta": {},
            }
            by_key[key] = row
            instances.append(row)
        row["files"].append(
            {
                "id": rec.get("id"),
                "path": rec.get("path"),
                "name": rec.get("name"),
                "kind": rec.get("kind"),
                "relative_path": rec.get("relative_path"),
                "size": rec.get("size"),
            }
        )
        kind = str(rec.get("kind") or "")
        if kind and kind not in row["kinds"]:
            row["kinds"].append(kind)
    for row in instances:
        row["files"].sort(
            key=lambda item: (str(item.get("kind") or ""), str(item.get("relative_path") or ""))
        )
    return {
        "updated_at": models.get("updated_at") or _now(),
        "instances": [row for row in instances if row.get("files")],
    }


def _materialize_catalog(base: dict[str, Any], delta: dict[str, Any]) -> dict[str, Any]:
    data = base.get("data") or {}
    removed = {str(path) for path in delta.get("removed_data_paths") or [] if path}
    upserts = {
        str(item["path"]): item
        for item in (delta.get("upsert_data_files") or [])
        if isinstance(item, dict) and item.get("path")
    }
    files = [
        rec
        for rec in (data.get("files") or [])
        if str(rec.get("path") or "") not in removed and str(rec.get("path") or "") not in upserts
    ]
    files.extend(upserts.values())
    assembled = _assemble_data_index(
        files,
        read_metadata(),
        include_empty=True,
        copy=True,
    )
    models = base.get("models") if isinstance(base.get("models"), dict) else {"instances": []}
    if any(
        delta.get(key)
        for key in ("removed_model_paths", "upsert_model_files", "removed_model_instances")
    ):
        models = _apply_model_delta(models, delta)
    return {
        "version": base.get("version") or 2,
        "updated_at": base.get("updated_at"),
        "data": assembled,
        "models": models,
    }


def _read_base_catalog() -> dict[str, Any] | None:
    global _catalog_raw, _catalog_mtime
    path = catalog_path()
    if not path.is_file():
        return None
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    if _catalog_raw is not None and _catalog_mtime == mtime:
        return _catalog_raw
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(raw, dict) or not isinstance(raw.get("data"), dict):
        return None
    _catalog_raw = raw
    _catalog_mtime = mtime
    _invalidate_catalog_view()
    return raw


def _read_data_catalog() -> dict[str, Any] | None:
    global _catalog_view, _catalog_view_key
    base = _read_base_catalog()
    if base is None:
        return None
    key = (_catalog_mtime, _delta_mtime())
    if _catalog_view is not None and _catalog_view_key == key:
        return _catalog_view
    delta = _read_catalog_delta()
    if _delta_is_empty(delta):
        _catalog_view = base
        _catalog_view_key = key
        return base
    view = _materialize_catalog(base, delta)
    _catalog_view = view
    _catalog_view_key = key
    return view


def _iter_indexed_data_files() -> list[dict[str, Any]]:
    base = _read_base_catalog()
    files = list(((base or {}).get("data") or {}).get("files") or [])
    delta = _read_catalog_delta()
    if _delta_is_empty(delta):
        return files
    removed = {str(path) for path in delta.get("removed_data_paths") or [] if path}
    upserts = {
        str(item["path"]): item
        for item in delta.get("upsert_data_files") or []
        if isinstance(item, dict) and item.get("path")
    }
    kept = [
        rec
        for rec in files
        if str(rec.get("path") or "") not in removed and str(rec.get("path") or "") not in upserts
    ]
    kept.extend(upserts.values())
    return kept


def _metadata_keys_for_unit(batch: str, name: str) -> list[str]:
    prefix = f"{batch}::"
    found: list[str] = []
    for key in read_metadata().get("units") or {}:
        text = str(key)
        if "::" not in text or not text.startswith(prefix):
            continue
        alias = text.split("::", 1)[1]
        if alias == name or stems_same_unit(alias, name):
            found.append(text)
    return found


def _unit_keys_emptied_by(paths: list[str]) -> list[str]:
    removing = {
        str(path)
        for path in paths
        if path and not str(path).startswith("3d_model/")
    }
    if not removing:
        return []
    grouped: dict[str, int] = defaultdict(int)
    touched: set[str] = set()
    for rec in _iter_indexed_data_files():
        path = str(rec.get("path") or "")
        batch = str(rec.get("batch") or "")
        name = str(rec.get("unit_name") or "")
        if not batch or not name:
            continue
        key = unit_key(batch, name)
        if path in removing:
            touched.add(key)
            continue
        grouped[key] += 1
    doomed: list[str] = []
    for key in touched:
        if grouped.get(key, 0):
            continue
        batch, name = key.split("::", 1)
        doomed.extend(_metadata_keys_for_unit(batch, name))
    return list(dict.fromkeys(doomed))


def _index_one_data_file(path: Path, metadata: dict[str, Any]) -> dict[str, Any] | None:
    rec = _parse_data_file(path, root())
    if not rec:
        return None
    rec["uploader"] = (metadata.get("file_uploaders") or {}).get(rec["path"])
    _attach_cached_media(rec, metadata, path)
    _attach_own_file_tags(rec, metadata)
    return apply_csv_fps(rec)


def _model_file_record(path: Path) -> dict[str, Any] | None:
    base = root()
    try:
        parts = path.relative_to(base / "3d_model").parts
    except ValueError:
        return None
    if len(parts) < 4:
        return None
    ontology, kind, instance = parts[0], parts[1], parts[2]
    instance_dir = base / "3d_model" / ontology / kind / instance
    rel = path.relative_to(base).as_posix()
    return {
        "id": _file_id(rel),
        "path": rel,
        "name": path.name,
        "kind": kind,
        "relative_path": path.relative_to(instance_dir).as_posix(),
        "size": path.stat().st_size,
        "ontology": ontology,
        "instance": instance,
    }


def refresh_catalog_paths(paths: list[str]) -> None:
    """Index only the given paths. Missing files are removed from the catalog."""
    metadata = read_metadata()
    data_removed: list[str] = []
    data_upsert: list[dict[str, Any]] = []
    model_removed: list[str] = []
    model_upsert: list[dict[str, Any]] = []
    for raw in paths:
        rel = str(raw or "").strip().lstrip("/")
        if not rel:
            continue
        try:
            path = resolve_repo_file(rel)
        except ValueError:
            continue
        if rel.startswith("3d_model/"):
            if path.is_file():
                rec = _model_file_record(path)
                if rec:
                    model_upsert.append(rec)
                else:
                    model_removed.append(rel)
            else:
                model_removed.append(rel)
            continue
        if path.is_file():
            rec = _index_one_data_file(path, metadata)
            if rec:
                data_upsert.append(rec)
            else:
                data_removed.append(rel)
        else:
            data_removed.append(rel)
    if not any((data_removed, data_upsert, model_removed, model_upsert)):
        return
    _merge_catalog_delta(
        removed_data_paths=data_removed,
        upsert_data_files=data_upsert,
        removed_model_paths=model_removed,
        upsert_model_files=model_upsert,
    )


def reindex_model_instance(ontology: str, name: str) -> None:
    """Replace one model instance in the index from its current files."""
    base = root() / "3d_model" / ontology
    upserts: list[dict[str, Any]] = []
    if base.is_dir():
        for kind_dir in sorted(path for path in base.iterdir() if path.is_dir()):
            instance_dir = kind_dir / name
            if not instance_dir.is_dir():
                continue
            for file_path in sorted(instance_dir.rglob("*")):
                if not file_path.is_file() or file_path.name.startswith("."):
                    continue
                rec = _model_file_record(file_path)
                if rec:
                    upserts.append(rec)
    _merge_catalog_delta(
        removed_model_instances=[f"{ontology}::{name}"],
        upsert_model_files=upserts,
    )


def catalog_full_rebuild_age_sec() -> float | None:
    return _catalog_age_sec()


def _catalog_age_sec() -> float | None:
    path = catalog_path()
    if not path.is_file():
        return None
    try:
        return max(0.0, time.time() - path.stat().st_mtime)
    except OSError:
        return None


def _set_rebuild_status(**kwargs: Any) -> None:
    with _status_lock:
        _rebuild_status.update(kwargs)


def catalog_rebuild_status() -> dict[str, Any]:
    with _status_lock:
        return dict(_rebuild_status)


def start_catalog_rebuild(*, force: bool = False) -> dict[str, Any]:
    """Start a background catalog rebuild and return the current status."""
    global _rebuild_running
    if not force:
        age = _catalog_age_sec()
        if age is not None and age < _CATALOG_MAX_AGE_SEC:
            return catalog_rebuild_status()
    with _rebuild_lock:
        if _rebuild_running:
            return catalog_rebuild_status()
        _rebuild_running = True
        _set_rebuild_status(
            status="running",
            phase="start",
            percent=1,
            message="开始更新索引…",
            stats=None,
            error=None,
            started_at=_now(),
            finished_at=None,
        )

    def run() -> None:
        global _rebuild_running
        try:
            rebuild_catalog()
        except Exception as exc:
            _set_rebuild_status(
                status="error",
                phase="error",
                message="索引更新失败",
                error=str(exc),
                finished_at=_now(),
            )
        finally:
            with _rebuild_lock:
                _rebuild_running = False

    threading.Thread(target=run, name="catalog-rebuild", daemon=True).start()
    return catalog_rebuild_status()


def schedule_catalog_rebuild(*, force: bool = False) -> bool:
    """Rebuild the on-disk browse index in a background thread."""
    before = catalog_rebuild_status()
    if before.get("status") == "running":
        return False
    result = start_catalog_rebuild(force=force)
    return result.get("status") == "running"


def _copy_file_row(rec: dict[str, Any]) -> dict[str, Any]:
    item = dict(rec)
    item["taxonomy_tag_ids"] = dict(rec.get("taxonomy_tag_ids") or {})
    item["annotation"] = dict(rec.get("annotation") or {})
    return item


def _overlay_metadata(
    snapshot: dict[str, Any],
    metadata: dict[str, Any],
    *,
    include_empty: bool,
) -> dict[str, Any]:
    files = []
    for rec in snapshot.get("files") or []:
        item = _copy_file_row(rec)
        item["uploader"] = (metadata.get("file_uploaders") or {}).get(item.get("path"))
        own = _tag_fields((metadata.get("files") or {}).get(item.get("path")))
        item["annotation"] = own["annotation"]
        item["taxonomy_tag_ids"] = _as_tag_ids(own["taxonomy_tag_ids"])
        _ensure_path_motion_kind(item)
        apply_csv_fps(item)
        files.append(item)
    version_lists = _apply_file_versions(files, metadata)
    file_by_path = {item["path"]: item for item in files if item.get("path")}

    units: list[dict[str, Any]] = []
    for unit in snapshot.get("units") or []:
        unit_files = []
        for rec in unit.get("files") or []:
            live = file_by_path.get(rec.get("path"))
            if live is not None:
                unit_files.append(live)
        if not unit_files:
            continue
        item = dict(unit)
        item["files"] = unit_files
        item["file_count"] = len(unit_files)
        item["uploaders"] = list(
            {
                (uploader["id"], uploader["username"]): uploader
                for rec in unit_files
                if (uploader := rec.get("uploader"))
            }.values()
        )
        item["taxonomy_tag_ids"] = dict(unit.get("taxonomy_tag_ids") or {})
        item["annotation"] = dict(unit.get("annotation") or {})
        alias_names = list(
            dict.fromkeys(
                [item.get("name") or "", *((item.get("alias_names") or []) if isinstance(item.get("alias_names"), list) else [])]
            )
        )
        meta = _unit_meta_for_names(metadata, str(item.get("batch") or ""), [name for name in alias_names if name])
        if meta:
            item["taxonomy_tag_ids"] = dict(meta.get("taxonomy_tag_ids") or item["taxonomy_tag_ids"])
            item["annotation"] = dict(meta.get("annotation") or item["annotation"])
            item["meta"] = dict(meta.get("meta") or item.get("meta") or {})
            if meta.get("created_at"):
                item["created_at"] = meta["created_at"]
            if meta.get("updated_at"):
                item["updated_at"] = meta["updated_at"]
        units.append(item)

    _inherit_file_tags(units, metadata)

    units_by_batch: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in units:
        units_by_batch[item["batch"]].append(item)

    batch_names = {item["batch"] for item in units}
    if include_empty:
        batch_names.update((metadata.get("batches") or {}).keys())
    catalog_batches = {item["name"]: item for item in snapshot.get("batches") or []}
    batches = []
    for name in sorted(batch_names):
        source = catalog_batches.get(name) or {}
        row = (metadata.get("batches") or {}).get(name) or {}
        batch_units = units_by_batch.get(name, [])
        batches.append(
            {
                **source,
                "name": name,
                "unit_count": len(batch_units),
                "file_count": sum(unit["file_count"] for unit in batch_units),
                "units": batch_units,
                "file_versions": version_lists.get(name) or _version_catalog(row, []),
                "meta": dict(row.get("meta") or source.get("meta") or {}),
                **_tag_fields(row or source),
                "uploaders": list(
                    {
                        (uploader["id"], uploader["username"]): uploader
                        for unit in batch_units
                        for uploader in unit.get("uploaders", [])
                    }.values()
                ),
            }
        )

    uploader_counts: dict[tuple[int, str], dict[str, Any]] = {}
    unknown_count = 0
    for item in files:
        uploader = item.get("uploader")
        if not uploader:
            unknown_count += 1
            continue
        key = (int(uploader["id"]), str(uploader["username"]))
        row = uploader_counts.setdefault(
            key,
            {
                "id": int(uploader["id"]),
                "username": str(uploader["username"]),
                "file_count": 0,
            },
        )
        row["file_count"] += 1
    uploaders = sorted(uploader_counts.values(), key=lambda row: row["username"])
    if unknown_count:
        uploaders.append(
            {"id": -1, "username": "历史数据（上传者未知）", "file_count": unknown_count}
        )
    _attach_sort_timestamps(units, batches, metadata)
    return {
        "updated_at": snapshot.get("updated_at") or _now(),
        "index_updated_at": snapshot.get("updated_at") or _now(),
        "modalities": list(snapshot.get("modalities") or MODALITIES),
        "ontologies": list(snapshot.get("ontologies") or ONTOLOGIES),
        "uploaders": uploaders,
        "batches": batches,
        "units": units,
        "files": files,
    }


_browse_ready: dict[bool, dict[str, Any]] = {}
_browse_key: dict[bool, tuple[float | None, ...]] = {}
_browse_refreshing: set[bool] = set()
_browse_refresh_lock = threading.Lock()
# Set when this process writes metadata. Retarget updates on the host must not
# force the next page open to re-read the whole index.
_browse_force_sync = False
# Bumped on every write made by this process. A cached page body built before
# the bump is stale for the user who just saved; one built after only an
# outside (host retarget) change may still be served while a fresh one builds.
_local_write_gen = 0
_index_listeners: list[Callable[[bool], None]] = []


_browse_serial: dict[bool, int] = {}
# Re-reading the index holds the interpreter for several seconds and stalls
# every other request. Outside writes (the host retarget loop finishes a wave
# every few minutes) are picked up at most this often.
_OUTSIDE_REFRESH_MIN_SEC = 90.0
_browse_refreshed_at: dict[bool, float] = {}


def local_write_generation() -> int:
    return _local_write_gen


def browse_snapshot_serial(include_empty: bool = False) -> int:
    """Changes whenever a different browse snapshot is swapped in."""
    return _browse_serial.get(include_empty, 0)


def add_index_listener(listener: Callable[[bool], None]) -> None:
    """Run after a background index refresh swaps in a newer snapshot."""
    if listener not in _index_listeners:
        _index_listeners.append(listener)


def _index_stamp() -> tuple[float | None, ...]:
    def mtime(path: Path) -> float | None:
        try:
            return path.stat().st_mtime
        except OSError:
            return None

    return mtime(catalog_path()), mtime(metadata_path()), mtime(catalog_delta_path())


def _build_data_index(*, include_empty: bool) -> dict[str, Any]:
    catalog = _read_data_catalog()
    metadata = read_metadata()
    if catalog is None:
        catalog = rebuild_catalog()
        metadata = read_metadata()
    return _overlay_metadata(catalog["data"], metadata, include_empty=include_empty)


def _refresh_data_index(include_empty: bool, stamp: tuple[float | None, ...]) -> None:
    try:
        data = _build_data_index(include_empty=include_empty)
    except Exception:
        return
    finally:
        with _browse_refresh_lock:
            _browse_refreshing.discard(include_empty)
    _browse_ready[include_empty] = data
    _browse_key[include_empty] = stamp
    _browse_serial[include_empty] = _browse_serial.get(include_empty, 0) + 1
    for listener in list(_index_listeners):
        try:
            listener(include_empty)
        except Exception:
            pass


def load_data_index(*, include_empty: bool = False) -> dict[str, Any]:
    """Serve the browse snapshot already in memory.

    The on-disk index is large and changes less often than the page is opened.
    A newer index is swapped in on a background thread; the page does not wait
    to re-read it. A write made by this process refreshes before the next read,
    so a tag just saved is visible.
    """
    global _browse_force_sync
    stamp = _index_stamp()
    ready = _browse_ready.get(include_empty)
    if ready is not None and not _browse_force_sync:
        if _browse_key.get(include_empty) != stamp:
            with _browse_refresh_lock:
                now = time.monotonic()
                recent = now - _browse_refreshed_at.get(include_empty, 0.0) < _OUTSIDE_REFRESH_MIN_SEC
                if include_empty not in _browse_refreshing and not recent:
                    _browse_refreshing.add(include_empty)
                    _browse_refreshed_at[include_empty] = now
                    threading.Thread(
                        target=_refresh_data_index,
                        args=(include_empty, stamp),
                        name="browse-index-refresh",
                        daemon=True,
                    ).start()
        return ready
    data = _build_data_index(include_empty=include_empty)
    _browse_ready[include_empty] = data
    _browse_key[include_empty] = _index_stamp()
    _browse_serial[include_empty] = _browse_serial.get(include_empty, 0) + 1
    _browse_force_sync = False
    return data


def scan_data(*, include_empty: bool = False, live: bool = False) -> dict[str, Any]:
    if live:
        return _scan_data_live(include_empty=include_empty)
    try:
        return load_data_index(include_empty=include_empty)
    except Exception:
        return _scan_data_live(include_empty=include_empty)


def scan_models(*, live: bool = False) -> dict[str, Any]:
    if not live:
        catalog = _read_data_catalog()
        models = (catalog or {}).get("models")
        if isinstance(models, dict) and models.get("instances") is not None:
            return models
    return _scan_models_live()


def _sync_robot_style_from_dirs(data: dict[str, Any]) -> None:
    """Update file annotation robot_style based on directory structure.

    For robot files stored under ``data/robot/{style}/...``, write the style
    into the file's annotation metadata so it persists across rescans.
    """
    updates: dict[str, str] = {}
    for rec in data.get("files") or []:
        if rec.get("ontology") != "robot":
            continue
        path_style = str(rec.get("robot_style") or "").strip()
        if not path_style:
            continue
        ann_style = str((rec.get("annotation") or {}).get("robot_style") or "").strip()
        if ann_style == path_style:
            continue
        updates[rec["path"]] = path_style
    if not updates:
        return

    def mutate(meta):
        files = meta.setdefault("files", {})
        for path, style in updates.items():
            row = files.setdefault(path, {})
            ann = dict(row.get("annotation") or {})
            ann["robot_style"] = style
            row["annotation"] = ann

    update_metadata(mutate)


def prune_units_without_files(units: list[dict[str, Any]] | None = None) -> int:
    """Drop unit metadata that no longer has any data file.

    Alias records that still match a file-backed unit (for example a
    ``skeleton`` suffix) are kept, because their tags belong to that unit.
    """
    if units is None:
        units = scan_data(include_empty=False).get("units") or []
    backed: dict[str, set[str]] = defaultdict(set)
    for unit in units:
        if not unit.get("files") and not unit.get("file_count"):
            continue
        batch = str(unit.get("batch") or "")
        name = str(unit.get("name") or "")
        if not batch or not name:
            continue
        backed[batch].add(normalize_unit_stem(name) or name)
        backed[batch].add(name)
    current = read_metadata().get("units") or {}
    pending: list[str] = []
    for key in current:
        if "::" not in str(key):
            pending.append(str(key))
            continue
        batch, name = str(key).split("::", 1)
        stem = normalize_unit_stem(name) or name
        names = backed.get(batch, set())
        if stem not in names and name not in names:
            pending.append(str(key))
    if not pending:
        return 0

    def mutate(data):
        rows = data.setdefault("units", {})
        for key in pending:
            rows.pop(key, None)

    update_metadata(mutate)
    return len(pending)


def rebuild_catalog() -> dict[str, Any]:
    def report(phase: str, percent: int, message: str) -> None:
        _set_rebuild_status(
            status="running",
            phase=phase,
            percent=max(0, min(99, int(percent))),
            message=message,
            error=None,
        )

    report("data", 4, "正在扫描数据文件…")
    delta_stamp = _delta_mtime()
    try:
        data = _scan_data_live(include_empty=True, on_progress=report)
        report("metadata", 56, "正在同步机器人款式标签…")
        _sync_robot_style_from_dirs(data)
        dropped = prune_units_without_files(data.get("units") or [])
        if dropped:
            report("metadata", 58, f"已移除 {dropped} 个没有数据文件的单元…")
        report("models", 60, "正在扫描三维模型…")
        models = _scan_models_live(on_progress=report)
        report("write", 92, "正在写入索引…")
        snapshot = {
            "version": 2,
            "updated_at": _now(),
            "data": data,
            "models": models,
        }
        global _browse_force_sync, _local_write_gen
        with _INDEX_LOCK:
            _write_json(catalog_path(), snapshot, compact=True)
            if _delta_mtime() == delta_stamp:
                _clear_catalog_delta_unlocked()
            _invalidate_catalog_cache()
            _browse_force_sync = True
            _local_write_gen += 1
        stats = {
            "file_count": len(data.get("files") or []),
            "unit_count": len(data.get("units") or []),
            "batch_count": len(data.get("batches") or []),
            "model_file_count": sum(
                len(item.get("files") or [])
                for item in (models.get("instances") or [])
            ),
            "model_instance_count": len(models.get("instances") or []),
        }
        _set_rebuild_status(
            status="done",
            phase="done",
            percent=100,
            message="索引已更新",
            stats=stats,
            error=None,
            finished_at=_now(),
        )
        return snapshot
    except Exception as exc:
        _set_rebuild_status(
            status="error",
            phase="error",
            message="索引更新失败",
            error=str(exc),
            finished_at=_now(),
        )
        raise


def register_file_version(batch: str, name: str) -> dict[str, Any]:
    """Remember a named file version on an existing batch. 「原版」 stays order 0."""
    batch = safe_name(batch, label="数据批次名")
    version = clean_file_version(name)
    if version == ORIGINAL_FILE_VERSION:
        return {"name": version, "order": 0}
    created: dict[str, Any] = {"name": version, "order": 0}

    def mutate(data: dict[str, Any]) -> None:
        row = data.setdefault("batches", {}).setdefault(batch, {"created_at": _now()})
        versions = row.get("file_versions")
        if not isinstance(versions, list):
            versions = []
            row["file_versions"] = versions
        if not any(
            isinstance(item, dict) and item.get("name") == ORIGINAL_FILE_VERSION
            for item in versions
        ):
            versions.insert(
                0,
                {
                    "name": ORIGINAL_FILE_VERSION,
                    "order": 0,
                    "created_at": row.get("created_at") or _now(),
                },
            )
        found = next(
            (
                item
                for item in versions
                if isinstance(item, dict) and item.get("name") == version
            ),
            None,
        )
        if found:
            created.clear()
            created.update(found)
            return
        order = max(int(item.get("order") or 0) for item in versions if isinstance(item, dict)) + 1
        entry = {"name": version, "order": order, "created_at": _now()}
        versions.append(entry)
        created.clear()
        created.update(entry)

    update_metadata(mutate)
    return created


def create_batch(name: str) -> dict[str, Any]:
    name = safe_name(name, label="数据批次名")

    def mutate(data):
        data["batches"].setdefault(name, {"created_at": _now()})

    update_metadata(mutate)
    return next(
        b for b in scan_data(include_empty=True)["batches"] if b["name"] == name
    )


def _batch_unit_names(
    data: dict[str, Any], batch: str, extra_names: list[str] | None = None
) -> list[str]:
    names = {item for item in (extra_names or []) if item}
    prefix = f"{batch}::"
    for key in data.get("units") or {}:
        if key.startswith(prefix) and "::" in key:
            names.add(key.split("::", 1)[1])
    return list(names)


def materialize_batch_tags_onto_units() -> int:
    """Give each unit its own copy of batch tags it does not already store.

    Batch tags stay as the template used to fill new units. They are not a
    live fallback when a unit is opened.
    """
    snapshot = scan_data(include_empty=True)
    pending: list[tuple[str, str, dict[str, list[int]]]] = []
    for batch in snapshot.get("batches") or []:
        batch_tags = _as_tag_ids(batch.get("taxonomy_tag_ids"))
        if not batch_tags:
            continue
        batch_name = str(batch.get("name") or "")
        for unit in batch.get("units") or []:
            own = _as_tag_ids(unit.get("taxonomy_tag_ids"))
            missing = {
                scheme: ids for scheme, ids in batch_tags.items() if scheme not in own
            }
            unit_name = str(unit.get("name") or "")
            if batch_name and unit_name and missing:
                pending.append((batch_name, unit_name, missing))
    if not pending:
        return 0

    def mutate(data):
        units = data.setdefault("units", {})
        for batch_name, unit_name, missing in pending:
            row = units.setdefault(unit_key(batch_name, unit_name), {})
            _ensure_created_at(row)
            current = _as_tag_ids(row.get("taxonomy_tag_ids"))
            for scheme, ids in missing.items():
                if scheme not in current:
                    current[scheme] = list(ids)
            row["taxonomy_tag_ids"] = current
            row["updated_at"] = _now()

    update_metadata(mutate)
    return len(pending)


def apply_batch_taxonomy_to_new_units(batch: str, unit_names: list[str]) -> None:
    """Copy batch taxonomy onto units that do not yet have those schemes."""
    batch = safe_name(batch, label="数据批次名")
    names = [safe_name(name, label="数据单元名") for name in unit_names if name]
    if not names:
        return

    def mutate(data):
        batch_tags = dict(
            ((data.get("batches") or {}).get(batch) or {}).get("taxonomy_tag_ids")
            or {}
        )
        if not batch_tags:
            return
        units = data.setdefault("units", {})
        for unit_name in names:
            row = units.setdefault(unit_key(batch, unit_name), {})
            _ensure_created_at(row)
            current = _as_tag_ids(row.get("taxonomy_tag_ids"))
            changed = False
            for scheme, node_id in _as_tag_ids(batch_tags).items():
                if scheme in current:
                    continue
                current[scheme] = node_id
                changed = True
            if changed:
                row["taxonomy_tag_ids"] = current
                row["updated_at"] = _now()

    update_metadata(mutate)


def apply_upload_taxonomy(
    batch: str,
    unit_names: list[str],
    taxonomy_tag_ids: dict[str, int | None] | None,
    file_paths: list[str] | None = None,
) -> None:
    """Write preset tags onto the batch default, this upload's units, and files."""
    batch = safe_name(batch, label="数据批次名")
    names = [safe_name(name, label="数据单元名") for name in unit_names if name]
    if taxonomy_tag_ids:
        targets = [str(path) for path in (file_paths or []) if path]
        if file_paths is None:
            targets = _file_paths_for_units(scan_data(), batch, names)

        def mutate(data):
            row = data.setdefault("batches", {}).setdefault(
                batch, {"created_at": _now()}
            )
            _merge_tag_updates(row, taxonomy_tag_ids=taxonomy_tag_ids)
            units = data.setdefault("units", {})
            for unit_name in names:
                unit_row = units.setdefault(unit_key(batch, unit_name), {})
                _ensure_created_at(unit_row)
                _merge_tag_updates(unit_row, taxonomy_tag_ids=taxonomy_tag_ids)
            if targets:
                _apply_taxonomy_to_file_rows(data, targets, taxonomy_tag_ids)

        update_metadata(mutate)
        return
    apply_batch_taxonomy_to_new_units(batch, names)


def update_unit_metadata(
    batch: str,
    name: str,
    *,
    taxonomy_tag_ids: dict[str, int | None] | None = None,
    annotation: dict[str, Any] | None = None,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    key = unit_key(batch, name)
    file_paths: list[str] = []
    if taxonomy_tag_ids is not None:
        file_paths = _file_paths_for_units(scan_data(), batch, [name])

    def mutate(data):
        row = data["units"].setdefault(key, {})
        _ensure_created_at(row)
        _merge_tag_updates(
            row,
            taxonomy_tag_ids=taxonomy_tag_ids,
            annotation=annotation,
            meta=meta,
        )
        if taxonomy_tag_ids is not None and file_paths:
            _apply_taxonomy_to_file_rows(data, file_paths, taxonomy_tag_ids)

    update_metadata(mutate)
    snapshot = scan_data()
    found = next((u for u in snapshot["units"] if u["key"] == key), None)
    if found is None:
        # Metadata may be created before the first physical file.
        found = {
            "key": key,
            "batch": batch,
            "name": name,
            "file_count": 0,
            "files": [],
            **read_metadata()["units"][key],
        }
    return found


def update_units_taxonomy(
    batch: str,
    updates: list[tuple[str, dict[str, int | None]]],
) -> int:
    """Apply taxonomy patches to many units in one metadata write."""
    cleaned: list[tuple[str, dict[str, int | None]]] = []
    seen: set[str] = set()
    for name, tags in updates:
        unit_name = str(name or "").strip()
        if not unit_name or unit_name in seen or not tags:
            continue
        seen.add(unit_name)
        cleaned.append((unit_name, tags))
    if not cleaned:
        return 0
    snapshot = scan_data()
    paths_by_name: dict[str, list[str]] = {name: [] for name, _ in cleaned}
    for unit in snapshot.get("units") or []:
        if unit.get("batch") != batch:
            continue
        unit_name = str(unit.get("name") or "")
        if unit_name not in paths_by_name:
            continue
        for item in unit.get("files") or []:
            path = str(item.get("path") or "")
            if path:
                paths_by_name[unit_name].append(path)

    def mutate(data):
        units = data.setdefault("units", {})
        for unit_name, tags in cleaned:
            row = units.setdefault(unit_key(batch, unit_name), {})
            _ensure_created_at(row)
            _merge_tag_updates(row, taxonomy_tag_ids=tags)
            paths = paths_by_name.get(unit_name) or []
            if paths:
                _apply_taxonomy_to_file_rows(data, paths, tags)

    update_metadata(mutate)
    return len(cleaned)


def update_batch_metadata(
    name: str,
    *,
    taxonomy_tag_ids: dict[str, int | None] | None = None,
    annotation: dict[str, Any] | None = None,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    name = safe_name(name, label="数据批次名")
    extra_names: list[str] = []
    file_paths: list[str] = []
    if taxonomy_tag_ids is not None:
        snapshot = scan_data(include_empty=True)
        current = next(
            (item for item in snapshot["batches"] if item["name"] == name), None
        )
        extra_names = [unit["name"] for unit in (current or {}).get("units") or []]
        file_paths = _file_paths_for_batch(snapshot, name)

    def mutate(data):
        row = data["batches"].setdefault(name, {"created_at": _now()})
        _merge_tag_updates(
            row,
            taxonomy_tag_ids=taxonomy_tag_ids,
            annotation=annotation,
            meta=meta,
        )
        if taxonomy_tag_ids is not None:
            units = data.setdefault("units", {})
            for unit_name in _batch_unit_names(data, name, extra_names):
                unit_row = units.setdefault(unit_key(name, unit_name), {})
                _merge_tag_updates(unit_row, taxonomy_tag_ids=taxonomy_tag_ids)
            if file_paths:
                _apply_taxonomy_to_file_rows(data, file_paths, taxonomy_tag_ids)

    update_metadata(mutate)
    snapshot = scan_data(include_empty=True)
    found = next((item for item in snapshot["batches"] if item["name"] == name), None)
    if found is None:
        found = {
            "name": name,
            "unit_count": 0,
            "file_count": 0,
            "units": [],
            "uploaders": [],
            "meta": dict((read_metadata().get("batches") or {}).get(name) or {}),
            **_tag_fields((read_metadata().get("batches") or {}).get(name)),
        }
    return found


def _rename_stored_path(data: dict[str, Any], old: str, new: str) -> None:
    """Point metadata rows at a file after it moves on disk."""
    if old == new:
        return
    for key in ("files", "file_uploaders", "file_media"):
        bucket = data.get(key)
        if isinstance(bucket, dict) and old in bucket:
            bucket[new] = bucket.pop(old)
    for session in data.get("upload_sessions") or []:
        if not isinstance(session, dict):
            continue
        session["paths"] = [new if path == old else path for path in (session.get("paths") or [])]


def _move_motion_file(record: dict[str, Any], kind: str) -> str:
    dest = data_destination(
        ontology=str(record.get("ontology") or ""),
        modality="motion",
        channel=str(record.get("channel") or ""),
        fmt=str(record.get("format") or ""),
        batch=str(record.get("batch") or ""),
        filename=str(record.get("name") or ""),
        robot_style=str(record.get("robot_style") or ""),
        robot_acquire_method=str(record.get("robot_acquire_method") or ""),
        sub_path=str(record.get("sub_path") or ""),
        file_version=str(record.get("file_version") or ""),
        motion_kind=kind,
    )
    new_rel = dest.relative_to(root()).as_posix()
    old_rel = str(record.get("path") or "")
    if new_rel == old_rel:
        return old_rel
    src = resolve_repo_file(old_rel)
    if dest.exists():
        raise ValueError(f"目标路径已有文件：{new_rel}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(src, dest)

    def mutate(data):
        _rename_stored_path(data, old_rel, new_rel)

    update_metadata(mutate)
    refresh_catalog_paths([old_rel, new_rel])
    return new_rel


def _maybe_move_motion_kind(rel_path: str, annotation: dict[str, Any] | None) -> str:
    if not annotation or "motion_kind" not in annotation:
        return rel_path
    kind = str(annotation.get("motion_kind") or "").strip().lower()
    if kind not in MOTION_KINDS:
        return rel_path
    record = inspect_data_file(rel_path)
    if not record or record.get("modality") != "motion":
        return rel_path
    if record.get("motion_kind") == kind:
        return rel_path
    return _move_motion_file(record, kind)


def update_files_annotation(paths: list[str], annotation: dict[str, Any]) -> None:
    if not paths or not annotation:
        return

    def mutate(data):
        files = data.setdefault("files", {})
        for path in paths:
            row = files.setdefault(str(path), {})
            _merge_tag_updates(row, annotation=annotation)

    update_metadata(mutate)
    if "motion_kind" in annotation:
        for path in paths:
            _maybe_move_motion_kind(path, annotation)


def update_file_metadata(
    rel_path: str,
    *,
    taxonomy_tag_ids: dict[str, int | None] | None = None,
    annotation: dict[str, Any] | None = None,
) -> dict[str, Any]:
    path = resolve_repo_file(rel_path)
    record = inspect_data_file(rel_path)
    if not record:
        raise FileNotFoundError(rel_path)

    def mutate(data):
        row = data.setdefault("files", {}).setdefault(record["path"], {})
        _merge_tag_updates(
            row,
            taxonomy_tag_ids=taxonomy_tag_ids,
            annotation=annotation,
        )

    update_metadata(mutate)
    moved = _maybe_move_motion_kind(record["path"], annotation)
    updated = inspect_data_file(moved)
    if updated is None:
        raise FileNotFoundError(moved)
    return updated


def data_destination(
    *,
    ontology: str,
    modality: str,
    channel: str,
    fmt: str,
    batch: str,
    filename: str,
    robot_style: str = "",
    robot_acquire_method: str = "",
    sub_path: str = "",
    file_version: str = "",
    motion_kind: str = "",
) -> Path:
    if ontology not in ONTOLOGIES:
        raise ValueError("本体须为 human 或 robot")
    if modality not in MODALITIES:
        raise ValueError(f"数据模态须为：{', '.join(MODALITIES)}")
    if modality == "fpv_video" and channel not in FPV_CHANNELS:
        raise ValueError("fpv_video 须选择 rgb 或 depth")
    fmt = safe_name(fmt.lower().lstrip("."), label="格式")
    batch = safe_name(batch, label="数据批次名")
    filename = preserved_segment(Path(filename).name, label="文件名")
    parts = [root(), "data", ontology]
    if ontology == "robot" and robot_style:
        parts.append(safe_name(robot_style, label="机器人款式"))
    parts.append(modality)
    if modality == "fpv_video":
        parts.append(channel)
    if ontology == "robot" and modality == "motion":
        method = (robot_acquire_method or DEFAULT_ROBOT_ACQUIRE_METHOD).strip().lower()
        if method not in ROBOT_ACQUIRE_METHODS:
            raise ValueError("机器人数据获取方式须为 omniretarget、umr 或 gmr")
        parts.append(method)
    if modality == "motion":
        kind = str(motion_kind or "").strip().lower()
        if kind not in MOTION_KINDS:
            kind = "skeleton"
        parts.append(kind)
    parts.append(fmt)
    parts.append(batch)
    version = clean_file_version(file_version)
    if version != ORIGINAL_FILE_VERSION:
        parts.append(FILE_VERSION_DIR)
        parts.append(version)
    if sub_path:
        for seg in sub_path.replace("\\", "/").split("/"):
            if not seg or seg == ".":
                continue
            parts.append(preserved_segment(seg, label="子目录"))
    parts.append(filename)
    return Path(*parts)


def _legacy_session_id(user_id: int, uploaded_at: str, batch: str) -> str:
    raw = f"{user_id}|{uploaded_at}|{batch}"
    return "legacy-" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _session_view(
    row: dict[str, Any], file_by_path: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    paths = [str(path) for path in (row.get("paths") or []) if path]
    files = [file_by_path[path] for path in paths if path in file_by_path]
    unit_names = list(
        dict.fromkeys(item.get("unit_name") or "" for item in files if item.get("unit_name"))
    )
    first = files[0] if files else {}
    return {
        "id": row.get("id"),
        "created_at": row.get("created_at") or "",
        "user_id": int(row.get("user_id") or 0),
        "username": str(row.get("username") or ""),
        "source": str(row.get("source") or "file"),
        "legacy": bool(row.get("legacy")),
        "batch": str(row.get("batch") or first.get("batch") or ""),
        "ontology": str(row.get("ontology") or first.get("ontology") or ""),
        "modality": str(row.get("modality") or first.get("modality") or ""),
        "channel": str(row.get("channel") or first.get("channel") or ""),
        "format": str(row.get("format") or first.get("format") or ""),
        "annotation": dict(row.get("annotation") or {}),
        "taxonomy_tag_ids": dict(row.get("taxonomy_tag_ids") or {}),
        "paths": [item["path"] for item in files],
        "unit_names": unit_names,
        "file_count": len(files),
        "uploaded": int(row.get("uploaded") or len(files) or 0),
        "replaced": int(row.get("replaced") or 0),
    }


def record_upload_session(
    *,
    user_id: int,
    username: str,
    source: str,
    batch: str,
    ontology: str = "",
    modality: str = "",
    channel: str = "",
    fmt: str = "",
    annotation: dict[str, Any] | None = None,
    taxonomy_tag_ids: dict[str, int | None] | None = None,
    paths: list[str],
    unit_names: list[str] | None = None,
    uploaded: int = 0,
    replaced: int = 0,
) -> dict[str, Any]:
    session = {
        "id": uuid.uuid4().hex[:16],
        "created_at": _now(),
        "user_id": int(user_id),
        "username": str(username),
        "source": source,
        "legacy": False,
        "batch": batch,
        "ontology": ontology,
        "modality": modality,
        "channel": channel,
        "format": fmt,
        "annotation": dict(annotation or {}),
        "taxonomy_tag_ids": _as_tag_ids(taxonomy_tag_ids),
        "paths": [str(path) for path in paths if path],
        "unit_names": [name for name in (unit_names or []) if name],
        "uploaded": uploaded or len(paths),
        "replaced": replaced,
    }

    def mutate(data):
        data.setdefault("upload_sessions", []).append(session)

    update_metadata(mutate)
    return session


def assemble_upload_sessions(files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    metadata = read_metadata()
    file_by_path = {item["path"]: item for item in files if item.get("path")}
    claimed: set[str] = set()
    sessions: list[dict[str, Any]] = []
    stored = sorted(
        metadata.get("upload_sessions") or [],
        key=lambda item: str(item.get("created_at") or ""),
        reverse=True,
    )
    for raw in stored:
        live_paths = [
            str(path)
            for path in (raw.get("paths") or [])
            if path and path in file_by_path and path not in claimed
        ]
        if not live_paths:
            continue
        claimed.update(live_paths)
        view = _session_view({**raw, "paths": live_paths}, file_by_path)
        if view["file_count"]:
            sessions.append(view)

    groups: dict[tuple[int, str, str], list[dict[str, Any]]] = defaultdict(list)
    for item in files:
        uploader = item.get("uploader") or {}
        path = item.get("path")
        if not path or path in claimed or not uploader:
            continue
        key = (
            int(uploader.get("id") or 0),
            str(uploader.get("uploaded_at") or ""),
            str(item.get("batch") or ""),
        )
        groups[key].append(item)

    for (user_id, uploaded_at, batch), rows in groups.items():
        first = rows[0]
        uploader = first.get("uploader") or {}
        sessions.append(
            _session_view(
                {
                    "id": _legacy_session_id(user_id, uploaded_at, batch),
                    "created_at": uploaded_at,
                    "user_id": user_id,
                    "username": str(uploader.get("username") or ""),
                    "source": "legacy",
                    "legacy": True,
                    "batch": batch,
                    "ontology": first.get("ontology") or "",
                    "modality": first.get("modality") or "",
                    "channel": first.get("channel") or "",
                    "format": first.get("format") or "",
                    "annotation": dict(first.get("annotation") or {}),
                    "taxonomy_tag_ids": dict(first.get("taxonomy_tag_ids") or {}),
                    "paths": [item["path"] for item in rows],
                    "unit_names": list(
                        dict.fromkeys(
                            item.get("unit_name") or "" for item in rows if item.get("unit_name")
                        )
                    ),
                    "uploaded": len(rows),
                    "replaced": 0,
                },
                file_by_path,
            )
        )
    sessions.sort(key=lambda item: item.get("created_at") or "", reverse=True)
    return sessions


def update_upload_session(
    session_id: str,
    *,
    annotation: dict[str, Any] | None = None,
    taxonomy_tag_ids: dict[str, int | None] | None = None,
    paths: list[str] | None = None,
) -> dict[str, Any]:
    session_id = (session_id or "").strip()
    if not session_id:
        raise ValueError("上传记录无效")

    def mutate(data):
        sessions = data.setdefault("upload_sessions", [])
        row = next((item for item in sessions if item.get("id") == session_id), None)
        if row is None:
            row = {
                "id": session_id,
                "created_at": _now(),
                "source": "legacy" if session_id.startswith("legacy-") else "file",
                "legacy": session_id.startswith("legacy-"),
                "paths": [str(path) for path in (paths or []) if path],
                "annotation": {},
            }
            sessions.append(row)
        if paths:
            row["paths"] = list(dict.fromkeys([*(row.get("paths") or []), *paths]))
        if annotation is not None:
            current = dict(row.get("annotation") or {})
            current.update(annotation)
            row["annotation"] = current
            row["updated_at"] = _now()
        if taxonomy_tag_ids is not None:
            row["taxonomy_tag_ids"] = apply_tag_updates(
                row.get("taxonomy_tag_ids"), taxonomy_tag_ids
            )
            row["updated_at"] = _now()

    update_metadata(mutate)
    metadata = read_metadata()
    row = next(
        (item for item in (metadata.get("upload_sessions") or []) if item.get("id") == session_id),
        None,
    )
    if row is None:
        raise FileNotFoundError(session_id)
    target_paths = [str(path) for path in (row.get("paths") or []) if path]
    if annotation is not None and target_paths:
        update_files_annotation(target_paths, annotation)
    if taxonomy_tag_ids is not None:
        apply_upload_taxonomy(
            str(row.get("batch") or ""),
            [str(name) for name in (row.get("unit_names") or []) if name],
            taxonomy_tag_ids,
            file_paths=target_paths,
        )
    return _session_view(row, {})


def delete_upload_session_files(
    session_id: str,
    *,
    paths: list[str] | None = None,
) -> dict[str, Any]:
    session_id = (session_id or "").strip()
    if not session_id:
        raise ValueError("上传记录无效")
    metadata = read_metadata()
    stored = next(
        (
            item
            for item in (metadata.get("upload_sessions") or [])
            if item.get("id") == session_id
        ),
        None,
    )
    targets = [
        str(path)
        for path in (paths if paths is not None else (stored or {}).get("paths") or [])
        if path
    ]
    if not targets:
        raise FileNotFoundError(session_id)
    doomed_units = _unit_keys_emptied_by(targets)
    removed: list[str] = []
    for rel_path in targets:
        try:
            delete_repo_file(rel_path, update_index=False)
            removed.append(rel_path)
        except FileNotFoundError:
            removed.append(rel_path)
    gone = set(removed)

    def mutate(data):
        sessions = data.setdefault("upload_sessions", [])
        next_rows: list[dict[str, Any]] = []
        for row in sessions:
            remaining = [path for path in (row.get("paths") or []) if path not in gone]
            if row.get("id") == session_id and paths is None:
                continue
            if row.get("id") == session_id and not remaining:
                continue
            row = dict(row)
            row["paths"] = remaining
            next_rows.append(row)
        data["upload_sessions"] = next_rows
        _drop_path_keys(data, removed)
        units = data.setdefault("units", {})
        for key in doomed_units:
            units.pop(key, None)

    update_metadata(mutate)
    refresh_catalog_paths(removed)
    return {"ok": True, "removed": removed, "session_id": session_id}


def rename_user_snapshots(user_id: int, username: str) -> None:
    """Keep browse and upload history labels on the account's current name."""
    target = int(user_id)
    name = str(username)

    def mutate(data):
        for row in (data.get("file_uploaders") or {}).values():
            if isinstance(row, dict) and int(row.get("id") or 0) == target:
                row["username"] = name
        for row in data.get("upload_sessions") or []:
            if isinstance(row, dict) and int(row.get("user_id") or 0) == target:
                row["username"] = name

    update_metadata(mutate)


def set_file_uploaders(
    paths: list[str],
    *,
    user_id: int,
    username: str,
) -> None:
    if not paths:
        return
    uploader = {
        "id": int(user_id),
        "username": str(username),
        "uploaded_at": _now(),
    }

    def mutate(data):
        rows = data.setdefault("file_uploaders", {})
        for path in paths:
            rows[str(path)] = dict(uploader)

    update_metadata(mutate)


def save_data_file(
    source: BinaryIO,
    *,
    ontology: str,
    modality: str,
    channel: str,
    fmt: str,
    batch: str,
    unit_name: str,
    original_name: str,
    replace: bool = False,
    update_index: bool = True,
    robot_style: str = "",
    robot_acquire_method: str = "",
    sub_path: str = "",
    file_version: str = "",
    motion_kind: str = "",
    preserve_tree: bool = False,
) -> dict[str, Any]:
    if preserve_tree:
        # Folder and zip uploads keep every directory and the original filename.
        filename = Path(original_name).name
        if not filename:
            suffix = f".{fmt.lstrip('.')}" if fmt else ""
            filename = f"{unit_name}{suffix}"
    else:
        unit_name = safe_name(normalize_unit_stem(unit_name) or unit_name, label="数据单元名")
        suffix = Path(original_name).suffix or f".{fmt.lstrip('.')}"
        original_stem = Path(original_name).stem
        if original_stem and (normalize_unit_stem(original_stem) or original_stem) == unit_name:
            filename = f"{safe_name(original_stem, label='文件名')}{suffix}"
        else:
            filename = f"{unit_name}{suffix}"
    dest = data_destination(
        ontology=ontology,
        modality=modality,
        channel=channel,
        fmt=fmt,
        batch=batch,
        filename=filename,
        robot_style=robot_style,
        robot_acquire_method=robot_acquire_method,
        sub_path=sub_path,
        file_version=file_version,
        motion_kind=motion_kind,
    )
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and not replace:
        raise ValueError(f"该数据单元已有同路径文件：{dest.relative_to(root())}")
    with dest.open("wb") as out:
        shutil.copyfileobj(source, out)
    if update_index:
        create_batch(batch)
        apply_batch_taxonomy_to_new_units(batch, [unit_name])
        refresh_catalog_paths([dest.relative_to(root()).as_posix()])
    parsed = _parse_data_file(dest, root())
    assert parsed is not None
    return parsed


def resolve_repo_file(rel_path: str) -> Path:
    base = root().resolve()
    path = (base / safe_relative_path(rel_path)).resolve()
    if path != base and base not in path.parents:
        raise ValueError("非法路径")
    return path


def delete_repo_file(rel_path: str, *, update_index: bool = True) -> None:
    path = resolve_repo_file(rel_path)
    if not path.is_file():
        raise FileNotFoundError(rel_path)
    doomed = _unit_keys_emptied_by([rel_path]) if update_index else []
    path.unlink()

    def mutate(data):
        _drop_path_keys(data, [rel_path])
        if doomed:
            units = data.setdefault("units", {})
            for key in doomed:
                units.pop(key, None)

    update_metadata(mutate)
    _cleanup_empty_parents(path.parent)
    if update_index:
        refresh_catalog_paths([rel_path])


def _drop_path_keys(data: dict[str, Any], paths: list[str]) -> None:
    for bucket in ("file_uploaders", "file_media", "files"):
        rows = data.get(bucket) or {}
        for path in paths:
            rows.pop(path, None)


def _remap_path_keys(data: dict[str, Any], mapping: dict[str, str]) -> None:
    for bucket in ("file_uploaders", "file_media", "files"):
        rows = data.setdefault(bucket, {})
        for old, new in mapping.items():
            if old in rows:
                rows[new] = rows.pop(old)
    for row in data.get("upload_sessions") or []:
        paths = [str(path) for path in (row.get("paths") or []) if path]
        if not paths:
            continue
        row["paths"] = [mapping.get(path, path) for path in paths]


def _cleanup_empty_parents(parent: Path) -> None:
    while parent != root() and parent.name not in {"data", "3d_model"}:
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent


def _require_batch(name: str, *, include_empty: bool = True) -> tuple[dict[str, Any], dict[str, Any]]:
    name = safe_name(name, label="数据批次名")
    snapshot = scan_data(include_empty=include_empty)
    batch = next((item for item in snapshot["batches"] if item["name"] == name), None)
    if batch is None:
        raise FileNotFoundError(name)
    return snapshot, batch


def _require_unit_row(batch: str, unit_name: str) -> tuple[dict[str, Any], dict[str, Any]]:
    snapshot, current = _require_batch(batch)
    units = current.get("units") or []
    unit = next((item for item in units if item["name"] == unit_name), None)
    if unit is None:
        unit = next(
            (item for item in units if stems_same_unit(item["name"], unit_name)),
            None,
        )
    if unit is None:
        raise FileNotFoundError(f"{batch}/{unit_name}")
    return snapshot, unit


def _relocate_files(mapping: dict[str, Path]) -> dict[str, str]:
    moved: dict[str, str] = {}
    for old_rel, dest in mapping.items():
        src = resolve_repo_file(old_rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists() and dest.resolve() != src.resolve():
            raise ValueError(f"目标已存在：{dest.relative_to(root())}")
        if dest.resolve() != src.resolve():
            src.rename(dest)
            _cleanup_empty_parents(src.parent)
        moved[old_rel] = dest.relative_to(root()).as_posix()
    return moved


def rename_batch(old_name: str, new_name: str) -> dict[str, Any]:
    old_name = safe_name(old_name, label="数据批次名")
    new_name = safe_name(new_name, label="数据批次名")
    snapshot, batch = _require_batch(old_name)
    if old_name == new_name:
        return batch
    target = next((item for item in snapshot["batches"] if item["name"] == new_name), None)
    if target is not None and (
        int(target.get("file_count") or 0) > 0 or int(target.get("unit_count") or 0) > 0
    ):
        raise ValueError(f"批次名已存在：{new_name}")
    mapping = {
        rec["path"]: resolve_repo_file(rec["path"]).parent.with_name(new_name)
        / Path(rec["path"]).name
        for rec in snapshot["files"]
        if rec["batch"] == old_name
    }
    moved = _relocate_files(mapping)

    def mutate(data):
        batches = data.setdefault("batches", {})
        row = dict(batches.pop(old_name, {"created_at": _now()}))
        placeholder = batches.pop(new_name, None)
        if isinstance(placeholder, dict):
            if not (row.get("taxonomy_tag_ids") or {}) and placeholder.get("taxonomy_tag_ids"):
                row["taxonomy_tag_ids"] = placeholder["taxonomy_tag_ids"]
            if not (row.get("annotation") or {}) and placeholder.get("annotation"):
                row["annotation"] = placeholder["annotation"]
            if not row.get("created_at"):
                row["created_at"] = placeholder.get("created_at") or _now()
        batches[new_name] = row
        units = data.setdefault("units", {})
        for key in list(units):
            if key.startswith(f"{old_name}::"):
                units[f"{new_name}::{key.split('::', 1)[1]}"] = units.pop(key)
        _remap_path_keys(data, moved)

    update_metadata(mutate)
    refresh_catalog_paths([*moved.keys(), *moved.values()])
    snapshot, renamed = _require_batch(new_name)
    return renamed


def rename_unit(batch: str, old_name: str, new_name: str) -> dict[str, Any]:
    batch = safe_name(batch, label="数据批次名")
    old_name = safe_name(old_name, label="数据单元名")
    new_name = safe_name(new_name, label="数据单元名")
    snapshot, unit = _require_unit_row(batch, old_name)
    old_name = unit["name"]
    if old_name == new_name:
        return unit
    if any(item["name"] == new_name for item in snapshot["units"] if item["batch"] == batch):
        raise ValueError(f"数据单元已存在：{new_name}")
    mapping = {
        rec["path"]: resolve_repo_file(rec["path"]).with_name(
            f"{new_name}{Path(rec['path']).suffix}"
        )
        for rec in unit.get("files") or []
    }
    moved = _relocate_files(mapping)

    def mutate(data):
        units = data.setdefault("units", {})
        old_key = unit_key(batch, old_name)
        new_key = unit_key(batch, new_name)
        if old_key in units:
            units[new_key] = units.pop(old_key)
        _remap_path_keys(data, moved)

    update_metadata(mutate)
    refresh_catalog_paths([*moved.keys(), *moved.values()])
    _, renamed = _require_unit_row(batch, new_name)
    return renamed


def _renamed_filename(old_name: str, new_name: str) -> str:
    """Sanitize a user-supplied file name while keeping the original suffix."""
    suffix = Path(old_name).suffix
    raw = (new_name or "").strip()
    if suffix and raw.lower().endswith(suffix.lower()):
        raw = raw[: -len(suffix)]
    stem = safe_name(raw, label="文件名")
    return f"{stem}{suffix}"


def rename_file(rel_path: str, new_name: str) -> dict[str, Any]:
    record = inspect_data_file(rel_path)
    if not record:
        raise FileNotFoundError(rel_path)
    src = resolve_repo_file(rel_path)
    filename = _renamed_filename(src.name, new_name)
    if filename == src.name:
        return record

    snapshot = scan_data()
    clustered = next((item for item in snapshot["files"] if item["path"] == rel_path), None)
    old_unit = str((clustered or record).get("unit_name") or record["unit_name"])
    batch = str(record.get("batch") or "")
    only_file = not any(
        item["path"] != rel_path
        and item.get("batch") == batch
        and item.get("unit_name") == old_unit
        for item in snapshot["files"]
    )
    dest = src.with_name(filename)
    moved = _relocate_files({rel_path: dest})
    new_rel = moved[rel_path]
    new_unit = normalize_unit_stem(Path(filename).stem) or Path(filename).stem

    def mutate(data):
        _remap_path_keys(data, moved)
        if not batch or old_unit == new_unit:
            return
        units = data.setdefault("units", {})
        old_key = unit_key(batch, old_unit)
        new_key = unit_key(batch, new_unit)
        if old_key not in units or old_key == new_key:
            return
        if only_file:
            units[new_key] = units.pop(old_key)
        elif new_key not in units:
            units[new_key] = dict(units[old_key])

    update_metadata(mutate)
    refresh_catalog_paths([*moved.keys(), *moved.values()])
    updated = inspect_data_file(new_rel)
    if updated is None:
        raise FileNotFoundError(new_rel)
    return updated


def delete_batches(names: list[str]) -> list[str]:
    removed: list[str] = []
    deleted_paths: list[str] = []
    for raw in names:
        name = safe_name(raw, label="数据批次名")
        try:
            snapshot, batch = _require_batch(name)
        except FileNotFoundError:
            continue
        for rec in snapshot["files"]:
            if rec["batch"] != name:
                continue
            path = resolve_repo_file(rec["path"])
            if path.is_file():
                path.unlink()
                _cleanup_empty_parents(path.parent)
            deleted_paths.append(rec["path"])
        removed.append(name)

    def mutate(data):
        batches = data.setdefault("batches", {})
        units = data.setdefault("units", {})
        for name in removed:
            batches.pop(name, None)
            for key in [key for key in units if key.startswith(f"{name}::")]:
                units.pop(key, None)
        _drop_path_keys(data, deleted_paths)

    if removed:
        update_metadata(mutate)
        refresh_catalog_paths(deleted_paths)
    return removed


def delete_units(items: list[tuple[str, str]]) -> list[str]:
    removed: list[str] = []
    deleted_paths: list[str] = []
    meta_keys: list[str] = []
    for raw_batch, raw_name in items:
        batch = safe_name(raw_batch, label="数据批次名")
        name = safe_name(raw_name, label="数据单元名")
        try:
            _, unit = _require_unit_row(batch, name)
        except FileNotFoundError:
            continue
        for rec in unit.get("files") or []:
            path = resolve_repo_file(rec["path"])
            if path.is_file():
                path.unlink()
                _cleanup_empty_parents(path.parent)
            deleted_paths.append(rec["path"])
        removed.append(unit_key(batch, unit["name"]))
        meta_keys.extend(_metadata_keys_for_unit(batch, unit["name"]))

    def mutate(data):
        units = data.setdefault("units", {})
        for key in [*removed, *meta_keys]:
            units.pop(key, None)
        _drop_path_keys(data, deleted_paths)

    if removed:
        update_metadata(mutate)
        refresh_catalog_paths(deleted_paths)
    return removed


def _file_robot_style(record: dict[str, Any], unit: dict[str, Any] | None = None) -> str:
    path_style = str(record.get("robot_style") or "").strip()
    if path_style:
        return path_style
    own = str(((record.get("annotation") or {}).get("robot_style") or "")).strip()
    if own:
        return own
    if unit:
        return str(((unit.get("annotation") or {}).get("robot_style") or "")).strip()
    return ""


def _archive_motion_kind(record: dict[str, Any]) -> str:
    kind = str(((record.get("annotation") or {}).get("motion_kind") or "")).strip().lower()
    if kind in {"skeleton", "object", "merged"}:
        return kind
    return "skeleton"


def _archive_kind_matches(record: dict[str, Any], kinds: list[tuple]) -> bool:
    rec_fmt = str(record.get("format") or "").lower()
    rec_motion = (
        _archive_motion_kind(record)
        if str(record.get("modality") or "") == "motion"
        else ""
    )
    for item in kinds:
        if (record.get("ontology"), record.get("modality")) != (item[0], item[1]):
            continue
        fmt = str(item[2] or "").lower() if len(item) > 2 and item[2] else ""
        if fmt and fmt != rec_fmt:
            continue
        motion = str(item[3] or "").strip().lower() if len(item) > 3 and item[3] else ""
        if motion and str(record.get("modality") or "") == "motion" and motion != rec_motion:
            continue
        return True
    return False


def collect_archive_entries(
    *,
    batches: list[str] | None = None,
    units: list[tuple[str, str]] | None = None,
    kinds: list[tuple[str, str] | tuple[str, str, str | None]] | None = None,
    robot_styles: list[str] | None = None,
    accept: Any | None = None,
) -> list[tuple[Path, str]]:
    snapshot = scan_data(include_empty=True)
    wanted_batches = {preserved_segment(name, label="数据批次名") for name in batches or []}
    wanted_units = {
        unit_key(preserved_segment(batch, label="数据批次名"), preserved_segment(name, label="数据单元名"))
        for batch, name in units or []
    }
    wanted_kinds = list(kinds or [])
    wanted_robot_styles = (
        None if robot_styles is None else {str(style) for style in robot_styles}
    )
    unit_by_key = {
        str(item.get("key") or unit_key(item.get("batch") or "", item.get("name") or "")): item
        for item in snapshot.get("units") or []
    }
    entries: list[tuple[Path, str]] = []
    seen: set[str] = set()
    for rec in snapshot["files"]:
        key = unit_key(rec["batch"], rec["unit_name"])
        if rec["batch"] not in wanted_batches and key not in wanted_units:
            continue
        if wanted_kinds and not _archive_kind_matches(rec, wanted_kinds):
            continue
        if wanted_robot_styles is not None and rec.get("ontology") == "robot":
            style = _file_robot_style(rec, unit_by_key.get(key))
            if style not in wanted_robot_styles:
                continue
        if accept is not None and not accept(rec):
            continue
        if rec["path"] in seen:
            continue
        path = resolve_repo_file(rec["path"])
        if not path.is_file():
            continue
        seen.add(rec["path"])
        entries.append((path, rec["path"].removeprefix("data/").lstrip("/")))
    return entries


def write_archive(entries: list[tuple[Path, str]]) -> Path:
    if not entries:
        raise ValueError("没有可下载的文件")
    handle = tempfile.NamedTemporaryFile(
        prefix="hub_archive_", suffix=".zip", delete=False
    )
    handle.close()
    dest = Path(handle.name)
    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path, arcname in entries:
            archive.write(path, arcname)
    return dest


def _safe_extract_zip(zip_file, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_file) as archive:
        for member in archive.infolist():
            name = decode_zip_filename(member)
            if member.is_dir() or name.startswith("__MACOSX/"):
                continue
            rel = safe_relative_path(name)
            target = (destination / rel).resolve()
            if destination.resolve() not in target.parents:
                raise ValueError("压缩包包含非法路径")
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as src, target.open("wb") as out:
                shutil.copyfileobj(src, out)


def _unwrap_single_directory(path: Path) -> Path:
    current = path
    while True:
        children = [p for p in current.iterdir() if not p.name.startswith(".")]
        if len(children) == 1 and children[0].is_dir():
            current = children[0]
            continue
        return current


def _checked_default_description(source_dir: Path, chosen: str) -> str:
    rel = chosen.replace("\\", "/").strip().lstrip("/")
    if not rel or ".." in Path(rel).parts:
        raise ValueError("请选择默认描述文件")
    path = (source_dir / rel).resolve()
    root_dir = source_dir.resolve()
    if path != root_dir and root_dir not in path.parents:
        raise ValueError("默认描述文件不在上传内容中")
    if not path.is_file():
        raise ValueError("默认描述文件不在上传内容中")
    if path.suffix.lower() not in {".urdf", ".xacro", ".xml"}:
        raise ValueError("默认描述文件须为 URDF、Xacro 或 MJCF XML")
    return path.relative_to(root_dir).as_posix()


def validate_standard_description(path: Path) -> dict[str, int]:
    source = _unwrap_single_directory(path)
    missing = [name for name in STANDARD_DESCRIPTION_DIRS if not (source / name).is_dir()]
    if missing:
        raise ValueError(
            "standard_description 缺少目录：" + "、".join(missing)
            + "；必须包含 meshes、mjcf、urdf"
        )
    counts = {
        name: sum(1 for p in (source / name).rglob("*") if p.is_file())
        for name in STANDARD_DESCRIPTION_DIRS
    }
    if any(count == 0 for count in counts.values()):
        empty = [name for name, count in counts.items() if count == 0]
        raise ValueError("standard_description 目录不能为空：" + "、".join(empty))
    return counts


def create_model_instance(ontology: str, name: str) -> dict[str, Any]:
    if ontology not in ONTOLOGIES:
        raise ValueError("模型类型须为 human 或 robot")
    name = safe_name(name, label="模型实例名")

    def mutate(data):
        data["models"].setdefault(
            f"{ontology}::{name}", {"created_at": _now(), "description": ""}
        )

    update_metadata(mutate)
    # Keep an empty instance represented in every relevant kind only in index;
    # physical directories are created when a file is uploaded.
    return {
        "key": f"{ontology}::{name}",
        "ontology": ontology,
        "name": name,
        "kinds": [],
        "files": [],
        "meta": read_metadata()["models"][f"{ontology}::{name}"],
    }


def update_model_instance_meta(
    ontology: str, name: str, patch: dict[str, Any]
) -> dict[str, Any]:
    if ontology not in ONTOLOGIES:
        raise ValueError("模型类型须为 human 或 robot")
    name = safe_name(name, label="模型实例名")
    key = f"{ontology}::{name}"

    def mutate(data):
        row = data["models"].setdefault(key, {"created_at": _now(), "description": ""})
        row.update(patch)

    update_metadata(mutate)
    return {
        "key": key,
        "ontology": ontology,
        "name": name,
        "meta": read_metadata()["models"].get(key, {}),
    }


def delete_model_instance(ontology: str, name: str) -> None:
    if ontology not in ONTOLOGIES:
        raise ValueError("模型类型须为 human 或 robot")
    name = safe_name(name, label="模型实例名")
    base = root() / "3d_model" / ontology
    for kind in MODEL_KINDS[ontology]:
        path = base / kind / name
        if path.is_dir():
            shutil.rmtree(path)

    def mutate(data):
        data["models"].pop(f"{ontology}::{name}", None)

    update_metadata(mutate)
    reindex_model_instance(ontology, name)


def save_model_upload(
    source: BinaryIO,
    *,
    ontology: str,
    instance: str,
    kind: str,
    filename: str,
    default_description_file: str = "",
) -> dict[str, Any]:
    if ontology not in ONTOLOGIES:
        raise ValueError("模型类型须为 human 或 robot")
    if kind not in MODEL_KINDS[ontology]:
        raise ValueError(f"模型格式须为：{', '.join(MODEL_KINDS[ontology])}")
    instance = safe_name(instance, label="模型实例名")
    destination = root() / "3d_model" / ontology / kind / instance
    if kind == "standard_description":
        if Path(filename).suffix.lower() != ".zip":
            raise ValueError("standard_description 请上传包含 meshes 与 urdf 的 zip 文件夹")
        with tempfile.TemporaryDirectory(
            prefix="standard_description_", dir=root() / "index"
        ) as temp_name:
            temp = Path(temp_name)
            _safe_extract_zip(source, temp)
            source_dir = _unwrap_single_directory(temp)
            default_rel = _checked_default_description(source_dir, default_description_file)
            from .robot_retarget_profile import fill_missing_mjcf

            generated_files = fill_missing_mjcf(source_dir, default_rel)
            counts = validate_standard_description(source_dir)
            create_model_instance(ontology, instance)
            if destination.exists():
                shutil.rmtree(destination)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(source_dir, destination)
        reindex_model_instance(ontology, instance)
        update_model_instance_meta(
            ontology, instance, {"default_description_file": default_rel}
        )
        ready = False
        profile_error = ""
        if default_rel.lower().endswith((".urdf", ".xacro")):
            try:
                from .robot_retarget_profile import write_uploaded_profile

                ready, profile_error = write_uploaded_profile(root(), instance, default_rel)
            except Exception as exc:
                ready, profile_error = False, str(exc)
        return {
            "ontology": ontology,
            "instance": instance,
            "kind": kind,
            "validation": counts,
            "default_description_file": default_rel,
            "generated_files": generated_files,
            "retarget_profile_ready": ready,
            "retarget_profile_error": profile_error,
        }
    create_model_instance(ontology, instance)
    destination.mkdir(parents=True, exist_ok=True)
    dest = destination / safe_name(Path(filename).name, label="文件名")
    if dest.exists():
        raise ValueError(f"模型文件已存在：{dest.name}")
    with dest.open("wb") as out:
        shutil.copyfileobj(source, out)
    refresh_catalog_paths([dest.relative_to(root()).as_posix()])
    return {
        "ontology": ontology,
        "instance": instance,
        "kind": kind,
        "path": dest.relative_to(root()).as_posix(),
    }


def resolve_import_zip(path: str) -> Path:
    """Resolve a server-side zip for import (host Downloads, /import_inbox, data/import)."""
    raw = Path(str(path or "").strip()).expanduser()
    if not str(raw):
        raise ValueError("请填写 zip 路径")
    candidates: list[Path] = []
    if raw.is_absolute():
        candidates.append(raw)
        candidates.append(Path("/import_inbox") / raw.name)
        if raw.name:
            candidates.append(Path("/data/import") / raw.name)
    else:
        candidates.extend(
            [
                Path("/import_inbox") / raw,
                Path("/import_inbox") / raw.name,
                Path("/data/import") / raw,
                Path("/data/import") / raw.name,
                Path("/data") / raw,
            ]
        )
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        if candidate.is_file() and candidate.suffix.lower() == ".zip":
            return candidate.resolve()
    raise FileNotFoundError(f"找不到 zip：{path}")
