from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..core.deps import get_current_user, require_admin
from ..database import get_db
from ..models import ClipTaxonomyTag, MotionClip, TaxonomyNode, TaxonomySchemeDef, User
from ..schemas import (
    TaxonomyNodeCreate,
    TaxonomyNodeOut,
    TaxonomyNodeReorder,
    TaxonomyNodeUpdate,
    TaxonomySchemeCreate,
    TaxonomySchemeOut,
    TaxonomySchemeReorder,
    TaxonomySchemeUpdate,
)
from ..services.audit import write_audit
from ..services.permissions import (
    is_admin,
    join_folder_path,
    normalize_path,
    user_has_capability,
)
from ..models.enums import Capability
from ..services.repo_taxonomy import pack_exact_sets, subtree_pack_counts
from ..services.taxonomy_schemes import (
    BUILTIN_KEYS,
    ensure_builtin_schemes,
    ensure_default_custom_schemes,
    get_scheme,
    list_schemes,
    next_code_prefix,
    scheme_key_from_name,
    unique_scheme_key,
)

router = APIRouter(prefix="/taxonomies", tags=["taxonomies"])


def _require_taxonomy_write(db: Session, user: User) -> None:
    """管理员，或具备全局/任意编辑权限的用户，可新增分类节点。"""
    if is_admin(user):
        return
    if user_has_capability(db, user, Capability.edit, "/"):
        return
    from ..models import UserPermission

    has_edit = (
        db.query(UserPermission.id)
        .filter(
            UserPermission.user_id == user.id,
            UserPermission.capability == Capability.edit,
        )
        .first()
    )
    if has_edit:
        return
    raise HTTPException(status_code=403, detail="缺少编辑权限，无法新增分类")


def _scheme_str(scheme) -> str:
    return scheme.value if hasattr(scheme, "value") else str(scheme)


def _clip_count(db: Session, node: TaxonomyNode) -> int:
    ids = [
        r[0]
        for r in db.query(TaxonomyNode.id)
        .filter(TaxonomyNode.scheme == node.scheme, TaxonomyNode.path.like(f"{node.path}%"))
        .all()
    ]
    if not ids:
        return 0
    return (
        db.query(func.count(ClipTaxonomyTag.id))
        .filter(
            ClipTaxonomyTag.scheme == node.scheme,
            ClipTaxonomyTag.node_id.in_(ids),
        )
        .scalar()
        or 0
    )


def _browse_count(
    db: Session,
    node: TaxonomyNode,
    *,
    pack_count: int | None = None,
) -> int:
    """旧库 MotionClip 数 + 维度仓库上传包数（含子树）。"""
    clips = _clip_count(db, node)
    if pack_count is not None:
        return clips + pack_count
    scheme = _scheme_str(node.scheme)
    scheme_nodes = (
        db.query(TaxonomyNode).filter(TaxonomyNode.scheme == node.scheme).all()
    )
    counts = subtree_pack_counts(scheme_nodes, pack_exact_sets(db, scheme))
    return clips + counts.get(node.id, 0)


def _node_out(
    db: Session,
    node: TaxonomyNode,
    *,
    pack_count: int | None = None,
    child_count: int | None = None,
) -> TaxonomyNodeOut:
    if child_count is None:
        child_count = (
            db.query(func.count(TaxonomyNode.id))
            .filter(TaxonomyNode.parent_id == node.id)
            .scalar()
            or 0
        )
    return TaxonomyNodeOut(
        id=node.id,
        scheme=_scheme_str(node.scheme),
        parent_id=node.parent_id,
        code=node.code or "",
        name=node.name,
        path=node.path,
        sort_order=getattr(node, "sort_order", 0) or 0,
        description=node.description or "",
        clip_count=_browse_count(db, node, pack_count=pack_count),
        child_count=child_count,
    )


def _next_sort_order(db: Session, scheme: str, parent_id: int | None) -> int:
    q = db.query(func.coalesce(func.max(TaxonomyNode.sort_order), -1)).filter(
        TaxonomyNode.scheme == scheme
    )
    if parent_id is None:
        q = q.filter(TaxonomyNode.parent_id.is_(None))
    else:
        q = q.filter(TaxonomyNode.parent_id == parent_id)
    return int(q.scalar() or -1) + 1


def _child_code(parent_code: str, index: int) -> str:
    """统一编码：根字母下一级为 A1/A2；更深为 A1.1 / A1.1.1。"""
    if not parent_code:
        return str(index)
    if len(parent_code) == 1 and parent_code.isalpha():
        return f"{parent_code}{index}"
    return f"{parent_code}.{index}"


def _parse_child_index(parent_code: str, child_code: str) -> int | None:
    if not parent_code or not child_code:
        return None
    if len(parent_code) == 1 and parent_code.isalpha():
        tail = child_code[len(parent_code) :]
        if child_code.startswith(parent_code) and tail.isdigit():
            return int(tail)
        return None
    prefix = parent_code + "."
    if child_code.startswith(prefix):
        tail = child_code[len(prefix) :]
        if tail.isdigit():
            return int(tail)
    return None


def _rewrite_code_prefix(db: Session, scheme: str, old_prefix: str, new_prefix: str) -> None:
    if not old_prefix or old_prefix == new_prefix:
        return
    # 使用 startswith（自动转义），避免 LIKE 把临时码中的 _ 当成通配符
    rows = (
        db.query(TaxonomyNode)
        .filter(TaxonomyNode.scheme == scheme)
        .filter(
            (TaxonomyNode.code == old_prefix)
            | (TaxonomyNode.code.startswith(old_prefix + "."))
        )
        .all()
    )
    for row in rows:
        code = row.code or ""
        if code == old_prefix:
            row.code = new_prefix
        else:
            row.code = new_prefix + code[len(old_prefix) :]


def _letter_for_scheme_index(idx: int) -> str:
    """Tab 第 N 个标准 → A/B/C…；超过 26 个用 X1/X2…"""
    if 0 <= idx < 26:
        return chr(ord("A") + idx)
    return f"X{idx - 25}"


def _sync_scheme_code_prefixes_to_sort_order(db: Session) -> None:
    """按 sort_order 将各标准编码前缀重编为 A、B、C…，并级联改写节点 code。"""
    rows = list_schemes(db)
    if not rows:
        return
    # 两阶段，避免互换前缀时唯一约束/节点码互相覆盖
    for idx, row in enumerate(rows):
        old = (row.code_prefix or "").strip()
        temp = f"#{idx}"
        if old and old != temp:
            _rewrite_code_prefix(db, row.key, old, temp)
        row.code_prefix = temp
    db.flush()
    for idx, row in enumerate(rows):
        new_prefix = _letter_for_scheme_index(idx)
        temp = f"#{idx}"
        _rewrite_code_prefix(db, row.key, temp, new_prefix)
        row.code_prefix = new_prefix
    db.flush()


def _siblings_query(db: Session, scheme: str, parent_id: int | None):
    q = db.query(TaxonomyNode).filter(TaxonomyNode.scheme == scheme)
    if parent_id is None:
        return q.filter(TaxonomyNode.parent_id.is_(None))
    return q.filter(TaxonomyNode.parent_id == parent_id)


def _renumber_children(db: Session, scheme: str, parent_id: int | None) -> None:
    """按 sort_order 重编同级序号码，并级联更新子孙编码前缀。

    根级（parent_id=None）通常为体系根字母节点，只整理 sort_order，不改编码。
    """
    # 确保此前对本 session 的 sort_order 写入对后续查询可见
    db.flush()

    if parent_id is None:
        siblings = (
            _siblings_query(db, scheme, None)
            .order_by(TaxonomyNode.sort_order.asc(), TaxonomyNode.id.asc())
            .all()
        )
        for idx, node in enumerate(siblings):
            node.sort_order = idx
        return

    parent = db.get(TaxonomyNode, parent_id)
    if not parent or _scheme_str(parent.scheme) != scheme:
        return
    parent_code = (parent.code or "").strip()
    if not parent_code:
        siblings = (
            _siblings_query(db, scheme, parent_id)
            .order_by(TaxonomyNode.sort_order.asc(), TaxonomyNode.id.asc())
            .all()
        )
        for idx, node in enumerate(siblings):
            node.sort_order = idx
        return

    siblings = (
        _siblings_query(db, scheme, parent_id)
        .order_by(TaxonomyNode.sort_order.asc(), TaxonomyNode.id.asc())
        .all()
    )
    for idx, node in enumerate(siblings):
        node.sort_order = idx

    # 两阶段改码（临时码不含 LIKE 通配符），避免同级互换时前缀互相覆盖
    for node in siblings:
        old = (node.code or "").strip()
        if not old:
            continue
        _rewrite_code_prefix(db, scheme, old, f"~T{node.id}~")
    db.flush()

    for idx, node in enumerate(siblings, start=1):
        new_code = _child_code(parent_code, idx)
        temp = f"~T{node.id}~"
        current = (node.code or "").strip()
        if current == temp or current.startswith(temp + "."):
            _rewrite_code_prefix(db, scheme, temp, new_code)
        else:
            node.code = new_code
    db.flush()


def _scheme_out(db: Session, row: TaxonomySchemeDef) -> TaxonomySchemeOut:
    node_count = (
        db.query(func.count(TaxonomyNode.id))
        .filter(TaxonomyNode.scheme == row.key)
        .scalar()
        or 0
    )
    return TaxonomySchemeOut(
        key=row.key,
        name=row.name,
        code_prefix=row.code_prefix,
        sort_order=row.sort_order or 0,
        builtin=bool(row.builtin),
        description=row.description or "",
        created_at=row.created_at,
        node_count=int(node_count),
    )


def _require_registered_scheme(db: Session, key: str) -> TaxonomySchemeDef:
    ensure_builtin_schemes(db)
    row = get_scheme(db, key)
    if not row:
        raise HTTPException(status_code=400, detail=f"未知分类标准: {key}")
    return row


# ---------- Schemes ----------


@router.get("/schemes", response_model=list[TaxonomySchemeOut])
def get_schemes(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    ensure_builtin_schemes(db)
    ensure_default_custom_schemes(db)
    db.commit()
    return [_scheme_out(db, s) for s in list_schemes(db)]


@router.post("/schemes", response_model=TaxonomySchemeOut)
def create_scheme(
    body: TaxonomySchemeCreate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    ensure_builtin_schemes(db)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="名称不能为空")
    if "/" in name:
        raise HTTPException(status_code=400, detail="名称不能包含 /")

    key = (body.key or "").strip().lower() or scheme_key_from_name(name)
    key = unique_scheme_key(db, key)
    if key in BUILTIN_KEYS:
        raise HTTPException(status_code=400, detail="不能覆盖内置分类标准 key")

    # 临时前缀，创建后按 Tab 排序统一重编为 A/B/C…
    prefix = next_code_prefix(db)

    sort_order = (
        body.sort_order
        if body.sort_order is not None
        else int(
            db.query(func.coalesce(func.max(TaxonomySchemeDef.sort_order), -1)).scalar() or -1
        )
        + 1
    )
    row = TaxonomySchemeDef(
        key=key,
        name=name,
        code_prefix=prefix,
        sort_order=sort_order,
        builtin=False,
        description=body.description or "",
    )
    db.add(row)
    db.flush()

    # create empty root node named after the scheme
    root_path = normalize_path(f"/{name}/")
    if not db.query(TaxonomyNode).filter(
        TaxonomyNode.scheme == key, TaxonomyNode.path == root_path
    ).first():
        db.add(
            TaxonomyNode(
                scheme=key,
                parent_id=None,
                code=prefix,
                name=name,
                path=root_path,
                sort_order=0,
                description="",
            )
        )

    _sync_scheme_code_prefixes_to_sort_order(db)

    write_audit(
        db,
        user_id=admin.id,
        action="create",
        entity_type="taxonomy_scheme",
        entity_id=None,
        detail={"key": key, "name": name, "code_prefix": row.code_prefix},
    )
    db.commit()
    db.refresh(row)
    return _scheme_out(db, row)


@router.patch("/schemes/{key}", response_model=TaxonomySchemeOut)
def update_scheme(
    key: str,
    body: TaxonomySchemeUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    row = _require_registered_scheme(db, key)
    data = body.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        name = data["name"].strip()
        if not name or "/" in name:
            raise HTTPException(status_code=400, detail="无效名称")
        old_name = row.name
        row.name = name
        # Sync root node name/path when it still matches the old scheme title
        if name != old_name:
            roots = (
                db.query(TaxonomyNode)
                .filter(TaxonomyNode.scheme == key, TaxonomyNode.parent_id.is_(None))
                .all()
            )
            for root in roots:
                if root.name != old_name:
                    continue
                old_path = root.path
                new_path = normalize_path(f"/{name}/")
                clash = (
                    db.query(TaxonomyNode)
                    .filter(
                        TaxonomyNode.scheme == key,
                        TaxonomyNode.path == new_path,
                        TaxonomyNode.id != root.id,
                    )
                    .first()
                )
                if clash:
                    raise HTTPException(
                        status_code=400,
                        detail="重命名后的根路径与已有节点冲突",
                    )
                descendants = (
                    db.query(TaxonomyNode)
                    .filter(
                        TaxonomyNode.scheme == key,
                        TaxonomyNode.path.like(f"{old_path}%"),
                    )
                    .order_by(TaxonomyNode.path.desc())
                    .all()
                )
                for d in descendants:
                    suffix = d.path[len(old_path) :]
                    d.path = new_path + suffix
                    if d.id == root.id:
                        d.name = name
    if "description" in data and data["description"] is not None:
        row.description = data["description"] or ""
    if "sort_order" in data and data["sort_order"] is not None:
        row.sort_order = int(data["sort_order"])
        _sync_scheme_code_prefixes_to_sort_order(db)
    if "code_prefix" in data and data["code_prefix"] is not None:
        # 编码前缀由 Tab 排序决定，禁止手改
        raise HTTPException(
            status_code=400,
            detail="编码前缀随上方 Tab 排序自动为 A/B/C…，请用左移/右移调整",
        )
    write_audit(
        db,
        user_id=admin.id,
        action="update",
        entity_type="taxonomy_scheme",
        entity_id=None,
        detail={"key": key, "fields": {k: v for k, v in data.items() if k != "code_prefix"}},
    )
    db.commit()
    db.refresh(row)
    return _scheme_out(db, row)


@router.put("/schemes/reorder", response_model=list[TaxonomySchemeOut])
def reorder_schemes(
    body: TaxonomySchemeReorder,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """Reorder schemes by ordered_keys list (full or partial)."""
    ensure_builtin_schemes(db)
    ordered_keys = [str(k) for k in body.ordered_keys]
    all_rows = list_schemes(db)
    by_key = {r.key: r for r in all_rows}
    missing = [k for k in ordered_keys if k not in by_key]
    if missing:
        raise HTTPException(status_code=400, detail=f"未知分类标准: {missing[0]}")
    # listed keys first in given order; any omitted keep relative order after
    rest = [r.key for r in all_rows if r.key not in set(ordered_keys)]
    final = ordered_keys + rest
    for idx, key in enumerate(final):
        by_key[key].sort_order = idx
    db.flush()
    _sync_scheme_code_prefixes_to_sort_order(db)
    write_audit(
        db,
        user_id=admin.id,
        action="reorder",
        entity_type="taxonomy_scheme",
        entity_id=None,
        detail={
            "ordered_keys": final,
            "prefixes": {r.key: r.code_prefix for r in list_schemes(db)},
        },
    )
    db.commit()
    return [_scheme_out(db, s) for s in list_schemes(db)]


@router.delete("/schemes/{key}")
def delete_scheme(
    key: str,
    cascade: bool = Query(False, description="为 true 时级联删除节点与条目标签"),
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    row = _require_registered_scheme(db, key)
    if row.builtin or key in BUILTIN_KEYS:
        raise HTTPException(status_code=400, detail="不能删除内置分类标准")

    node_count = (
        db.query(func.count(TaxonomyNode.id)).filter(TaxonomyNode.scheme == key).scalar() or 0
    )
    if node_count and not cascade:
        raise HTTPException(
            status_code=400,
            detail=f"该标准下仍有 {node_count} 个节点；如需删除请传 cascade=true",
        )

    if cascade and node_count:
        db.query(ClipTaxonomyTag).filter(ClipTaxonomyTag.scheme == key).delete(
            synchronize_session=False
        )
        nodes = (
            db.query(TaxonomyNode)
            .filter(TaxonomyNode.scheme == key)
            .order_by(TaxonomyNode.path.desc())
            .all()
        )
        for n in nodes:
            db.delete(n)

    write_audit(
        db,
        user_id=admin.id,
        action="delete",
        entity_type="taxonomy_scheme",
        entity_id=None,
        detail={"key": key, "cascade": cascade},
    )
    db.delete(row)
    db.flush()
    _sync_scheme_code_prefixes_to_sort_order(db)
    db.commit()
    return {"ok": True, "key": key}


# ---------- Nodes ----------


@router.get("", response_model=list[TaxonomyNodeOut])
def list_taxonomies(
    scheme: str | None = Query(None),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    q = db.query(TaxonomyNode)
    if scheme is not None:
        q = q.filter(TaxonomyNode.scheme == scheme)
    nodes = q.order_by(
        TaxonomyNode.scheme.asc(),
        TaxonomyNode.sort_order.asc(),
        TaxonomyNode.name.asc(),
        TaxonomyNode.id.asc(),
    ).all()
    by_scheme: dict[str, list[TaxonomyNode]] = defaultdict(list)
    for n in nodes:
        by_scheme[_scheme_str(n.scheme)].append(n)
    pack_by_node: dict[int, int] = {}
    for sk, snodes in by_scheme.items():
        pack_by_node.update(subtree_pack_counts(snodes, pack_exact_sets(db, sk)))
    child_counts: dict[int, int] = defaultdict(int)
    for n in nodes:
        if n.parent_id is not None:
            child_counts[n.parent_id] += 1
    return [
        _node_out(
            db,
            n,
            pack_count=pack_by_node.get(n.id, 0),
            child_count=child_counts.get(n.id, 0),
        )
        for n in nodes
    ]


@router.post("/nodes", response_model=TaxonomyNodeOut)
def create_node(
    body: TaxonomyNodeCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_taxonomy_write(db, user)
    scheme = body.scheme.strip()
    scheme_def = _require_registered_scheme(db, scheme)

    parent = None
    parent_path = None
    if body.parent_id is not None:
        parent = db.get(TaxonomyNode, body.parent_id)
        if not parent:
            raise HTTPException(status_code=404, detail="父节点不存在")
        if _scheme_str(parent.scheme) != scheme:
            raise HTTPException(status_code=400, detail="父节点分类体系不匹配")
        parent_path = parent.path
    try:
        path = join_folder_path(parent_path, body.name.strip())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    if db.query(TaxonomyNode).filter(
        TaxonomyNode.scheme == scheme, TaxonomyNode.path == path
    ).first():
        raise HTTPException(status_code=400, detail="同路径节点已存在")

    code = (body.code or "").strip()
    if not code:
        root_letter = scheme_def.code_prefix or "X"
        if parent is None:
            code = root_letter
        elif parent.code:
            siblings = (
                db.query(TaxonomyNode)
                .filter(TaxonomyNode.parent_id == parent.id)
                .all()
            )
            max_n = 0
            for s in siblings:
                n = _parse_child_index(parent.code, s.code or "")
                if n is not None:
                    max_n = max(max_n, n)
            code = _child_code(parent.code, max_n + 1)
        else:
            code = ""

    node = TaxonomyNode(
        scheme=scheme,
        parent_id=parent.id if parent else None,
        code=code,
        name=body.name.strip(),
        path=path,
        description=body.description or "",
        sort_order=(
            body.sort_order
            if body.sort_order is not None
            else _next_sort_order(db, scheme, parent.id if parent else None)
        ),
    )
    db.add(node)
    db.flush()
    write_audit(
        db,
        user_id=user.id,
        action="create",
        entity_type="taxonomy_node",
        entity_id=node.id,
        detail=body.model_dump(),
    )
    db.commit()
    db.refresh(node)
    return _node_out(db, node)


@router.put("/nodes/reorder", response_model=list[TaxonomyNodeOut])
def reorder_nodes(
    body: TaxonomyNodeReorder,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """同级重排；默认按新顺序重编号码（含子树前缀）。"""
    if body.parent_id is not None:
        parent = db.get(TaxonomyNode, body.parent_id)
        if not parent:
            raise HTTPException(status_code=404, detail="父节点不存在")
        scheme = _scheme_str(parent.scheme)
    else:
        if not body.ordered_ids:
            raise HTTPException(status_code=400, detail="排序列表为空")
        first = db.get(TaxonomyNode, body.ordered_ids[0])
        if not first:
            raise HTTPException(status_code=400, detail="排序列表无效")
        if first.parent_id is not None:
            raise HTTPException(status_code=400, detail="排序列表包含非同级节点")
        scheme = _scheme_str(first.scheme)

    siblings = _siblings_query(db, scheme, body.parent_id).all()
    sibling_ids = {s.id for s in siblings}
    if set(body.ordered_ids) - sibling_ids:
        raise HTTPException(status_code=400, detail="排序列表包含非同级节点")
    remaining = [
        s.id
        for s in sorted(siblings, key=lambda x: (x.sort_order, x.id))
        if s.id not in set(body.ordered_ids)
    ]
    final_ids = list(body.ordered_ids) + remaining
    by_id = {s.id: s for s in siblings}
    for idx, nid in enumerate(final_ids):
        by_id[nid].sort_order = idx

    if body.renumber_codes:
        _renumber_children(db, scheme, body.parent_id)

    write_audit(
        db,
        user_id=admin.id,
        action="reorder",
        entity_type="taxonomy_node",
        entity_id=body.parent_id,
        detail={
            "ordered_ids": final_ids,
            "scheme": scheme,
            "renumber_codes": body.renumber_codes,
        },
    )
    db.commit()
    nodes = (
        db.query(TaxonomyNode)
        .filter(TaxonomyNode.scheme == scheme)
        .order_by(
            TaxonomyNode.sort_order.asc(),
            TaxonomyNode.name.asc(),
            TaxonomyNode.id.asc(),
        )
        .all()
    )
    return [_node_out(db, n) for n in nodes]


@router.patch("/nodes/{node_id}", response_model=TaxonomyNodeOut)
def update_node(
    node_id: int,
    body: TaxonomyNodeUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    node = db.get(TaxonomyNode, node_id)
    if not node:
        raise HTTPException(status_code=404, detail="节点不存在")

    data = body.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(status_code=400, detail="无更新字段")

    new_name = node.name if "name" not in data else (data["name"] or "").strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="名称不能为空")
    new_parent_id = data["parent_id"] if "parent_id" in data else node.parent_id
    scheme = _scheme_str(node.scheme)

    parent = None
    parent_path = None
    if new_parent_id is not None:
        if new_parent_id == node.id:
            raise HTTPException(status_code=400, detail="不能将节点移动到自身下")
        parent = db.get(TaxonomyNode, new_parent_id)
        if not parent:
            raise HTTPException(status_code=404, detail="父节点不存在")
        if _scheme_str(parent.scheme) != scheme:
            raise HTTPException(status_code=400, detail="父节点分类体系不匹配")
        if normalize_path(parent.path).startswith(normalize_path(node.path)):
            raise HTTPException(status_code=400, detail="不能将节点移动到其子路径下")
        parent_path = parent.path

    try:
        new_path = join_folder_path(parent_path, new_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    old_path = node.path
    old_parent_id = node.parent_id
    parent_changed = new_parent_id != node.parent_id
    if new_path != old_path:
        clash = (
            db.query(TaxonomyNode)
            .filter(
                TaxonomyNode.scheme == scheme,
                TaxonomyNode.path == new_path,
                TaxonomyNode.id != node.id,
            )
            .first()
        )
        if clash:
            raise HTTPException(status_code=400, detail="目标路径已存在同名节点")

    descendants = (
        db.query(TaxonomyNode)
        .filter(TaxonomyNode.scheme == scheme, TaxonomyNode.path.like(f"{old_path}%"))
        .order_by(TaxonomyNode.path.desc())
        .all()
    )
    for d in descendants:
        suffix = d.path[len(old_path) :]
        d.path = new_path + suffix
        if d.id == node.id:
            d.name = new_name
            d.parent_id = new_parent_id
            if "code" in data and data["code"] is not None:
                d.code = (data["code"] or "").strip()
            if "description" in data and data["description"] is not None:
                d.description = data["description"] or ""
            if parent_changed:
                d.sort_order = _next_sort_order(db, scheme, new_parent_id)
            elif "sort_order" in data and data["sort_order"] is not None:
                d.sort_order = int(data["sort_order"])

    # 移动后按同级顺序重编号码；手动改 code 时跳过目标父级重编
    manual_code = "code" in data and data["code"] is not None
    if parent_changed:
        _renumber_children(db, scheme, old_parent_id)
        if not manual_code:
            _renumber_children(db, scheme, new_parent_id)
    elif "sort_order" in data and data["sort_order"] is not None and not manual_code:
        _renumber_children(db, scheme, node.parent_id)

    write_audit(
        db,
        user_id=admin.id,
        action="update",
        entity_type="taxonomy_node",
        entity_id=node.id,
        detail={"old_path": old_path, "new_path": new_path, "fields": data},
    )
    db.commit()
    db.refresh(node)
    return _node_out(db, node)


@router.delete("/nodes/{node_id}")
def delete_node(
    node_id: int,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    node = db.get(TaxonomyNode, node_id)
    if not node:
        raise HTTPException(status_code=404, detail="节点不存在")
    child = db.query(TaxonomyNode).filter(TaxonomyNode.parent_id == node_id).first()
    if child:
        raise HTTPException(status_code=400, detail="请先删除子节点")
    used = (
        db.query(ClipTaxonomyTag.id)
        .filter(ClipTaxonomyTag.node_id == node_id)
        .first()
    )
    if not used:
        used = (
            db.query(MotionClip.id)
            .filter(
                (MotionClip.atomic_tag_id == node_id)
                | (MotionClip.intent_tag_id == node_id)
                | (MotionClip.style_tag_id == node_id)
            )
            .first()
        )
    if used:
        raise HTTPException(status_code=400, detail="仍有条目使用该标签，禁止删除")

    scheme = _scheme_str(node.scheme)
    parent_id = node.parent_id
    write_audit(
        db,
        user_id=admin.id,
        action="delete",
        entity_type="taxonomy_node",
        entity_id=node_id,
        detail={"path": node.path, "scheme": scheme},
    )
    db.delete(node)
    db.flush()
    _renumber_children(db, scheme, parent_id)
    db.commit()
    return {"ok": True}
