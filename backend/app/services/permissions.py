"""Folder-path based permission checks."""

from __future__ import annotations

from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..models import Capability, Folder, MotionClip, User, UserPermission
from ..models.enums import (
    alias_capability,
    is_super_manager_role,
    is_super_role,
    role_capabilities,
)

ALL_CAPABILITIES = (
    Capability.browse,
    Capability.download,
    Capability.annotate,
    Capability.upload,
    Capability.manage_data,
    Capability.manage_users,
    Capability.edit,
)

# 管理数据覆盖同范围内的浏览 / 下载 / 标注 / 上传
MANAGE_DATA_IMPLIES = (
    Capability.browse,
    Capability.download,
    Capability.annotate,
    Capability.upload,
)

# 与浏览页「筛选维度」里分类标准之外的四项对应。path_prefix 存筛选项 id，不是文件夹路径。
FACET_SCHEMES = frozenset({"uploader", "subject", "format", "modality"})
_MOTION_KINDS = frozenset({"skeleton", "object", "merged"})


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


def permission_prefix(scheme: str, path_prefix: str | None) -> str:
    """Folder and taxonomy scopes are directory paths. Filter scopes keep their raw id."""
    if scheme in FACET_SCHEMES:
        raw = (path_prefix or "/").strip()
        return "/" if raw in ("", "/") else raw
    return normalize_path(path_prefix)


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
    """超级管理者（含旧 admin）可管理用户。"""
    return is_super_manager_role(user.role)


def has_role_capability(user: User, capability: Capability) -> bool:
    return alias_capability(capability) in role_capabilities(user.role)


def capability_query_values(capability: Capability) -> list[Capability]:
    cap = alias_capability(capability)
    if cap == Capability.manage_data:
        return [Capability.manage_data, Capability.edit]
    if cap in MANAGE_DATA_IMPLIES:
        return [cap, Capability.manage_data, Capability.edit]
    return [cap]


def user_has_any_capability(db: Session, user: User, capability: Capability) -> bool:
    if not has_role_capability(user, capability):
        return False
    if is_super_role(user.role):
        return True
    return (
        db.query(UserPermission)
        .filter(
            UserPermission.user_id == user.id,
            UserPermission.capability.in_(capability_query_values(capability)),
        )
        .first()
        is not None
    )


def list_user_permissions(db: Session, user: User) -> list[UserPermission]:
    return (
        db.query(UserPermission)
        .filter(UserPermission.user_id == user.id)
        .order_by(UserPermission.capability, UserPermission.path_prefix)
        .all()
    )


def user_has_capability(db: Session, user: User, capability: Capability, folder_path: str) -> bool:
    """Folder-tree scoped check (permissions with scheme=='')."""
    if not has_role_capability(user, capability):
        return False
    if is_super_role(user.role):
        return True
    folder_path = normalize_path(folder_path)
    perms = (
        db.query(UserPermission)
        .filter(
            UserPermission.user_id == user.id,
            UserPermission.capability.in_(capability_query_values(capability)),
            UserPermission.scheme == "",
        )
        .all()
    )
    for p in perms:
        if path_matches(folder_path, p.path_prefix, p.recursive):
            return True
    return False


def _file_modality_key(file: dict) -> str:
    modality = str(file.get("modality") or "")
    if modality != "motion":
        return modality
    kind = str((file.get("annotation") or {}).get("motion_kind") or "skeleton")
    if kind not in _MOTION_KINDS:
        kind = "skeleton"
    return f"motion:{kind}"


def _file_matches_subject(file: dict, selected: str) -> bool:
    ontology = str(file.get("ontology") or "")
    annotation = file.get("annotation") or {}
    if ontology == "robot":
        instance = str(file.get("robot_style") or annotation.get("robot_style") or "")
        version = str(annotation.get("robot_version") or "")
    else:
        instance = str(annotation.get("human_model") or "")
        version = str(annotation.get("human_model_file") or "")
    parts = selected.split("|")
    onto = parts[0] if parts else ""
    inst = parts[1] if len(parts) > 1 else ""
    ver = parts[2] if len(parts) > 2 else ""
    if onto != ontology:
        return False
    if not inst:
        return True
    if inst != instance:
        return False
    if not ver:
        return True
    return ver == version or version.endswith(ver) or ver.endswith(version)


def unit_matches_facet(unit: dict, scheme: str, path_prefix: str) -> bool:
    """Same match as the browse filter chips: uploader, subject, format, modality."""
    if scheme not in FACET_SCHEMES:
        return False
    if path_prefix in ("", "/"):
        return True
    files = unit.get("files") or []
    if scheme == "uploader":
        ids: set[str] = set()
        for item in unit.get("uploaders") or []:
            if item and item.get("id") is not None:
                ids.add(str(item["id"]))
        for file in files:
            uploader = file.get("uploader") or {}
            if uploader.get("id") is not None:
                ids.add(str(uploader["id"]))
        return path_prefix in ids
    if scheme == "format":
        wanted = path_prefix.lower()
        return any(str(file.get("format") or "").lower() == wanted for file in files)
    if scheme == "modality":
        return any(_file_modality_key(file) == path_prefix for file in files)
    if scheme == "subject":
        return any(_file_matches_subject(file, path_prefix) for file in files)
    return False


def _clip_tag_paths(db: Session, clip: MotionClip) -> dict[str, str]:
    """scheme key -> taxonomy node path for the clip's tags."""
    from ..models import ClipTaxonomyTag, TaxonomyNode

    rows = (
        db.query(ClipTaxonomyTag.scheme, TaxonomyNode.path)
        .join(TaxonomyNode, ClipTaxonomyTag.node_id == TaxonomyNode.id)
        .filter(ClipTaxonomyTag.clip_id == clip.id)
        .all()
    )
    return {scheme: path for scheme, path in rows}


def user_has_clip_capability(
    db: Session, user: User, capability: Capability, clip: MotionClip
) -> bool:
    """Clip-level check: folder-tree perms OR taxonomy-scheme perms."""
    if (
        capability
        in (
            Capability.browse,
            Capability.download,
            Capability.annotate,
        )
        and clip.created_by == user.id
    ):
        return True
    if not has_role_capability(user, capability):
        return False
    if is_super_role(user.role):
        return True
    perms = (
        db.query(UserPermission)
        .filter(
            UserPermission.user_id == user.id,
            UserPermission.capability.in_(capability_query_values(capability)),
        )
        .all()
    )
    if not perms:
        return False
    folder_path = folder_path_of_clip(db, clip)
    tag_paths: dict[str, str] | None = None
    for p in perms:
        if not p.scheme:
            if path_matches(folder_path, p.path_prefix, p.recursive):
                return True
            continue
        if p.scheme in FACET_SCHEMES:
            continue
        if tag_paths is None:
            tag_paths = _clip_tag_paths(db, clip)
        tpath = tag_paths.get(p.scheme)
        if tpath and path_matches(tpath, p.path_prefix, p.recursive):
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
    from fastapi import HTTPException, status

    path = folder_path_of_clip(db, clip)
    if not user_has_clip_capability(db, user, capability, clip):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"缺少权限：{capability.value} @ {path}",
        )
    if capability != Capability.browse and not user_has_clip_capability(
        db, user, Capability.browse, clip
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"缺少浏览权限：{path}",
        )
    return path


def browse_path_prefixes(db: Session, user: User) -> list[str] | None:
    """Folder-tree browse prefixes, or None if unrestricted browse."""
    if is_super_role(user.role) and has_role_capability(user, Capability.browse):
        return None
    rows = (
        db.query(UserPermission)
        .filter(
            UserPermission.user_id == user.id,
            UserPermission.capability.in_(capability_query_values(Capability.browse)),
            UserPermission.scheme == "",
        )
        .all()
    )
    return [normalize_path(r.path_prefix) for r in rows]


def _scheme_browse_perms(db: Session, user: User) -> list[UserPermission]:
    return (
        db.query(UserPermission)
        .filter(
            UserPermission.user_id == user.id,
            UserPermission.capability.in_(capability_query_values(Capability.browse)),
            UserPermission.scheme != "",
        )
        .all()
    )


def apply_browse_filter(query, db: Session, user: User):
    """Filter MotionClip query by folder-tree and taxonomy-scheme browse perms."""
    from ..models import ClipTaxonomyTag, TaxonomyNode

    prefixes = browse_path_prefixes(db, user)
    if prefixes is None:
        return query
    scheme_perms = _scheme_browse_perms(db, user)
    owner_clause = MotionClip.created_by == user.id
    if not prefixes and not scheme_perms:
        return query.filter(owner_clause)
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
    for p in scheme_perms:
        if p.scheme in FACET_SCHEMES:
            continue
        pref = normalize_path(p.path_prefix)
        tagged = (
            db.query(ClipTaxonomyTag.clip_id)
            .join(TaxonomyNode, ClipTaxonomyTag.node_id == TaxonomyNode.id)
            .filter(
                ClipTaxonomyTag.scheme == p.scheme,
                TaxonomyNode.path.like(f"{pref}%")
                if pref != "/"
                else TaxonomyNode.path.like("/%"),
            )
        )
        clauses.append(MotionClip.id.in_(tagged))
    clauses.append(owner_clause)
    return query.filter(or_(*clauses))


def folder_visible(db: Session, user: User, folder: Folder) -> bool:
    if is_super_role(user.role) and has_role_capability(user, Capability.browse):
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


def _granted_caps_for_role(user: User) -> list[Capability]:
    allowed = role_capabilities(user.role)
    out: list[Capability] = []
    for cap in ALL_CAPABILITIES:
        if alias_capability(cap) in allowed:
            out.append(cap)
    return out


def permission_summary(db: Session, user: User) -> dict:
    granted = _granted_caps_for_role(user)
    if is_super_role(user.role):
        return {
            "is_admin": is_admin(user),
            "capabilities": {c.value: ["/"] for c in granted},
            "permissions": [
                {
                    "capability": c.value,
                    "scheme": "",
                    "path_prefix": "/",
                    "recursive": True,
                }
                for c in granted
                if c != Capability.edit
            ],
        }
    rows = list_user_permissions(db, user)
    caps: dict[str, list[str]] = {c.value: [] for c in ALL_CAPABILITIES}
    perms_out = []
    allowed = role_capabilities(user.role)
    for r in rows:
        scheme = getattr(r, "scheme", "") or ""
        pref = permission_prefix(scheme, r.path_prefix)
        raw = r.capability.value
        aliased = alias_capability(r.capability)
        if aliased not in allowed:
            continue
        token = f"{scheme}:{pref}" if scheme else pref
        caps[raw].append(token)
        if aliased == Capability.manage_data:
            if token not in caps[Capability.manage_data.value]:
                caps[Capability.manage_data.value].append(token)
            if token not in caps[Capability.edit.value]:
                caps[Capability.edit.value].append(token)
            for implied in MANAGE_DATA_IMPLIES:
                if implied in allowed and token not in caps[implied.value]:
                    caps[implied.value].append(token)
        perms_out.append(
            {
                "capability": raw,
                "scheme": scheme,
                "path_prefix": pref,
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
    allowed = role_capabilities(user.role)
    # normalize + auto browse
    seen: set[tuple[str, str, str]] = set()
    expanded: list[tuple[Capability, str, str, bool]] = []
    for item in items:
        cap = item["capability"] if isinstance(item["capability"], Capability) else Capability(item["capability"])
        cap = alias_capability(cap)
        if cap not in allowed or cap == Capability.manage_users:
            continue
        scheme = (item.get("scheme") or "").strip()
        prefix = permission_prefix(scheme, item.get("path_prefix"))
        recursive = bool(item.get("recursive", True))
        key = (cap.value, scheme, prefix)
        if key in seen:
            continue
        seen.add(key)
        expanded.append((cap, scheme, prefix, recursive))
        if cap != Capability.browse and Capability.browse in allowed:
            bkey = (Capability.browse.value, scheme, prefix)
            if bkey not in seen:
                seen.add(bkey)
                expanded.append((Capability.browse, scheme, prefix, recursive))

    created = []
    for cap, scheme, prefix, recursive in expanded:
        row = UserPermission(
            user_id=user.id,
            capability=cap,
            scheme=scheme,
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
