"""Filesystem-first APIs for hub_repo/data, 3d_model and index metadata."""

from __future__ import annotations

import gc
import gzip
import json
import logging
import os
import shutil
import tempfile
import threading
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Body, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..core.deps import get_current_user
from ..database import get_db
from ..models import Capability, TaxonomyNode, User, UserPermission
from ..services.audit import write_audit
from ..services.disk_repository import tag_id_list
from ..services.disk_repository import (
    FPV_CHANNELS,
    MODEL_KINDS,
    MODALITIES,
    ONTOLOGIES,
    add_index_listener,
    browse_snapshot_serial,
    collect_archive_entries,
    local_write_generation,
    apply_upload_taxonomy,
    assemble_upload_sessions,
    ORIGINAL_FILE_VERSION,
    clean_file_version,
    clean_motion_kind,
    create_batch,
    data_destination,
    create_model_instance,
    delete_batches,
    delete_upload_session_files,
    delete_model_instance,
    delete_repo_file,
    delete_units,
    list_trash_entries,
    purge_all_trash,
    purge_trash_entry,
    restore_trash_entry,
    trash_repo_files,
    inspect_data_file,
    model_kind_directory,
    normalize_unit_stem,
    parent_taxonomy_ids,
    probe_data_file,
    read_metadata,
    catalog_rebuild_status,
    refresh_catalog_paths,
    root as repo_root,
    start_catalog_rebuild,
    record_upload_session,
    register_file_version,
    resolve_import_source,
    resolve_import_zip,
    rename_batch,
    rename_file,
    rename_unit,
    resolve_repo_file,
    save_data_file,
    write_archive,
    write_model_kind_zip,
    save_model_upload,
    scan_data,
    scan_models,
    set_file_uploaders,
    stems_same_unit,
    unit_key,
    update_batch_metadata,
    update_upload_session,
    update_file_metadata,
    update_files_annotation,
    update_unit_metadata,
    update_units_taxonomy,
)
from ..models.enums import is_super_role
from ..services.c3d_fbx_merge import (
    fbx_bytes_have_c3d,
    fbx_file_has_c3d,
    merge_c3d_into_fbx,
    pair_fbx_and_c3d_paths,
)
from ..services.human_zip import (
    folder_name_from_zip_filename,
    human_format_from_filename,
    iter_dir_human_members,
    iter_zip_human_members,
    safe_extract_member,
)
from ..services.motion_units import plan_clip_units, plan_followed_paths
from ..services.permissions import (
    FACET_SCHEMES,
    capability_query_values,
    ensure_capability,
    has_role_capability,
    path_matches,
    unit_matches_facet,
    user_has_any_capability,
    user_has_capability,
)

router = APIRouter(prefix="/storage", tags=["storage-repository"])


class BatchCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    taxonomy_tag_ids: dict[str, int | list[int] | None] | None = None


class UnitMetadataIn(BaseModel):
    taxonomy_tag_ids: dict[str, int | list[int] | None] | None = None
    annotation: dict[str, Any] | None = None
    meta: dict[str, Any] | None = None


class ModelInstanceIn(BaseModel):
    ontology: str
    name: str = Field(min_length=1, max_length=256)


class ModelInstanceMetaIn(BaseModel):
    default_description_file: str | None = None


class RenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=256)


class UploadSessionIn(BaseModel):
    annotation: dict[str, Any] | None = None
    taxonomy_tag_ids: dict[str, int | list[int] | None] | None = None
    paths: list[str] | None = None


class UploadSessionDeleteIn(BaseModel):
    paths: list[str] | None = None


class UnitTaxonomyPatch(BaseModel):
    name: str = Field(min_length=1, max_length=1024)
    taxonomy_tag_ids: dict[str, int | list[int] | None]


class NodeTaxonomyIn(BaseModel):
    batch: str = Field(min_length=1, max_length=256)
    units: list[UnitTaxonomyPatch] = Field(default_factory=list)


class UnitRefIn(BaseModel):
    batch: str = Field(min_length=1, max_length=256)
    name: str = Field(min_length=1, max_length=256)


class DataKindIn(BaseModel):
    ontology: str
    modality: str
    format: str | None = None
    motion_kind: str | None = None


class StorageSelectionIn(BaseModel):
    batches: list[str] = Field(default_factory=list)
    units: list[UnitRefIn] = Field(default_factory=list)
    kinds: list[DataKindIn] = Field(default_factory=list)
    robot_styles: list[str] | None = None
    paths: list[str] = Field(default_factory=list)
    label: str = ""


def _actor(user: User) -> dict[str, Any]:
    return {"id": user.id, "username": user.username}


def _can_manage_trash(db: Session, user: User, entry: dict[str, Any]) -> bool:
    if is_super_role(user.role) or user_has_any_capability(db, user, Capability.manage_users):
        return True
    deleted_by = entry.get("deleted_by") if isinstance(entry.get("deleted_by"), dict) else {}
    return int(deleted_by.get("id") or 0) == user.id


def _parse_annotation_form(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if not text:
        return {}
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="文件标注无效") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="文件标注须为对象")
    return {
        key: value
        for key, value in payload.items()
        if value not in (None, "")
    }


def _parse_taxonomy_form(raw: str) -> dict[str, list[int] | None] | None:
    text = (raw or "").strip()
    if not text:
        return None
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="分类标签无效") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="分类标签须为对象")
    parsed: dict[str, list[int] | None] = {}
    for scheme, value in payload.items():
        if value is None:
            parsed[str(scheme)] = None
            continue
        ids = tag_id_list(value)
        if not ids and value not in ("", []):
            raise HTTPException(status_code=400, detail=f"分类标签 {scheme} 无效")
        if ids:
            parsed[str(scheme)] = ids
    return parsed or None


def _format_from_upload(filename: str, fallback: str = "") -> str:
    fmt = human_format_from_filename(filename) or str(fallback or "").strip().lower().lstrip(".")
    if not fmt:
        raise HTTPException(status_code=400, detail="无法从文件名判断格式，请填写格式")
    return fmt


def _unit_path(unit: dict[str, Any]) -> str:
    return f"/{unit['batch']}/{unit['name']}/"


def _batch_path(batch: dict[str, Any] | str) -> str:
    name = batch if isinstance(batch, str) else batch["name"]
    return f"/{name}/"


def _can_see_empty_batch(db: Session, user: User, batch: dict[str, Any]) -> bool:
    """空批次：超级角色可见；受限角色仅当文件夹浏览范围覆盖该批次。"""
    if is_super_role(user.role) and has_role_capability(user, Capability.browse):
        return True
    return user_has_capability(db, user, Capability.browse, _batch_path(batch))


OWNER_CAPABILITIES = frozenset(
    {Capability.browse, Capability.download, Capability.annotate}
)


def _as_user_id(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _is_uploader(user: User, payload: dict[str, Any] | None) -> bool:
    if not payload:
        return False
    return _as_user_id(payload.get("id")) == user.id


def _user_uploaded_file(user: User, file: dict[str, Any]) -> bool:
    return _is_uploader(user, file.get("uploader"))


def _user_uploaded_in_unit(user: User, unit: dict[str, Any]) -> bool:
    if any(_is_uploader(user, item) for item in unit.get("uploaders") or []):
        return True
    return any(_user_uploaded_file(user, item) for item in unit.get("files") or [])


def _user_uploaded_in_batch(user: User, batch: dict[str, Any]) -> bool:
    if any(_is_uploader(user, item) for item in batch.get("uploaders") or []):
        return True
    return any(_user_uploaded_in_unit(user, unit) for unit in batch.get("units") or [])


def _unit_allowed_scoped(
    db: Session,
    user: User,
    capability: Capability,
    unit: dict[str, Any],
) -> bool:
    if not has_role_capability(user, capability):
        return False
    if is_super_role(user.role):
        return True
    rows = (
        db.query(UserPermission)
        .filter(
            UserPermission.user_id == user.id,
            UserPermission.capability.in_(capability_query_values(capability)),
        )
        .all()
    )
    for permission in rows:
        scheme = permission.scheme or ""
        if not scheme:
            if path_matches(_unit_path(unit), permission.path_prefix, permission.recursive):
                return True
            continue
        if scheme in FACET_SCHEMES:
            if unit_matches_facet(unit, scheme, permission.path_prefix):
                return True
            continue
        raw_id = (unit.get("taxonomy_tag_ids") or {}).get(scheme)
        for item in tag_id_list(raw_id):
            node = db.get(TaxonomyNode, item)
            if node and path_matches(node.path, permission.path_prefix, permission.recursive):
                return True
    return False


def _unit_allowed(
    db: Session,
    user: User,
    capability: Capability,
    unit: dict[str, Any],
) -> bool:
    if capability in OWNER_CAPABILITIES and _user_uploaded_in_unit(user, unit):
        return True
    return _unit_allowed_scoped(db, user, capability, unit)


def _require_unit(
    db: Session,
    user: User,
    capability: Capability,
    unit: dict[str, Any],
) -> None:
    if not _unit_allowed(db, user, capability, unit):
        raise HTTPException(
            status_code=403,
            detail=f"缺少权限：{capability.value} @ {_unit_path(unit)}",
        )
    if capability != Capability.browse and not _unit_allowed(
        db, user, Capability.browse, unit
    ):
        raise HTTPException(status_code=403, detail=f"缺少浏览权限：{_unit_path(unit)}")


def _require_batch_capability(
    db: Session,
    user: User,
    capability: Capability,
    batch: dict[str, Any],
) -> None:
    units = batch.get("units") or []
    if not units:
        if is_super_role(user.role) and has_role_capability(user, capability):
            return
        ensure_capability(db, user, capability, f"/{batch['name']}/")
        return
    if capability in OWNER_CAPABILITIES and any(
        _unit_allowed(db, user, capability, unit) for unit in units
    ):
        return
    for unit in units:
        _require_unit(db, user, capability, unit)


def _archive_response(
    entries: list[tuple[Path, str]],
    filename: str,
    background: BackgroundTasks,
) -> FileResponse:
    try:
        archive = write_archive(entries)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    background.add_task(lambda path=archive: path.unlink(missing_ok=True))
    return FileResponse(
        archive,
        filename=filename,
        media_type="application/zip",
        content_disposition_type="attachment",
    )


def _has_capability_on_unit(
    db: Session,
    user: User,
    unit: dict[str, Any],
    *capabilities: Capability,
) -> bool:
    return any(
        _unit_allowed(db, user, capability, unit) for capability in capabilities
    )


def _require_model_library_write(db: Session, user: User) -> None:
    """3D 模型库是全局资源。角色包含管理数据时，可以直接新增实例、上传文件并设置默认描述。"""
    if has_role_capability(user, Capability.manage_data):
        return
    ensure_capability(db, user, Capability.upload, "/")


def _require_tag_edit(
    db: Session,
    user: User,
    *,
    unit: dict[str, Any] | None = None,
    path: str,
) -> None:
    if is_super_role(user.role) and (
        has_role_capability(user, Capability.annotate)
        or has_role_capability(user, Capability.manage_data)
        or has_role_capability(user, Capability.upload)
    ):
        return
    caps = (Capability.annotate, Capability.manage_data, Capability.edit, Capability.upload)
    if unit and (
        _user_uploaded_in_unit(user, unit)
        or _has_capability_on_unit(db, user, unit, *caps)
    ):
        return
    if not unit:
        for capability in caps:
            rows = (
                db.query(UserPermission)
                .filter(
                    UserPermission.user_id == user.id,
                    UserPermission.capability == capability,
                )
                .all()
            )
            for permission in rows:
                if not permission.scheme and path_matches(
                    path, permission.path_prefix, permission.recursive
                ):
                    return
    raise HTTPException(status_code=403, detail=f"缺少标注权限：{path}")


def _require_file_owner(user: User, file: dict[str, Any]) -> None:
    uploader = file.get("uploader")
    if not uploader or int(uploader.get("id") or 0) != user.id:
        raise HTTPException(status_code=403, detail="只能替换当前用户自己上传的文件")


# Lookup tables for the browse snapshot. The snapshot holds every file in the
# repository; scanning it for one path on each preview request is what made
# file serving slow. Rebuilt only when a different snapshot object comes in.
_snapshot_lookup: tuple[dict[str, Any], dict[str, Any]] | None = None


def _lookup(snapshot: dict[str, Any]) -> dict[str, Any]:
    global _snapshot_lookup
    cached = _snapshot_lookup
    if cached is not None and cached[0] is snapshot:
        return cached[1]
    files: dict[str, dict[str, Any]] = {}
    for item in snapshot.get("files") or []:
        files.setdefault(item["path"], item)
    units: dict[tuple[str, str], dict[str, Any]] = {}
    unit_of_path: dict[str, dict[str, Any]] = {}
    for unit in snapshot.get("units") or []:
        units.setdefault((unit["batch"], unit["name"]), unit)
        for item in unit.get("files") or []:
            path = item.get("path")
            if path:
                unit_of_path.setdefault(path, unit)
    tables = {"files": files, "units": units, "unit_of_path": unit_of_path}
    _snapshot_lookup = (snapshot, tables)
    return tables


def _file_by_path(snapshot: dict[str, Any], path: str) -> dict[str, Any] | None:
    return _lookup(snapshot)["files"].get(path)


def _find_unit(snapshot: dict[str, Any], batch: str, name: str) -> dict[str, Any] | None:
    exact = _lookup(snapshot)["units"].get((batch, name))
    if exact:
        return exact
    return next(
        (
            unit
            for unit in snapshot["units"]
            if unit["batch"] == batch and stems_same_unit(unit["name"], name)
        ),
        None,
    )


def _unit_for_file(snapshot: dict[str, Any], path: str) -> dict[str, Any] | None:
    file = _file_by_path(snapshot, path)
    if file:
        unit = _find_unit(snapshot, file["batch"], file["unit_name"])
        if unit:
            return unit
    return _lookup(snapshot)["unit_of_path"].get(path)


def _taxonomy_briefs(db: Session, ids: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return _taxonomy_brief_loader(db, [ids])(ids)


def _taxonomy_brief_loader(db: Session, id_maps: list[dict[str, Any] | None]):
    wanted: set[int] = set()
    for ids in id_maps:
        for raw_id in (ids or {}).values():
            wanted.update(tag_id_list(raw_id))
    nodes = (
        {
            node.id: node
            for node in db.query(TaxonomyNode).filter(TaxonomyNode.id.in_(wanted)).all()
        }
        if wanted
        else {}
    )

    def briefs(ids: dict[str, Any] | None) -> dict[str, list[dict[str, Any]]]:
        out: dict[str, list[dict[str, Any]]] = {}
        for scheme, raw_id in (ids or {}).items():
            rows: list[dict[str, Any]] = []
            for item in tag_id_list(raw_id):
                node = nodes.get(item)
                if node and str(node.scheme) == scheme:
                    rows.append(
                        {
                            "id": node.id,
                            "scheme": scheme,
                            "code": node.code or "",
                            "name": node.name,
                            "path": node.path,
                        }
                    )
            if rows:
                out[scheme] = rows
        return out

    return briefs


def _validate_taxonomy_ids(db: Session, ids: dict[str, Any] | None) -> None:
    for scheme, node_id in (ids or {}).items():
        if node_id is None:
            continue
        for item in tag_id_list(node_id):
            node = db.get(TaxonomyNode, item)
            if not node:
                raise HTTPException(status_code=404, detail=f"分类节点不存在：{item}")
            if str(node.scheme) != scheme:
                raise HTTPException(status_code=400, detail=f"节点 {item} 不属于 {scheme}")


def _decorate_and_filter(
    snapshot: dict[str, Any],
    db: Session,
    user: User,
    *,
    batch: str | None,
    q: str | None,
    taxonomy_scheme: str | None,
    tag_id: int | None,
    uploader_id: int | None,
    tag_exact: bool = False,
    with_briefs: bool = True,
) -> dict[str, Any]:
    q_norm = (q or "").strip().lower()
    wanted_tag_ids: set[int] | None = None
    if taxonomy_scheme and tag_id is not None:
        node = db.get(TaxonomyNode, tag_id)
        if not node or str(node.scheme) != taxonomy_scheme:
            wanted_tag_ids = set()
        elif tag_exact:
            wanted_tag_ids = {tag_id}
        else:
            wanted_tag_ids = {
                row[0]
                for row in db.query(TaxonomyNode.id)
                .filter(
                    TaxonomyNode.scheme == taxonomy_scheme,
                    TaxonomyNode.path.like(f"{node.path}%"),
                )
                .all()
            }

    if with_briefs:
        brief_ids = [
            unit.get("taxonomy_tag_ids") or {}
            for unit in snapshot.get("units") or []
        ]
        brief_ids.extend(
            item.get("taxonomy_tag_ids") or {}
            for item in snapshot.get("batches") or []
        )
        brief_ids.extend(
            file.get("taxonomy_tag_ids") or {}
            for unit in snapshot.get("units") or []
            for file in unit.get("files") or []
        )
        briefs = _taxonomy_brief_loader(db, brief_ids)
    else:
        def briefs(_ids: dict[str, Any] | None) -> dict[str, list[dict[str, Any]]]:
            return {}

    units = []
    uploader_options: dict[int, dict[str, Any]] = {}
    unknown_file_count = 0
    for unit in snapshot["units"]:
        unit = dict(unit)
        if not _unit_allowed(db, user, Capability.browse, unit):
            continue
        for file in unit.get("files", []):
            uploader = file.get("uploader")
            if not uploader:
                unknown_file_count += 1
                continue
            uploader_key = int(uploader["id"])
            option = uploader_options.setdefault(
                uploader_key,
                {
                    "id": uploader_key,
                    "username": str(uploader["username"]),
                    "file_count": 0,
                },
            )
            option["file_count"] += 1
        if uploader_id is not None:
            filtered_files = [
                file
                for file in unit.get("files", [])
                if (
                    uploader_id == -1
                    and not file.get("uploader")
                )
                or (
                    file.get("uploader")
                    and int(file["uploader"]["id"]) == uploader_id
                )
            ]
            if not filtered_files:
                continue
            unit["files"] = filtered_files
            unit["file_count"] = len(filtered_files)
            unit["uploaders"] = list(
                {
                    (
                        file["uploader"]["id"],
                        file["uploader"]["username"],
                    ): file["uploader"]
                    for file in filtered_files
                    if file.get("uploader")
                }.values()
            )
        unit["taxonomy_tags"] = briefs(unit.get("taxonomy_tag_ids") or {})
        if batch and unit["batch"] != batch:
            continue
        if q_norm and q_norm not in unit["batch"].lower() and q_norm not in unit["name"].lower():
            continue
        if taxonomy_scheme and tag_id is not None:
            selected_ids = tag_id_list(
                (unit.get("taxonomy_tag_ids") or {}).get(taxonomy_scheme)
            )
            if wanted_tag_ids is not None and not any(
                item in wanted_tag_ids for item in selected_ids
            ):
                continue
        units.append(unit)

    visible_keys = {u["key"] for u in units}
    units_by_batch: dict[str, list[dict[str, Any]]] = {}
    for unit in units:
        units_by_batch.setdefault(unit["batch"], []).append(unit)
    batches = []
    for item in snapshot["batches"]:
        if batch and item["name"] != batch:
            continue
        visible_units = units_by_batch.get(item["name"], [])
        if not visible_units:
            if (
                q_norm
                or (taxonomy_scheme and tag_id is not None)
                or uploader_id is not None
            ):
                continue
            if not _can_see_empty_batch(db, user, item):
                continue
        batches.append(
            {
                **item,
                "taxonomy_tags": briefs(item.get("taxonomy_tag_ids") or {}),
                "units": visible_units,
                "unit_count": len(visible_units),
                "file_count": sum(u["file_count"] for u in visible_units),
                "uploaders": list(
                    {
                        (uploader["id"], uploader["username"]): uploader
                        for unit in visible_units
                        for uploader in unit.get("uploaders", [])
                    }.values()
                ),
            }
        )
    uploaders = sorted(
        uploader_options.values(), key=lambda item: item["username"]
    )
    if unknown_file_count:
        uploaders.append(
            {
                "id": -1,
                "username": "历史数据（上传者未知）",
                "file_count": unknown_file_count,
            }
        )
    visible_files = [
        file
        for unit in units
        if unit["key"] in visible_keys
        for file in unit.get("files", [])
    ]
    return {
        "updated_at": snapshot.get("updated_at"),
        "index_updated_at": snapshot.get("index_updated_at") or snapshot.get("updated_at"),
        "modalities": snapshot.get("modalities") or [],
        "ontologies": snapshot.get("ontologies") or [],
        "uploaders": uploaders,
        "batches": batches,
        "units": [],
        "files": [],
        "upload_sessions": _attach_session_taxonomy(
            assemble_upload_sessions(visible_files),
            units,
            db,
        ),
    }


def _attach_session_taxonomy(
    sessions: list[dict[str, Any]],
    units: list[dict[str, Any]],
    db: Session,
) -> list[dict[str, Any]]:
    unit_by_key = {item["key"]: item for item in units}
    out: list[dict[str, Any]] = []
    for session in sessions:
        tags = dict(session.get("taxonomy_tag_ids") or {})
        if not tags:
            batch = str(session.get("batch") or "")
            for name in session.get("unit_names") or []:
                unit = unit_by_key.get(f"{batch}::{name}")
                if not unit:
                    unit = next(
                        (
                            item
                            for item in units
                            if item.get("batch") == batch
                            and stems_same_unit(str(item.get("name") or ""), str(name))
                        ),
                        None,
                    )
                if not unit:
                    continue
                for scheme, node_id in (unit.get("taxonomy_tag_ids") or {}).items():
                    tags.setdefault(scheme, node_id)
        session = {
            **session,
            "taxonomy_tag_ids": tags,
            "taxonomy_tags": _taxonomy_briefs(db, tags),
        }
        out.append(session)
    return out


_OVERVIEW_ANN = (
    "motion_kind",
    "human_model",
    "human_model_file",
    "robot_style",
    "robot_version",
    "quality",
    "note",
    "fps",
    "person_name",
    "gender",
    "height",
    "status",
    "world_frame",
    "scene_xml",
    "scene_csv",
)


def _slim_file(file: dict[str, Any], unit: dict[str, Any]) -> dict[str, Any]:
    """One file row. Fields equal to the parent unit are left out; the page fills them back in."""
    path = file.get("path") or ""
    item: dict[str, Any] = {"path": path}
    name = file.get("name")
    if name and name != path.rsplit("/", 1)[-1]:
        item["name"] = name
    unit_name = file.get("unit_name")
    if unit_name and unit_name != unit.get("name"):
        item["unit_name"] = unit_name
    for key in ("size", "ontology", "modality", "format", "id"):
        value = file.get(key)
        if value not in (None, ""):
            item[key] = value
    for key in ("sub_path", "robot_style", "robot_acquire_method", "modified_at", "uploaded_at", "fps"):
        value = file.get(key)
        if value not in (None, "", 0):
            item[key] = value
    version = str(file.get("file_version") or "")
    if version and version != ORIGINAL_FILE_VERSION:
        item["file_version"] = version
    try:
        version_order = int(file.get("file_version_order") or 0)
    except (TypeError, ValueError):
        version_order = 0
    if version_order:
        item["file_version_order"] = version_order
    uploader = file.get("uploader")
    if isinstance(uploader, dict) and uploader.get("id") is not None:
        item["uploader"] = {"id": uploader.get("id"), "username": uploader.get("username")}
    tags = file.get("taxonomy_tag_ids") or {}
    if tags != (unit.get("taxonomy_tag_ids") or {}):
        item["taxonomy_tag_ids"] = tags
    ann = file.get("annotation")
    if ann:
        kept = {}
        for key in _OVERVIEW_ANN:
            value = ann.get(key)
            if value is not None and value != "":
                kept[key] = value
        if kept:
            item["annotation"] = kept
    return item


def _slim_unit(unit: dict[str, Any]) -> dict[str, Any]:
    item: dict[str, Any] = {
        "key": unit.get("key"),
        "batch": unit.get("batch"),
        "name": unit.get("name"),
        "file_count": unit.get("file_count") or 0,
        "files": [_slim_file(file, unit) for file in unit.get("files") or []],
        "taxonomy_tag_ids": unit.get("taxonomy_tag_ids") or {},
        "uploaders": unit.get("uploaders") or [],
    }
    for key in ("created_at", "uploaded_at", "modified_at"):
        if unit.get(key):
            item[key] = unit[key]
    if unit.get("annotation"):
        item["annotation"] = unit["annotation"]
    if unit.get("meta"):
        item["meta"] = unit["meta"]
    return item


def _compact_overview(payload: dict[str, Any]) -> dict[str, Any]:
    """Drop empty file fields and repeated tag paths. The page resolves names from the taxonomy list."""
    batches = []
    for batch in payload.get("batches") or []:
        row: dict[str, Any] = {
            "name": batch.get("name"),
            "unit_count": batch.get("unit_count") or 0,
            "file_count": batch.get("file_count") or 0,
            "units": [_slim_unit(unit) for unit in batch.get("units") or []],
            "uploaders": batch.get("uploaders") or [],
            "taxonomy_tag_ids": batch.get("taxonomy_tag_ids") or {},
        }
        for key in ("created_at", "uploaded_at", "modified_at"):
            if batch.get(key):
                row[key] = batch[key]
        if batch.get("annotation"):
            row["annotation"] = batch["annotation"]
        if batch.get("meta"):
            row["meta"] = batch["meta"]
        if batch.get("file_versions"):
            row["file_versions"] = batch["file_versions"]
        batches.append(row)
    return {**payload, "batches": batches}


@router.get("/overview")
def overview(
    batch: str | None = None,
    q: str | None = None,
    taxonomy_scheme: str | None = None,
    tag_id: int | None = None,
    tag_exact: bool = False,
    uploader_id: int | None = None,
    include_empty: bool = False,
    *,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if include_empty and not user_has_any_capability(db, user, Capability.manage_data):
        raise HTTPException(status_code=403, detail="只有具备管理数据权限的用户可以查看空目录")
    params = {
        "batch": batch or "",
        "q": (q or "").strip(),
        "taxonomy_scheme": taxonomy_scheme or "",
        "tag_id": tag_id,
        "tag_exact": bool(tag_exact),
        "uploader_id": uploader_id,
        "include_empty": bool(include_empty),
    }
    key = (user.id, *(params[name] for name in sorted(params)))
    gen = local_write_generation()
    serial = browse_snapshot_serial(include_empty)
    # Cheap when nothing changed; starts a background index refresh when the
    # files on disk moved on.
    snapshot = scan_data(include_empty=include_empty)
    with _overview_lock:
        entry = _overview_entries.get(key)
        if entry is not None:
            _overview_recent[key] = (user.id, params)
    if entry is None or entry["gen"] != gen:
        entry = _build_overview_entry(snapshot, serial, gen, db, user, params)
        _store_overview_entry(key, user.id, params, entry)
    elif entry["serial"] != browse_snapshot_serial(include_empty):
        # A host-side change (auto retarget) swapped in a newer index. Serve the
        # page already built and rebuild it off the request path.
        _schedule_overview_build(key, user.id, params)
    accepts_gzip = "gzip" in (request.headers.get("accept-encoding") or "").lower()
    headers = {"Vary": "Accept-Encoding"}
    if accepts_gzip:
        headers["Content-Encoding"] = "gzip"
        return Response(content=entry["gzip"], media_type="application/json", headers=headers)
    return Response(content=entry["raw"], media_type="application/json", headers=headers)


_overview_entries: dict[tuple, dict[str, Any]] = {}
_overview_recent: dict[tuple, tuple[int, dict[str, Any]]] = {}
_overview_building: set[tuple] = set()
_overview_lock = threading.Lock()
_OVERVIEW_MAX_ENTRIES = 8


def _build_overview_entry(
    snapshot: dict[str, Any],
    serial: int,
    gen: int,
    db: Session,
    user: User,
    params: dict[str, Any],
) -> dict[str, Any]:
    gc_was_on = gc.isenabled()
    gc.disable()
    try:
        payload = _compact_overview(
            _decorate_and_filter(
                snapshot,
                db,
                user,
                batch=params["batch"] or None,
                q=params["q"] or None,
                taxonomy_scheme=params["taxonomy_scheme"] or None,
                tag_id=params["tag_id"],
                tag_exact=params["tag_exact"],
                uploader_id=params["uploader_id"],
                with_briefs=False,
            )
        )
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    finally:
        if gc_was_on:
            gc.enable()
    return {
        "serial": serial,
        "gen": gen,
        "raw": raw,
        "gzip": gzip.compress(raw, compresslevel=5),
    }


def _store_overview_entry(key: tuple, user_id: int, params: dict[str, Any], entry: dict[str, Any]) -> None:
    with _overview_lock:
        _overview_entries[key] = entry
        _overview_recent[key] = (user_id, params)
        while len(_overview_entries) > _OVERVIEW_MAX_ENTRIES:
            oldest = next(iter(_overview_entries))
            _overview_entries.pop(oldest, None)
            _overview_recent.pop(oldest, None)


def _schedule_overview_build(key: tuple, user_id: int, params: dict[str, Any]) -> None:
    with _overview_lock:
        if key in _overview_building:
            return
        _overview_building.add(key)

    def run() -> None:
        from ..database import SessionLocal

        db = SessionLocal()
        try:
            user = db.get(User, user_id)
            if user is None:
                return
            gen = local_write_generation()
            serial = browse_snapshot_serial(params["include_empty"])
            snapshot = scan_data(include_empty=params["include_empty"])
            entry = _build_overview_entry(snapshot, serial, gen, db, user, params)
            with _overview_lock:
                current = _overview_entries.get(key)
            if current is None or current["gen"] <= gen:
                _store_overview_entry(key, user_id, params, entry)
        except Exception:
            logging.getLogger("catalog").exception("后台重建浏览页面失败")
        finally:
            db.close()
            with _overview_lock:
                _overview_building.discard(key)

    threading.Thread(target=run, name="overview-build", daemon=True).start()


def _rebuild_recent_overviews(include_empty: bool) -> None:
    """After a background index refresh, refresh the pages people opened recently."""
    with _overview_lock:
        recent = [
            (key, user_id, params)
            for key, (user_id, params) in _overview_recent.items()
            if params["include_empty"] == include_empty
        ]
    for key, user_id, params in recent[-4:]:
        _schedule_overview_build(key, user_id, params)


add_index_listener(_rebuild_recent_overviews)


@router.post("/rescan")
def rescan(
    _: User = Depends(get_current_user),
):
    return start_catalog_rebuild(force=True)


@router.get("/rescan/status")
def rescan_status(
    _: User = Depends(get_current_user),
):
    return catalog_rebuild_status()


@router.patch("/upload-sessions/{session_id}")
def patch_upload_session(
    session_id: str,
    body: UploadSessionIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    snapshot = _decorate_and_filter(
        scan_data(),
        db,
        user,
        batch=None,
        q=None,
        taxonomy_scheme=None,
        tag_id=None,
        uploader_id=None,
    )
    current = next(
        (
            item
            for item in snapshot.get("upload_sessions") or []
            if item.get("id") == session_id
        ),
        None,
    )
    if current is None:
        raise HTTPException(status_code=404, detail="上传记录不存在")
    if int(current.get("user_id") or 0) != user.id and not user_has_any_capability(
        db, user, Capability.manage_data
    ):
        raise HTTPException(status_code=403, detail="只能修改自己的上传记录")
    if body.annotation is None and body.taxonomy_tag_ids is None:
        return current
    if body.taxonomy_tag_ids is not None:
        _validate_taxonomy_ids(db, body.taxonomy_tag_ids)
    try:
        result = update_upload_session(
            session_id,
            annotation=body.annotation,
            taxonomy_tag_ids=body.taxonomy_tag_ids,
            paths=body.paths or current.get("paths") or [],
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(
        db,
        user_id=user.id,
        action="annotate",
        entity_type="upload_session",
        detail={"session_id": session_id, **body.model_dump(exclude_none=True)},
    )
    db.commit()
    return result


@router.delete("/upload-sessions/{session_id}")
def remove_upload_session(
    session_id: str,
    body: UploadSessionDeleteIn = Body(default=UploadSessionDeleteIn()),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    snapshot = _decorate_and_filter(
        scan_data(),
        db,
        user,
        batch=None,
        q=None,
        taxonomy_scheme=None,
        tag_id=None,
        uploader_id=None,
    )
    current = next(
        (
            item
            for item in snapshot.get("upload_sessions") or []
            if item.get("id") == session_id
        ),
        None,
    )
    if current is None:
        raise HTTPException(status_code=404, detail="上传记录不存在")
    if int(current.get("user_id") or 0) != user.id and not user_has_any_capability(
        db, user, Capability.manage_data
    ):
        raise HTTPException(status_code=403, detail="只能删除自己的上传记录")
    allowed = set(current.get("paths") or [])
    requested = body.paths
    selected = [path for path in (requested or []) if path in allowed] if requested is not None else None
    if requested is not None and not selected:
        raise HTTPException(status_code=400, detail="没有可删除的文件")
    try:
        result = delete_upload_session_files(
            session_id,
            paths=selected if selected is not None else list(current.get("paths") or []),
            actor=_actor(user),
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="上传记录不存在") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    removed = result.get("removed") or []
    write_audit(
        db,
        user_id=user.id,
        action="trash",
        entity_type="upload_session",
        detail={
            "session_id": session_id,
            "trash_id": result.get("trash_id") or "",
            "file_count": len(removed),
            "removed": removed[:20],
        },
    )
    db.commit()
    return result


@router.post("/batches")
def add_batch(
    body: BatchCreateIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ensure_capability(db, user, Capability.upload, "/")
    result = create_batch(body.name)
    if body.taxonomy_tag_ids:
        _validate_taxonomy_ids(db, body.taxonomy_tag_ids)
        result = update_batch_metadata(
            body.name, taxonomy_tag_ids=body.taxonomy_tag_ids
        )
    write_audit(
        db,
        user_id=user.id,
        action="create",
        entity_type="storage_batch",
        detail={"name": body.name},
    )
    db.commit()
    return result


@router.post("/batches/{name}/rename")
def rename_batch_api(
    name: str,
    body: RenameIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    snapshot = scan_data(include_empty=user_has_any_capability(db, user, Capability.manage_data))
    batch = next((item for item in snapshot["batches"] if item["name"] == name), None)
    if batch is None:
        raise HTTPException(status_code=404, detail="数据批次不存在")
    _require_batch_capability(db, user, Capability.edit, batch)
    try:
        result = rename_batch(name, body.name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="数据批次不存在") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(
        db,
        user_id=user.id,
        action="rename",
        entity_type="storage_batch",
        detail={"batch": name, "name": body.name},
    )
    db.commit()
    return result


@router.delete("/batches/{name}")
def remove_batch(
    name: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    snapshot = scan_data(include_empty=user_has_any_capability(db, user, Capability.manage_data))
    batch = next((item for item in snapshot["batches"] if item["name"] == name), None)
    if batch is None:
        raise HTTPException(status_code=404, detail="数据批次不存在")
    _require_batch_capability(db, user, Capability.edit, batch)
    delete_batches([name], actor=_actor(user))
    write_audit(
        db,
        user_id=user.id,
        action="trash",
        entity_type="storage_batch",
        detail={"batch": name},
    )
    db.commit()
    return {"ok": True, "removed": [name]}


@router.get("/batches/{name}/download")
def download_batch(
    name: str,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    snapshot = scan_data(include_empty=user_has_any_capability(db, user, Capability.manage_data))
    batch = next((item for item in snapshot["batches"] if item["name"] == name), None)
    if batch is None:
        raise HTTPException(status_code=404, detail="数据批次不存在")
    _require_batch_capability(db, user, Capability.download, batch)
    return _archive_response(
        collect_archive_entries(batches=[name]),
        f"{name}.zip",
        background,
    )


@router.post("/units/{batch}/{unit_name}/rename")
def rename_unit_api(
    batch: str,
    unit_name: str,
    body: RenameIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    snapshot = scan_data()
    unit = _find_unit(snapshot, batch, unit_name)
    if not unit:
        raise HTTPException(status_code=404, detail="数据单元不存在")
    _require_unit(db, user, Capability.edit, unit)
    try:
        result = rename_unit(batch, unit["name"], body.name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="数据单元不存在") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(
        db,
        user_id=user.id,
        action="rename",
        entity_type="storage_unit",
        detail={"batch": batch, "unit_name": unit_name, "name": body.name},
    )
    db.commit()
    return result


@router.delete("/units/{batch}/{unit_name}")
def remove_unit(
    batch: str,
    unit_name: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    snapshot = scan_data()
    unit = _find_unit(snapshot, batch, unit_name)
    if not unit:
        raise HTTPException(status_code=404, detail="数据单元不存在")
    _require_unit(db, user, Capability.edit, unit)
    delete_units([(batch, unit["name"])], actor=_actor(user))
    write_audit(
        db,
        user_id=user.id,
        action="trash",
        entity_type="storage_unit",
        detail={"batch": batch, "unit_name": unit_name},
    )
    db.commit()
    return {"ok": True, "removed": [f"{batch}::{unit_name}"]}


@router.get("/units/{batch}/{unit_name}/download")
def download_unit(
    batch: str,
    unit_name: str,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    snapshot = scan_data()
    unit = _find_unit(snapshot, batch, unit_name)
    if not unit:
        raise HTTPException(status_code=404, detail="数据单元不存在")
    _require_unit(db, user, Capability.download, unit)
    return _archive_response(
        collect_archive_entries(units=[(batch, unit["name"])]),
        f"{unit['name']}.zip",
        background,
    )


@router.post("/bulk-delete")
def bulk_delete(
    body: StorageSelectionIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    snapshot = scan_data(include_empty=user_has_any_capability(db, user, Capability.manage_data))
    actor = _actor(user)
    if body.paths:
        by_path = {
            str(item.get("path") or ""): unit
            for unit in snapshot["units"]
            for item in unit.get("files") or []
        }
        allowed: list[str] = []
        for raw in body.paths:
            path = str(raw or "").strip()
            unit = by_path.get(path)
            if not unit:
                raise HTTPException(status_code=404, detail=f"文件不在数据单元中：{path}")
            _require_unit(db, user, Capability.edit, unit)
            allowed.append(path)
        trashed = trash_repo_files(allowed, actor=actor, label=body.label)
        write_audit(
            db,
            user_id=user.id,
            action="trash",
            entity_type="storage_files",
            detail={
                "trash_id": trashed.get("id") or "",
                "label": trashed.get("label") or body.label,
                "file_count": trashed.get("file_count") or 0,
                "paths": allowed[:20],
            },
        )
        db.commit()
        return {
            "ok": True,
            "batches": [],
            "units": [],
            "trash_id": trashed.get("id") or "",
            "file_count": trashed.get("file_count") or 0,
        }
    batches_by_name = {item["name"]: item for item in snapshot["batches"]}
    removed_batches: list[str] = []
    removed_units: list[tuple[str, str]] = []
    for name in body.batches:
        batch = batches_by_name.get(name)
        if not batch:
            raise HTTPException(status_code=404, detail=f"数据批次不存在：{name}")
        _require_batch_capability(db, user, Capability.edit, batch)
        removed_batches.append(name)
    covered = set(removed_batches)
    for item in body.units:
        if item.batch in covered:
            continue
        unit = _find_unit(snapshot, item.batch, item.name)
        if not unit:
            raise HTTPException(status_code=404, detail=f"数据单元不存在：{item.batch}/{item.name}")
        _require_unit(db, user, Capability.edit, unit)
        removed_units.append((item.batch, item.name))
    if removed_units:
        delete_units(removed_units, actor=actor)
    if removed_batches:
        delete_batches(removed_batches, actor=actor)
    for name in removed_batches:
        write_audit(
            db,
            user_id=user.id,
            action="trash",
            entity_type="storage_batch",
            detail={"batch": name},
        )
    for batch_name, unit_name in removed_units:
        write_audit(
            db,
            user_id=user.id,
            action="trash",
            entity_type="storage_unit",
            detail={"batch": batch_name, "unit_name": unit_name},
        )
    db.commit()
    return {
        "ok": True,
        "batches": removed_batches,
        "units": [f"{batch}::{name}" for batch, name in removed_units],
    }


def _require_trash_reader(db: Session, user: User) -> None:
    if not user_has_any_capability(db, user, Capability.manage_data):
        raise HTTPException(status_code=403, detail="需要数据管理权限才能查看回收站")


@router.get("/trash")
def trash_list(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_trash_reader(db, user)
    entries = [
        entry
        for entry in list_trash_entries()
        if _can_manage_trash(db, user, entry)
    ]
    return {"entries": entries}


@router.post("/trash/{entry_id}/restore")
def trash_restore(
    entry_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_trash_reader(db, user)
    try:
        current = next(item for item in list_trash_entries() if item.get("id") == entry_id)
    except StopIteration as exc:
        raise HTTPException(status_code=404, detail="回收站里没有这项") from exc
    if not _can_manage_trash(db, user, current):
        raise HTTPException(status_code=403, detail="不能恢复别人删除的数据")
    try:
        result = restore_trash_entry(entry_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="回收站里没有这项") from exc
    write_audit(
        db,
        user_id=user.id,
        action="restore",
        entity_type="storage_trash",
        detail={
            "trash_id": entry_id,
            "file_count": len(result.get("restored") or []),
            "conflicts": result.get("conflicts") or [],
        },
    )
    db.commit()
    return result


@router.delete("/trash/{entry_id}")
def trash_purge(
    entry_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_trash_reader(db, user)
    try:
        current = next(item for item in list_trash_entries() if item.get("id") == entry_id)
    except StopIteration as exc:
        raise HTTPException(status_code=404, detail="回收站里没有这项") from exc
    if not _can_manage_trash(db, user, current):
        raise HTTPException(status_code=403, detail="不能永久删除别人放进回收站的数据")
    try:
        result = purge_trash_entry(entry_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="回收站里没有这项") from exc
    write_audit(
        db,
        user_id=user.id,
        action="purge",
        entity_type="storage_trash",
        detail={"trash_id": entry_id, "file_count": result.get("file_count") or 0},
    )
    db.commit()
    return result


@router.delete("/trash")
def trash_empty(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_trash_reader(db, user)
    visible = [entry for entry in list_trash_entries() if _can_manage_trash(db, user, entry)]
    if is_super_role(user.role) or user_has_any_capability(db, user, Capability.manage_users):
        result = purge_all_trash()
    else:
        result = {"entries": 0, "file_count": 0}
        for entry in visible:
            purged = purge_trash_entry(str(entry["id"]))
            result["entries"] += 1
            result["file_count"] += int(purged.get("file_count") or 0)
    write_audit(
        db,
        user_id=user.id,
        action="purge",
        entity_type="storage_trash",
        detail={"scope": "all", **result},
    )
    db.commit()
    return result


@router.post("/archive")
def archive_selection(
    body: StorageSelectionIn,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    snapshot = scan_data(include_empty=user_has_any_capability(db, user, Capability.manage_data))
    batches_by_name = {item["name"]: item for item in snapshot["batches"]}
    batches: list[str] = []
    units: list[tuple[str, str]] = []
    for name in body.batches:
        batch = batches_by_name.get(name)
        if not batch:
            raise HTTPException(status_code=404, detail=f"数据批次不存在：{name}")
        _require_batch_capability(db, user, Capability.download, batch)
        batches.append(name)
    covered = set(batches)
    for item in body.units:
        if item.batch in covered:
            continue
        unit = _find_unit(snapshot, item.batch, item.name)
        if not unit:
            raise HTTPException(status_code=404, detail=f"数据单元不存在：{item.batch}/{item.name}")
        _require_unit(db, user, Capability.download, unit)
        units.append((item.batch, item.name))
    if len(batches) == 1 and not units:
        filename = f"{batches[0]}.zip"
    elif len(units) == 1 and not batches:
        filename = f"{units[0][1]}.zip"
    else:
        filename = "storage_selection.zip"
    kinds = [
        (item.ontology, item.modality, item.format, item.motion_kind or "")
        for item in body.kinds
    ]
    for name in batches:
        write_audit(
            db,
            user_id=user.id,
            action="download",
            entity_type="storage_batch",
            detail={"batch": name},
        )
    for batch_name, unit_name in units:
        write_audit(
            db,
            user_id=user.id,
            action="download",
            entity_type="storage_unit",
            detail={"batch": batch_name, "unit_name": unit_name},
        )
    if not batches and not units:
        write_audit(
            db,
            user_id=user.id,
            action="download",
            entity_type="storage",
            detail={"kinds": kinds, "robot_styles": body.robot_styles},
        )
    db.commit()

    def accept(record: dict[str, Any]) -> bool:
        unit = _find_unit(snapshot, record["batch"], record["unit_name"])
        if unit and _unit_allowed_scoped(db, user, Capability.download, unit):
            return True
        return _user_uploaded_file(user, record)

    return _archive_response(
        collect_archive_entries(
            batches=batches,
            units=units,
            kinds=kinds or None,
            robot_styles=body.robot_styles,
            accept=accept,
        ),
        filename,
        background,
    )


@router.patch("/batches/{name}")
def patch_batch(
    name: str,
    body: UnitMetadataIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    snapshot = scan_data(include_empty=user_has_any_capability(db, user, Capability.manage_data))
    batch = next((item for item in snapshot["batches"] if item["name"] == name), None)
    units = (batch or {}).get("units") or []
    allowed_unit = next(
        (
            unit
            for unit in units
            if _has_capability_on_unit(
                db, user, unit, Capability.annotate, Capability.edit, Capability.upload
            )
        ),
        None,
    )
    _require_tag_edit(
        db,
        user,
        unit=allowed_unit,
        path=f"/{name}/",
    )
    if body.taxonomy_tag_ids is not None:
        _validate_taxonomy_ids(db, body.taxonomy_tag_ids)
    result = update_batch_metadata(
        name,
        taxonomy_tag_ids=body.taxonomy_tag_ids,
        annotation=body.annotation,
        meta=body.meta,
    )
    result["taxonomy_tags"] = _taxonomy_briefs(
        db, result.get("taxonomy_tag_ids") or {}
    )
    write_audit(
        db,
        user_id=user.id,
        action="annotate",
        entity_type="storage_batch",
        detail={"batch": name, **body.model_dump(exclude_none=True)},
    )
    db.commit()
    return result


@router.post("/nodes/taxonomy")
def patch_node_taxonomy(
    body: NodeTaxonomyIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not body.units:
        raise HTTPException(status_code=400, detail="没有要更新的数据单元")
    if len(body.units) > 20000:
        raise HTTPException(status_code=400, detail="一次更新的数据单元过多")
    merged_ids: dict[str, int | None] = {}
    for item in body.units:
        merged_ids.update(item.taxonomy_tag_ids)
    if merged_ids:
        _validate_taxonomy_ids(db, merged_ids)
    snapshot = scan_data(
        include_empty=user_has_any_capability(db, user, Capability.manage_data)
    )
    batch = next((item for item in snapshot["batches"] if item["name"] == body.batch), None)
    units = (batch or {}).get("units") or []
    allowed_unit = next(
        (
            unit
            for unit in units
            if _has_capability_on_unit(
                db, user, unit, Capability.annotate, Capability.edit, Capability.upload
            )
        ),
        None,
    )
    _require_tag_edit(
        db,
        user,
        unit=allowed_unit,
        path=f"/{body.batch}/",
    )
    updated = update_units_taxonomy(
        body.batch,
        [(item.name, item.taxonomy_tag_ids) for item in body.units],
    )
    write_audit(
        db,
        user_id=user.id,
        action="annotate",
        entity_type="storage_node",
        detail={
            "batch": body.batch,
            "unit_count": updated,
            "schemes": sorted(merged_ids),
        },
    )
    db.commit()
    return {"updated": updated}


@router.patch("/units/{batch}/{unit_name}")
def patch_unit(
    batch: str,
    unit_name: str,
    body: UnitMetadataIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    snapshot = scan_data()
    current = _find_unit(snapshot, batch, unit_name)
    _require_tag_edit(
        db,
        user,
        unit=current,
        path=f"/{batch}/{unit_name}/",
    )
    if body.taxonomy_tag_ids is not None:
        _validate_taxonomy_ids(db, body.taxonomy_tag_ids)
    result = update_unit_metadata(
        batch,
        current["name"] if current else unit_name,
        taxonomy_tag_ids=body.taxonomy_tag_ids,
        annotation=body.annotation,
        meta=body.meta,
    )
    result["taxonomy_tags"] = _taxonomy_briefs(
        db, result.get("taxonomy_tag_ids") or {}
    )
    write_audit(
        db,
        user_id=user.id,
        action="annotate",
        entity_type="storage_unit",
        detail={"batch": batch, "unit_name": unit_name, **body.model_dump(exclude_none=True)},
    )
    db.commit()
    return result


_UPLOAD_AUDIT_ACTION = {
    "uploaded": "upload",
    "replaced": "replace",
    "skip": "skip",
    "failed": "fail",
}


def _audit_upload_items(
    db: Session,
    user: User,
    *,
    batch: str,
    file_version: str,
    results: list[dict[str, Any]],
) -> None:
    """One audit row per file in a folder or zip upload."""
    version = file_version or ORIGINAL_FILE_VERSION
    if not results:
        write_audit(
            db,
            user_id=user.id,
            action="upload",
            entity_type="storage_batch",
            detail={"batch": batch, "file_version": version, "total": 0},
        )
        return
    for item in results:
        status = str(item.get("status") or "")
        file = item.get("file") if isinstance(item.get("file"), dict) else {}
        write_audit(
            db,
            user_id=user.id,
            action=_UPLOAD_AUDIT_ACTION.get(status, status or "upload"),
            entity_type="storage_file",
            detail={
                "batch": batch,
                "file_version": version,
                "name": item.get("name") or "",
                "unit_name": item.get("unit_name") or "",
                "path": (file or {}).get("path") or "",
                "status": status,
                "detail": item.get("detail") or "",
            },
        )


def _stored_file_version(item: dict[str, Any]) -> str:
    return str(item.get("file_version") or ORIGINAL_FILE_VERSION)


def _resolve_upload_file_version(snapshot: dict[str, Any], batch: str, raw: str) -> str:
    try:
        version = clean_file_version(raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if version == ORIGINAL_FILE_VERSION:
        return version
    known = {str(item.get("name") or "") for item in snapshot.get("batches") or []}
    if batch not in known and batch not in (read_metadata().get("batches") or {}):
        raise HTTPException(status_code=400, detail="文件版本只能加到已有批次")
    register_file_version(batch, version)
    return version


@router.post("/data/upload")
async def upload_data(
    ontology: str = Form(...),
    modality: str = Form(...),
    channel: str = Form(""),
    format: str = Form(...),
    batch: str = Form(...),
    unit_name: str = Form(...),
    replace: bool = Form(False),
    manage_override: bool = Form(False),
    annotation: str = Form(""),
    taxonomy_tag_ids: str = Form(""),
    robot_acquire_method: str = Form(""),
    file_version: str = Form(""),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if manage_override and not user_has_any_capability(db, user, Capability.manage_data):
        raise HTTPException(status_code=403, detail="只有具备管理数据权限的用户可以覆盖其他用户的数据")
    parsed_annotation = _parse_annotation_form(annotation)
    snapshot = scan_data()
    version = _resolve_upload_file_version(snapshot, batch, file_version)
    current = _find_unit(snapshot, batch, unit_name)
    if current:
        _require_unit(db, user, Capability.upload, current)
    else:
        ensure_capability(db, user, Capability.upload, f"/{batch}/{unit_name}/")
    resolved_fmt = _format_from_upload(file.filename or "", format)
    if replace and current:
        suffix = Path(file.filename or "").suffix or f".{resolved_fmt.lstrip('.')}"
        target_name = f"{unit_name}{suffix}"
        existing = next(
            (
                item
                for item in current.get("files", [])
                if item["ontology"] == ontology.strip().lower()
                and item["modality"] == modality.strip().lower()
                and item["channel"] == channel.strip().lower()
                and item["format"] == resolved_fmt
                and item["name"] == target_name
                and (
                    ontology.strip().lower() != "robot"
                    or modality.strip().lower() != "motion"
                    or (item.get("robot_acquire_method") or "omniretarget")
                    == (robot_acquire_method.strip().lower() or "omniretarget")
                )
                and (
                    modality.strip().lower() != "motion"
                    or clean_motion_kind((item.get("annotation") or {}).get("motion_kind"))
                    == clean_motion_kind(parsed_annotation.get("motion_kind"))
                )
                and _stored_file_version(item) == version
            ),
            None,
        )
        if existing and not manage_override:
            _require_file_owner(user, existing)
    try:
        result = save_data_file(
            file.file,
            ontology=ontology.strip().lower(),
            modality=modality.strip().lower(),
            channel=channel.strip().lower(),
            fmt=resolved_fmt,
            batch=batch,
            unit_name=unit_name,
            original_name=file.filename or f"{unit_name}.{resolved_fmt}",
            replace=replace,
            update_index=False,
            robot_style=str(parsed_annotation.get("robot_style") or ""),
            robot_acquire_method=robot_acquire_method,
            file_version=version,
            motion_kind=str(parsed_annotation.get("motion_kind") or ""),
        )
        uploader = {
            "id": user.id,
            "username": user.username,
        }
        set_file_uploaders(
            [result["path"]], user_id=user.id, username=user.username
        )
        update_files_annotation([result["path"]], parsed_annotation)
        create_batch(batch)
        parsed_tags = _parse_taxonomy_form(taxonomy_tag_ids)
        if parsed_tags:
            _validate_taxonomy_ids(db, parsed_tags)
        apply_upload_taxonomy(
            batch, [unit_name], parsed_tags, file_paths=[result["path"]]
        )
        session = record_upload_session(
            user_id=user.id,
            username=user.username,
            source="file",
            batch=batch,
            ontology=ontology.strip().lower(),
            modality=modality.strip().lower(),
            channel=channel.strip().lower(),
            fmt=resolved_fmt,
            annotation=parsed_annotation,
            taxonomy_tag_ids=parsed_tags,
            paths=[result["path"]],
            unit_names=[unit_name],
            uploaded=1,
        )
        refresh_catalog_paths([result["path"]])
        result["uploader"] = uploader
        result["upload_session_id"] = session["id"]
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(
        db,
        user_id=user.id,
        action="upload",
        entity_type="storage_file",
        detail=result,
    )
    db.commit()
    return result


@router.post("/data/upload-folder")
async def upload_data_folder(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    import logging as _logging
    _log = _logging.getLogger("upload_debug")
    try:
        form = await request.form(max_files=100000, max_fields=100000, max_part_size=100*1024*1024)
    except Exception as e:
        _log.error("Form parse error: %s: %s", type(e).__name__, e)
        raise HTTPException(status_code=400, detail=f"解析表单失败：{type(e).__name__}: {e}")
    ontology = form.get("ontology", "")
    modality = form.get("modality", "")
    channel = form.get("channel", "")
    format = form.get("format", "")
    batch = form.get("batch", "")
    actions = form.get("actions", "[]")
    annotation = form.get("annotation", "")
    taxonomy_tag_ids = form.get("taxonomy_tag_ids", "")
    raw_files = form.getlist("files")
    files = raw_files if isinstance(raw_files, list) else [raw_files]
    sub_paths_raw = form.get("sub_paths", "[]")
    """Upload one folder as a batch while rebuilding the catalog only once."""
    if not files:
        raise HTTPException(status_code=400, detail="文件夹中没有可上传文件")
    try:
        raw_actions = json.loads(actions)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="文件处理策略无效") from exc
    if not isinstance(raw_actions, list) or len(raw_actions) != len(files):
        raise HTTPException(status_code=400, detail="文件处理策略与文件数量不一致")
    if any(action not in {"upload", "replace", "skip"} for action in raw_actions):
        raise HTTPException(status_code=400, detail="文件处理策略须为 upload、replace 或 skip")
    try:
        raw_sub_paths = json.loads(sub_paths_raw)
    except json.JSONDecodeError:
        raw_sub_paths = []
    if not isinstance(raw_sub_paths, list):
        raw_sub_paths = []
    while len(raw_sub_paths) < len(files):
        raw_sub_paths.append("")
    folder_rels = [
        "/".join(
            part
            for part in (
                str(sub_path or "").replace("\\", "/").strip("/"),
                Path(getattr(file, "filename", "") or "").name,
            )
            if part
        )
        for file, sub_path in zip(files, raw_sub_paths)
    ]
    follow_paths = str(form.get("follow_paths", "")).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    merge_c3d = str(form.get("merge_c3d", "")).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }

    ontology = ontology.strip().lower()
    modality = modality.strip().lower()
    channel = channel.strip().lower()
    fallback_fmt = format.strip().lower().lstrip(".")
    parsed_annotation = _parse_annotation_form(annotation)
    robot_style = str(parsed_annotation.get("robot_style") or "")
    robot_acquire_method = str(form.get("robot_acquire_method") or "")

    c3d_by_index: dict[int, Any] = {}
    paired_c3d_indices: set[int] = set()
    if merge_c3d and modality == "motion":
        raw_c3d_files = form.getlist("c3d_files")
        raw_c3d_indices = form.getlist("c3d_target_indices")
        if raw_c3d_files and len(raw_c3d_files) == len(raw_c3d_indices):
            for c3d_obj, idx_str in zip(raw_c3d_files, raw_c3d_indices):
                try:
                    target_idx = int(str(idx_str).strip())
                except ValueError:
                    continue
                if 0 <= target_idx < len(files):
                    c3d_by_index[target_idx] = c3d_obj
        else:
            rel_to_idx = {rel: idx for idx, rel in enumerate(folder_rels)}
            for fbx_rel, c3d_rel in pair_fbx_and_c3d_paths(folder_rels):
                fbx_idx = rel_to_idx.get(fbx_rel)
                c3d_idx = rel_to_idx.get(c3d_rel)
                if fbx_idx is None or c3d_idx is None:
                    continue
                fbx_upload = files[fbx_idx]
                fbx_upload.file.seek(0)
                fbx_raw = fbx_upload.file.read()
                fbx_upload.file.seek(0)
                if not fbx_bytes_have_c3d(fbx_raw):
                    c3d_by_index[fbx_idx] = files[c3d_idx]
                    paired_c3d_indices.add(c3d_idx)

    active_folder_rels = [
        rel for idx, rel in enumerate(folder_rels) if idx not in paired_c3d_indices
    ]
    clip_plan = (
        plan_followed_paths(active_folder_rels, strip_common_root=True)
        if follow_paths
        else plan_clip_units(active_folder_rels)
    )

    snapshot = scan_data()
    raw_version = form.get("file_version", "")
    version = _resolve_upload_file_version(
        snapshot,
        str(batch or "").strip(),
        raw_version if isinstance(raw_version, str) else "",
    )
    current_units = {
        (item["batch"], item["name"]): item for item in snapshot.get("units", [])
    }
    results: list[dict[str, Any]] = []
    saved = 0
    saved_paths: list[str] = []
    normal_saved_paths: list[str] = []
    merged_saved_paths: list[str] = []
    merged_c3d_count = 0
    formats: list[str] = []

    _merge_tmp_root = Path("/hub_repo/index/tmp")
    if not _merge_tmp_root.parent.exists():
        _merge_tmp_root = Path(tempfile.gettempdir())
    else:
        _merge_tmp_root.mkdir(parents=True, exist_ok=True)

    for idx, (file, action, sub_path, rel) in enumerate(
        zip(files, raw_actions, raw_sub_paths, folder_rels)
    ):
        if idx in paired_c3d_indices:
            continue
        paired_c3d = c3d_by_index.get(idx)
        is_merged_pair = paired_c3d is not None and modality == "motion"
        effective_motion_kind = (
            "merged"
            if is_merged_pair
            else str(parsed_annotation.get("motion_kind") or "")
        )
        original_name = Path(file.filename or "").name
        planned = clip_plan.get(rel) or {}
        if planned.get("skip"):
            results.append(
                {
                    "name": original_name,
                    "unit_name": "",
                    "status": "skip",
                    "detail": planned["skip"],
                }
            )
            continue
        if planned:
            raw_unit_name = planned["unit_name"]
            stored_name = planned["stored_name"] or original_name
            sub_path = planned.get("sub_path") or ""
        else:
            file_stem = Path(original_name).stem
            if sub_path:
                raw_unit_name = normalize_unit_stem((sub_path + "/" + file_stem).replace("/", "_")) or (sub_path + "_" + file_stem).replace("/", "_")
            else:
                raw_unit_name = normalize_unit_stem(file_stem) or file_stem
            stored_name = original_name
        row: dict[str, Any] = {
            "name": original_name,
            "unit_name": raw_unit_name,
            "status": action,
        }
        if action == "skip":
            results.append(row)
            continue
        try:
            file_fmt = "fbx" if is_merged_pair else _format_from_upload(original_name, fallback_fmt)
            row["format"] = file_fmt
            current = current_units.get((batch, raw_unit_name))
            if not current:
                current = next(
                    (
                        item
                        for item in snapshot.get("units", [])
                        if item["batch"] == batch
                        and stems_same_unit(item["name"], raw_unit_name)
                    ),
                    None,
                )
            if current:
                _require_unit(db, user, Capability.upload, current)
            else:
                ensure_capability(
                    db, user, Capability.upload, f"/{batch}/{raw_unit_name}/"
                )
            if action == "replace" and current:
                wanted_kind = clean_motion_kind(effective_motion_kind)
                wanted_method = robot_acquire_method.strip().lower() or "omniretarget"
                existing = next(
                    (
                        item
                        for item in current.get("files", [])
                        if item["ontology"] == ontology
                        and item["modality"] == modality
                        and item["channel"] == channel
                        and item["format"] == file_fmt
                        and item["name"] == stored_name
                        and (item.get("sub_path") or "") == (sub_path or "")
                        and _stored_file_version(item) == version
                        and (
                            ontology != "robot"
                            or str(item.get("robot_style") or "").strip() == robot_style
                        )
                        and (
                            modality != "motion"
                            or clean_motion_kind(
                                (item.get("annotation") or {}).get("motion_kind")
                                or item.get("motion_kind")
                            )
                            == wanted_kind
                        )
                        and (
                            ontology != "robot"
                            or modality != "motion"
                            or (item.get("robot_acquire_method") or "omniretarget")
                            == wanted_method
                        )
                    ),
                    None,
                )
                if existing and not user_has_any_capability(db, user, Capability.manage_data):
                    _require_file_owner(user, existing)
            if is_merged_pair:
                with tempfile.TemporaryDirectory(
                    prefix="c3d_merge_", dir=_merge_tmp_root
                ) as td:
                    td_path = Path(td)
                    fbx_in = td_path / "in.fbx"
                    c3d_in = td_path / "in.c3d"
                    fbx_out = td_path / (stored_name or f"{raw_unit_name}.fbx")
                    file.file.seek(0)
                    with fbx_in.open("wb") as out_fh:
                        shutil.copyfileobj(file.file, out_fh, 1024 * 1024)
                    paired_c3d.file.seek(0)
                    with c3d_in.open("wb") as out_fh:
                        shutil.copyfileobj(paired_c3d.file, out_fh, 1024 * 1024)
                    merge_c3d_into_fbx(fbx_in, c3d_in, fbx_out)
                    result = save_data_file(
                        source_path=fbx_out,
                        ontology=ontology,
                        modality=modality,
                        channel=channel,
                        fmt="fbx",
                        batch=batch,
                        unit_name=raw_unit_name,
                        original_name=stored_name or f"{raw_unit_name}.fbx",
                        replace=action == "replace",
                        update_index=False,
                        robot_style=robot_style,
                        robot_acquire_method=robot_acquire_method,
                        sub_path=sub_path,
                        file_version=version,
                        motion_kind="merged",
                        preserve_tree=True,
                    )
            else:
                result = save_data_file(
                    file.file,
                    ontology=ontology,
                    modality=modality,
                    channel=channel,
                    fmt=file_fmt,
                    batch=batch,
                    unit_name=raw_unit_name,
                    original_name=stored_name or f"{raw_unit_name}.{file_fmt}",
                    replace=action == "replace",
                    update_index=False,
                    robot_style=robot_style,
                    robot_acquire_method=robot_acquire_method,
                    sub_path=sub_path,
                    file_version=version,
                    motion_kind=effective_motion_kind,
                    preserve_tree=True,
                )
            result["uploader"] = {
                "id": user.id,
                "username": user.username,
            }
            row.update({"status": "replaced" if action == "replace" else "uploaded", "file": result})
            if is_merged_pair:
                row["merged_c3d"] = True
                merged_saved_paths.append(result["path"])
                merged_c3d_count += 1
            else:
                normal_saved_paths.append(result["path"])
            saved += 1
            saved_paths.append(result["path"])
            formats.append(file_fmt)
        except (ValueError, RuntimeError, HTTPException) as exc:
            detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
            row.update({"status": "failed", "detail": detail})
        except OSError as exc:
            row.update({"status": "failed", "detail": f"写入文件失败：{exc}"})
        results.append(row)

    session = None
    if saved:
        set_file_uploaders(
            saved_paths, user_id=user.id, username=user.username
        )
        parsed_annotation = _parse_annotation_form(annotation)
        if normal_saved_paths and parsed_annotation:
            update_files_annotation(normal_saved_paths, parsed_annotation)
        if merged_saved_paths:
            update_files_annotation(
                merged_saved_paths,
                {**parsed_annotation, "motion_kind": "merged"},
            )
        create_batch(batch)
        unit_names = [
            str(item.get("unit_name") or "")
            for item in results
            if item.get("status") in {"uploaded", "replaced"}
        ]
        parsed_tags = _parse_taxonomy_form(taxonomy_tag_ids)
        if parsed_tags:
            _validate_taxonomy_ids(db, parsed_tags)
        apply_upload_taxonomy(batch, unit_names, parsed_tags, file_paths=saved_paths)
        session_annotation = (
            {**parsed_annotation, "motion_kind": "merged"}
            if merged_saved_paths and not normal_saved_paths
            else parsed_annotation
        )
        session = record_upload_session(
            user_id=user.id,
            username=user.username,
            source="folder",
            batch=batch,
            ontology=ontology,
            modality=modality,
            channel=channel,
            fmt=",".join(dict.fromkeys(formats)),
            annotation=session_annotation,
            taxonomy_tag_ids=parsed_tags,
            paths=saved_paths,
            unit_names=unit_names,
            uploaded=sum(item["status"] == "uploaded" for item in results),
            replaced=sum(item["status"] == "replaced" for item in results),
        )
        refresh_catalog_paths(saved_paths)
    summary = {
        "batch": batch,
        "file_version": version,
        "total": len(results),
        "uploaded": sum(item["status"] == "uploaded" for item in results),
        "replaced": sum(item["status"] == "replaced" for item in results),
        "skipped": sum(item["status"] == "skip" for item in results),
        "failed": sum(item["status"] == "failed" for item in results),
        "merged_c3d": merged_c3d_count,
        "items": results,
        "upload_session_id": session["id"] if session else None,
    }
    _audit_upload_items(
        db,
        user,
        batch=batch,
        file_version=version,
        results=results,
    )
    db.commit()
    return summary


_ZIP_JOBS: dict[str, dict[str, Any]] = {}
_ZIP_JOBS_LOCK = threading.Lock()
_ZIP_JOB_KEEP = 24


def _http_detail(exc: HTTPException) -> str:
    detail = exc.detail
    return detail if isinstance(detail, str) else str(detail)


def _zip_job_counts(results: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "processed": len(results),
        "uploaded": sum(item["status"] == "uploaded" for item in results),
        "replaced": sum(item["status"] == "replaced" for item in results),
        "skipped": sum(item["status"] == "skip" for item in results),
        "failed": sum(item["status"] == "failed" for item in results),
    }


def _public_zip_job(job: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "job_id": job["id"],
        "status": job["status"],
        "batch": job["batch"],
        "total": job["total"],
        "processed": job["processed"],
        "uploaded": job["uploaded"],
        "replaced": job["replaced"],
        "skipped": job["skipped"],
        "failed": job["failed"],
        "detail": job.get("detail") or "",
    }
    if job["status"] == "done" and job.get("result") is not None:
        payload["result"] = job["result"]
    return payload


def _new_zip_job(job_id: str, user_id: int, batch: str) -> None:
    job = {
        "id": job_id,
        "user_id": user_id,
        "batch": batch,
        "status": "running",
        "total": 0,
        "processed": 0,
        "uploaded": 0,
        "replaced": 0,
        "skipped": 0,
        "failed": 0,
        "detail": "正在保存压缩包",
        "result": None,
        "started": time.time(),
    }
    with _ZIP_JOBS_LOCK:
        _ZIP_JOBS[job_id] = job
        overflow = len(_ZIP_JOBS) - _ZIP_JOB_KEEP
        if overflow > 0:
            finished = sorted(
                (item for item in _ZIP_JOBS.values() if item["status"] != "running"),
                key=lambda item: item["started"],
            )
            for item in finished[:overflow]:
                _ZIP_JOBS.pop(item["id"], None)


def _touch_zip_job(job_id: str, **fields: Any) -> None:
    with _ZIP_JOBS_LOCK:
        job = _ZIP_JOBS.get(job_id)
        if job is not None:
            job.update(fields)


def _copy_zip_job(job_id: str, user_id: int | None = None) -> dict[str, Any] | None:
    with _ZIP_JOBS_LOCK:
        job = _ZIP_JOBS.get(job_id)
        if job is None or (user_id is not None and job["user_id"] != user_id):
            return None
        return _public_zip_job(job)


def _absent_zip_job() -> dict[str, Any]:
    return {
        "status": "absent",
        "total": 0,
        "processed": 0,
        "uploaded": 0,
        "replaced": 0,
        "skipped": 0,
        "failed": 0,
        "detail": "",
    }


def _run_zip_import(
    *,
    job_id: str,
    staging: Path,
    archive: Path | None,
    source_fd: int | None,
    user_id: int,
    ontology: str,
    modality: str,
    channel: str,
    batch: str,
    replace: bool,
    follow_paths: bool,
    manage_override: bool,
    annotation: str,
    taxonomy_tag_ids: str,
    robot_acquire_method: str,
    version: str,
    merge_c3d: bool = False,
) -> None:
    """Extract and store a zip (or server directory) after the HTTP response has already been sent."""
    from contextlib import ExitStack
    from ..database import SessionLocal

    db = None
    try:
        if source_fd is not None:
            _touch_zip_job(job_id, detail="正在保存压缩包")
            archive = staging / "upload.zip"
            held_fd = source_fd
            source_fd = None
            with os.fdopen(held_fd, "rb") as src, archive.open("wb") as out:
                src.seek(0)
                shutil.copyfileobj(src, out, 1024 * 1024)
        if archive is None:
            raise RuntimeError("缺少导入源")

        db = SessionLocal()
        user = db.get(User, user_id)
        if user is None:
            raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
        parsed_annotation = _parse_annotation_form(annotation)
        work_dir = staging / "extracted"
        warnings: list[str] = []
        is_dir_source = archive.is_dir()
        _touch_zip_job(job_id, detail="正在读取文件夹" if is_dir_source else "正在读取压缩包")
        with ExitStack() as stack:
            archive_handle: zipfile.ZipFile | None = None
            if is_dir_source:
                raw_members: list[tuple[Any, str]] = list(iter_dir_human_members(archive))
            else:
                try:
                    archive_handle = stack.enter_context(zipfile.ZipFile(archive))
                except Exception as exc:
                    raise HTTPException(status_code=400, detail=f"无法解压 ZIP：{exc}") from exc
                raw_members = list(iter_zip_human_members(archive_handle))
            if not raw_members:
                raise HTTPException(
                    status_code=400,
                    detail="未找到可导入文件（按后缀识别格式，未知后缀会作为新格式入库）",
                )

            merge_c3d_by_fbx: dict[str, tuple[Any, str]] = {}
            paired_c3d_rels: set[str] = set()
            if merge_c3d and modality == "motion":
                _touch_zip_job(job_id, detail="正在检查可合并的 C3D 与 FBX")
                entry_by_rel = {rel: entry for entry, rel in raw_members}
                for fbx_rel, c3d_rel in pair_fbx_and_c3d_paths(entry_by_rel.keys()):
                    fbx_entry = entry_by_rel.get(fbx_rel)
                    c3d_entry = entry_by_rel.get(c3d_rel)
                    if fbx_entry is None or c3d_entry is None:
                        continue
                    has_c3d = (
                        fbx_file_has_c3d(fbx_entry)
                        if is_dir_source
                        else fbx_bytes_have_c3d(archive_handle.read(fbx_entry))  # type: ignore[union-attr]
                    )
                    if not has_c3d:
                        merge_c3d_by_fbx[fbx_rel] = (c3d_entry, c3d_rel)
                        paired_c3d_rels.add(c3d_rel)

            members = [
                (entry, rel)
                for entry, rel in raw_members
                if rel not in paired_c3d_rels
            ]
            zip_rels = [name for _info, name in members]
            clip_plan = (
                plan_followed_paths(zip_rels, strip_common_root=False)
                if follow_paths
                else plan_clip_units(zip_rels)
            )
            _touch_zip_job(job_id, total=len(members), detail="正在对照已有文件")
            snapshot = scan_data()
            current_units = {
                (item["batch"], item["name"]): item for item in snapshot.get("units", [])
            }
            results: list[dict[str, Any]] = []
            saved_paths: list[str] = []
            normal_saved_paths: list[str] = []
            merged_saved_paths: list[str] = []
            merged_c3d_count = 0
            formats: list[str] = []
            new_robot_style = str(parsed_annotation.get("robot_style") or "").strip()

            def publish(detail: str = "") -> None:
                _touch_zip_job(job_id, detail=detail, **_zip_job_counts(results))

            for info, rel in members:
                is_merged_pair = rel in merge_c3d_by_fbx
                effective_motion_kind = (
                    "merged"
                    if is_merged_pair
                    else str(parsed_annotation.get("motion_kind") or "")
                )
                original_name = Path(rel).name
                planned = clip_plan.get(rel) or {}
                if planned.get("skip"):
                    results.append(
                        {
                            "name": original_name,
                            "unit_name": "",
                            "status": "skip",
                            "detail": planned["skip"],
                        }
                    )
                    publish()
                    continue
                file_sub_path = planned.get("sub_path") or ""
                effective_unit = planned.get("unit_name") or (
                    normalize_unit_stem(Path(original_name).stem) or Path(original_name).stem
                )
                stored_name = planned.get("stored_name") or original_name
                fmt = "fbx" if is_merged_pair else human_format_from_filename(original_name).lstrip(".")
                row: dict[str, Any] = {
                    "name": original_name,
                    "unit_name": effective_unit,
                    "status": "upload",
                }
                current = current_units.get((batch, effective_unit))
                if not current:
                    current = next(
                        (
                            item
                            for item in snapshot.get("units", [])
                            if item["batch"] == batch
                            and stems_same_unit(item["name"], effective_unit)
                        ),
                        None,
                    )
                if current:
                    _require_unit(db, user, Capability.upload, current)
                else:
                    ensure_capability(db, user, Capability.upload, f"/{batch}/{effective_unit}/")
                wanted_kind = clean_motion_kind(effective_motion_kind)
                existing = None
                if current:
                    existing = next(
                        (
                            item
                            for item in current.get("files", [])
                            if item["ontology"] == ontology
                            and item["modality"] == modality
                            and item["channel"] == channel
                            and item["format"] == fmt
                            and item["name"] == stored_name
                            and (item.get("sub_path") or "") == file_sub_path
                            and _stored_file_version(item) == version
                            and (
                                ontology != "robot"
                                or not new_robot_style
                                or str(item.get("robot_style") or "").strip() == new_robot_style
                            )
                            and (
                                modality != "motion"
                                or clean_motion_kind(
                                    (item.get("annotation") or {}).get("motion_kind")
                                    or item.get("motion_kind")
                                )
                                == wanted_kind
                            )
                        ),
                        None,
                    )
                try:
                    dest = data_destination(
                        ontology=ontology,
                        modality=modality,
                        channel=channel,
                        fmt=fmt,
                        batch=batch,
                        filename=stored_name,
                        robot_style=new_robot_style,
                        robot_acquire_method=robot_acquire_method,
                        sub_path=file_sub_path,
                        file_version=version,
                        motion_kind=effective_motion_kind,
                    )
                except ValueError as exc:
                    row.update({"status": "failed", "detail": str(exc)})
                    results.append(row)
                    publish()
                    continue
                on_disk = dest.is_file()
                if (existing or on_disk) and not replace:
                    row["status"] = "skip"
                    row["detail"] = f"已有同路径文件：{dest.relative_to(repo_root())}"
                    results.append(row)
                    publish()
                    continue
                if existing and not manage_override:
                    try:
                        _require_file_owner(user, existing)
                    except HTTPException as exc:
                        row.update({"status": "failed", "detail": exc.detail})
                        results.append(row)
                        publish()
                        continue
                try:
                    if is_merged_pair:
                        c3d_entry, c3d_rel = merge_c3d_by_fbx[rel]
                        publish(f"正在合并 C3D → {original_name}")
                        merge_stage = work_dir / f"_merge_{len(results)}"
                        merge_stage.mkdir(parents=True, exist_ok=True)
                        try:
                            if is_dir_source:
                                fbx_in = Path(info)
                                c3d_in = Path(c3d_entry)
                            else:
                                assert archive_handle is not None
                                fbx_in = safe_extract_member(
                                    archive_handle, info, merge_stage / "src", filename=rel
                                )
                                c3d_in = safe_extract_member(
                                    archive_handle, c3d_entry, merge_stage / "src", filename=c3d_rel
                                )
                            merged_out = merge_stage / "out" / stored_name
                            merge_c3d_into_fbx(fbx_in, c3d_in, merged_out)
                            result = save_data_file(
                                source_path=merged_out,
                                ontology=ontology,
                                modality=modality,
                                channel=channel,
                                fmt="fbx",
                                batch=batch,
                                unit_name=row["unit_name"],
                                original_name=stored_name,
                                replace=bool(replace and (existing or on_disk)),
                                update_index=False,
                                robot_style=str(parsed_annotation.get("robot_style") or ""),
                                robot_acquire_method=robot_acquire_method,
                                sub_path=file_sub_path,
                                file_version=version,
                                motion_kind="merged",
                                preserve_tree=True,
                            )
                        finally:
                            shutil.rmtree(merge_stage, ignore_errors=True)
                    elif is_dir_source:
                        with Path(info).open("rb") as src_fh:
                            result = save_data_file(
                                src_fh,
                                ontology=ontology,
                                modality=modality,
                                channel=channel,
                                fmt=fmt,
                                batch=batch,
                                unit_name=row["unit_name"],
                                original_name=stored_name,
                                replace=bool(replace and (existing or on_disk)),
                                update_index=False,
                                robot_style=str(parsed_annotation.get("robot_style") or ""),
                                robot_acquire_method=robot_acquire_method,
                                sub_path=file_sub_path,
                                file_version=version,
                                motion_kind=effective_motion_kind,
                                preserve_tree=True,
                            )
                    else:
                        assert archive_handle is not None
                        extracted = safe_extract_member(
                            archive_handle, info, work_dir, filename=rel
                        )
                        result = save_data_file(
                            source_path=extracted,
                            ontology=ontology,
                            modality=modality,
                            channel=channel,
                            fmt=fmt,
                            batch=batch,
                            unit_name=row["unit_name"],
                            original_name=stored_name,
                            replace=bool(replace and (existing or on_disk)),
                            update_index=False,
                            robot_style=str(parsed_annotation.get("robot_style") or ""),
                            robot_acquire_method=robot_acquire_method,
                            sub_path=file_sub_path,
                            file_version=version,
                            motion_kind=effective_motion_kind,
                            preserve_tree=True,
                        )
                    result["uploader"] = {"id": user.id, "username": user.username}
                    row.update(
                        {
                            "status": "replaced" if replace and (existing or on_disk) else "uploaded",
                            "file": result,
                        }
                    )
                    if is_merged_pair:
                        row["merged_c3d"] = True
                        merged_saved_paths.append(result["path"])
                        merged_c3d_count += 1
                    else:
                        normal_saved_paths.append(result["path"])
                    saved_paths.append(result["path"])
                    formats.append(str(fmt).lstrip("."))
                except (ValueError, RuntimeError, OSError) as exc:
                    row.update({"status": "failed", "detail": str(exc)})
                    warnings.append(f"导入失败 {original_name}: {exc}")
                results.append(row)
                publish()

        session = None
        _touch_zip_job(job_id, detail="正在写入索引")
        if saved_paths:
            set_file_uploaders(saved_paths, user_id=user.id, username=user.username)
            if normal_saved_paths and parsed_annotation:
                csv_paths = [path for path in normal_saved_paths if path.lower().endswith(".csv")]
                update_files_annotation(
                    csv_paths if "fps" in parsed_annotation and csv_paths else normal_saved_paths,
                    parsed_annotation,
                )
            if merged_saved_paths:
                update_files_annotation(
                    merged_saved_paths,
                    {**parsed_annotation, "motion_kind": "merged"},
                )
            create_batch(batch)
            unit_names = [
                str(item.get("unit_name") or "")
                for item in results
                if item.get("status") in {"uploaded", "replaced"}
            ]
            parsed_tags = _parse_taxonomy_form(taxonomy_tag_ids)
            if parsed_tags:
                _validate_taxonomy_ids(db, parsed_tags)
            apply_upload_taxonomy(
                batch, unit_names, parsed_tags, file_paths=saved_paths
            )
            unique_formats = list(dict.fromkeys(formats))
            session_annotation = (
                {**parsed_annotation, "motion_kind": "merged"}
                if merged_saved_paths and not normal_saved_paths
                else parsed_annotation
            )
            session = record_upload_session(
                user_id=user.id,
                username=user.username,
                source="folder" if is_dir_source else "zip",
                batch=batch,
                ontology=ontology,
                modality=modality,
                channel=channel,
                fmt=",".join(unique_formats),
                annotation=session_annotation,
                taxonomy_tag_ids=parsed_tags,
                paths=saved_paths,
                unit_names=unit_names,
                uploaded=sum(item["status"] == "uploaded" for item in results),
                replaced=sum(item["status"] == "replaced" for item in results),
            )
            refresh_catalog_paths(saved_paths)

        summary = {
            "batch": batch,
            "file_version": version,
            "total": len(results),
            "uploaded": sum(item["status"] == "uploaded" for item in results),
            "replaced": sum(item["status"] == "replaced" for item in results),
            "skipped": sum(item["status"] == "skip" for item in results),
            "failed": sum(item["status"] == "failed" for item in results),
            "merged_c3d": merged_c3d_count,
            "items": results,
            "warnings": warnings,
            "upload_session_id": session["id"] if session else None,
        }
        _audit_upload_items(
            db,
            user,
            batch=batch,
            file_version=version,
            results=results,
        )
        db.commit()
        _touch_zip_job(
            job_id,
            status="done",
            detail="",
            result=summary,
            total=len(results),
            **_zip_job_counts(results),
        )
    except HTTPException as exc:
        if db is not None:
            db.rollback()
        _touch_zip_job(job_id, status="failed", detail=_http_detail(exc))
    except Exception as exc:
        if db is not None:
            db.rollback()
        _touch_zip_job(job_id, status="failed", detail=str(exc) or "导入失败")
    finally:
        if source_fd is not None:
            os.close(source_fd)
        if db is not None:
            db.close()
        shutil.rmtree(staging, ignore_errors=True)


@router.get("/data/inspect-import-path")
def inspect_import_path(
    local_path: str = Query(...),
    user: User = Depends(get_current_user),
):
    """Inspect a server-side zip or directory for file counts and mergeable C3D+FBX pairs."""
    del user
    try:
        source = resolve_import_source(local_path.strip())
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    is_dir = source.is_dir()
    mergeable_pairs: list[tuple[str, str]] = []
    formats: list[str] = []
    if is_dir:
        members = iter_dir_human_members(source)
        entry_by_rel = {rel: path for path, rel in members}
        for _p, rel in members:
            fmt = human_format_from_filename(Path(rel).name).lstrip(".")
            if fmt:
                formats.append(fmt)
        for fbx_rel, c3d_rel in pair_fbx_and_c3d_paths(entry_by_rel.keys()):
            fbx_p = entry_by_rel.get(fbx_rel)
            if fbx_p is not None and not fbx_file_has_c3d(fbx_p):
                mergeable_pairs.append((fbx_rel, c3d_rel))
    else:
        try:
            with zipfile.ZipFile(source) as zf:
                members_zip = iter_zip_human_members(zf)
                entry_by_rel_zip = {rel: info for info, rel in members_zip}
                for _info, rel in members_zip:
                    fmt = human_format_from_filename(Path(rel).name).lstrip(".")
                    if fmt:
                        formats.append(fmt)
                for fbx_rel, c3d_rel in pair_fbx_and_c3d_paths(entry_by_rel_zip.keys()):
                    info = entry_by_rel_zip.get(fbx_rel)
                    if info is not None and not fbx_bytes_have_c3d(zf.read(info)):
                        mergeable_pairs.append((fbx_rel, c3d_rel))
                members = members_zip  # type: ignore[assignment]
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"无法读取 ZIP：{exc}") from exc

    return {
        "kind": "dir" if is_dir else "zip",
        "name": source.name,
        "suggested_batch": folder_name_from_zip_filename(source.name),
        "file_count": len(members),
        "formats": sorted(set(formats)),
        "mergeable_c3d_fbx_count": len(mergeable_pairs),
        "sample_pairs": [Path(f).stem for f, _ in mergeable_pairs[:5]],
    }


@router.get("/data/upload-zip/active")
def active_zip_import(
    batch: str = Query(""),
    user: User = Depends(get_current_user),
):
    batch = batch.strip()
    now = time.time()
    with _ZIP_JOBS_LOCK:
        jobs = [
            job
            for job in _ZIP_JOBS.values()
            if job["user_id"] == user.id
            and (not batch or job["batch"] == batch)
            and (job["status"] == "running" or now - float(job["started"]) < 6 * 3600)
        ]
        jobs.sort(key=lambda item: item["started"], reverse=True)
        chosen = next((job for job in jobs if job["status"] == "running"), None)
        if chosen is None and jobs:
            chosen = jobs[0]
        return _public_zip_job(chosen) if chosen is not None else _absent_zip_job()


@router.get("/data/upload-zip/{job_id}")
def zip_import_status(
    job_id: str,
    user: User = Depends(get_current_user),
):
    job = _copy_zip_job(job_id, user.id)
    if job is None:
        raise HTTPException(status_code=404, detail="导入任务不存在")
    return job


@router.post("/data/upload-zip")
async def upload_data_zip(
    ontology: str = Form(...),
    modality: str = Form(...),
    channel: str = Form(""),
    batch: str = Form(""),
    replace: bool = Form(False),
    follow_paths: bool = Form(False),
    manage_override: bool = Form(False),
    merge_c3d: bool = Form(False),
    annotation: str = Form(""),
    taxonomy_tag_ids: str = Form(""),
    robot_acquire_method: str = Form(""),
    file_version: str = Form(""),
    local_path: str = Form(""),
    file: UploadFile | None = File(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Accept a motion zip (or server directory) and import it after the response."""
    if manage_override and not user_has_any_capability(db, user, Capability.manage_data):
        raise HTTPException(status_code=403, detail="只有具备管理数据权限的用户可以覆盖其他用户的数据")
    if file is not None and file.filename:
        if not str(file.filename).lower().endswith(".zip"):
            raise HTTPException(status_code=400, detail="请上传 .zip 文件")
        filename = file.filename
    elif local_path.strip():
        filename = Path(local_path.strip().rstrip("/")).name
    else:
        raise HTTPException(status_code=400, detail="请选择 zip 或填写服务器路径")
    batch = (batch or "").strip() or folder_name_from_zip_filename(filename)
    ontology = ontology.strip().lower()
    modality = modality.strip().lower()
    channel = channel.strip().lower()
    _parse_annotation_form(annotation)
    parsed_tags = _parse_taxonomy_form(taxonomy_tag_ids)
    if parsed_tags:
        _validate_taxonomy_ids(db, parsed_tags)
    ensure_capability(db, user, Capability.upload, f"/{batch}/")
    version = _resolve_upload_file_version({"batches": []}, batch, file_version)

    _tmp_root = Path("/hub_repo/index/tmp")
    if not _tmp_root.parent.exists():
        _tmp_root = Path(tempfile.gettempdir())
    else:
        _tmp_root.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="storage_zip_", dir=_tmp_root))
    source_fd: int | None = None
    archive: Path | None = None
    try:
        if local_path.strip():
            try:
                archive = resolve_import_source(local_path.strip())
            except (ValueError, FileNotFoundError) as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        elif file is not None:
            file.file.seek(0)
            source_fd = os.dup(file.file.fileno())
        else:
            raise HTTPException(status_code=400, detail="请选择 zip 或填写服务器路径")
    except Exception:
        if source_fd is not None:
            os.close(source_fd)
        shutil.rmtree(staging, ignore_errors=True)
        raise

    job_id = uuid.uuid4().hex
    _new_zip_job(job_id, user.id, batch)
    try:
        threading.Thread(
            target=_run_zip_import,
            kwargs={
                "job_id": job_id,
                "staging": staging,
                "archive": archive,
                "source_fd": source_fd,
                "user_id": user.id,
                "ontology": ontology,
                "modality": modality,
                "channel": channel,
                "batch": batch,
                "replace": replace,
                "follow_paths": follow_paths,
                "manage_override": manage_override,
                "annotation": annotation,
                "taxonomy_tag_ids": taxonomy_tag_ids,
                "robot_acquire_method": robot_acquire_method,
                "version": version,
                "merge_c3d": merge_c3d,
            },
            daemon=True,
            name=f"zip-import-{job_id[:8]}",
        ).start()
    except Exception:
        if source_fd is not None:
            os.close(source_fd)
        shutil.rmtree(staging, ignore_errors=True)
        _touch_zip_job(job_id, status="failed", detail="无法启动导入")
        raise
    return _copy_zip_job(job_id)


@router.get("/file-detail")
def file_detail(
    path: str = Query(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    try:
        record = probe_data_file(path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not record:
        record = inspect_data_file(path)
    if not record:
        raise HTTPException(status_code=404, detail="文件未纳入数据单元")
    metadata = read_metadata()
    key = unit_key(record["batch"], record["unit_name"])
    unit_meta = dict((metadata.get("units") or {}).get(key) or {})
    batch_meta = dict((metadata.get("batches") or {}).get(record["batch"]) or {})
    batch_tag_ids, unit_tag_ids = parent_taxonomy_ids(
        record["batch"], record["unit_name"], metadata
    )
    unit = {
        "batch": record["batch"],
        "name": record["unit_name"],
        "taxonomy_tag_ids": unit_tag_ids or unit_meta.get("taxonomy_tag_ids") or {},
        "annotation": unit_meta.get("annotation") or {},
    }
    _require_unit(db, user, Capability.browse, unit)
    file_tag_ids = record.get("taxonomy_tag_ids") or {}
    return {
        **record,
        "annotation": record.get("annotation") or {},
        "taxonomy_tag_ids": file_tag_ids,
        "taxonomy_tags": _taxonomy_briefs(db, file_tag_ids),
        "unit_taxonomy_tag_ids": unit["taxonomy_tag_ids"],
        "unit_taxonomy_tags": _taxonomy_briefs(db, unit["taxonomy_tag_ids"]),
        "unit_annotation": unit["annotation"],
        "batch_taxonomy_tag_ids": batch_tag_ids
        or batch_meta.get("taxonomy_tag_ids")
        or {},
        "batch_taxonomy_tags": _taxonomy_briefs(db, batch_tag_ids or {}),
        "batch_annotation": batch_meta.get("annotation") or {},
    }


@router.patch("/file-meta")
def patch_file_meta(
    path: str = Query(...),
    body: UnitMetadataIn = ...,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    record = inspect_data_file(path)
    if not record:
        raise HTTPException(status_code=404, detail="文件未纳入数据单元")
    unit = {
        "batch": record["batch"],
        "name": record["unit_name"],
        "taxonomy_tag_ids": {},
        "annotation": {},
    }
    snapshot = scan_data()
    current = _find_unit(snapshot, record["batch"], record["unit_name"])
    _require_tag_edit(
        db,
        user,
        unit=current or unit,
        path=f"/{record['batch']}/{record['unit_name']}/",
    )
    if body.taxonomy_tag_ids is not None:
        _validate_taxonomy_ids(db, body.taxonomy_tag_ids)
    try:
        result = update_file_metadata(
            path,
            taxonomy_tag_ids=body.taxonomy_tag_ids,
            annotation=body.annotation,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="文件不存在") from exc
    result["taxonomy_tags"] = _taxonomy_briefs(
        db, result.get("taxonomy_tag_ids") or {}
    )
    write_audit(
        db,
        user_id=user.id,
        action="annotate",
        entity_type="storage_file",
        detail={"path": path, **body.model_dump(exclude_none=True)},
    )
    db.commit()
    return result


@router.get("/file")
def get_file(
    path: str = Query(...),
    download: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if path.startswith("data/"):
        snapshot = scan_data()
        file = _file_by_path(snapshot, path)
        unit = _unit_for_file(snapshot, path)
        if not unit:
            raise HTTPException(status_code=404, detail="文件未纳入数据单元")
        if download:
            if not (
                (file and _user_uploaded_file(user, file))
                or _unit_allowed_scoped(db, user, Capability.download, unit)
            ):
                raise HTTPException(status_code=403, detail=f"缺少权限：download @ {_unit_path(unit)}")
        else:
            _require_unit(db, user, Capability.browse, unit)
    try:
        file_path = resolve_repo_file(path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    disposition = "attachment" if download else "inline"
    # Retarget redo and merges overwrite files in place. Without this the browser
    # treats Last-Modified as a heuristic lifetime and keeps showing the old copy.
    return FileResponse(
        file_path,
        filename=file_path.name if download else None,
        content_disposition_type=disposition,
        headers={"Cache-Control": "no-cache"},
    )


@router.get("/retarget-frame")
def get_retarget_frame(
    path: str = Query(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Where holosoma placed this human FBX in the robot CSV world (scripts/retarget_frames.py)."""
    import hashlib

    from ..services.disk_repository import root as hub_root

    if not path.startswith("data/human/"):
        raise HTTPException(status_code=400, detail="只支持人体动作文件")
    snapshot = scan_data()
    unit = _unit_for_file(snapshot, path)
    if not unit:
        raise HTTPException(status_code=404, detail="文件未纳入数据单元")
    _require_unit(db, user, Capability.browse, unit)
    frame_dir = hub_root() / "index" / "retarget_frames"
    frame_file = frame_dir / f"{hashlib.sha1(path.encode('utf-8')).hexdigest()}.json"
    if not frame_file.is_file():
        raise HTTPException(status_code=404, detail="还没有记录这个文件的重定向坐标系")
    try:
        frame = json.loads(frame_file.read_text(encoding="utf-8"))
        robots = json.loads((frame_dir / "robots.json").read_text(encoding="utf-8")).get("robots") or {}
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"重定向坐标系文件损坏：{exc}") from exc
    return {**frame, "robot_heights": robots}


@router.get("/smpl-model")
def get_smpl_model(
    path: str = Query(...),
    user: User = Depends(get_current_user),
):
    """按需解析 SMPL/SMPL-X/SMPL-H 身体模型（pkl/npz），返回模板网格顶点+面。"""
    from ..worker.parsers import load_smpl_model

    try:
        file_path = resolve_repo_file(path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    if file_path.stat().st_size == 0:
        raise HTTPException(status_code=400, detail="模型文件为空，请上传真实的 SMPL 模型")
    try:
        return load_smpl_model(file_path)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"SMPL 模型解析失败：{exc}") from exc


@router.post("/smpl-motion")
async def upload_smpl_motion(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    """解析浏览器本地拖入的 SMPL 动作 npz。"""
    from ..worker.parsers import load_smpl_motion

    raw = await file.read()
    with tempfile.NamedTemporaryFile(suffix=".npz", delete=False) as handle:
        handle.write(raw)
        tmp = Path(handle.name)
    try:
        return load_smpl_motion(tmp)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"SMPL 解析失败：{exc}") from exc
    finally:
        tmp.unlink(missing_ok=True)


@router.get("/smpl-motion")
def get_smpl_motion_by_path(
    path: str = Query(...),
    user: User = Depends(get_current_user),
):
    """按需解析 SMPL/SMPL-X/SMPL-H 动作 npz（按仓库路径），返回 poses/trans/fps。"""
    from ..worker.parsers import load_smpl_motion

    try:
        file_path = resolve_repo_file(path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    try:
        return load_smpl_motion(file_path)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"SMPL 解析失败：{exc}") from exc


@router.post("/file/rename")
def rename_file_api(
    path: str = Query(...),
    body: RenameIn = ...,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    snapshot = scan_data()
    unit = _unit_for_file(snapshot, path)
    if not unit:
        raise HTTPException(status_code=404, detail="文件未纳入数据单元")
    _require_unit(db, user, Capability.edit, unit)
    try:
        result = rename_file(path, body.name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="文件不存在") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    result["taxonomy_tags"] = _taxonomy_briefs(
        db, result.get("taxonomy_tag_ids") or {}
    )
    write_audit(
        db,
        user_id=user.id,
        action="rename",
        entity_type="storage_file",
        detail={"path": path, "name": body.name, "next_path": result.get("path")},
    )
    db.commit()
    return result


@router.delete("/file")
def remove_file(
    path: str = Query(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    unit = _unit_for_file(scan_data(), path)
    if not unit:
        raise HTTPException(status_code=404, detail="文件未纳入数据单元")
    _require_unit(db, user, Capability.edit, unit)
    try:
        delete_repo_file(path, actor=_actor(user), label=Path(path).name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="文件不存在") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(
        db,
        user_id=user.id,
        action="trash",
        entity_type="storage_file",
        detail={"path": path},
    )
    db.commit()
    return {"ok": True}


@router.get("/models")
def models(_: User = Depends(get_current_user)):
    result = scan_models()
    # Overlay latest metadata for all instances and add metadata-only ones.
    from ..services.disk_repository import read_metadata

    meta_by_key = read_metadata().get("models") or {}
    for instance in result["instances"]:
        key = instance.get("key") or ""
        if key in meta_by_key:
            instance["meta"] = dict(meta_by_key[key])
    existing = {item["key"] for item in result["instances"]}
    for key, meta in meta_by_key.items():
        if key in existing or "::" not in key:
            continue
        ontology, name = key.split("::", 1)
        result["instances"].append(
            {
                "key": key,
                "ontology": ontology,
                "name": name,
                "kinds": [],
                "files": [],
                "meta": meta,
            }
        )
    result["instances"].sort(key=lambda x: (x["ontology"], x["name"]))
    result["kinds"] = MODEL_KINDS
    return result


@router.get("/models/kind-zip")
def download_model_kind_zip(
    ontology: str = Query(...),
    instance: str = Query(...),
    kind: str = Query(...),
    _: User = Depends(get_current_user),
):
    """Zip one model-type folder. The archive is named after the instance."""
    try:
        directory = model_kind_directory(ontology.strip().lower(), instance, kind.strip().lower())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    tmp_root = repo_root().parent / ".model_zip_tmp"
    tmp_root.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(prefix="model-kind-", suffix=".zip", dir=tmp_root, delete=False)
    handle.close()
    archive_path = Path(handle.name)
    try:
        write_model_kind_zip(directory, archive_path)
    except FileNotFoundError as exc:
        archive_path.unlink(missing_ok=True)
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception:
        archive_path.unlink(missing_ok=True)
        raise
    filename = f"{directory.name}.zip"
    return FileResponse(
        archive_path,
        media_type="application/zip",
        filename=filename,
        background=BackgroundTask(archive_path.unlink, missing_ok=True),
    )


@router.post("/models/instances")
def add_model_instance(
    body: ModelInstanceIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_model_library_write(db, user)
    try:
        result = create_model_instance(body.ontology, body.name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(
        db,
        user_id=user.id,
        action="create",
        entity_type="model_instance",
        detail=body.model_dump(),
    )
    db.commit()
    return result


@router.post("/models/upload")
async def upload_model(
    ontology: str = Form(...),
    instance: str = Form(...),
    kind: str = Form(...),
    file: UploadFile = File(...),
    default_description_file: str = Form(""),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_model_library_write(db, user)
    try:
        result = save_model_upload(
            file.file,
            ontology=ontology.strip().lower(),
            instance=instance,
            kind=kind.strip().lower(),
            filename=file.filename or "model.bin",
            default_description_file=default_description_file,
        )
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(
        db,
        user_id=user.id,
        action="upload",
        entity_type="model_file",
        detail=result,
    )
    db.commit()
    return result


@router.patch("/models/instances/{ontology}/{name}")
def patch_model_instance(
    ontology: str,
    name: str,
    body: ModelInstanceMetaIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_model_library_write(db, user)
    from ..services.disk_repository import update_model_instance_meta

    try:
        result = update_model_instance_meta(ontology, name, body.model_dump(exclude_none=True))
        rel = str(body.default_description_file or "")
        if ontology == "robot" and rel.lower().endswith((".urdf", ".xacro")):
            from ..services.disk_repository import root as hub_root
            from ..services.robot_retarget_profile import write_uploaded_profile

            result["retarget_profile_ready"], result["retarget_profile_error"] = write_uploaded_profile(
                hub_root(), name, rel
            )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(
        db,
        user_id=user.id,
        action="update",
        entity_type="model_instance",
        detail={"ontology": ontology, "name": name, **body.model_dump(exclude_none=True)},
    )
    db.commit()
    return result


@router.delete("/models/instances/{ontology}/{name}")
def remove_model_instance(
    ontology: str,
    name: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ensure_capability(db, user, Capability.edit, "/")
    try:
        delete_model_instance(ontology, name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(
        db,
        user_id=user.id,
        action="delete",
        entity_type="model_instance",
        detail={"ontology": ontology, "name": name},
    )
    db.commit()
    return {"ok": True}


@router.delete("/models/file")
def remove_model_file(
    path: str = Query(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ensure_capability(db, user, Capability.edit, "/")
    if not path.startswith("3d_model/"):
        raise HTTPException(status_code=400, detail="不是 3D 模型文件")
    try:
        delete_repo_file(path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="文件不存在") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(
        db,
        user_id=user.id,
        action="delete",
        entity_type="model_file",
        detail={"path": path},
    )
    db.commit()
    return {"ok": True}


@router.get("/schema")
def repository_schema(_: User = Depends(get_current_user)):
    return {
        "ontologies": ONTOLOGIES,
        "modalities": MODALITIES,
        "fpv_channels": FPV_CHANNELS,
        "model_kinds": MODEL_KINDS,
    }
