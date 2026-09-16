"""Normalize filenames into data-unit names.

Files with the same stem belong to the same unit. If the stem contains a
role token such as ``skeleton``, ``rigid body`` or ``marker``, the unit name
is the text before that token, so ``XXXX_skeleton_0`` and ``XXXX_marker003``
share the unit ``XXXX``.
"""

from __future__ import annotations

import re

_UNIT_ROLE_SUFFIX = re.compile(
    r"(?:[\s._-]+|\.[A-Za-z0-9]{1,8}[\s._-]*)"
    r"(?:skeleton|rigid[\s._-]*bod(?:y|ies)|marker)"
    r".*$",
    re.I,
)


def normalize_unit_stem(name: str) -> str:
    stem = str(name or "").strip()
    if not stem:
        return ""
    cleaned = _UNIT_ROLE_SUFFIX.sub("", stem).strip(" ._")
    return cleaned or stem


def stems_same_unit(left: str, right: str) -> bool:
    a = normalize_unit_stem(left)
    b = normalize_unit_stem(right)
    return bool(a) and a == b


def cluster_unit_names(names: list[str]) -> dict[str, str]:
    """Map each name to the normalized unit it belongs to."""
    mapping: dict[str, str] = {}
    for name in names:
        mapping[name] = normalize_unit_stem(name) or name
    return mapping
