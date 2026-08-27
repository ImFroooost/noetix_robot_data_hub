"""Filesystem-first repository for hub_repo/data, hub_repo/3d_model and index.

The physical files are the source of truth.  ``index/repository.json`` stores
only metadata (annotations, taxonomy tags and empty batches/instances), while
``index/catalog.json`` is a rebuildable snapshot of the current filesystem.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import tempfile
import threading
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO

from ..config import settings
from .media_probe import probe_file, public_media

ONTOLOGIES = ("human", "robot")
MODALITIES = ("tpv_video", "fpv_video", "motion", "text", "audio", "log")
FPV_CHANNELS = ("rgb", "depth")
MODEL_KINDS = {
    "human": ("fbx", "bvh", "smpl", "blend"),
    "robot": ("standard_description", "fbx", "blend"),
}
STANDARD_DESCRIPTION_DIRS = ("meshes", "mjcf", "urdf")

_SAFE_RE = re.compile(r"[^\w\u4e00-\u9fff\-.]+", re.UNICODE)
_INDEX_LOCK = threading.RLock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


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


def safe_relative_path(value: str) -> Path:
    p = Path(value)
    if p.is_absolute() or ".." in p.parts:
        raise ValueError("非法相对路径")
    return p


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = dict(data)
    payload["updated_at"] = _now()
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def read_metadata() -> dict[str, Any]:
    ensure_layout()
    with _INDEX_LOCK:
        try:
            data = json.loads(metadata_path().read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = {}
        data.setdefault("version", 1)
        data.setdefault("batches", {})
        data.setdefault("units", {})
        data.setdefault("models", {})
        data.setdefault("file_uploaders", {})
        data.setdefault("file_media", {})
        data.setdefault("files", {})
        return data


def update_metadata(mutator) -> dict[str, Any]:
    with _INDEX_LOCK:
        data = read_metadata()
        mutator(data)
        data["version"] = int(data.get("version") or 1) + 1
        _write_json(metadata_path(), data)
        return data


def unit_key(batch: str, unit_name: str) -> str:
    return f"{batch}::{unit_name}"


def _file_id(rel_path: str) -> str:
    return hashlib.sha1(rel_path.encode("utf-8")).hexdigest()[:20]


def _file_record(path: Path, base: Path, parsed: dict[str, str]) -> dict[str, Any]:
    stat = path.stat()
    rel = path.relative_to(base).as_posix()
    return {
        "id": _file_id(rel),
        "path": rel,
        "name": path.name,
        "unit_name": path.stem,
        "size": stat.st_size,
        "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        **parsed,
    }


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


def _attach_file_tags(record: dict[str, Any], metadata: dict[str, Any]) -> dict[str, Any]:
    record.update(_tag_fields((metadata.get("files") or {}).get(record["path"])))
    return record


def _merge_tag_updates(
    row: dict[str, Any],
    *,
    taxonomy_tag_ids: dict[str, int | None] | None = None,
    annotation: dict[str, Any] | None = None,
    meta: dict[str, Any] | None = None,
) -> None:
    if taxonomy_tag_ids is not None:
        current = dict(row.get("taxonomy_tag_ids") or {})
        for scheme, node_id in taxonomy_tag_ids.items():
            if node_id is None:
                current.pop(scheme, None)
            else:
                current[scheme] = int(node_id)
        row["taxonomy_tag_ids"] = current
    if annotation is not None:
        row["annotation"] = {**(row.get("annotation") or {}), **annotation}
    if meta is not None:
        row["meta"] = {**(row.get("meta") or {}), **meta}
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
    return _attach_cached_media(record, metadata, path)


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
        return record

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
    return record


def _parse_data_file(path: Path, base: Path) -> dict[str, Any] | None:
    parts = path.relative_to(base / "data").parts
    if len(parts) < 5:
        return None
    ontology, modality = parts[0], parts[1]
    if ontology not in ONTOLOGIES or modality not in MODALITIES:
        return None
    if modality == "fpv_video":
        if len(parts) < 6 or parts[2] not in FPV_CHANNELS:
            return None
        channel, fmt, batch = parts[2], parts[3], parts[4]
    else:
        channel, fmt, batch = "", parts[2], parts[3]
    return _file_record(
        path,
        base,
        {
            "ontology": ontology,
            "modality": modality,
            "channel": channel,
            "format": fmt,
            "batch": batch,
        },
    )


def scan_data(*, include_empty: bool = False) -> dict[str, Any]:
    """Scan files and group by ``batch + filename stem`` into data units."""
    base = root()
    metadata = read_metadata()
    files: list[dict[str, Any]] = []
    data_root = base / "data"
    if data_root.is_dir():
        for path in sorted(data_root.rglob("*")):
            if not path.is_file() or path.name.startswith("."):
                continue
            rec = _parse_data_file(path, base)
            if rec:
                rec["uploader"] = (metadata.get("file_uploaders") or {}).get(
                    rec["path"]
                )
                _attach_cached_media(rec, metadata, path)
                _attach_file_tags(rec, metadata)
                files.append(rec)

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for rec in files:
        grouped[unit_key(rec["batch"], rec["unit_name"])].append(rec)

    batch_names = {rec["batch"] for rec in files}
    if include_empty:
        batch_names.update((metadata.get("batches") or {}).keys())
    units = []
    for key, unit_files in sorted(grouped.items()):
        batch, name = key.split("::", 1)
        meta = dict((metadata.get("units") or {}).get(key) or {})
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
                        MODALITIES.index(f["modality"]),
                        f["channel"],
                        f["format"],
                    ),
                ),
                "taxonomy_tag_ids": meta.get("taxonomy_tag_ids") or {},
                "annotation": meta.get("annotation") or {},
                "meta": meta.get("meta") or {},
                "uploaders": list(uploaders.values()),
            }
        )
    if include_empty:
        existing_keys = {item["key"] for item in units}
        for key, raw_meta in sorted((metadata.get("units") or {}).items()):
            if key in existing_keys or "::" not in key:
                continue
            batch, name = key.split("::", 1)
            batch_names.add(batch)
            meta = dict(raw_meta or {})
            units.append(
                {
                    "key": key,
                    "batch": batch,
                    "name": name,
                    "file_count": 0,
                    "files": [],
                    "taxonomy_tag_ids": meta.get("taxonomy_tag_ids") or {},
                    "annotation": meta.get("annotation") or {},
                    "meta": meta.get("meta") or {},
                    "uploaders": [],
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
    return {
        "updated_at": _now(),
        "modalities": list(MODALITIES),
        "ontologies": list(ONTOLOGIES),
        "uploaders": uploaders,
        "batches": batches,
        "units": units,
        "files": files,
    }


def scan_models() -> dict[str, Any]:
    base = root()
    metadata = read_metadata()
    instances: dict[tuple[str, str], dict[str, Any]] = {}
    model_root = base / "3d_model"
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
    return {"updated_at": _now(), "instances": list(instances.values())}


def rebuild_catalog() -> dict[str, Any]:
    snapshot = {
        "version": 2,
        "updated_at": _now(),
        "data": scan_data(include_empty=True),
        "models": scan_models(),
    }
    with _INDEX_LOCK:
        _write_json(catalog_path(), snapshot)
    return snapshot


def create_batch(name: str) -> dict[str, Any]:
    name = safe_name(name, label="数据批次名")

    def mutate(data):
        data["batches"].setdefault(name, {"created_at": _now()})

    update_metadata(mutate)
    return next(
        b for b in scan_data(include_empty=True)["batches"] if b["name"] == name
    )


def update_unit_metadata(
    batch: str,
    name: str,
    *,
    taxonomy_tag_ids: dict[str, int | None] | None = None,
    annotation: dict[str, Any] | None = None,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    key = unit_key(batch, name)

    def mutate(data):
        row = data["units"].setdefault(key, {})
        _merge_tag_updates(
            row,
            taxonomy_tag_ids=taxonomy_tag_ids,
            annotation=annotation,
            meta=meta,
        )

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


def update_batch_metadata(
    name: str,
    *,
    taxonomy_tag_ids: dict[str, int | None] | None = None,
    annotation: dict[str, Any] | None = None,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    name = safe_name(name, label="数据批次名")

    def mutate(data):
        row = data["batches"].setdefault(name, {"created_at": _now()})
        _merge_tag_updates(
            row,
            taxonomy_tag_ids=taxonomy_tag_ids,
            annotation=annotation,
            meta=meta,
        )

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


def update_files_annotation(paths: list[str], annotation: dict[str, Any]) -> None:
    if not paths or not annotation:
        return

    def mutate(data):
        files = data.setdefault("files", {})
        for path in paths:
            row = files.setdefault(str(path), {})
            _merge_tag_updates(row, annotation=annotation)

    update_metadata(mutate)


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
    updated = inspect_data_file(rel_path)
    if updated is None:
        raise FileNotFoundError(rel_path)
    return updated


def data_destination(
    *,
    ontology: str,
    modality: str,
    channel: str,
    fmt: str,
    batch: str,
    filename: str,
) -> Path:
    if ontology not in ONTOLOGIES:
        raise ValueError("本体须为 human 或 robot")
    if modality not in MODALITIES:
        raise ValueError(f"数据模态须为：{', '.join(MODALITIES)}")
    if modality == "fpv_video" and channel not in FPV_CHANNELS:
        raise ValueError("fpv_video 须选择 rgb 或 depth")
    fmt = safe_name(fmt.lower().lstrip("."), label="格式")
    batch = safe_name(batch, label="数据批次名")
    filename = safe_name(Path(filename).name, label="文件名")
    parts = [root(), "data", ontology, modality]
    if modality == "fpv_video":
        parts.append(channel)
    return Path(*parts) / fmt / batch / filename


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
) -> dict[str, Any]:
    unit_name = safe_name(unit_name, label="数据单元名")
    suffix = Path(original_name).suffix or f".{fmt.lstrip('.')}"
    filename = f"{unit_name}{suffix}"
    dest = data_destination(
        ontology=ontology,
        modality=modality,
        channel=channel,
        fmt=fmt,
        batch=batch,
        filename=filename,
    )
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and not replace:
        raise ValueError(f"该数据单元已有同路径文件：{dest.relative_to(root())}")
    with dest.open("wb") as out:
        shutil.copyfileobj(source, out)
    if update_index:
        create_batch(batch)
        rebuild_catalog()
    parsed = _parse_data_file(dest, root())
    assert parsed is not None
    return parsed


def resolve_repo_file(rel_path: str) -> Path:
    base = root().resolve()
    path = (base / safe_relative_path(rel_path)).resolve()
    if path != base and base not in path.parents:
        raise ValueError("非法路径")
    return path


def delete_repo_file(rel_path: str) -> None:
    path = resolve_repo_file(rel_path)
    if not path.is_file():
        raise FileNotFoundError(rel_path)
    path.unlink()

    def mutate(data):
        (data.get("file_uploaders") or {}).pop(rel_path, None)
        (data.get("file_media") or {}).pop(rel_path, None)
        (data.get("files") or {}).pop(rel_path, None)

    update_metadata(mutate)
    parent = path.parent
    while parent != root() and parent.name not in {"data", "3d_model"}:
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent
    rebuild_catalog()


def _safe_extract_zip(zip_file, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_file) as archive:
        for member in archive.infolist():
            if member.is_dir() or member.filename.startswith("__MACOSX/"):
                continue
            rel = safe_relative_path(member.filename)
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
    rebuild_catalog()


def save_model_upload(
    source: BinaryIO,
    *,
    ontology: str,
    instance: str,
    kind: str,
    filename: str,
) -> dict[str, Any]:
    if ontology not in ONTOLOGIES:
        raise ValueError("模型类型须为 human 或 robot")
    if kind not in MODEL_KINDS[ontology]:
        raise ValueError(f"模型格式须为：{', '.join(MODEL_KINDS[ontology])}")
    instance = safe_name(instance, label="模型实例名")
    destination = root() / "3d_model" / ontology / kind / instance
    if kind == "standard_description":
        if Path(filename).suffix.lower() != ".zip":
            raise ValueError("standard_description 请上传包含 meshes/mjcf/urdf 的 zip 文件夹")
        with tempfile.TemporaryDirectory(
            prefix="standard_description_", dir=root() / "index"
        ) as temp_name:
            temp = Path(temp_name)
            _safe_extract_zip(source, temp)
            source_dir = _unwrap_single_directory(temp)
            counts = validate_standard_description(source_dir)
            create_model_instance(ontology, instance)
            if destination.exists():
                shutil.rmtree(destination)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(source_dir, destination)
        rebuild_catalog()
        return {
            "ontology": ontology,
            "instance": instance,
            "kind": kind,
            "validation": counts,
        }
    create_model_instance(ontology, instance)
    destination.mkdir(parents=True, exist_ok=True)
    dest = destination / safe_name(Path(filename).name, label="文件名")
    if dest.exists():
        raise ValueError(f"模型文件已存在：{dest.name}")
    with dest.open("wb") as out:
        shutil.copyfileobj(source, out)
    rebuild_catalog()
    return {
        "ontology": ontology,
        "instance": instance,
        "kind": kind,
        "path": dest.relative_to(root()).as_posix(),
    }
