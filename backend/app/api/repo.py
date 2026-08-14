"""Hub repo: dimensional upload, catalog index, dimension browse."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session, joinedload

from ..core.deps import get_current_user
from ..database import get_db
from ..models import ActionUnit, Capability, RepoFile, TaxonomyNode, User
from ..services.audit import write_audit
from ..services.dimensions import (
    MODALITIES,
    ONTOLOGIES,
    action_id_from_dims,
    file_dimension_key,
    load_dimension_schema,
    merge_dimension_schema,
    normalize_file_dimensions,
)
from ..services.hub_repo import (
    absolute_repo_path,
    copy_path_to_repo,
    ensure_hub_skeleton,
    extract_zip_members,
    group_files_by_format,
    hub_root,
    infer_format,
    read_catalog,
    relocate_repo_file,
    remove_catalog_entry,
    sanitize_name,
    save_stream_to_repo,
    upsert_catalog_entry,
)
from ..services.permissions import ensure_capability, normalize_path
from ..services.repo_taxonomy import repo_file_tag_id as _repo_file_tag_id
from ..services.repo_taxonomy import scheme_str as _scheme_str

router = APIRouter(prefix="/repo", tags=["repo"])


def _taxonomy_filter_node_ids(
    db: Session,
    *,
    scheme: str | None,
    tag_id: int | None,
    taxonomy_path: str | None,
    tag_exact: bool,
) -> list[int] | None:
    """None = no taxonomy filter; [] = match nothing; else allowed node ids."""
    if not scheme:
        return None
    scheme = scheme.strip()
    if tag_id is not None:
        node = db.get(TaxonomyNode, tag_id)
        if not node or _scheme_str(node.scheme) != scheme:
            return []
        if tag_exact:
            return [node.id]
        pref = node.path or ""
        rows = (
            db.query(TaxonomyNode.id)
            .filter(
                TaxonomyNode.scheme == scheme,
                TaxonomyNode.path.like(f"{pref}%"),
            )
            .all()
        )
        return [r[0] for r in rows]
    if taxonomy_path:
        pref = normalize_path(taxonomy_path)
        rows = (
            db.query(TaxonomyNode.id)
            .filter(
                TaxonomyNode.scheme == scheme,
                TaxonomyNode.path.like(f"{pref}%"),
            )
            .all()
        )
        return [r[0] for r in rows]
    return None


class ActionDefIn(BaseModel):
    action_def: dict[str, Any] = Field(default_factory=dict)


class DimensionExtendIn(BaseModel):
    group_key: str | None = None
    field: dict[str, Any] | None = None
    new_group: dict[str, Any] | None = None


class RepoFileUpdateIn(BaseModel):
    """Partial update for a hub_repo file (metadata + optional rename/move)."""

    original_name: str | None = None
    source_name: str | None = None
    fps: float | None = None
    clear_fps: bool = False
    meta: dict[str, Any] | None = None
    engineering: dict[str, Any] | None = None
    replica: dict[str, Any] | None = None
    action_def: dict[str, Any] | None = None


class BatchIdsIn(BaseModel):
    ids: list[int] = Field(default_factory=list)


class PackKeyIn(BaseModel):
    """一次上传对应的逻辑文件夹：模态 × 本体 × 来源名（ZIP/文件夹名）。"""

    modality: str
    ontology: str
    source_name: str


class PackUpdateIn(PackKeyIn):
    new_source_name: str | None = None
    fps: float | None = None
    clear_fps: bool = False
    meta: dict[str, Any] | None = None
    engineering: dict[str, Any] | None = None
    action_def: dict[str, Any] | None = None


class RepoPackOut(BaseModel):
    key: str
    modality: str
    ontology: str
    source_name: str
    file_count: int
    formats: list[str]
    action_ids: list[str]
    project: str = ""
    quality: str = ""
    fps: float | None = None
    action_def: dict[str, Any] = Field(default_factory=dict)
    engineering: dict[str, Any] = Field(default_factory=dict)
    meta: dict[str, Any] = Field(default_factory=dict)
    created_at: Any = None
    files: list[RepoFileOut] = Field(default_factory=list)


class ActionUnitOut(BaseModel):
    id: int
    action_id: str
    action_def: dict[str, Any]
    file_count: int = 0

    class Config:
        from_attributes = True


class RepoFileOut(BaseModel):
    id: int
    action_unit_id: int
    action_id: str = ""
    action_def: dict[str, Any] = Field(default_factory=dict)
    dimensions: dict[str, Any]
    modality: str
    ontology: str
    format: str
    source_name: str
    repo_path: str
    original_name: str
    checksum: str | None
    fps: float | None
    meta: dict[str, Any]
    created_at: Any

    class Config:
        from_attributes = True


def _file_out(rf: RepoFile, action_id: str = "", action_def: dict[str, Any] | None = None) -> RepoFileOut:
    unit = rf.action_unit
    aid = action_id or (unit.action_id if unit else "")
    adef = action_def if action_def is not None else ((unit.action_def or {}) if unit else {})
    return RepoFileOut(
        id=rf.id,
        action_unit_id=rf.action_unit_id,
        action_id=aid,
        action_def=adef,
        dimensions=rf.dimensions or {},
        modality=rf.modality,
        ontology=rf.ontology,
        format=rf.format,
        source_name=rf.source_name,
        repo_path=rf.repo_path,
        original_name=rf.original_name,
        checksum=rf.checksum,
        fps=rf.fps,
        meta=rf.meta or {},
        created_at=rf.created_at,
    )


def _catalog_entry(rf: RepoFile, unit: ActionUnit) -> dict[str, Any]:
    return {
        "id": rf.id,
        "action_unit_id": unit.id,
        "action_id": unit.action_id,
        "action_def": unit.action_def or {},
        "dimensions": rf.dimensions or {},
        "modality": rf.modality,
        "ontology": rf.ontology,
        "format": rf.format,
        "source_name": rf.source_name,
        "path": rf.repo_path,
        "original_name": rf.original_name,
        "checksum": rf.checksum,
        "fps": rf.fps,
        "meta": rf.meta or {},
    }


def _get_or_create_unit(
    db: Session, action_def: dict[str, Any], user: User
) -> ActionUnit:
    aid = action_id_from_dims(action_def)
    unit = db.query(ActionUnit).filter(ActionUnit.action_id == aid).first()
    if unit:
        # merge non-empty fields
        merged = dict(unit.action_def or {})
        for k, v in (action_def or {}).items():
            if v not in (None, ""):
                merged[k] = v
        merged["action_id"] = aid
        unit.action_def = merged
        return unit
    unit = ActionUnit(
        action_id=aid,
        action_def={**(action_def or {}), "action_id": aid},
        created_by=user.id,
    )
    db.add(unit)
    db.flush()
    return unit


def _register_file(
    db: Session,
    *,
    unit: ActionUnit,
    file_dims: dict[str, Any],
    modality: str,
    ontology: str,
    fmt: str,
    source_name: str,
    repo_path: str,
    original_name: str,
    checksum: str,
    fps: float | None,
    user: User,
    meta: dict[str, Any] | None = None,
) -> RepoFile:
    dims = normalize_file_dimensions(
        file_dims, modality=modality, ontology=ontology, fmt=fmt
    )
    key = file_dimension_key(dims)
    existing = (
        db.query(RepoFile)
        .filter(RepoFile.action_unit_id == unit.id, RepoFile.dim_key == key)
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"该动作单元下已存在相同维度组合的文件（dim_key={key}）",
        )
    rf = RepoFile(
        action_unit_id=unit.id,
        dimensions=dims,
        dim_key=key,
        modality=modality,
        ontology=ontology,
        format=fmt,
        source_name=source_name,
        repo_path=repo_path,
        original_name=original_name,
        checksum=checksum,
        fps=fps,
        meta=meta or {},
        created_by=user.id,
    )
    db.add(rf)
    db.flush()
    upsert_catalog_entry(_catalog_entry(rf, unit))
    return rf


@router.get("/dimensions")
def get_dimensions(user: User = Depends(get_current_user)):
    ensure_hub_skeleton()
    return load_dimension_schema(hub_root())


@router.patch("/dimensions")
def extend_dimensions(
    body: DimensionExtendIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ensure_capability(db, user, Capability.edit, "/")
    try:
        schema = merge_dimension_schema(
            hub_root(),
            group_key=body.group_key,
            field=body.field,
            new_group=body.new_group,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    write_audit(
        db,
        user_id=user.id,
        action="update",
        entity_type="dimension_schema",
        entity_id=None,
        detail=body.model_dump(),
    )
    db.commit()
    return schema


@router.get("/catalog")
def get_catalog(user: User = Depends(get_current_user)):
    ensure_hub_skeleton()
    return read_catalog(hub_root())


@router.get("/meta")
def repo_meta(user: User = Depends(get_current_user)):
    return {
        "modalities": list(MODALITIES),
        "ontologies": list(ONTOLOGIES),
        "layout": "data/{modality}/{ontology}/{format}/{source_name}/{filename}",
        "hub_repo_root": str(hub_root()),
    }


@router.get("/units", response_model=list[ActionUnitOut])
def list_units(
    q: str = "",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ensure_capability(db, user, Capability.browse, "/")
    query = db.query(ActionUnit).options(joinedload(ActionUnit.files))
    if q.strip():
        like = f"%{q.strip()}%"
        query = query.filter(ActionUnit.action_id.ilike(like))
    units = query.order_by(ActionUnit.id.desc()).limit(500).all()
    return [
        ActionUnitOut(
            id=u.id,
            action_id=u.action_id,
            action_def=u.action_def or {},
            file_count=len(u.files or []),
        )
        for u in units
    ]


@router.get("/files", response_model=list[RepoFileOut])
def list_files(
    modality: str | None = None,
    ontology: str | None = None,
    format: str | None = None,
    source_name: str | None = None,
    action_id: str | None = None,
    project: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Browse files by any dimension facet."""
    ensure_capability(db, user, Capability.browse, "/")
    q = db.query(RepoFile).options(joinedload(RepoFile.action_unit))
    if modality:
        q = q.filter(RepoFile.modality == modality.strip().lower())
    if ontology:
        q = q.filter(RepoFile.ontology == ontology.strip().lower())
    if format:
        q = q.filter(RepoFile.format == format.strip().lower().lstrip("."))
    if source_name:
        q = q.filter(RepoFile.source_name == sanitize_name(source_name))
    if action_id:
        q = q.join(ActionUnit).filter(ActionUnit.action_id == action_id.strip())
    rows = q.order_by(RepoFile.id.desc()).limit(1000).all()
    out: list[RepoFileOut] = []
    for rf in rows:
        if project:
            eng = (rf.dimensions or {}).get("engineering") or {}
            if str(eng.get("project") or "") != project:
                continue
        out.append(_file_out(rf))
    return out


@router.get("/browse-tree")
def browse_tree(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Facet tree: modality → ontology → format → source_name → files count."""
    ensure_capability(db, user, Capability.browse, "/")
    rows = db.query(RepoFile).all()
    tree: dict[str, Any] = {}
    for rf in rows:
        m = tree.setdefault(rf.modality, {})
        o = m.setdefault(rf.ontology, {})
        f = o.setdefault(rf.format, {})
        s = f.setdefault(rf.source_name or "_", {"count": 0, "files": []})
        s["count"] += 1
        s["files"].append({"id": rf.id, "name": rf.original_name, "path": rf.repo_path})
    return {"tree": tree}


def _pack_key(modality: str, ontology: str, source_name: str) -> str:
    return f"{modality}/{ontology}/{source_name}"


def _query_pack_files(
    db: Session, *, modality: str, ontology: str, source_name: str
) -> list[RepoFile]:
    return (
        db.query(RepoFile)
        .options(joinedload(RepoFile.action_unit))
        .filter(
            RepoFile.modality == modality.strip().lower(),
            RepoFile.ontology == ontology.strip().lower(),
            RepoFile.source_name == sanitize_name(source_name),
        )
        .order_by(RepoFile.format.asc(), RepoFile.id.asc())
        .all()
    )


def _pack_out(rows: list[RepoFile]) -> RepoPackOut:
    if not rows:
        raise ValueError("empty pack")
    first = rows[0]
    formats = sorted({r.format for r in rows})
    action_ids = sorted(
        {r.action_unit.action_id for r in rows if r.action_unit},
        key=str,
    )
    eng = (first.dimensions or {}).get("engineering") or {}
    meta = first.meta or {}
    adef = (first.action_unit.action_def if first.action_unit else {}) or {}
    created = max((r.created_at for r in rows if r.created_at), default=None)
    return RepoPackOut(
        key=_pack_key(first.modality, first.ontology, first.source_name),
        modality=first.modality,
        ontology=first.ontology,
        source_name=first.source_name,
        file_count=len(rows),
        formats=formats,
        action_ids=action_ids,
        project=str(eng.get("project") or ""),
        quality=str(meta.get("quality") or ""),
        fps=first.fps,
        action_def=adef,
        engineering=dict(eng),
        meta=dict(meta),
        created_at=created,
        files=[_file_out(r) for r in rows],
    )


@router.get("/packs", response_model=list[RepoPackOut])
def list_packs(
    modality: str | None = None,
    ontology: str | None = None,
    source_name: str | None = None,
    q: str = "",
    taxonomy_scheme: str | None = None,
    taxonomy_path: str | None = None,
    tag_id: int | None = None,
    tag_exact: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """按「上传包」列出：每次 ZIP/散文件上传的来源名为一夹，内含多格式文件。

    可按分类标准筛选：taxonomy_scheme + tag_id（默认含子节点）或 taxonomy_path。
    """
    ensure_capability(db, user, Capability.browse, "/")
    match_ids = _taxonomy_filter_node_ids(
        db,
        scheme=taxonomy_scheme,
        tag_id=tag_id,
        taxonomy_path=taxonomy_path,
        tag_exact=tag_exact,
    )
    if match_ids is not None and len(match_ids) == 0:
        return []

    query = db.query(RepoFile).options(joinedload(RepoFile.action_unit))
    if modality:
        query = query.filter(RepoFile.modality == modality.strip().lower())
    if ontology:
        query = query.filter(RepoFile.ontology == ontology.strip().lower())
    if source_name:
        query = query.filter(RepoFile.source_name == sanitize_name(source_name))
    rows = query.order_by(RepoFile.id.desc()).limit(5000).all()

    scheme = (taxonomy_scheme or "").strip()
    if match_ids is not None and scheme:
        allow = set(match_ids)
        rows = [rf for rf in rows if (_repo_file_tag_id(rf, scheme) in allow)]

    groups: dict[tuple[str, str, str], list[RepoFile]] = {}
    for rf in rows:
        key = (rf.modality, rf.ontology, rf.source_name or "")
        groups.setdefault(key, []).append(rf)
    packs = [_pack_out(sorted(v, key=lambda r: (r.format, r.id))) for v in groups.values()]
    packs.sort(key=lambda p: (p.created_at or "", p.source_name), reverse=True)
    qq = q.strip().lower()
    if qq:
        packs = [
            p
            for p in packs
            if qq in p.source_name.lower()
            or qq in p.key.lower()
            or any(qq in a.lower() for a in p.action_ids)
            or any(qq in f.original_name.lower() for f in p.files)
        ]
    return packs


@router.patch("/packs", response_model=RepoPackOut)
def update_pack(
    body: PackUpdateIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """批量修改整个上传包的属性（工程标记 / 动作定义 / 元数据 / 重命名来源夹）。"""
    ensure_capability(db, user, Capability.edit, "/")
    modality = body.modality.strip().lower()
    ontology = body.ontology.strip().lower()
    src = sanitize_name(body.source_name)
    rows = _query_pack_files(db, modality=modality, ontology=ontology, source_name=src)
    if not rows:
        raise HTTPException(status_code=404, detail="上传包不存在或已空")

    new_src = sanitize_name(body.new_source_name) if body.new_source_name is not None else src
    if new_src != src:
        clash = (
            db.query(RepoFile)
            .filter(
                RepoFile.modality == modality,
                RepoFile.ontology == ontology,
                RepoFile.source_name == new_src,
            )
            .first()
        )
        if clash:
            raise HTTPException(status_code=400, detail=f"目标来源名「{new_src}」已存在")

    # 动作定义：对包内涉及的动作单元去重后合并更新
    if body.action_def is not None:
        unit_ids = {r.action_unit_id for r in rows}
        for uid in unit_ids:
            unit = db.get(ActionUnit, uid)
            if not unit:
                continue
            merged = {**(unit.action_def or {}), **body.action_def}
            try:
                unit = _get_or_create_unit(db, merged, user)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
            for r in rows:
                if r.action_unit_id == uid:
                    r.action_unit_id = unit.id
                    r.action_unit = unit

    for rf in rows:
        dims = dict(rf.dimensions or {})
        eng = dict(dims.get("engineering") or {})
        replica = dict(dims.get("replica") or {})
        data_type = dict(dims.get("data_type") or {})
        if body.engineering is not None:
            for k, v in body.engineering.items():
                if v in (None, ""):
                    eng.pop(k, None)
                else:
                    eng[k] = v
        if body.clear_fps:
            rf.fps = None
            data_type.pop("fps", None)
        elif body.fps is not None:
            rf.fps = body.fps
            data_type["fps"] = body.fps
        if body.meta is not None:
            merged_meta = dict(rf.meta or {})
            merged_meta.update(body.meta)
            rf.meta = merged_meta

        if new_src != src:
            try:
                new_rel = relocate_repo_file(
                    rf.repo_path,
                    modality=rf.modality,
                    ontology=rf.ontology,
                    fmt=rf.format,
                    source_name=new_src,
                    filename=rf.original_name or Path(rf.repo_path).name,
                )
            except FileNotFoundError as e:
                raise HTTPException(status_code=404, detail=f"磁盘文件缺失: {e}") from e
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
            remove_catalog_entry(file_id=rf.id, path=rf.repo_path)
            rf.repo_path = new_rel
            rf.source_name = new_src

        new_dims = normalize_file_dimensions(
            {"engineering": eng, "data_type": data_type, "replica": replica},
            modality=rf.modality,
            ontology=rf.ontology,
            fmt=rf.format,
        )
        new_key = file_dimension_key(new_dims)
        clash = (
            db.query(RepoFile)
            .filter(
                RepoFile.action_unit_id == rf.action_unit_id,
                RepoFile.dim_key == new_key,
                RepoFile.id != rf.id,
            )
            .first()
        )
        if clash:
            raise HTTPException(
                status_code=400,
                detail=f"文件 #{rf.id} 维度与 #{clash.id} 冲突，请先调整副本号",
            )
        rf.dimensions = new_dims
        rf.dim_key = new_key
        db.flush()
        unit = rf.action_unit or db.get(ActionUnit, rf.action_unit_id)
        if unit:
            upsert_catalog_entry(_catalog_entry(rf, unit))

    write_audit(
        db,
        user_id=user.id,
        action="update",
        entity_type="repo_pack",
        entity_id=None,
        detail=body.model_dump(exclude_none=True),
    )
    db.commit()
    updated = _query_pack_files(
        db, modality=modality, ontology=ontology, source_name=new_src
    )
    return _pack_out(updated)


@router.post("/packs/delete")
def delete_pack(
    body: PackKeyIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """删除整个上传包（包内全部格式文件 + 磁盘 + 索引）。"""
    ensure_capability(db, user, Capability.edit, "/")
    rows = _query_pack_files(
        db,
        modality=body.modality,
        ontology=body.ontology,
        source_name=body.source_name,
    )
    if not rows:
        raise HTTPException(status_code=404, detail="上传包不存在或已空")
    count = 0
    for rf in rows:
        _delete_one_repo_file(db, rf, user)
        count += 1
    write_audit(
        db,
        user_id=user.id,
        action="delete",
        entity_type="repo_pack",
        entity_id=None,
        detail={
            "modality": body.modality,
            "ontology": body.ontology,
            "source_name": body.source_name,
            "count": count,
        },
    )
    db.commit()
    return {"ok": True, "count": count}


@router.get("/files/{file_id}", response_model=RepoFileOut)
def get_repo_file(
    file_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ensure_capability(db, user, Capability.browse, "/")
    rf = (
        db.query(RepoFile)
        .options(joinedload(RepoFile.action_unit))
        .filter(RepoFile.id == file_id)
        .first()
    )
    if not rf:
        raise HTTPException(status_code=404, detail="文件不存在")
    return _file_out(rf)


@router.patch("/files/{file_id}", response_model=RepoFileOut)
def update_repo_file(
    file_id: int,
    body: RepoFileUpdateIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Edit metadata; optionally rename/move the on-disk file under hub_repo."""
    ensure_capability(db, user, Capability.edit, "/")
    rf = (
        db.query(RepoFile)
        .options(joinedload(RepoFile.action_unit))
        .filter(RepoFile.id == file_id)
        .first()
    )
    if not rf:
        raise HTTPException(status_code=404, detail="文件不存在")
    unit = rf.action_unit
    if not unit:
        raise HTTPException(status_code=400, detail="动作单元缺失")

    if body.action_def is not None:
        unit = _get_or_create_unit(db, {**(unit.action_def or {}), **body.action_def}, user)
        rf.action_unit_id = unit.id
        rf.action_unit = unit

    dims = dict(rf.dimensions or {})
    eng = dict(dims.get("engineering") or {})
    replica = dict(dims.get("replica") or {})
    data_type = dict(dims.get("data_type") or {})
    if body.engineering is not None:
        for k, v in body.engineering.items():
            if v in (None, ""):
                eng.pop(k, None)
            else:
                eng[k] = v
    if body.replica is not None:
        for k, v in body.replica.items():
            if v in (None, ""):
                replica.pop(k, None)
            else:
                replica[k] = v
    new_fps = rf.fps
    if body.clear_fps:
        new_fps = None
        data_type.pop("fps", None)
    elif body.fps is not None:
        new_fps = body.fps
        data_type["fps"] = body.fps

    new_name = (body.original_name if body.original_name is not None else rf.original_name) or "file.bin"
    new_name = Path(str(new_name).strip()).name or rf.original_name or "file.bin"
    new_source = sanitize_name(
        body.source_name if body.source_name is not None else rf.source_name
    )
    new_fmt = infer_format(new_name) if body.original_name is not None else rf.format

    dims = {
        "engineering": eng,
        "data_type": data_type,
        "replica": replica,
    }
    dims = normalize_file_dimensions(
        dims, modality=rf.modality, ontology=rf.ontology, fmt=new_fmt
    )
    new_key = file_dimension_key(dims)
    clash = (
        db.query(RepoFile)
        .filter(
            RepoFile.action_unit_id == unit.id,
            RepoFile.dim_key == new_key,
            RepoFile.id != rf.id,
        )
        .first()
    )
    if clash:
        raise HTTPException(
            status_code=400,
            detail=f"维度组合与文件 #{clash.id} 冲突，请调整副本号或工程标记",
        )

    need_move = (
        new_name != (rf.original_name or "")
        or new_source != (rf.source_name or "")
        or new_fmt != rf.format
    )
    if need_move:
        try:
            new_rel = relocate_repo_file(
                rf.repo_path,
                modality=rf.modality,
                ontology=rf.ontology,
                fmt=new_fmt,
                source_name=new_source,
                filename=new_name,
            )
        except FileNotFoundError as e:
            raise HTTPException(status_code=404, detail=f"磁盘文件缺失: {e}") from e
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        remove_catalog_entry(file_id=rf.id, path=rf.repo_path)
        rf.repo_path = new_rel
        rf.original_name = new_name
        rf.source_name = new_source
        rf.format = new_fmt

    rf.fps = new_fps
    rf.dimensions = dims
    rf.dim_key = new_key
    if body.meta is not None:
        merged_meta = dict(rf.meta or {})
        merged_meta.update(body.meta)
        rf.meta = merged_meta

    db.flush()
    upsert_catalog_entry(_catalog_entry(rf, unit))
    write_audit(
        db,
        user_id=user.id,
        action="update",
        entity_type="repo_file",
        entity_id=rf.id,
        detail=body.model_dump(exclude_none=True),
    )
    db.commit()
    rf = (
        db.query(RepoFile)
        .options(joinedload(RepoFile.action_unit))
        .filter(RepoFile.id == file_id)
        .first()
    )
    return _file_out(rf)  # type: ignore[arg-type]


@router.get("/files/{file_id}/download")
def download_repo_file(
    file_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ensure_capability(db, user, Capability.download, "/")
    rf = db.get(RepoFile, file_id)
    if not rf:
        raise HTTPException(status_code=404, detail="文件不存在")
    path = absolute_repo_path(rf.repo_path)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="磁盘文件缺失")
    return FileResponse(path, filename=rf.original_name or path.name)


@router.post("/upload", response_model=list[RepoFileOut])
async def upload_repo_files(
    modality: str = Form(...),
    ontology: str = Form(...),
    source_name: str = Form(""),
    action_def_json: str = Form("{}"),
    engineering_json: str = Form("{}"),
    replica_json: str = Form("{}"),
    meta_json: str = Form("{}"),
    fps: float | None = Form(None),
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Upload one or more loose files into hub_repo under modality/ontology/format/source."""
    ensure_capability(db, user, Capability.upload, "/")
    modality = modality.strip().lower()
    ontology = ontology.strip().lower()
    if modality not in MODALITIES or ontology not in ONTOLOGIES:
        raise HTTPException(status_code=400, detail="modality/ontology 无效")
    try:
        action_def = json.loads(action_def_json or "{}")
        engineering = json.loads(engineering_json or "{}")
        replica = json.loads(replica_json or "{}")
        meta = json.loads(meta_json or "{}")
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"JSON 无效: {e}") from e
    if not isinstance(meta, dict):
        meta = {}

    src_name = sanitize_name(source_name or "upload")
    if not action_def.get("action_id") and not action_def.get("action_name"):
        action_def["action_id"] = src_name
        action_def.setdefault("action_name", src_name)

    unit = _get_or_create_unit(db, action_def, user)
    created: list[RepoFileOut] = []
    fmt_counts: dict[str, int] = {}
    for uf in files:
        fname = uf.filename or "file.bin"
        fmt = infer_format(fname)
        fmt_counts[fmt] = fmt_counts.get(fmt, 0) + 1
    for uf in files:
        fname = uf.filename or "file.bin"
        fmt = infer_format(fname)
        rel, checksum, _ = save_stream_to_repo(
            uf.file,
            modality=modality,
            ontology=ontology,
            fmt=fmt,
            source_name=src_name,
            filename=fname,
        )
        copy_no = (
            Path(fname).stem
            if fmt_counts.get(fmt, 0) > 1
            else str((replica or {}).get("copy_no") or "1")
        )
        file_dims = {
            "engineering": engineering,
            "data_type": {"fps": fps} if fps is not None else {},
            "replica": {**(replica or {}), "copy_no": copy_no},
        }
        rf = _register_file(
            db,
            unit=unit,
            file_dims=file_dims,
            modality=modality,
            ontology=ontology,
            fmt=fmt,
            source_name=src_name,
            repo_path=rel,
            original_name=fname,
            checksum=checksum,
            fps=fps,
            user=user,
            meta=meta,
        )
        created.append(_file_out(rf, unit.action_id))

    write_audit(
        db,
        user_id=user.id,
        action="upload",
        entity_type="repo_batch",
        entity_id=unit.id,
        detail={"count": len(created), "source_name": src_name, "modality": modality},
    )
    db.commit()
    return created


@router.post("/upload-zip", response_model=list[RepoFileOut])
async def upload_repo_zip(
    modality: str = Form(...),
    ontology: str = Form(...),
    action_def_json: str = Form("{}"),
    engineering_json: str = Form("{}"),
    replica_json: str = Form("{}"),
    meta_json: str = Form("{}"),
    fps: float | None = Form(None),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Upload a ZIP: source_name = zip stem; files grouped by extension into format folders."""
    ensure_capability(db, user, Capability.upload, "/")
    modality = modality.strip().lower()
    ontology = ontology.strip().lower()
    if modality not in MODALITIES or ontology not in ONTOLOGIES:
        raise HTTPException(status_code=400, detail="modality/ontology 无效")
    try:
        action_def = json.loads(action_def_json or "{}")
        engineering = json.loads(engineering_json or "{}")
        replica = json.loads(replica_json or "{}")
        meta = json.loads(meta_json or "{}")
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"JSON 无效: {e}") from e
    if not isinstance(meta, dict):
        meta = {}

    src_name = sanitize_name(file.filename or "upload")
    if not action_def.get("action_id") and not action_def.get("action_name"):
        action_def["action_id"] = src_name
        action_def.setdefault("action_name", src_name)

    unit = _get_or_create_unit(db, action_def, user)
    created: list[RepoFileOut] = []

    with tempfile.TemporaryDirectory(prefix="hub_zip_") as tmp:
        tmp_dir = Path(tmp)
        zip_path = tmp_dir / "in.zip"
        with zip_path.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
        extracted = extract_zip_members(zip_path, tmp_dir / "extracted")
        by_fmt = group_files_by_format(extracted)
        if not by_fmt:
            raise HTTPException(status_code=400, detail="ZIP 中未找到可识别文件")

        for fmt, paths in by_fmt.items():
            multi = len(paths) > 1
            for p in paths:
                rel, checksum, _ = copy_path_to_repo(
                    p,
                    modality=modality,
                    ontology=ontology,
                    fmt=fmt,
                    source_name=src_name,
                )
                # 同格式多文件时用文件名作为副本号，保证维度组合唯一
                copy_no = (
                    Path(p.name).stem
                    if multi
                    else str((replica or {}).get("copy_no") or "1")
                )
                file_dims = {
                    "engineering": engineering,
                    "data_type": {"fps": fps} if fps is not None else {},
                    "replica": {**(replica or {}), "copy_no": copy_no},
                }
                rf = _register_file(
                    db,
                    unit=unit,
                    file_dims=file_dims,
                    modality=modality,
                    ontology=ontology,
                    fmt=fmt,
                    source_name=src_name,
                    repo_path=rel,
                    original_name=p.name,
                    checksum=checksum,
                    fps=fps,
                    user=user,
                    meta=meta,
                )
                created.append(_file_out(rf, unit.action_id))

    write_audit(
        db,
        user_id=user.id,
        action="upload",
        entity_type="repo_zip",
        entity_id=unit.id,
        detail={"count": len(created), "source_name": src_name, "modality": modality},
    )
    db.commit()
    return created


def _delete_one_repo_file(db: Session, rf: RepoFile, user: User) -> str:
    path = absolute_repo_path(rf.repo_path)
    rel = rf.repo_path
    remove_catalog_entry(file_id=rf.id, path=rf.repo_path)
    write_audit(
        db,
        user_id=user.id,
        action="delete",
        entity_type="repo_file",
        entity_id=rf.id,
        detail={"path": str(rf.repo_path)},
    )
    db.delete(rf)
    if path.is_file():
        path.unlink(missing_ok=True)
    return rel


@router.delete("/files/{file_id}")
def delete_repo_file(
    file_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ensure_capability(db, user, Capability.edit, "/")
    rf = db.get(RepoFile, file_id)
    if not rf:
        raise HTTPException(status_code=404, detail="文件不存在")
    _delete_one_repo_file(db, rf, user)
    db.commit()
    return {"ok": True}


@router.post("/files/batch-delete")
def batch_delete_repo_files(
    body: BatchIdsIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ensure_capability(db, user, Capability.edit, "/")
    ids = list(dict.fromkeys(body.ids or []))
    if not ids:
        raise HTTPException(status_code=400, detail="未选择文件")
    if len(ids) > 500:
        raise HTTPException(status_code=400, detail="单次最多删除 500 个")
    rows = db.query(RepoFile).filter(RepoFile.id.in_(ids)).all()
    deleted = 0
    for rf in rows:
        _delete_one_repo_file(db, rf, user)
        deleted += 1
    db.commit()
    return {"ok": True, "count": deleted}
