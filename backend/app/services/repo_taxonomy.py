"""Helpers to read taxonomy tags from hub_repo files / action units."""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from sqlalchemy.orm import Session, joinedload

from ..models import RepoFile, TaxonomyNode


def scheme_str(scheme: Any) -> str:
    return scheme.value if hasattr(scheme, "value") else str(scheme)


def _ids_from_value(raw: Any) -> list[int]:
    items = raw if isinstance(raw, list) else [raw]
    out: list[int] = []
    for item in items:
        if isinstance(item, dict):
            item = item.get("id")
        if item in (None, ""):
            continue
        try:
            number = int(item)
        except (TypeError, ValueError):
            continue
        if number > 0 and number not in out:
            out.append(number)
    return out


def repo_file_tag_ids(rf: RepoFile, scheme: str) -> list[int]:
    """Read taxonomy node ids for a scheme from file meta or action_def."""
    meta = rf.meta or {}
    ids = meta.get("taxonomy_tag_ids") or {}
    found = _ids_from_value(ids.get(scheme))
    if found:
        return found
    unit = rf.action_unit
    adef = (unit.action_def if unit else {}) or {}
    tax = adef.get("taxonomy") or {}
    return _ids_from_value(tax.get(scheme))


def repo_file_tag_id(rf: RepoFile, scheme: str) -> int | None:
    """Read the first taxonomy node id for a scheme from file meta or action_def."""
    found = repo_file_tag_ids(rf, scheme)
    return found[0] if found else None


def pack_exact_sets(db: Session, scheme: str) -> dict[int, set[tuple[str, str, str]]]:
    """Exact tag_id -> set of pack keys (modality, ontology, source_name)."""
    rows = (
        db.query(RepoFile)
        .options(joinedload(RepoFile.action_unit))
        .all()
    )
    out: dict[int, set[tuple[str, str, str]]] = defaultdict(set)
    for rf in rows:
        for tid in repo_file_tag_ids(rf, scheme):
            out[tid].add((rf.modality, rf.ontology, rf.source_name or ""))
    return out


def subtree_pack_counts(
    nodes: list[TaxonomyNode],
    exact: dict[int, set[tuple[str, str, str]]],
) -> dict[int, int]:
    """For each node, count distinct packs tagged on the node or any descendant."""
    children: dict[int | None, list[int]] = defaultdict(list)
    for n in nodes:
        children[n.parent_id].append(n.id)

    memo: dict[int, set[tuple[str, str, str]]] = {}

    def packs_under(nid: int) -> set[tuple[str, str, str]]:
        if nid in memo:
            return memo[nid]
        s = set(exact.get(nid) or ())
        for cid in children.get(nid, []):
            s |= packs_under(cid)
        memo[nid] = s
        return s

    return {n.id: len(packs_under(n.id)) for n in nodes}
