"""Taxonomy scheme registry helpers and clip↔tag sync."""

from __future__ import annotations

import re

from sqlalchemy.orm import Session

from ..models import ClipTaxonomyTag, MotionClip, TaxonomyNode, TaxonomySchemeDef
from ..models.enums import BUILTIN_TAXONOMY_SCHEMES, TaxonomyScheme

BUILTIN_KEYS = {k for k, *_ in BUILTIN_TAXONOMY_SCHEMES}
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
            if not row.name:
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
