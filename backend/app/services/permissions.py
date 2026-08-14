"""Folder-path based permission checks."""

from __future__ import annotations

from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..models import Capability, Folder, MotionClip, User, UserPermission, UserRole

ALL_CAPABILITIES = (
    Capability.browse,
    Capability.download,
    Capability.edit,
    Capability.annotate,
    Capability.upload,
)


def normalize_path(path: str | None) -> str:
    if not path or path.strip() in ("", "/"):
        return "/"
    p = "/" + "/".join(seg for seg in path.strip().split("/") if seg)
    if not p.endswith("/"):
        p += "/"
    return p


def join_folder_path(parent_path: str | None, name: str) -> str:
    name = name.strip().strip("/")
    if not name:
        raise ValueError("文件夹名不能为空")
    if "/" in name or name in (".", ".."):
        raise ValueError("文件夹名非法")
    parent = normalize_path(parent_path)
    if parent == "/":
        return f"/{name}/"
    return f"{parent}{name}/"


def path_matches(folder_path: str, prefix: str, recursive: bool = True) -> bool:
    folder_path = normalize_path(folder_path)
    prefix = normalize_path(prefix)
    if prefix == "/":
        return True
    if recursive:
        return folder_path == prefix or folder_path.startswith(prefix)
    return folder_path == prefix


def folder_path_of_clip(db: Session, clip: MotionClip) -> str:
    if clip.folder_id:
        folder = db.get(Folder, clip.folder_id)
        if folder:
            return normalize_path(folder.path)
    return "/未分类/"


def is_admin(user: User) -> bool:
    return user.role == UserRole.admin


def list_user_permissions(db: Session, user: User) -> list[UserPermission]:
    return (
        db.query(UserPermission)
        .filter(UserPermission.user_id == user.id)
        .order_by(UserPermission.capability, UserPermission.path_prefix)
        .all()
    )


def user_has_capability(db: Session, user: User, capability: Capability, folder_path: str) -> bool:
    if is_admin(user):
        return True
    folder_path = normalize_path(folder_path)
    perms = (
        db.query(UserPermission)
        .filter(
            UserPermission.user_id == user.id,
            UserPermission.capability == capability,
        )
        .all()
    )
    for p in perms:
        if path_matches(folder_path, p.path_prefix, p.recursive):
            return True
    return False


def ensure_capability(db: Session, user: User, capability: Capability, folder_path: str) -> None:
    from fastapi import HTTPException, status

    if not user_has_capability(db, user, capability, folder_path):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"缺少权限：{capability.value} @ {normalize_path(folder_path)}",
        )
    if capability != Capability.browse and not user_has_capability(
        db, user, Capability.browse, folder_path
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"缺少浏览权限：{normalize_path(folder_path)}",
        )


def ensure_clip_capability(
    db: Session, user: User, capability: Capability, clip: MotionClip
) -> str:
    path = folder_path_of_clip(db, clip)
    ensure_capability(db, user, capability, path)
    return path


def browse_path_prefixes(db: Session, user: User) -> list[str] | None:
    """Return path prefixes for browse filter, or None if admin (no filter)."""
    if is_admin(user):
        return None
    rows = (
        db.query(UserPermission)
        .filter(
            UserPermission.user_id == user.id,
            UserPermission.capability == Capability.browse,
        )
        .all()
    )
    return [normalize_path(r.path_prefix) for r in rows]


def apply_browse_filter(query, db: Session, user: User):
    """Filter MotionClip query by browse path prefixes."""
    prefixes = browse_path_prefixes(db, user)
    if prefixes is None:
        return query
    if not prefixes:
        return query.filter(False)
    # join folder; clips without folder treated as /未分类/
    query = query.outerjoin(Folder, MotionClip.folder_id == Folder.id)
    clauses = []
    for pref in prefixes:
        if pref == "/":
            return query  # full access
        # Folder.path like prefix% OR (no folder and /未分类/ matches)
        clauses.append(Folder.path.like(f"{pref}%"))
        if path_matches("/未分类/", pref, True):
            clauses.append(MotionClip.folder_id.is_(None))
    return query.filter(or_(*clauses))


def folder_visible(db: Session, user: User, folder: Folder) -> bool:
    if is_admin(user):
        return True
    path = normalize_path(folder.path)
    # visible if any browse prefix covers this folder, or this folder is ancestor of a granted prefix
    prefixes = browse_path_prefixes(db, user) or []
    for pref in prefixes:
        if pref == "/":
            return True
        if path_matches(path, pref, True):
            return True
        # ancestor of a granted path: /A/ visible if user has /A/B/
        if pref.startswith(path):
            return True
    return False


def permission_summary(db: Session, user: User) -> dict:
    if is_admin(user):
        return {
            "is_admin": True,
            "capabilities": {c.value: ["/"] for c in ALL_CAPABILITIES},
            "permissions": [
                {
                    "capability": c.value,
                    "path_prefix": "/",
                    "recursive": True,
                }
                for c in ALL_CAPABILITIES
            ],
        }
    rows = list_user_permissions(db, user)
    caps: dict[str, list[str]] = {c.value: [] for c in ALL_CAPABILITIES}
    perms_out = []
    for r in rows:
        caps[r.capability.value].append(normalize_path(r.path_prefix))
        perms_out.append(
            {
                "capability": r.capability.value,
                "path_prefix": normalize_path(r.path_prefix),
                "recursive": r.recursive,
            }
        )
    return {"is_admin": False, "capabilities": caps, "permissions": perms_out}


def set_user_permissions(
    db: Session,
    user: User,
    items: list[dict],
) -> list[UserPermission]:
    """Replace all permissions. Auto-add browse for non-browse capabilities."""
    db.query(UserPermission).filter(UserPermission.user_id == user.id).delete()
    # normalize + auto browse
    seen: set[tuple[str, str]] = set()
    expanded: list[tuple[Capability, str, bool]] = []
    for item in items:
        cap = item["capability"] if isinstance(item["capability"], Capability) else Capability(item["capability"])
        prefix = normalize_path(item.get("path_prefix") or "/")
        recursive = bool(item.get("recursive", True))
        key = (cap.value, prefix)
        if key in seen:
            continue
        seen.add(key)
        expanded.append((cap, prefix, recursive))
        if cap != Capability.browse:
            bkey = (Capability.browse.value, prefix)
            if bkey not in seen:
                seen.add(bkey)
                expanded.append((Capability.browse, prefix, recursive))

    created = []
    for cap, prefix, recursive in expanded:
        row = UserPermission(
            user_id=user.id,
            capability=cap,
            path_prefix=prefix,
            recursive=recursive,
        )
        db.add(row)
        created.append(row)
    db.flush()
    return created


TRASH_FOLDER_PATH = "/回收站/"
UNCLASSIFIED_FOLDER_PATH = "/未分类/"


def ensure_unclassified_folder(db: Session) -> Folder:
    path = UNCLASSIFIED_FOLDER_PATH
    folder = db.query(Folder).filter(Folder.path == path).first()
    if folder:
        return folder
    folder = Folder(parent_id=None, name="未分类", path=path)
    db.add(folder)
    db.flush()
    return folder


def ensure_trash_folder(db: Session) -> Folder:
    path = TRASH_FOLDER_PATH
    folder = db.query(Folder).filter(Folder.path == path).first()
    if folder:
        return folder
    folder = Folder(parent_id=None, name="回收站", path=path, sort_order=9999)
    db.add(folder)
    db.flush()
    return folder


def is_trash_path(path: str) -> bool:
    p = normalize_path(path)
    return p == TRASH_FOLDER_PATH or p.startswith(TRASH_FOLDER_PATH)


def is_protected_system_folder(path: str) -> bool:
    p = normalize_path(path)
    return p in (TRASH_FOLDER_PATH, UNCLASSIFIED_FOLDER_PATH)


def get_or_create_folder_by_path(db: Session, path: str) -> Folder:
    path = normalize_path(path)
    if path == "/":
        raise ValueError("不能使用根路径作为文件夹")
    existing = db.query(Folder).filter(Folder.path == path).first()
    if existing:
        return existing
    parts = [p for p in path.strip("/").split("/") if p]
    parent_path: str | None = None
    folder: Folder | None = None
    for name in parts:
        cur = join_folder_path(parent_path, name)
        folder = db.query(Folder).filter(Folder.path == cur).first()
        if not folder:
            parent = None
            if parent_path:
                parent = db.query(Folder).filter(Folder.path == normalize_path(parent_path)).first()
            folder = Folder(
                parent_id=parent.id if parent else None,
                name=name,
                path=cur,
            )
            db.add(folder)
            db.flush()
        parent_path = cur
    assert folder is not None
    return folder
