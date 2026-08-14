"""Helpers to read taxonomy tags from hub_repo files / action units."""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from sqlalchemy.orm import Session, joinedload

from ..models import RepoFile, TaxonomyNode


def scheme_str(scheme: Any) -> str:
    return scheme.value if hasattr(scheme, "value") else str(scheme)


def repo_file_tag_id(rf: RepoFile, scheme: str) -> int | None:
    """Read taxonomy node id for a scheme from file meta or action_def."""
    meta = rf.meta or {}
    ids = meta.get("taxonomy_tag_ids") or {}
    raw = ids.get(scheme)
    if raw is not None and raw != "":
        try:
            return int(raw)
        except (TypeError, ValueError):
            pass
    unit = rf.action_unit
    adef = (unit.action_def if unit else {}) or {}
    tax = adef.get("taxonomy") or {}
    brief = tax.get(scheme)
    if isinstance(brief, dict) and brief.get("id") is not None:
        try:
            return int(brief["id"])
        except (TypeError, ValueError):
            pass
    return None


def pack_exact_sets(db: Session, scheme: str) -> dict[int, set[tuple[str, str, str]]]:
    """Exact tag_id -> set of pack keys (modality, ontology, source_name)."""
    rows = (
        db.query(RepoFile)
        .options(joinedload(RepoFile.action_unit))
        .all()
    )
    out: dict[int, set[tuple[str, str, str]]] = defaultdict(set)
    for rf in rows:
        tid = repo_file_tag_id(rf, scheme)
        if tid is not None:
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
