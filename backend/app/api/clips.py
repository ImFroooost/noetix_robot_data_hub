from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, joinedload

from ..core.deps import get_current_user
from ..database import get_db
from ..models import (
    Capability,
    ClipTaxonomyTag,
    Folder,
    HumanMotionFile,
    MotionClip,
    RealVideo,
    RobotModel,
    RobotMotionFile,
    SharedTextFile,
    TaxonomyNode,
    User,
)
from ..models.enums import QualityLevel, RobotStage, TaxonomyScheme
from ..schemas import (
    REVIEW_VALUES,
    VIDEO_KINDS,
    ClipBatchIn,
    ClipCreate,
    ClipListItem,
    ClipOut,
    ClipReorderIn,
    ClipUpdate,
    HumanFileOut,
    HumanFileUpdate,
    RealVideoOut,
    RealVideoUpdate,
    RobotFileOut,
    RobotFileUpdate,
    SearchResult,
    SharedTextOut,
    SharedTextUpdate,
    SliceInfoOut,
    TaxonomyTagBrief,
)
from ..services.audit import write_audit
from ..services.permissions import (
    apply_browse_filter,
    ensure_capability,
    ensure_clip_capability,
    ensure_unclassified_folder,
    folder_path_of_clip,
    user_has_clip_capability,
)
from ..services.taxonomy_schemes import (
    clip_taxonomy_tag_map,
    get_scheme,
    set_clip_taxonomy_tags,
)

router = APIRouter(prefix="/clips", tags=["clips"])


def _robot_file_out(rf: RobotMotionFile, can_download: bool = False) -> RobotFileOut:
    data = RobotFileOut.model_validate(rf)
    if rf.robot_model:
        data.robot_model_name = rf.robot_model.name
    data.can_download = can_download
    return data


def _scheme_str(scheme) -> str:
    return scheme.value if hasattr(scheme, "value") else str(scheme)


def _tag_brief(node: TaxonomyNode | None) -> TaxonomyTagBrief | None:
    if not node:
        return None
    return TaxonomyTagBrief(
        id=node.id,
        scheme=_scheme_str(node.scheme),
        code=node.code or "",
        name=node.name,
        path=node.path,
    )


def _resolve_tag(db: Session, tag_id: int | None, scheme: str) -> int | None:
    if tag_id is None:
        return None
    scheme = _scheme_str(scheme)
    if get_scheme(db, scheme) is None:
        raise HTTPException(status_code=400, detail=f"未知分类标准: {scheme}")
    node = db.get(TaxonomyNode, tag_id)
    if not node:
        raise HTTPException(status_code=404, detail=f"{scheme} 标签不存在")
    if _scheme_str(node.scheme) != scheme:
        raise HTTPException(status_code=400, detail=f"标签不属于 {scheme} 分类体系")
    return node.id


def _taxonomy_tags_dict(db: Session, clip: MotionClip) -> dict[str, TaxonomyTagBrief]:
    mapping = clip_taxonomy_tag_map(db, clip.id)
    # fallback to legacy columns if join rows missing
    if not mapping:
        for scheme, node in (
            (TaxonomyScheme.atomic.value, clip.atomic_tag),
            (TaxonomyScheme.intent.value, clip.intent_tag),
            (TaxonomyScheme.style.value, clip.style_tag),
        ):
            if node:
                mapping[scheme] = node
    return {k: _tag_brief(v) for k, v in mapping.items() if v}  # type: ignore[misc]


def _apply_taxonomy_writes(
    db: Session,
    clip: MotionClip,
    *,
    atomic_tag_id=...,
    intent_tag_id=...,
    style_tag_id=...,
    taxonomy_tag_ids: dict[str, int | None] | None = None,
) -> None:
    updates: dict[str, int | None] = {}
    if taxonomy_tag_ids:
        for scheme, nid in taxonomy_tag_ids.items():
            updates[_scheme_str(scheme)] = (
                None if nid is None else _resolve_tag(db, nid, scheme)
            )
    if atomic_tag_id is not ...:
        updates[TaxonomyScheme.atomic.value] = _resolve_tag(
            db, atomic_tag_id, TaxonomyScheme.atomic.value
        )
    if intent_tag_id is not ...:
        updates[TaxonomyScheme.intent.value] = _resolve_tag(
            db, intent_tag_id, TaxonomyScheme.intent.value
        )
    if style_tag_id is not ...:
        updates[TaxonomyScheme.style.value] = _resolve_tag(
            db, style_tag_id, TaxonomyScheme.style.value
        )
    if updates:
        set_clip_taxonomy_tags(db, clip, updates)


def _clip_out(db: Session, clip: MotionClip, user: User) -> ClipOut:
    path = folder_path_of_clip(db, clip)
    can_dl = user_has_clip_capability(db, user, Capability.download, clip)
    can_edit = user_has_clip_capability(db, user, Capability.edit, clip)
    can_ann = user_has_clip_capability(db, user, Capability.annotate, clip)
    can_up = user_has_clip_capability(db, user, Capability.upload, clip)
    tax = _taxonomy_tags_dict(db, clip)
    return ClipOut(
        id=clip.id,
        folder_id=clip.folder_id,
        folder_path=path,
        atomic_tag_id=clip.atomic_tag_id,
        intent_tag_id=clip.intent_tag_id,
        style_tag_id=clip.style_tag_id,
        atomic_tag=tax.get(TaxonomyScheme.atomic.value) or _tag_brief(clip.atomic_tag),
        intent_tag=tax.get(TaxonomyScheme.intent.value) or _tag_brief(clip.intent_tag),
        style_tag=tax.get(TaxonomyScheme.style.value) or _tag_brief(clip.style_tag),
        taxonomy_tags=tax,
        category=clip.category,
        subcategory=clip.subcategory,
        summary=clip.summary,
        description=clip.description,
        action_code=getattr(clip, "action_code", "") or "",
        action_name=getattr(clip, "action_name", "") or "",
        brief=getattr(clip, "brief", "") or "",
        detail_def=getattr(clip, "detail_def", "") or "",
        action_version=getattr(clip, "action_version", "") or "",
        routine_label=getattr(clip, "routine_label", "") or "",
        duel_label=getattr(clip, "duel_label", "") or "",
        compute_level=getattr(clip, "compute_level", "") or "",
        multimodal_overall=getattr(clip, "multimodal_overall", "") or "",
        multimodal_segment=getattr(clip, "multimodal_segment", "") or "",
        multimodal_atomic=getattr(clip, "multimodal_atomic", "") or "",
        tags=clip.tags or [],
        duration_sec=clip.duration_sec,
        sort_order=getattr(clip, "sort_order", 0) or 0,
        thumbnail_path=clip.thumbnail_path,
        created_by=clip.created_by,
        updated_by=clip.updated_by,
        created_at=clip.created_at,
        updated_at=clip.updated_at,
        human_files=[
            HumanFileOut.model_validate(h).model_copy(update={"can_download": can_dl})
            for h in clip.human_files
        ],
        robot_files=[_robot_file_out(r, can_dl) for r in clip.robot_files],
        real_videos=[
            RealVideoOut.model_validate(v).model_copy(update={"can_download": can_dl})
            for v in (clip.real_videos or [])
        ],
        shared_texts=[
            SharedTextOut.model_validate(t).model_copy(update={"can_download": can_dl})
            for t in (clip.shared_texts or [])
        ],
        slice_info=SliceInfoOut(
            has_file=bool(clip.slice_json_path),
            original_name=clip.slice_json_name,
            checksum=clip.slice_json_checksum,
            can_download=can_dl and bool(clip.slice_json_path),
        ),
        can_download=can_dl,
        can_edit=can_edit,
        can_annotate=can_ann,
        can_upload=can_up,
    )


def _load_clip(db: Session, clip_id: int) -> MotionClip | None:
    return (
        db.query(MotionClip)
        .options(
            joinedload(MotionClip.human_files),
            joinedload(MotionClip.robot_files).joinedload(RobotMotionFile.robot_model),
            joinedload(MotionClip.real_videos),
            joinedload(MotionClip.shared_texts),
            joinedload(MotionClip.folder),
            joinedload(MotionClip.atomic_tag),
            joinedload(MotionClip.intent_tag),
            joinedload(MotionClip.style_tag),
            joinedload(MotionClip.taxonomy_tag_rows).joinedload(ClipTaxonomyTag.node),
        )
        .filter(MotionClip.id == clip_id)
        .first()
    )


@router.post("", response_model=ClipOut)
def create_clip(
    body: ClipCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    folder = None
    if body.folder_id is not None:
        folder = db.get(Folder, body.folder_id)
        if not folder:
            raise HTTPException(status_code=404, detail="文件夹不存在")
        path = folder.path
    else:
        folder = ensure_unclassified_folder(db)
        path = folder.path
    ensure_capability(db, user, Capability.upload, path)

    max_order = (
        db.query(func.coalesce(func.max(MotionClip.sort_order), -1))
        .filter(MotionClip.folder_id == folder.id)
        .scalar()
    )
    clip = MotionClip(
        folder_id=folder.id,
        category=body.category or (folder.name if folder else ""),
        subcategory=body.subcategory,
        summary=body.summary,
        description=body.description,
        action_code=body.action_code or "",
        action_name=body.action_name or "",
        brief=body.brief or "",
        detail_def=body.detail_def or "",
        action_version=body.action_version or "",
        routine_label=body.routine_label or "",
        duel_label=body.duel_label or "",
        compute_level=body.compute_level or "",
        multimodal_overall=body.multimodal_overall or "",
        multimodal_segment=body.multimodal_segment or "",
        multimodal_atomic=body.multimodal_atomic or "",
        tags=body.tags,
        duration_sec=body.duration_sec,
        sort_order=int(max_order or -1) + 1,
        created_by=user.id,
        updated_by=user.id,
    )
    db.add(clip)
    db.flush()
    create_tags = dict(body.taxonomy_tag_ids or {})
    if body.atomic_tag_id is not None:
        create_tags[TaxonomyScheme.atomic.value] = body.atomic_tag_id
    if body.intent_tag_id is not None:
        create_tags[TaxonomyScheme.intent.value] = body.intent_tag_id
    if body.style_tag_id is not None:
        create_tags[TaxonomyScheme.style.value] = body.style_tag_id
    if create_tags:
        _apply_taxonomy_writes(db, clip, taxonomy_tag_ids=create_tags)
    write_audit(
        db,
        user_id=user.id,
        action="create",
        entity_type="clip",
        entity_id=clip.id,
        detail=body.model_dump(),
    )
    db.commit()
    clip = _load_clip(db, clip.id)
    return _clip_out(db, clip, user)


@router.get("/search", response_model=SearchResult)
def search_clips(
    q: str | None = Query(None, description="关键词，匹配大类/子类/概括/详述/标签"),
    folder_id: int | None = None,
    folder_path: str | None = None,
    taxonomy_scheme: str | None = None,
    taxonomy_path: str | None = None,
    tag_id: int | None = None,
    tag_exact: bool = Query(
        False,
        description="为 true 时只匹配该标签本身，不包含子孙分类（用于分类树叶子展示）",
    ),
    category: str | None = None,
    subcategory: str | None = None,
    human_format: str | None = None,
    human_quality: QualityLevel | None = None,
    robot_model: str | None = None,
    robot_stage: RobotStage | None = None,
    robot_quality: QualityLevel | None = None,
    has_real: bool | None = Query(None, description="是否有真机数据"),
    min_duration: float | None = None,
    max_duration: float | None = None,
    min_fps: float | None = None,
    max_fps: float | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    sort_by: str = Query(
        "created_at",
        description="排序字段: created_at|summary|duration_sec|sort_order|id|folder_path",
    ),
    sort_dir: str = Query("desc", description="asc 或 desc"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    from ..services.permissions import normalize_path

    query = db.query(MotionClip)
    query = apply_browse_filter(query, db, user)

    if folder_id is not None:
        query = query.filter(MotionClip.folder_id == folder_id)
    if folder_path:
        pref = normalize_path(folder_path)
        query = query.outerjoin(Folder, MotionClip.folder_id == Folder.id).filter(
            Folder.path.like(f"{pref}%")
        )

    # taxonomy filter via clip_taxonomy_tags (+ legacy columns for builtin)
    tax_node: TaxonomyNode | None = None
    scheme_key = _scheme_str(taxonomy_scheme) if taxonomy_scheme else None
    if tag_id is not None:
        tax_node = db.get(TaxonomyNode, tag_id)
        if not tax_node:
            raise HTTPException(status_code=404, detail="分类标签不存在")
        scheme_key = _scheme_str(tax_node.scheme)
    elif scheme_key is not None and taxonomy_path:
        pref = normalize_path(taxonomy_path)
        tax_node = (
            db.query(TaxonomyNode)
            .filter(TaxonomyNode.scheme == scheme_key, TaxonomyNode.path == pref)
            .first()
        )

    def _filter_by_tag_ids(q, scheme: str, tag_ids: list[int]):
        if not tag_ids:
            return q.filter(False)
        tagged = (
            db.query(ClipTaxonomyTag.clip_id)
            .filter(
                ClipTaxonomyTag.scheme == scheme,
                ClipTaxonomyTag.node_id.in_(tag_ids),
            )
        )
        legacy_col = {
            TaxonomyScheme.atomic.value: MotionClip.atomic_tag_id,
            TaxonomyScheme.intent.value: MotionClip.intent_tag_id,
            TaxonomyScheme.style.value: MotionClip.style_tag_id,
        }.get(scheme)
        if legacy_col is not None:
            return q.filter(or_(MotionClip.id.in_(tagged), legacy_col.in_(tag_ids)))
        return q.filter(MotionClip.id.in_(tagged))

    if tax_node is not None:
        if tag_exact:
            tag_ids = [tax_node.id]
        else:
            pref = tax_node.path
            tag_ids = [
                r[0]
                for r in db.query(TaxonomyNode.id)
                .filter(
                    TaxonomyNode.scheme == _scheme_str(tax_node.scheme),
                    TaxonomyNode.path.like(f"{pref}%"),
                )
                .all()
            ]
        query = _filter_by_tag_ids(query, _scheme_str(tax_node.scheme), tag_ids)
    elif scheme_key is not None and taxonomy_path:
        if tag_exact:
            pref = normalize_path(taxonomy_path)
            node_exact = (
                db.query(TaxonomyNode)
                .filter(TaxonomyNode.scheme == scheme_key, TaxonomyNode.path == pref)
                .first()
            )
            tag_ids = [node_exact.id] if node_exact else []
        else:
            pref = normalize_path(taxonomy_path)
            tag_ids = [
                r[0]
                for r in db.query(TaxonomyNode.id)
                .filter(
                    TaxonomyNode.scheme == scheme_key,
                    TaxonomyNode.path.like(f"{pref}%"),
                )
                .all()
            ]
        query = _filter_by_tag_ids(query, scheme_key, tag_ids)

    if q:
        like = f"%{q}%"
        tag_match = MotionClip.tags.any(q)
        query = query.filter(
            or_(
                MotionClip.category.ilike(like),
                MotionClip.subcategory.ilike(like),
                MotionClip.summary.ilike(like),
                MotionClip.description.ilike(like),
                tag_match,
            )
        )
    if category:
        query = query.filter(MotionClip.category == category)
    if subcategory:
        query = query.filter(MotionClip.subcategory == subcategory)
    if min_duration is not None:
        query = query.filter(MotionClip.duration_sec >= min_duration)
    if max_duration is not None:
        query = query.filter(MotionClip.duration_sec <= max_duration)

    if human_format or human_quality or min_fps is not None or max_fps is not None:
        query = query.join(HumanMotionFile)
        if human_format:
            query = query.filter(HumanMotionFile.format == human_format.lower())
        if human_quality:
            query = query.filter(HumanMotionFile.quality == human_quality)
        if min_fps is not None:
            query = query.filter(HumanMotionFile.fps >= min_fps)
        if max_fps is not None:
            query = query.filter(HumanMotionFile.fps <= max_fps)

    need_robot_join = any(
        x is not None for x in (robot_model, robot_stage, robot_quality, has_real)
    )
    if need_robot_join:
        query = query.join(RobotMotionFile)
        if robot_model:
            query = query.join(RobotModel).filter(RobotModel.name == robot_model)
        if robot_stage:
            query = query.filter(RobotMotionFile.stage == robot_stage)
        if robot_quality:
            query = query.filter(RobotMotionFile.quality == robot_quality)
        if has_real is True:
            query = query.filter(RobotMotionFile.stage == RobotStage.real)
        elif has_real is False:
            real_exists = (
                db.query(RobotMotionFile.id)
                .filter(
                    RobotMotionFile.clip_id == MotionClip.id,
                    RobotMotionFile.stage == RobotStage.real,
                )
                .exists()
            )
            query = query.filter(~real_exists)

    id_query = query.with_entities(MotionClip.id).distinct()
    total = db.query(func.count()).select_from(id_query.subquery()).scalar() or 0

    direction = (sort_dir or "desc").lower()
    if direction not in ("asc", "desc"):
        direction = "desc"
    sort_key = (sort_by or "created_at").lower()

    # rebuild ordered query for stable distinct+order
    order_query = query
    if sort_key == "folder_path":
        order_query = order_query.outerjoin(Folder, MotionClip.folder_id == Folder.id)
        order_col = func.coalesce(Folder.path, "/未分类/")
    elif sort_key == "summary":
        order_col = MotionClip.summary
    elif sort_key == "duration_sec":
        order_col = MotionClip.duration_sec
    elif sort_key == "sort_order":
        order_col = MotionClip.sort_order
    elif sort_key == "id":
        order_col = MotionClip.id
    else:
        order_col = MotionClip.created_at

    ordered = order_col.asc() if direction == "asc" else order_col.desc()
    id_rows = (
        order_query.with_entities(MotionClip.id, order_col)
        .distinct()
        .order_by(ordered, MotionClip.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    ids = [r[0] for r in id_rows]
    clips = []
    if ids:
        loaded = (
            db.query(MotionClip)
            .options(
                joinedload(MotionClip.human_files),
                joinedload(MotionClip.robot_files).joinedload(RobotMotionFile.robot_model),
                joinedload(MotionClip.real_videos),
                joinedload(MotionClip.shared_texts),
                joinedload(MotionClip.folder),
                joinedload(MotionClip.atomic_tag),
                joinedload(MotionClip.intent_tag),
                joinedload(MotionClip.style_tag),
            )
            .filter(MotionClip.id.in_(ids))
            .all()
        )
        order = {i: n for n, i in enumerate(ids)}
        clips = sorted(loaded, key=lambda c: order[c.id])

    items = []
    for c in clips:
        tax = _taxonomy_tags_dict(db, c)
        items.append(
            ClipListItem(
                id=c.id,
                folder_id=c.folder_id,
                folder_path=folder_path_of_clip(db, c),
                atomic_tag_id=c.atomic_tag_id,
                intent_tag_id=c.intent_tag_id,
                style_tag_id=c.style_tag_id,
                atomic_tag=tax.get(TaxonomyScheme.atomic.value) or _tag_brief(c.atomic_tag),
                intent_tag=tax.get(TaxonomyScheme.intent.value) or _tag_brief(c.intent_tag),
                style_tag=tax.get(TaxonomyScheme.style.value) or _tag_brief(c.style_tag),
                taxonomy_tags=tax,
                category=c.category,
                subcategory=c.subcategory,
                summary=c.summary,
                description=c.description,
                action_code=getattr(c, "action_code", "") or "",
                action_name=getattr(c, "action_name", "") or "",
                action_version=getattr(c, "action_version", "") or "",
                tags=c.tags or [],
                duration_sec=c.duration_sec,
                sort_order=getattr(c, "sort_order", 0) or 0,
                thumbnail_path=c.thumbnail_path,
                created_at=c.created_at,
                human_formats=[h.format for h in c.human_files],
                robot_stages=[r.stage.value for r in c.robot_files],
                robot_models=list(
                    {r.robot_model.name for r in c.robot_files if r.robot_model}
                ),
                shared_formats=[t.format for t in (c.shared_texts or [])],
                video_kinds=list({v.kind for v in (c.real_videos or [])}),
                has_slice=bool(c.slice_json_path),
                has_video=bool(c.real_videos),
            )
        )
    return SearchResult(total=total, page=page, page_size=page_size, items=items)


@router.put("/reorder", response_model=dict)
def reorder_clips(
    body: ClipReorderIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    folder = db.get(Folder, body.folder_id)
    if not folder:
        raise HTTPException(status_code=404, detail="文件夹不存在")
    ensure_capability(db, user, Capability.edit, folder.path)

    clips = (
        db.query(MotionClip).filter(MotionClip.folder_id == body.folder_id).all()
    )
    clip_ids = {c.id for c in clips}
    if not body.ordered_ids:
        raise HTTPException(status_code=400, detail="排序列表不能为空")
    if set(body.ordered_ids) - clip_ids:
        raise HTTPException(status_code=400, detail="排序列表包含不属于该文件夹的条目")
    # allow partial reorder: listed ids first, others keep relative order after
    remaining = [c.id for c in sorted(clips, key=lambda x: (x.sort_order, x.id)) if c.id not in set(body.ordered_ids)]
    final_ids = list(body.ordered_ids) + remaining
    for idx, cid in enumerate(final_ids):
        clip = db.get(MotionClip, cid)
        if clip:
            clip.sort_order = idx
    write_audit(
        db,
        user_id=user.id,
        action="reorder",
        entity_type="clip",
        entity_id=body.folder_id,
        detail={"ordered_ids": body.ordered_ids},
    )
    db.commit()
    return {"ok": True, "count": len(final_ids)}


@router.post("/batch", response_model=dict)
def batch_clips(
    body: ClipBatchIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """批量移动或删除动作条目。"""
    action = (body.action or "").strip().lower()
    if action not in ("move", "delete"):
        raise HTTPException(status_code=400, detail="action 须为 move 或 delete")
    ids = list(dict.fromkeys(body.clip_ids or []))
    if not ids:
        raise HTTPException(status_code=400, detail="clip_ids 不能为空")
    if len(ids) > 500:
        raise HTTPException(status_code=400, detail="单次最多 500 条")

    target: Folder | None = None
    if action == "move":
        if body.folder_id is None:
            raise HTTPException(status_code=400, detail="move 需要 folder_id")
        target = db.get(Folder, body.folder_id)
        if not target:
            raise HTTPException(status_code=404, detail="目标文件夹不存在")
        ensure_capability(db, user, Capability.edit, target.path)

    clips = db.query(MotionClip).filter(MotionClip.id.in_(ids)).all()
    found = {c.id: c for c in clips}
    missing = [i for i in ids if i not in found]
    if missing:
        raise HTTPException(status_code=404, detail=f"条目不存在: {missing[:10]}")

    ok_ids: list[int] = []
    for cid in ids:
        clip = found[cid]
        ensure_clip_capability(db, user, Capability.edit, clip)
        if action == "move":
            assert target is not None
            clip.folder_id = target.id
            clip.updated_by = user.id
        else:
            db.delete(clip)
        ok_ids.append(cid)

    write_audit(
        db,
        user_id=user.id,
        action=f"batch_{action}",
        entity_type="clip",
        entity_id=target.id if target else 0,
        detail={"clip_ids": ok_ids, "folder_id": body.folder_id, "count": len(ok_ids)},
    )
    db.commit()
    return {"ok": True, "action": action, "count": len(ok_ids), "clip_ids": ok_ids}


@router.get("/facets")
def facets(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    query = apply_browse_filter(db.query(MotionClip), db, user)
    clip_ids = [r[0] for r in query.with_entities(MotionClip.id).distinct().all()]
    categories = [
        r[0]
        for r in db.query(MotionClip.category)
        .filter(MotionClip.id.in_(clip_ids) if clip_ids else False)
        .distinct()
        .all()
        if r[0]
    ] if clip_ids else []
    subcategories = [
        r[0]
        for r in db.query(MotionClip.subcategory)
        .filter(MotionClip.id.in_(clip_ids) if clip_ids else False)
        .distinct()
        .all()
        if r[0]
    ] if clip_ids else []
    human_formats = [
        r[0]
        for r in db.query(HumanMotionFile.format)
        .filter(HumanMotionFile.clip_id.in_(clip_ids) if clip_ids else False)
        .distinct()
        .all()
        if r[0]
    ] if clip_ids else []
    robot_names = [r[0] for r in db.query(RobotModel.name).order_by(RobotModel.name).all()]
    return {
        "categories": sorted(categories),
        "subcategories": sorted(subcategories),
        "human_formats": sorted(human_formats),
        "robot_models": robot_names,
        "qualities": [q.value for q in QualityLevel],
        "stages": [s.value for s in RobotStage],
        "quality_labels": {"high": "好", "medium": "中", "low": "差"},
    }


@router.get("/{clip_id}", response_model=ClipOut)
def get_clip(
    clip_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    clip = _load_clip(db, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="条目不存在")
    ensure_clip_capability(db, user, Capability.browse, clip)
    return _clip_out(db, clip, user)


@router.patch("/{clip_id}", response_model=ClipOut)
def update_clip(
    clip_id: int,
    body: ClipUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    clip = _load_clip(db, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="条目不存在")

    data = body.model_dump(exclude_unset=True)
    annotate_fields = {
        "summary",
        "description",
        "action_code",
        "action_name",
        "brief",
        "detail_def",
        "action_version",
        "routine_label",
        "duel_label",
        "compute_level",
        "multimodal_overall",
        "multimodal_segment",
        "multimodal_atomic",
    }
    edit_fields = {
        "folder_id",
        "category",
        "subcategory",
        "tags",
        "duration_sec",
        "sort_order",
        "atomic_tag_id",
        "intent_tag_id",
        "style_tag_id",
        "taxonomy_tag_ids",
    }

    if annotate_fields & data.keys():
        ensure_clip_capability(db, user, Capability.annotate, clip)
    if edit_fields & data.keys():
        ensure_clip_capability(db, user, Capability.edit, clip)
    if not data:
        raise HTTPException(status_code=400, detail="无更新字段")

    tax_payload = data.pop("taxonomy_tag_ids", None)
    atomic = data.pop("atomic_tag_id", ...) if "atomic_tag_id" in data else ...
    intent = data.pop("intent_tag_id", ...) if "intent_tag_id" in data else ...
    style = data.pop("style_tag_id", ...) if "style_tag_id" in data else ...

    if "folder_id" in data and data["folder_id"] is not None:
        folder = db.get(Folder, data["folder_id"])
        if not folder:
            raise HTTPException(status_code=404, detail="文件夹不存在")
        ensure_capability(db, user, Capability.edit, folder.path)

    for k, v in data.items():
        setattr(clip, k, v)
    _apply_taxonomy_writes(
        db,
        clip,
        atomic_tag_id=atomic,
        intent_tag_id=intent,
        style_tag_id=style,
        taxonomy_tag_ids=tax_payload,
    )
    clip.updated_by = user.id
    write_audit(
        db,
        user_id=user.id,
        action="update",
        entity_type="clip",
        entity_id=clip.id,
        detail=body.model_dump(exclude_unset=True),
    )
    db.commit()
    clip = _load_clip(db, clip_id)
    return _clip_out(db, clip, user)


@router.delete("/{clip_id}")
def delete_clip(
    clip_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    clip = db.get(MotionClip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="条目不存在")
    ensure_clip_capability(db, user, Capability.edit, clip)
    write_audit(
        db,
        user_id=user.id,
        action="delete",
        entity_type="clip",
        entity_id=clip_id,
        detail={"summary": clip.summary},
    )
    db.delete(clip)
    db.commit()
    return {"ok": True}


ANNOTATE_FILE_FIELDS = {"quality", "review", "kind"}


def _validate_review(data: dict) -> None:
    if "review" in data:
        val = (data["review"] or "").strip()
        if val not in REVIEW_VALUES:
            raise HTTPException(
                status_code=400,
                detail="review 须为 pass / needs_fix / discard 或空",
            )
        data["review"] = val


@router.patch("/human-files/{file_id}", response_model=HumanFileOut)
def update_human_file(
    file_id: int,
    body: HumanFileUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    hf = db.get(HumanMotionFile, file_id)
    if not hf:
        raise HTTPException(status_code=404, detail="文件不存在")
    clip = db.get(MotionClip, hf.clip_id)
    data = body.model_dump(exclude_unset=True)
    _validate_review(data)
    if ANNOTATE_FILE_FIELDS & data.keys():
        ensure_clip_capability(db, user, Capability.annotate, clip)
    other = set(data) - ANNOTATE_FILE_FIELDS
    if other:
        ensure_clip_capability(db, user, Capability.edit, clip)
    for k, v in data.items():
        setattr(hf, k, v)
    write_audit(
        db,
        user_id=user.id,
        action="update",
        entity_type="human_file",
        entity_id=file_id,
        detail=data,
    )
    db.commit()
    db.refresh(hf)
    out = HumanFileOut.model_validate(hf)
    out.can_download = user_has_clip_capability(db, user, Capability.download, clip)
    return out


@router.patch("/robot-files/{file_id}", response_model=RobotFileOut)
def update_robot_file(
    file_id: int,
    body: RobotFileUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rf = (
        db.query(RobotMotionFile)
        .options(joinedload(RobotMotionFile.robot_model))
        .filter(RobotMotionFile.id == file_id)
        .first()
    )
    if not rf:
        raise HTTPException(status_code=404, detail="文件不存在")
    clip = db.get(MotionClip, rf.clip_id)
    data = body.model_dump(exclude_unset=True)
    _validate_review(data)
    if ANNOTATE_FILE_FIELDS & data.keys():
        ensure_clip_capability(db, user, Capability.annotate, clip)
    other = set(data) - ANNOTATE_FILE_FIELDS
    if other:
        ensure_clip_capability(db, user, Capability.edit, clip)
    for k, v in data.items():
        setattr(rf, k, v)
    write_audit(
        db,
        user_id=user.id,
        action="update",
        entity_type="robot_file",
        entity_id=file_id,
        detail=data,
    )
    db.commit()
    db.refresh(rf)
    return _robot_file_out(
        rf, user_has_clip_capability(db, user, Capability.download, clip)
    )


@router.patch("/real-videos/{video_id}", response_model=RealVideoOut)
def update_real_video(
    video_id: int,
    body: RealVideoUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rv = db.get(RealVideo, video_id)
    if not rv:
        raise HTTPException(status_code=404, detail="视频不存在")
    clip = db.get(MotionClip, rv.clip_id)
    data = body.model_dump(exclude_unset=True)
    _validate_review(data)
    if "kind" in data:
        kind = (data["kind"] or "").strip().lower()
        if kind not in VIDEO_KINDS:
            raise HTTPException(
                status_code=400, detail=f"kind 须为 {'/'.join(sorted(VIDEO_KINDS))}"
            )
        data["kind"] = kind
    if ANNOTATE_FILE_FIELDS & data.keys():
        ensure_clip_capability(db, user, Capability.annotate, clip)
    other = set(data) - ANNOTATE_FILE_FIELDS
    if other:
        ensure_clip_capability(db, user, Capability.edit, clip)
    for k, v in data.items():
        setattr(rv, k, v)
    write_audit(
        db,
        user_id=user.id,
        action="update",
        entity_type="real_video",
        entity_id=video_id,
        detail=data,
    )
    db.commit()
    db.refresh(rv)
    out = RealVideoOut.model_validate(rv)
    out.can_download = user_has_clip_capability(db, user, Capability.download, clip)
    return out


@router.patch("/shared-texts/{text_id}", response_model=SharedTextOut)
def update_shared_text(
    text_id: int,
    body: SharedTextUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    st = db.get(SharedTextFile, text_id)
    if not st:
        raise HTTPException(status_code=404, detail="文本文件不存在")
    clip = db.get(MotionClip, st.clip_id)
    data = body.model_dump(exclude_unset=True)
    _validate_review(data)
    if ANNOTATE_FILE_FIELDS & data.keys():
        ensure_clip_capability(db, user, Capability.annotate, clip)
    other = set(data) - ANNOTATE_FILE_FIELDS
    if other:
        ensure_clip_capability(db, user, Capability.edit, clip)
    for k, v in data.items():
        setattr(st, k, v)
    write_audit(
        db,
        user_id=user.id,
        action="update",
        entity_type="shared_text",
        entity_id=text_id,
        detail=data,
    )
    db.commit()
    db.refresh(st)
    out = SharedTextOut.model_validate(st)
    out.can_download = user_has_clip_capability(db, user, Capability.download, clip)
    return out
