from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..core.deps import get_current_user
from ..database import get_db
from ..models import Folder, MotionClip, User, UserPermission
from ..models.enums import Capability
from ..schemas import FolderCreate, FolderEnsureIn, FolderOut, FolderReorderIn, FolderUpdate
from ..services.audit import write_audit
from ..services.permissions import (
    TRASH_FOLDER_PATH,
    ensure_trash_folder,
    folder_visible,
    get_or_create_folder_by_path,
    is_admin,
    is_protected_system_folder,
    is_trash_path,
    join_folder_path,
    normalize_path,
    user_has_capability,
)

router = APIRouter(prefix="/folders", tags=["folders"])


def _folder_out(db: Session, folder: Folder) -> FolderOut:
    clip_count = (
        db.query(func.count(MotionClip.id))
        .filter(MotionClip.folder_id == folder.id)
        .scalar()
        or 0
    )
    child_count = (
        db.query(func.count(Folder.id)).filter(Folder.parent_id == folder.id).scalar() or 0
    )
    return FolderOut(
        id=folder.id,
        parent_id=folder.parent_id,
        name=folder.name,
        path=folder.path,
        sort_order=getattr(folder, "sort_order", 0) or 0,
        created_at=folder.created_at,
        clip_count=clip_count,
        child_count=child_count,
    )


def _require_folder_edit(db: Session, user: User, path: str) -> None:
    if is_admin(user):
        return
    if not user_has_capability(db, user, Capability.edit, path):
        raise HTTPException(status_code=403, detail="缺少编辑权限，无法管理文件夹")


def _next_sort_order(db: Session, parent_id: int | None) -> int:
    q = db.query(func.coalesce(func.max(Folder.sort_order), -1))
    if parent_id is None:
        q = q.filter(Folder.parent_id.is_(None))
    else:
        q = q.filter(Folder.parent_id == parent_id)
    return int(q.scalar() or -1) + 1


def _subtree_folder_ids(db: Session, folder: Folder) -> list[int]:
    rows = (
        db.query(Folder.id)
        .filter(Folder.path.like(f"{normalize_path(folder.path)}%"))
        .all()
    )
    return [r[0] for r in rows]


def _subtree_stats(db: Session, folder: Folder) -> dict:
    ids = _subtree_folder_ids(db, folder)
    child_folders = max(0, len(ids) - 1)
    clips = 0
    if ids:
        clips = (
            db.query(func.count(MotionClip.id))
            .filter(MotionClip.folder_id.in_(ids))
            .scalar()
            or 0
        )
    return {"folder_count": child_folders, "clip_count": clips}


def _unique_name_under(db: Session, parent: Folder | None, base_name: str) -> str:
    parent_path = parent.path if parent else None
    name = base_name.strip()
    n = 2
    while True:
        path = join_folder_path(parent_path, name)
        if not db.query(Folder).filter(Folder.path == path).first():
            return name
        name = f"{base_name}_{n}"
        n += 1


def _relocate_folder(
    db: Session,
    folder: Folder,
    new_parent: Folder | None,
    new_name: str,
) -> tuple[str, str]:
    """Move/rename folder subtree. Returns (old_path, new_path)."""
    new_parent_id = new_parent.id if new_parent else None
    parent_path = new_parent.path if new_parent else None
    if new_parent is not None:
        if new_parent.id == folder.id:
            raise HTTPException(status_code=400, detail="不能将文件夹移动到自身下")
        if normalize_path(new_parent.path).startswith(normalize_path(folder.path)):
            raise HTTPException(status_code=400, detail="不能将文件夹移动到其子路径下")

    new_path = join_folder_path(parent_path, new_name)
    old_path = folder.path
    if new_path != old_path:
        clash = db.query(Folder).filter(Folder.path == new_path, Folder.id != folder.id).first()
        if clash:
            raise HTTPException(status_code=400, detail="目标路径已存在同名文件夹")

    parent_changed = new_parent_id != folder.parent_id
    descendants = (
        db.query(Folder)
        .filter(Folder.path.like(f"{old_path}%"))
        .order_by(Folder.path.desc())
        .all()
    )
    for d in descendants:
        suffix = d.path[len(old_path) :]
        d.path = new_path + suffix
        if d.id == folder.id:
            d.name = new_name
            d.parent_id = new_parent_id
            if parent_changed:
                d.sort_order = _next_sort_order(db, new_parent_id)

    if new_path != old_path:
        perms = (
            db.query(UserPermission)
            .filter(UserPermission.path_prefix.like(f"{old_path}%"))
            .all()
        )
        for p in perms:
            p.path_prefix = new_path + p.path_prefix[len(old_path) :]

    return old_path, new_path


def _purge_folder_subtree(db: Session, folder: Folder) -> dict:
    """Permanently delete folder, descendants, and clips inside."""
    ids = _subtree_folder_ids(db, folder)
    stats = _subtree_stats(db, folder)
    if ids:
        clips = db.query(MotionClip).filter(MotionClip.folder_id.in_(ids)).all()
        for c in clips:
            db.delete(c)
        db.flush()
        nodes = (
            db.query(Folder)
            .filter(Folder.id.in_(ids))
            .order_by(Folder.path.desc())
            .all()
        )
        for n in nodes:
            db.delete(n)
        db.flush()
    return stats


@router.get("", response_model=list[FolderOut])
def list_folders(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    ensure_trash_folder(db)
    db.commit()
    folders = (
        db.query(Folder)
        .order_by(Folder.sort_order.asc(), Folder.name.asc(), Folder.id.asc())
        .all()
    )
    return [_folder_out(db, f) for f in folders if folder_visible(db, user, f)]


@router.post("", response_model=FolderOut)
def create_folder(
    body: FolderCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    parent = None
    parent_path = None
    if body.parent_id is not None:
        parent = db.get(Folder, body.parent_id)
        if not parent:
            raise HTTPException(status_code=404, detail="父文件夹不存在")
        parent_path = parent.path
    try:
        path = join_folder_path(parent_path, body.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    if normalize_path(path) == TRASH_FOLDER_PATH:
        raise HTTPException(status_code=400, detail="「回收站」为系统文件夹，请勿手动创建")

    _require_folder_edit(db, user, parent_path or "/")

    if db.query(Folder).filter(Folder.path == path).first():
        raise HTTPException(status_code=400, detail="同名文件夹已存在")

    folder = Folder(
        parent_id=parent.id if parent else None,
        name=body.name.strip(),
        path=path,
        sort_order=_next_sort_order(db, parent.id if parent else None),
    )
    db.add(folder)
    db.flush()
    write_audit(
        db,
        user_id=user.id,
        action="create",
        entity_type="folder",
        entity_id=folder.id,
        detail={"path": path},
    )
    db.commit()
    db.refresh(folder)
    return _folder_out(db, folder)


@router.post("/ensure", response_model=FolderOut)
def ensure_folder(
    body: FolderEnsureIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Create folder by name under parent if missing; otherwise return existing."""
    name = body.name.strip().strip("/")
    if not name or "/" in name or name in (".", ".."):
        raise HTTPException(status_code=400, detail="文件夹名无效")
    parent = None
    parent_path = None
    if body.parent_id is not None:
        parent = db.get(Folder, body.parent_id)
        if not parent:
            raise HTTPException(status_code=404, detail="父文件夹不存在")
        parent_path = parent.path
    try:
        path = join_folder_path(parent_path, name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if normalize_path(path) == TRASH_FOLDER_PATH:
        raise HTTPException(status_code=400, detail="不能使用回收站路径")
    _require_folder_edit(db, user, parent_path or "/")
    existing = db.query(Folder).filter(Folder.path == path).first()
    if existing:
        return _folder_out(db, existing)
    folder = get_or_create_folder_by_path(db, path)
    folder.sort_order = _next_sort_order(db, parent.id if parent else None)
    write_audit(
        db,
        user_id=user.id,
        action="ensure",
        entity_type="folder",
        entity_id=folder.id,
        detail={"path": path},
    )
    db.commit()
    db.refresh(folder)
    return _folder_out(db, folder)


@router.put("/reorder", response_model=list[FolderOut])
def reorder_folders(
    body: FolderReorderIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    parent_path = "/"
    if body.parent_id is not None:
        parent = db.get(Folder, body.parent_id)
        if not parent:
            raise HTTPException(status_code=404, detail="父文件夹不存在")
        parent_path = parent.path
    _require_folder_edit(db, user, parent_path)

    q = db.query(Folder)
    if body.parent_id is None:
        q = q.filter(Folder.parent_id.is_(None))
    else:
        q = q.filter(Folder.parent_id == body.parent_id)
    siblings = q.all()
    sibling_ids = {f.id for f in siblings}
    if set(body.ordered_ids) - sibling_ids:
        raise HTTPException(status_code=400, detail="排序列表包含非同级文件夹")
    remaining = [
        f.id
        for f in sorted(siblings, key=lambda x: (x.sort_order, x.id))
        if f.id not in set(body.ordered_ids)
    ]
    final_ids = list(body.ordered_ids) + remaining
    for idx, fid in enumerate(final_ids):
        f = db.get(Folder, fid)
        if f:
            f.sort_order = idx
    write_audit(
        db,
        user_id=user.id,
        action="reorder",
        entity_type="folder",
        entity_id=body.parent_id,
        detail={"ordered_ids": body.ordered_ids},
    )
    db.commit()
    folders = (
        db.query(Folder)
        .order_by(Folder.sort_order.asc(), Folder.name.asc(), Folder.id.asc())
        .all()
    )
    return [_folder_out(db, f) for f in folders if folder_visible(db, user, f)]


@router.delete("/trash")
def empty_trash(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """清空回收站：彻底删除其中全部文件夹与条目。"""
    trash = ensure_trash_folder(db)
    _require_folder_edit(db, user, trash.path)

    children = (
        db.query(Folder)
        .filter(Folder.parent_id == trash.id)
        .order_by(Folder.path.desc())
        .all()
    )
    folder_count = 0
    clip_count = 0
    for child in list(children):
        stats = _subtree_stats(db, child)
        folder_count += 1 + int(stats["folder_count"])
        clip_count += int(stats["clip_count"])
        _purge_folder_subtree(db, child)

    # clips placed directly under 回收站
    direct_clips = db.query(MotionClip).filter(MotionClip.folder_id == trash.id).all()
    for c in direct_clips:
        db.delete(c)
        clip_count += 1

    write_audit(
        db,
        user_id=user.id,
        action="empty_trash",
        entity_type="folder",
        entity_id=trash.id,
        detail={"folder_count": folder_count, "clip_count": clip_count},
    )
    db.commit()
    return {"ok": True, "action": "emptied", "folder_count": folder_count, "clip_count": clip_count}


@router.patch("/{folder_id}", response_model=FolderOut)
def update_folder(
    folder_id: int,
    body: FolderUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    folder = db.get(Folder, folder_id)
    if not folder:
        raise HTTPException(status_code=404, detail="文件夹不存在")

    _require_folder_edit(db, user, folder.path)

    if is_protected_system_folder(folder.path):
        data = body.model_dump(exclude_unset=True)
        # allow sort_order only on system folders
        if set(data.keys()) - {"sort_order"}:
            raise HTTPException(status_code=400, detail="系统文件夹不可重命名或移动")
        if "sort_order" in data and data["sort_order"] is not None:
            folder.sort_order = int(data["sort_order"])
            db.commit()
            db.refresh(folder)
        return _folder_out(db, folder)

    data = body.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(status_code=400, detail="无更新字段")

    new_name = folder.name if "name" not in data else (data["name"] or "").strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="文件夹名不能为空")
    if "parent_id" in data:
        new_parent_id = data["parent_id"]
    else:
        new_parent_id = folder.parent_id

    parent = None
    if new_parent_id is not None:
        parent = db.get(Folder, new_parent_id)
        if not parent:
            raise HTTPException(status_code=404, detail="父文件夹不存在")
        _require_folder_edit(db, user, parent.path)

    # only sort_order change without move/rename
    if (
        new_name == folder.name
        and new_parent_id == folder.parent_id
        and "sort_order" in data
        and data["sort_order"] is not None
    ):
        folder.sort_order = int(data["sort_order"])
        db.commit()
        db.refresh(folder)
        return _folder_out(db, folder)

    try:
        old_path, new_path = _relocate_folder(db, folder, parent, new_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    if "sort_order" in data and data["sort_order"] is not None and new_parent_id == folder.parent_id:
        # parent already updated inside relocate; set explicit order if same parent rename-only
        folder.sort_order = int(data["sort_order"])

    write_audit(
        db,
        user_id=user.id,
        action="update",
        entity_type="folder",
        entity_id=folder.id,
        detail={"old_path": old_path, "new_path": new_path, "fields": data},
    )
    db.commit()
    db.refresh(folder)
    return _folder_out(db, folder)


@router.post("/{folder_id}/restore", response_model=FolderOut)
def restore_folder(
    folder_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """从回收站恢复到根目录。"""
    folder = db.get(Folder, folder_id)
    if not folder:
        raise HTTPException(status_code=404, detail="文件夹不存在")
    if folder.path == TRASH_FOLDER_PATH or not is_trash_path(folder.path):
        raise HTTPException(status_code=400, detail="仅可恢复回收站中的文件夹")
    _require_folder_edit(db, user, folder.path)
    _require_folder_edit(db, user, "/")

    name = _unique_name_under(db, None, folder.name)
    old_path, new_path = _relocate_folder(db, folder, None, name)
    write_audit(
        db,
        user_id=user.id,
        action="restore",
        entity_type="folder",
        entity_id=folder.id,
        detail={"old_path": old_path, "new_path": new_path},
    )
    db.commit()
    db.refresh(folder)
    return _folder_out(db, folder)


@router.delete("/{folder_id}")
def delete_folder(
    folder_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """普通文件夹：移入回收站；已在回收站内：彻底删除（含子树与条目）。"""
    folder = db.get(Folder, folder_id)
    if not folder:
        raise HTTPException(status_code=404, detail="文件夹不存在")
    _require_folder_edit(db, user, folder.path)

    if folder.path == TRASH_FOLDER_PATH:
        raise HTTPException(status_code=400, detail="不能删除回收站本身")
    if folder.path == "/未分类/":
        raise HTTPException(status_code=400, detail="不能删除「未分类」系统文件夹")

    stats = _subtree_stats(db, folder)

    # already in trash → permanent purge
    if is_trash_path(folder.path):
        write_audit(
            db,
            user_id=user.id,
            action="purge",
            entity_type="folder",
            entity_id=folder_id,
            detail={"path": folder.path, **stats},
        )
        _purge_folder_subtree(db, folder)
        db.commit()
        return {"ok": True, "action": "purged", **stats}

    # move into trash
    trash = ensure_trash_folder(db)
    _require_folder_edit(db, user, trash.path)
    name = _unique_name_under(db, trash, folder.name)
    old_path, new_path = _relocate_folder(db, folder, trash, name)
    write_audit(
        db,
        user_id=user.id,
        action="trash",
        entity_type="folder",
        entity_id=folder_id,
        detail={"old_path": old_path, "new_path": new_path, **stats},
    )
    db.commit()
    return {
        "ok": True,
        "action": "trashed",
        "path": new_path,
        **stats,
    }
