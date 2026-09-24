"""Filesystem-first APIs for hub_repo/data, 3d_model and index metadata."""

from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Body, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..core.deps import get_current_user
from ..database import get_db
from ..models import Capability, TaxonomyNode, User, UserPermission
from ..services.audit import write_audit
from ..services.disk_repository import (
    FPV_CHANNELS,
    MODEL_KINDS,
    MODALITIES,
    ONTOLOGIES,
    collect_archive_entries,
    apply_upload_taxonomy,
    assemble_upload_sessions,
    create_batch,
    create_model_instance,
    delete_batches,
    delete_upload_session_files,
    delete_model_instance,
    delete_repo_file,
    delete_units,
    inspect_data_file,
    normalize_unit_stem,
    parent_taxonomy_ids,
    probe_data_file,
    read_metadata,
    catalog_rebuild_status,
    rebuild_catalog,
    start_catalog_rebuild,
    record_upload_session,
    resolve_import_zip,
    rename_batch,
    rename_file,
    rename_unit,
    resolve_repo_file,
    save_data_file,
    write_archive,
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
from ..services.human_zip import (
    extract_and_group_zip,
    folder_name_from_zip_filename,
    human_format_from_filename,
)
from ..services.permissions import (
    capability_query_values,
    ensure_capability,
    has_role_capability,
    path_matches,
    user_has_any_capability,
    user_has_capability,
)

router = APIRouter(prefix="/storage", tags=["storage-repository"])


class BatchCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    taxonomy_tag_ids: dict[str, int | None] | None = None


class UnitMetadataIn(BaseModel):
    taxonomy_tag_ids: dict[str, int | None] | None = None
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
    taxonomy_tag_ids: dict[str, int | None] | None = None
    paths: list[str] | None = None


class UploadSessionDeleteIn(BaseModel):
    paths: list[str] | None = None


class UnitTaxonomyPatch(BaseModel):
    name: str = Field(min_length=1, max_length=1024)
    taxonomy_tag_ids: dict[str, int | None]


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


class StorageSelectionIn(BaseModel):
    batches: list[str] = Field(default_factory=list)
    units: list[UnitRefIn] = Field(default_factory=list)
    kinds: list[DataKindIn] = Field(default_factory=list)
    robot_styles: list[str] | None = None


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


def _parse_taxonomy_form(raw: str) -> dict[str, int | None] | None:
    text = (raw or "").strip()
    if not text:
        return None
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="分类标签无效") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="分类标签须为对象")
    parsed: dict[str, int | None] = {}
    for scheme, value in payload.items():
        if value in (None, ""):
            continue
        try:
            parsed[str(scheme)] = int(value)
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=400, detail=f"分类标签 {scheme} 无效"
            ) from exc
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
        raw_id = (unit.get("taxonomy_tag_ids") or {}).get(scheme)
        if raw_id is None:
            continue
        node = db.get(TaxonomyNode, int(raw_id))
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


def _find_unit(snapshot: dict[str, Any], batch: str, name: str) -> dict[str, Any] | None:
    exact = next(
        (unit for unit in snapshot["units"] if unit["batch"] == batch and unit["name"] == name),
        None,
    )
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
    file = next((item for item in snapshot["files"] if item["path"] == path), None)
    if file:
        unit = _find_unit(snapshot, file["batch"], file["unit_name"])
        if unit:
            return unit
    return next(
        (
            unit
            for unit in snapshot["units"]
            if any(item.get("path") == path for item in unit.get("files") or [])
        ),
        None,
    )


def _taxonomy_briefs(db: Session, ids: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return _taxonomy_brief_loader(db, [ids])(ids)


def _taxonomy_brief_loader(db: Session, id_maps: list[dict[str, Any] | None]):
    wanted: set[int] = set()
    for ids in id_maps:
        for raw_id in (ids or {}).values():
            try:
                wanted.add(int(raw_id))
            except (TypeError, ValueError):
                continue
    nodes = (
        {
            node.id: node
            for node in db.query(TaxonomyNode).filter(TaxonomyNode.id.in_(wanted)).all()
        }
        if wanted
        else {}
    )

    def briefs(ids: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for scheme, raw_id in (ids or {}).items():
            try:
                node = nodes.get(int(raw_id))
            except (TypeError, ValueError):
                continue
            if node and str(node.scheme) == scheme:
                out[scheme] = {
                    "id": node.id,
                    "scheme": scheme,
                    "code": node.code or "",
                    "name": node.name,
                    "path": node.path,
                }
        return out

    return briefs


def _validate_taxonomy_ids(db: Session, ids: dict[str, int | None] | None) -> None:
    for scheme, node_id in (ids or {}).items():
        if node_id is None:
            continue
        node = db.get(TaxonomyNode, node_id)
        if not node:
            raise HTTPException(status_code=404, detail=f"分类节点不存在：{node_id}")
        if str(node.scheme) != scheme:
            raise HTTPException(status_code=400, detail=f"节点 {node_id} 不属于 {scheme}")


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
            raw = (unit.get("taxonomy_tag_ids") or {}).get(taxonomy_scheme)
            try:
                selected_id = int(raw)
            except (TypeError, ValueError):
                continue
            if wanted_tag_ids is not None and selected_id not in wanted_tag_ids:
                continue
        units.append(unit)

    visible_keys = {u["key"] for u in units}
    batches = []
    for item in snapshot["batches"]:
        if batch and item["name"] != batch:
            continue
        visible_units = [u for u in units if u["batch"] == item["name"]]
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


@router.get("/overview")
def overview(
    batch: str | None = None,
    q: str | None = None,
    taxonomy_scheme: str | None = None,
    tag_id: int | None = None,
    tag_exact: bool = False,
    uploader_id: int | None = None,
    include_empty: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if include_empty and not user_has_any_capability(db, user, Capability.manage_data):
        raise HTTPException(status_code=403, detail="只有具备管理数据权限的用户可以查看空目录")
    return _decorate_and_filter(
        scan_data(include_empty=include_empty),
        db,
        user,
        batch=batch,
        q=q,
        taxonomy_scheme=taxonomy_scheme,
        tag_id=tag_id,
        tag_exact=tag_exact,
        uploader_id=uploader_id,
    )


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
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="上传记录不存在") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(
        db,
        user_id=user.id,
        action="delete",
        entity_type="upload_session",
        detail={"session_id": session_id, "removed": result.get("removed") or []},
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
    delete_batches([name])
    write_audit(
        db,
        user_id=user.id,
        action="delete",
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
    delete_units([(batch, unit["name"])])
    write_audit(
        db,
        user_id=user.id,
        action="delete",
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
        delete_units(removed_units)
    if removed_batches:
        delete_batches(removed_batches)
    write_audit(
        db,
        user_id=user.id,
        action="bulk_delete",
        entity_type="storage",
        detail={
            "batches": removed_batches,
            "units": [{"batch": batch, "name": name} for batch, name in removed_units],
        },
    )
    db.commit()
    return {
        "ok": True,
        "batches": removed_batches,
        "units": [f"{batch}::{name}" for batch, name in removed_units],
    }


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
    kinds = [(item.ontology, item.modality, item.format) for item in body.kinds]

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
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if manage_override and not user_has_any_capability(db, user, Capability.manage_data):
        raise HTTPException(status_code=403, detail="只有具备管理数据权限的用户可以覆盖其他用户的数据")
    parsed_annotation = _parse_annotation_form(annotation)
    current = _find_unit(scan_data(), batch, unit_name)
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
        rebuild_catalog()
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

    ontology = ontology.strip().lower()
    modality = modality.strip().lower()
    channel = channel.strip().lower()
    fallback_fmt = format.strip().lower().lstrip(".")
    parsed_annotation = _parse_annotation_form(annotation)
    robot_style = str(parsed_annotation.get("robot_style") or "")
    snapshot = scan_data()
    current_units = {
        (item["batch"], item["name"]): item for item in snapshot.get("units", [])
    }
    results: list[dict[str, Any]] = []
    saved = 0
    saved_paths: list[str] = []
    formats: list[str] = []

    for file, action, sub_path in zip(files, raw_actions, raw_sub_paths):
        original_name = Path(file.filename or "").name
        file_stem = Path(original_name).stem
        if sub_path:
            raw_unit_name = normalize_unit_stem((sub_path + "/" + file_stem).replace("/", "_")) or (sub_path + "_" + file_stem).replace("/", "_")
        else:
            raw_unit_name = normalize_unit_stem(file_stem) or file_stem
        row: dict[str, Any] = {
            "name": original_name,
            "unit_name": raw_unit_name,
            "status": action,
        }
        if action == "skip":
            results.append(row)
            continue
        try:
            file_fmt = _format_from_upload(original_name, fallback_fmt)
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
                existing = next(
                    (
                        item
                        for item in current.get("files", [])
                        if item["ontology"] == ontology
                        and item["modality"] == modality
                        and item["channel"] == channel
                        and item["format"] == file_fmt
                        and item["name"] == original_name
                    ),
                    None,
                )
                if existing:
                    _require_file_owner(user, existing)
            result = save_data_file(
                file.file,
                ontology=ontology,
                modality=modality,
                channel=channel,
                fmt=file_fmt,
                batch=batch,
                unit_name=raw_unit_name,
                original_name=original_name or f"{raw_unit_name}.{file_fmt}",
                replace=action == "replace",
                update_index=False,
                robot_style=robot_style,
                sub_path=sub_path,
            )
            result["uploader"] = {
                "id": user.id,
                "username": user.username,
            }
            row.update({"status": "replaced" if action == "replace" else "uploaded", "file": result})
            saved += 1
            saved_paths.append(result["path"])
            formats.append(file_fmt)
        except (ValueError, HTTPException) as exc:
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
        update_files_annotation(saved_paths, parsed_annotation)
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
        session = record_upload_session(
            user_id=user.id,
            username=user.username,
            source="folder",
            batch=batch,
            ontology=ontology,
            modality=modality,
            channel=channel,
            fmt=",".join(dict.fromkeys(formats)),
            annotation=parsed_annotation,
            taxonomy_tag_ids=parsed_tags,
            paths=saved_paths,
            unit_names=unit_names,
            uploaded=sum(item["status"] == "uploaded" for item in results),
            replaced=sum(item["status"] == "replaced" for item in results),
        )
        rebuild_catalog()
    summary = {
        "batch": batch,
        "total": len(files),
        "uploaded": sum(item["status"] == "uploaded" for item in results),
        "replaced": sum(item["status"] == "replaced" for item in results),
        "skipped": sum(item["status"] == "skip" for item in results),
        "failed": sum(item["status"] == "failed" for item in results),
        "items": results,
        "upload_session_id": session["id"] if session else None,
    }
    write_audit(
        db,
        user_id=user.id,
        action="upload_folder",
        entity_type="storage_batch",
        detail={
            key: value
            for key, value in summary.items()
            if key != "items"
        },
    )
    db.commit()
    return summary


@router.post("/data/upload-zip")
async def upload_data_zip(
    ontology: str = Form(...),
    modality: str = Form(...),
    channel: str = Form(""),
    batch: str = Form(""),
    replace: bool = Form(False),
    manage_override: bool = Form(False),
    annotation: str = Form(""),
    taxonomy_tag_ids: str = Form(""),
    local_path: str = Form(""),
    file: UploadFile | None = File(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Import a motion zip (bvh/csv/fbx/tak in one archive) as one storage batch."""
    if manage_override and not user_has_any_capability(db, user, Capability.manage_data):
        raise HTTPException(status_code=403, detail="只有具备管理数据权限的用户可以覆盖其他用户的数据")
    filename = file.filename if file and file.filename else Path(local_path).name
    if not str(filename).lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="请上传 .zip 文件")
    batch = (batch or "").strip() or folder_name_from_zip_filename(filename)
    ontology = ontology.strip().lower()
    modality = modality.strip().lower()
    channel = channel.strip().lower()
    parsed_annotation = _parse_annotation_form(annotation)
    ensure_capability(db, user, Capability.upload, f"/{batch}/")

    _tmp_root = Path("/hub_repo/index/tmp")
    _tmp_root.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix="storage_zip_", dir=_tmp_root)
    )
    zip_path = staging / "upload.zip"
    work_dir = staging / "extracted"
    try:
        if local_path.strip():
            try:
                source = resolve_import_zip(local_path.strip())
            except FileNotFoundError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            shutil.copy2(source, zip_path)
        elif file is not None:
            with zip_path.open("wb") as out:
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
        else:
            raise HTTPException(status_code=400, detail="请选择 zip 或填写服务器路径")

        try:
            groups, warnings = extract_and_group_zip(zip_path, work_dir)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"无法解压 ZIP：{exc}") from exc
        if not groups:
            raise HTTPException(
                status_code=400,
                detail="ZIP 中未找到可导入文件（按后缀识别格式，未知后缀会作为新格式入库）",
            )

        snapshot = scan_data()
        current_units = {
            (item["batch"], item["name"]): item for item in snapshot.get("units", [])
        }
        results: list[dict[str, Any]] = []
        saved_paths: list[str] = []
        formats: list[str] = []

        for group in groups:
            raw_unit_name = normalize_unit_stem(group.display_stem) or group.display_stem
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
                ensure_capability(db, user, Capability.upload, f"/{batch}/{raw_unit_name}/")

            new_robot_style = str(parsed_annotation.get("robot_style") or "").strip()

            for fmt, path in sorted(group.files.items()):
                original_name = path.name
                file_sub_path = ""
                try:
                    rel_to_work = path.relative_to(work_dir)
                    if len(rel_to_work.parts) > 1:
                        file_sub_path = "/".join(rel_to_work.parts[:-1])
                except Exception:
                    pass
                file_stem = Path(original_name).stem
                if file_sub_path:
                    effective_unit = normalize_unit_stem((file_sub_path + "/" + file_stem).replace("/", "_")) or (file_sub_path + "_" + file_stem).replace("/", "_")
                else:
                    effective_unit = raw_unit_name
                row: dict[str, Any] = {
                    "name": original_name,
                    "unit_name": effective_unit,
                    "status": "upload",
                }
                existing = None
                if current:
                    existing = next(
                        (
                            item
                            for item in current.get("files", [])
                            if item["ontology"] == ontology
                            and item["modality"] == modality
                            and item["channel"] == channel
                            and item["format"] == str(fmt).lstrip(".")
                            and (
                                item["name"] == original_name
                                or Path(item["name"]).stem == raw_unit_name
                            )
                            and (
                                ontology != "robot"
                                or not new_robot_style
                                or str(item.get("robot_style") or "").strip() == new_robot_style
                            )
                        ),
                        None,
                    )
                if existing and not replace:
                    row["status"] = "skip"
                    results.append(row)
                    continue
                if existing and not manage_override:
                    try:
                        _require_file_owner(user, existing)
                    except HTTPException as exc:
                        row.update({"status": "failed", "detail": exc.detail})
                        results.append(row)
                        continue
                try:
                    with path.open("rb") as handle:
                        result = save_data_file(
                            handle,
                            ontology=ontology,
                            modality=modality,
                            channel=channel,
                            fmt=str(fmt).lstrip("."),
                            batch=batch,
                            unit_name=row["unit_name"],
                            original_name=original_name,
                            replace=bool(existing and replace),
                            update_index=False,
                            robot_style=str(parsed_annotation.get("robot_style") or ""),
                            sub_path=file_sub_path,
                        )
                    result["uploader"] = {"id": user.id, "username": user.username}
                    row.update(
                        {
                            "status": "replaced" if existing and replace else "uploaded",
                            "file": result,
                        }
                    )
                    saved_paths.append(result["path"])
                    formats.append(str(fmt).lstrip("."))
                except (ValueError, OSError) as exc:
                    row.update({"status": "failed", "detail": str(exc)})
                results.append(row)

        session = None
        if saved_paths:
            set_file_uploaders(saved_paths, user_id=user.id, username=user.username)
            csv_paths = [path for path in saved_paths if path.lower().endswith(".csv")]
            if parsed_annotation:
                update_files_annotation(
                    csv_paths if "fps" in parsed_annotation and csv_paths else saved_paths,
                    parsed_annotation,
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
            session = record_upload_session(
                user_id=user.id,
                username=user.username,
                source="zip",
                batch=batch,
                ontology=ontology,
                modality=modality,
                channel=channel,
                fmt=",".join(unique_formats),
                annotation=parsed_annotation,
                taxonomy_tag_ids=parsed_tags,
                paths=saved_paths,
                unit_names=unit_names,
                uploaded=sum(item["status"] == "uploaded" for item in results),
                replaced=sum(item["status"] == "replaced" for item in results),
            )
            rebuild_catalog()

        summary = {
            "batch": batch,
            "total": len(results),
            "uploaded": sum(item["status"] == "uploaded" for item in results),
            "replaced": sum(item["status"] == "replaced" for item in results),
            "skipped": sum(item["status"] == "skip" for item in results),
            "failed": sum(item["status"] == "failed" for item in results),
            "items": results,
            "warnings": warnings,
            "upload_session_id": session["id"] if session else None,
        }
        write_audit(
            db,
            user_id=user.id,
            action="upload_zip",
            entity_type="storage_batch",
            detail={key: value for key, value in summary.items() if key != "items"},
        )
        db.commit()
        return summary
    finally:
        shutil.rmtree(staging, ignore_errors=True)


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
        file = next((item for item in snapshot["files"] if item["path"] == path), None)
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
    return FileResponse(
        file_path,
        filename=file_path.name if download else None,
        content_disposition_type=disposition,
    )


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
        delete_repo_file(path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="文件不存在") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(
        db,
        user_id=user.id,
        action="delete",
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


@router.post("/models/instances")
def add_model_instance(
    body: ModelInstanceIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ensure_capability(db, user, Capability.upload, "/")
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
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ensure_capability(db, user, Capability.upload, "/")
    try:
        result = save_model_upload(
            file.file,
            ontology=ontology.strip().lower(),
            instance=instance,
            kind=kind.strip().lower(),
            filename=file.filename or "model.bin",
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
    ensure_capability(db, user, Capability.edit, "/")
    from ..services.disk_repository import update_model_instance_meta

    try:
        result = update_model_instance_meta(ontology, name, body.model_dump(exclude_none=True))
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
