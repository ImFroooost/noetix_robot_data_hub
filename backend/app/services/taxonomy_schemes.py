"""Taxonomy scheme registry helpers and clip↔tag sync."""

from __future__ import annotations

import re

from sqlalchemy.orm import Session

from ..models import ClipTaxonomyTag, MotionClip, TaxonomyNode, TaxonomySchemeDef
from ..models.enums import (
    BUILTIN_TAXONOMY_SCHEMES,
    LEGACY_SCHEME_NAMES,
    TaxonomyScheme,
)

BUILTIN_KEYS = {k for k, *_ in BUILTIN_TAXONOMY_SCHEMES}

# 图表方案的自定义分类维度（builtin=False，分类管理显示「·自定」）
DEFAULT_CUSTOM_SCHEMES: tuple[tuple[str, str, str, int], ...] = (
    ("custom", "所属项目", "D", 3),
    ("custom_3", "获取方式", "E", 4),
    ("custom_2", "获取地点", "F", 5),
    ("custom_4", "获取设备", "G", 6),
    ("custom_5", "所处阶段", "H", 7),
)

DEFAULT_CUSTOM_TREES: dict[str, dict] = {
    "custom": {
        "运动会": ("D1", None),
        "GMT": ("D2", {"动作表2": ("D2.1", None)}),
        "马拉松": ("D3", None),
    },
    "custom_3": {
        "全身动捕": ("E1", None),
        "视频生成": ("E2", None),
        "vr5点式": ("E3", None),
    },
    "custom_2": {
        "松延大厦": ("F1", None),
        "机器人产业园": ("F2", None),
    },
    "custom_4": {
        "op": ("G1", None),
        "xsens": ("G2", None),
        "pico": ("G3", None),
    },
    "custom_5": {
        "待描述": ("H1", None),
        "待采集": ("H2", None),
        "待重定向": ("H3", None),
        "待精修": ("H4", None),
        "待训练": ("H5", None),
        "待真机测试": ("H6", None),
    },
}

# 旧节点名 → 新节点名（仅在无条目引用歧义时安全改名）
LEGACY_NODE_RENAMES: dict[str, dict[str, str]] = {
    "custom_4": {"optitrack": "op"},
}
BUILTIN_COLUMN = {
    TaxonomyScheme.atomic.value: "atomic_tag_id",
    TaxonomyScheme.intent.value: "intent_tag_id",
    TaxonomyScheme.style.value: "style_tag_id",
}


def ensure_builtin_schemes(db: Session) -> None:
    for key, name, prefix, sort_order in BUILTIN_TAXONOMY_SCHEMES:
        row = db.get(TaxonomySchemeDef, key)
        if row:
            if not row.code_prefix:
                row.code_prefix = prefix
            if row.sort_order is None:
                row.sort_order = sort_order
            row.builtin = True
            if not row.name or LEGACY_SCHEME_NAMES.get(row.name) == name:
                row.name = name
            continue
        db.add(
            TaxonomySchemeDef(
                key=key,
                name=name,
                code_prefix=prefix,
                sort_order=sort_order,
                builtin=True,
                description="",
            )
        )
    db.flush()


def _rename_node_with_subtree(db: Session, node: TaxonomyNode, new_name: str) -> None:
    """Rename node and re-prefix its own + descendant paths."""
    from .permissions import join_folder_path

    old_path = node.path
    parent = db.get(TaxonomyNode, node.parent_id) if node.parent_id else None
    new_path = join_folder_path(parent.path if parent else None, new_name)
    if new_path == old_path:
        node.name = new_name
        return
    clash = (
        db.query(TaxonomyNode)
        .filter(TaxonomyNode.scheme == node.scheme, TaxonomyNode.path == new_path)
        .first()
    )
    if clash:
        return  # 目标名已存在，跳过改名
    node.name = new_name
    node.path = new_path
    descendants = (
        db.query(TaxonomyNode)
        .filter(
            TaxonomyNode.scheme == node.scheme,
            TaxonomyNode.path.like(f"{old_path}%"),
            TaxonomyNode.id != node.id,
        )
        .all()
    )
    for d in descendants:
        d.path = new_path + d.path[len(old_path):]
    db.flush()


def ensure_default_custom_schemes(db: Session) -> None:
    """补齐图表方案的自定义维度：所属项目/获取方式/获取地点/获取设备/所处阶段。"""
    from .permissions import join_folder_path, normalize_path

    for key, name, prefix, sort_order in DEFAULT_CUSTOM_SCHEMES:
        row = db.get(TaxonomySchemeDef, key)
        if not row:
            db.add(
                TaxonomySchemeDef(
                    key=key,
                    name=name,
                    code_prefix=prefix,
                    sort_order=sort_order,
                    builtin=False,
                    description="",
                )
            )
            db.flush()
        elif LEGACY_SCHEME_NAMES.get(row.name) == name:
            row.name = name
            db.flush()
        root_path = normalize_path(f"/{name}/")
        root = (
            db.query(TaxonomyNode)
            .filter(TaxonomyNode.scheme == key, TaxonomyNode.parent_id.is_(None))
            .first()
        )
        if root and root.name != name and LEGACY_SCHEME_NAMES.get(root.name) == name:
            _rename_node_with_subtree(db, root, name)
        if not root:
            root = TaxonomyNode(
                scheme=key,
                parent_id=None,
                code=prefix,
                name=name,
                path=root_path,
                sort_order=0,
                description="",
            )
            db.add(root)
            db.flush()

        for old_name, new_name in (LEGACY_NODE_RENAMES.get(key) or {}).items():
            stale = (
                db.query(TaxonomyNode)
                .filter(TaxonomyNode.scheme == key, TaxonomyNode.name == old_name)
                .first()
            )
            if stale:
                _rename_node_with_subtree(db, stale, new_name)

        def _ensure(parent: TaxonomyNode, tree: dict) -> None:
            for idx, (child_name, payload) in enumerate(tree.items()):
                code, children = payload
                path = join_folder_path(parent.path, child_name)
                node = (
                    db.query(TaxonomyNode)
                    .filter(TaxonomyNode.scheme == key, TaxonomyNode.path == path)
                    .first()
                )
                if not node:
                    node = TaxonomyNode(
                        scheme=key,
                        parent_id=parent.id,
                        code=code or "",
                        name=child_name,
                        path=path,
                        sort_order=idx,
                        description="",
                    )
                    db.add(node)
                    db.flush()
                else:
                    if code and node.code != code:
                        node.code = code
                    if node.sort_order != idx:
                        node.sort_order = idx
                if children:
                    _ensure(node, children)

        child_count = (
            db.query(TaxonomyNode)
            .filter(
                TaxonomyNode.scheme == key,
                TaxonomyNode.parent_id.isnot(None),
            )
            .count()
        )
        # 只在该标准还没有任何子节点时种默认树；用户删掉的节点不要刷新后又长回来
        if child_count == 0:
            tree = DEFAULT_CUSTOM_TREES.get(key) or {}
            _ensure(root, tree)
    db.flush()


def list_schemes(db: Session) -> list[TaxonomySchemeDef]:
    return (
        db.query(TaxonomySchemeDef)
        .order_by(TaxonomySchemeDef.sort_order.asc(), TaxonomySchemeDef.key.asc())
        .all()
    )


def get_scheme(db: Session, key: str) -> TaxonomySchemeDef | None:
    return db.get(TaxonomySchemeDef, key)


def scheme_key_from_name(name: str) -> str:
    raw = name.strip().lower()
    slug = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "_", raw)
    slug = re.sub(r"_+", "_", slug).strip("_")
    if not slug:
        slug = "custom"
    if not re.match(r"^[a-z]", slug):
        slug = f"custom_{slug}"
    # keep ASCII-ish keys for URL safety; chinese -> custom_N
    if re.search(r"[^\w]", slug) or re.search(r"[\u4e00-\u9fff]", slug):
        slug = "custom"
    return slug[:56]


def next_code_prefix(db: Session) -> str:
    used = {r.code_prefix for r in db.query(TaxonomySchemeDef).all() if r.code_prefix}
    for i in range(26):
        letter = chr(ord("A") + i)
        if letter not in used:
            return letter
    # fallback beyond Z
    n = 1
    while f"X{n}" in used:
        n += 1
    return f"X{n}"


def unique_scheme_key(db: Session, base: str) -> str:
    key = base[:56] or "custom"
    if db.get(TaxonomySchemeDef, key) is None:
        return key
    n = 2
    while db.get(TaxonomySchemeDef, f"{key}_{n}") is not None:
        n += 1
    return f"{key}_{n}"[:64]


def sync_clip_tag_columns_from_rows(clip: MotionClip) -> None:
    """Mirror join-table tags into legacy atomic/intent/style columns."""
    by_scheme = {row.scheme: row.node_id for row in (clip.taxonomy_tag_rows or [])}
    clip.atomic_tag_id = by_scheme.get(TaxonomyScheme.atomic.value)
    clip.intent_tag_id = by_scheme.get(TaxonomyScheme.intent.value)
    clip.style_tag_id = by_scheme.get(TaxonomyScheme.style.value)


def set_clip_taxonomy_tag(
    db: Session,
    clip: MotionClip,
    scheme: str,
    node_id: int | None,
) -> None:
    existing = (
        db.query(ClipTaxonomyTag)
        .filter(ClipTaxonomyTag.clip_id == clip.id, ClipTaxonomyTag.scheme == scheme)
        .first()
    )
    if node_id is None:
        if existing:
            db.delete(existing)
    else:
        if existing:
            existing.node_id = node_id
        else:
            db.add(
                ClipTaxonomyTag(clip_id=clip.id, scheme=scheme, node_id=node_id)
            )
    db.flush()
    rows = (
        db.query(ClipTaxonomyTag).filter(ClipTaxonomyTag.clip_id == clip.id).all()
    )
    by_scheme = {row.scheme: row.node_id for row in rows}
    clip.atomic_tag_id = by_scheme.get(TaxonomyScheme.atomic.value)
    clip.intent_tag_id = by_scheme.get(TaxonomyScheme.intent.value)
    clip.style_tag_id = by_scheme.get(TaxonomyScheme.style.value)


def set_clip_taxonomy_tags(
    db: Session,
    clip: MotionClip,
    tags: dict[str, int | None],
) -> None:
    for scheme, node_id in tags.items():
        set_clip_taxonomy_tag(db, clip, scheme, node_id)


def backfill_clip_taxonomy_tags(db: Session) -> None:
    """One-time: copy legacy columns into clip_taxonomy_tags when missing."""
    clips = db.query(MotionClip).all()
    for clip in clips:
        pairs = (
            (TaxonomyScheme.atomic.value, clip.atomic_tag_id),
            (TaxonomyScheme.intent.value, clip.intent_tag_id),
            (TaxonomyScheme.style.value, clip.style_tag_id),
        )
        existing = {
            r.scheme: r
            for r in db.query(ClipTaxonomyTag)
            .filter(ClipTaxonomyTag.clip_id == clip.id)
            .all()
        }
        for scheme, node_id in pairs:
            if not node_id:
                continue
            if scheme in existing:
                if existing[scheme].node_id != node_id:
                    existing[scheme].node_id = node_id
            else:
                db.add(
                    ClipTaxonomyTag(
                        clip_id=clip.id, scheme=scheme, node_id=node_id
                    )
                )
    db.flush()


def clip_taxonomy_tag_map(db: Session, clip_id: int) -> dict[str, TaxonomyNode]:
    rows = (
        db.query(ClipTaxonomyTag)
        .filter(ClipTaxonomyTag.clip_id == clip_id)
        .all()
    )
    out: dict[str, TaxonomyNode] = {}
    for row in rows:
        node = db.get(TaxonomyNode, row.node_id)
        if node:
            out[row.scheme] = node
    return out


def filter_clip_ids_by_taxonomy(
    db: Session,
    scheme: str,
    node_ids: list[int],
) -> list[int]:
    if not node_ids:
        return []
    rows = (
        db.query(ClipTaxonomyTag.clip_id)
        .filter(
            ClipTaxonomyTag.scheme == scheme,
            ClipTaxonomyTag.node_id.in_(node_ids),
        )
        .all()
    )
    return [r[0] for r in rows]
