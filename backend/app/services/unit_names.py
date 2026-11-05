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
    r"(?:skeleton|rigid[\s._-]*bod(?:y|ies)|marker|merged)"
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


ORIGINAL_FILE_VERSION = "原版"
FILE_VERSION_DIR = ".file_versions"


def split_file_version(parts: tuple[str, ...] | list[str]) -> tuple[str, list[str]]:
    """Split ``.file_versions/<name>/...`` off the path after a batch directory.

    The version directory is only recognized when a file still follows the
    version name, so a batch file itself is never treated as a version.
    """
    items = [str(part) for part in parts]
    if (
        len(items) >= 3
        and items[0] == FILE_VERSION_DIR
        and items[1] not in {"", ".", ".."}
        and "/" not in items[1]
        and "\\" not in items[1]
    ):
        return items[1], items[2:]
    return ORIGINAL_FILE_VERSION, items


def file_version_from_path(path: str) -> str:
    parts = [part for part in str(path or "").replace("\\", "/").split("/") if part]
    try:
        index = parts.index(FILE_VERSION_DIR)
    except ValueError:
        return ORIGINAL_FILE_VERSION
    if index + 2 >= len(parts):
        return ORIGINAL_FILE_VERSION
    name = parts[index + 1]
    if not name or name in {".", ".."}:
        return ORIGINAL_FILE_VERSION
    return name
