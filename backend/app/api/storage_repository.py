"""Filesystem-first APIs for hub_repo/data, 3d_model and index metadata."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
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
    create_batch,
    create_model_instance,
    delete_model_instance,
    delete_repo_file,
    inspect_data_file,
    probe_data_file,
    read_metadata,
    rebuild_catalog,
    resolve_repo_file,
    save_data_file,
    save_model_upload,
    scan_data,
    scan_models,
    set_file_uploaders,
    unit_key,
    update_batch_metadata,
    update_file_metadata,
    update_files_annotation,
    update_unit_metadata,
)
from ..services.permissions import ensure_capability, is_admin, path_matches

router = APIRouter(prefix="/storage", tags=["storage-repository"])


class BatchCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=256)


class UnitMetadataIn(BaseModel):
    taxonomy_tag_ids: dict[str, int | None] | None = None
    annotation: dict[str, Any] | None = None
    meta: dict[str, Any] | None = None


class ModelInstanceIn(BaseModel):
    ontology: str
    name: str = Field(min_length=1, max_length=256)


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


def _unit_path(unit: dict[str, Any]) -> str:
    return f"/{unit['batch']}/{unit['name']}/"


def _unit_allowed(
    db: Session,
    user: User,
    capability: Capability,
    unit: dict[str, Any],
) -> bool:
    if is_admin(user):
        return True
    rows = (
        db.query(UserPermission)
        .filter(
            UserPermission.user_id == user.id,
            UserPermission.capability == capability,
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
    if is_admin(user):
        return
    caps = (Capability.annotate, Capability.edit, Capability.upload)
    if unit and _has_capability_on_unit(db, user, unit, *caps):
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
    return next(
        (unit for unit in snapshot["units"] if unit["batch"] == batch and unit["name"] == name),
        None,
    )


def _unit_for_file(snapshot: dict[str, Any], path: str) -> dict[str, Any] | None:
    file = next((item for item in snapshot["files"] if item["path"] == path), None)
    if not file:
        return None
    return _find_unit(snapshot, file["batch"], file["unit_name"])


def _taxonomy_briefs(db: Session, ids: dict[str, Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for scheme, raw_id in (ids or {}).items():
        try:
            node_id = int(raw_id)
        except (TypeError, ValueError):
            continue
        node = db.get(TaxonomyNode, node_id)
        if node and str(node.scheme) == scheme:
            out[scheme] = {
                "id": node.id,
                "scheme": scheme,
                "code": node.code or "",
                "name": node.name,
                "path": node.path,
            }
    return out


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
) -> dict[str, Any]:
    q_norm = (q or "").strip().lower()
    wanted_tag_ids: set[int] | None = None
    if taxonomy_scheme and tag_id is not None:
        node = db.get(TaxonomyNode, tag_id)
        if not node or str(node.scheme) != taxonomy_scheme:
            wanted_tag_ids = set()
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
        unit["taxonomy_tags"] = _taxonomy_briefs(
            db, unit.get("taxonomy_tag_ids") or {}
        )
        for file in unit.get("files", []):
            file["taxonomy_tags"] = _taxonomy_briefs(
                db, file.get("taxonomy_tag_ids") or {}
            )
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
        if (
            q_norm
            or (taxonomy_scheme and tag_id is not None)
            or uploader_id is not None
        ) and not visible_units:
            continue
        batches.append(
            {
                **item,
                "taxonomy_tags": _taxonomy_briefs(
                    db, item.get("taxonomy_tag_ids") or {}
                ),
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
    return {
        **snapshot,
        "uploaders": uploaders,
        "units": units,
        "batches": batches,
        "files": [
            file
            for unit in units
            if unit["key"] in visible_keys
            for file in unit.get("files", [])
        ],
    }


@router.get("/overview")
def overview(
    batch: str | None = None,
    q: str | None = None,
    taxonomy_scheme: str | None = None,
    tag_id: int | None = None,
    uploader_id: int | None = None,
    include_empty: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if include_empty and not is_admin(user):
        raise HTTPException(status_code=403, detail="只有管理员可以查看空目录")
    return _decorate_and_filter(
        scan_data(include_empty=include_empty),
        db,
        user,
        batch=batch,
        q=q,
        taxonomy_scheme=taxonomy_scheme,
        tag_id=tag_id,
        uploader_id=uploader_id,
    )


@router.post("/rescan")
def rescan(
    _: User = Depends(get_current_user),
):
    return rebuild_catalog()


@router.post("/batches")
def add_batch(
    body: BatchCreateIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ensure_capability(db, user, Capability.upload, "/")
    result = create_batch(body.name)
    rebuild_catalog()
    write_audit(
        db,
        user_id=user.id,
        action="create",
        entity_type="storage_batch",
        detail={"name": body.name},
    )
    db.commit()
    return result


@router.patch("/batches/{name}")
def patch_batch(
    name: str,
    body: UnitMetadataIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    snapshot = scan_data(include_empty=is_admin(user))
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
    rebuild_catalog()
    write_audit(
        db,
        user_id=user.id,
        action="annotate",
        entity_type="storage_batch",
        detail={"batch": name, **body.model_dump(exclude_none=True)},
    )
    db.commit()
    return result


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
        unit_name,
        taxonomy_tag_ids=body.taxonomy_tag_ids,
        annotation=body.annotation,
        meta=body.meta,
    )
    result["taxonomy_tags"] = _taxonomy_briefs(
        db, result.get("taxonomy_tag_ids") or {}
    )
    rebuild_catalog()
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
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if manage_override and not is_admin(user):
        raise HTTPException(status_code=403, detail="只有管理员可以覆盖其他用户的数据")
    current = _find_unit(scan_data(), batch, unit_name)
    if current:
        _require_unit(db, user, Capability.upload, current)
    else:
        ensure_capability(db, user, Capability.upload, f"/{batch}/{unit_name}/")
    if replace and current:
        suffix = Path(file.filename or "").suffix or f".{format.lstrip('.')}"
        target_name = f"{unit_name}{suffix}"
        existing = next(
            (
                item
                for item in current.get("files", [])
                if item["ontology"] == ontology.strip().lower()
                and item["modality"] == modality.strip().lower()
                and item["channel"] == channel.strip().lower()
                and item["format"] == format.strip().lower().lstrip(".")
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
            fmt=format.strip().lower(),
            batch=batch,
            unit_name=unit_name,
            original_name=file.filename or f"{unit_name}.{format}",
            replace=replace,
            update_index=False,
        )
        uploader = {
            "id": user.id,
            "username": user.username,
        }
        set_file_uploaders(
            [result["path"]], user_id=user.id, username=user.username
        )
        update_files_annotation([result["path"]], _parse_annotation_form(annotation))
        create_batch(batch)
        rebuild_catalog()
        result["uploader"] = uploader
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
    ontology: str = Form(...),
    modality: str = Form(...),
    channel: str = Form(""),
    format: str = Form(...),
    batch: str = Form(...),
    actions: str = Form("[]"),
    annotation: str = Form(""),
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
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

    ontology = ontology.strip().lower()
    modality = modality.strip().lower()
    channel = channel.strip().lower()
    fmt = format.strip().lower()
    snapshot = scan_data()
    current_units = {
        (item["batch"], item["name"]): item for item in snapshot.get("units", [])
    }
    results: list[dict[str, Any]] = []
    saved = 0
    saved_paths: list[str] = []

    for file, action in zip(files, raw_actions):
        original_name = Path(file.filename or "").name
        raw_unit_name = Path(original_name).stem
        row: dict[str, Any] = {
            "name": original_name,
            "unit_name": raw_unit_name,
            "status": action,
        }
        if action == "skip":
            results.append(row)
            continue
        try:
            current = current_units.get((batch, raw_unit_name))
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
                        and item["format"] == fmt.lstrip(".")
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
                fmt=fmt,
                batch=batch,
                unit_name=raw_unit_name,
                original_name=original_name or f"{raw_unit_name}.{fmt}",
                replace=action == "replace",
                update_index=False,
            )
            result["uploader"] = {
                "id": user.id,
                "username": user.username,
            }
            row.update({"status": "replaced" if action == "replace" else "uploaded", "file": result})
            saved += 1
            saved_paths.append(result["path"])
        except (ValueError, HTTPException) as exc:
            detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
            row.update({"status": "failed", "detail": detail})
        except OSError as exc:
            row.update({"status": "failed", "detail": f"写入文件失败：{exc}"})
        results.append(row)

    if saved:
        set_file_uploaders(
            saved_paths, user_id=user.id, username=user.username
        )
        update_files_annotation(saved_paths, _parse_annotation_form(annotation))
        create_batch(batch)
        rebuild_catalog()
    summary = {
        "batch": batch,
        "total": len(files),
        "uploaded": sum(item["status"] == "uploaded" for item in results),
        "replaced": sum(item["status"] == "replaced" for item in results),
        "skipped": sum(item["status"] == "skip" for item in results),
        "failed": sum(item["status"] == "failed" for item in results),
        "items": results,
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
    unit = {
        "batch": record["batch"],
        "name": record["unit_name"],
        "taxonomy_tag_ids": unit_meta.get("taxonomy_tag_ids") or {},
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
        "batch_taxonomy_tag_ids": batch_meta.get("taxonomy_tag_ids") or {},
        "batch_taxonomy_tags": _taxonomy_briefs(
            db, batch_meta.get("taxonomy_tag_ids") or {}
        ),
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
        unit = _unit_for_file(scan_data(), path)
        if not unit:
            raise HTTPException(status_code=404, detail="文件未纳入数据单元")
        _require_unit(
            db,
            user,
            Capability.download if download else Capability.browse,
            unit,
        )
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
    # Include metadata-only instances that have no file yet.
    from ..services.disk_repository import read_metadata

    existing = {item["key"] for item in result["instances"]}
    for key, meta in (read_metadata().get("models") or {}).items():
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
