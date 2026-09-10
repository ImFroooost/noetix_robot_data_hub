"""Decode ZIP entry names that Windows stored as GBK/UTF-8 without the UTF-8 flag."""

from __future__ import annotations

import zipfile

_MOJIBAKE = frozenset("Ññº°µß²íóτΓδσφΦΣΘ")


def decode_zip_filename(info: zipfile.ZipInfo) -> str:
    stored = (info.filename or "").replace("\\", "/")
    if info.flag_bits & 0x800:
        return stored
    try:
        raw = stored.encode("cp437")
    except UnicodeEncodeError:
        return stored
    try:
        return raw.decode("utf-8").replace("\\", "/")
    except UnicodeDecodeError:
        pass
    try:
        candidate = raw.decode("gb18030").replace("\\", "/")
    except UnicodeDecodeError:
        return stored
    if _name_score(candidate) > _name_score(stored):
        return candidate
    return stored


def _name_score(name: str) -> tuple[int, int, int]:
    cjk = sum(1 for char in name if "\u4e00" <= char <= "\u9fff")
    junk = sum(
        1
        for char in name
        if char in _MOJIBAKE
        or "\u0370" <= char <= "\u03ff"
        or "\u2500" <= char <= "\u257f"
        or char == "�"
    )
    return (cjk, -junk, -name.count("�"))
