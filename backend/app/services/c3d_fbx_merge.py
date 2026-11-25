"""Merge ChingMU / motion-capture C3D optical markers into same-named FBX files.

Follows the exact binary FBX merge algorithm from ``merge_c3d_pingpong.py``:
- Shifts ChingMU rest-key curves by one frame tick (dynamically read from the
  FBX curve ``KeyTime`` so 120fps, 300fps, etc. all work identically).
- Reads optical marker trajectories from the paired ``.c3d`` file, transforms
  coordinates ``(-x * 0.1, z * 0.1, y * 0.1)`` into the FBX centimetre Y-up
  frame, linearly interpolates gaps, and writes ``C3D:optical`` +
  ``C3D:<label>`` ``OpticalMarker`` nodes with ``T``, ``R``, ``Visibility``,
  and ``Occlusion`` curves.
- Normalizes skeleton hierarchy (``Skeleton_<idx>_*`` -> ``Skeleton <idx:03d>_*``
  under ``Skeleton <idx:03d>_Root``) and rigid-body ``_Root`` / ``_Bone`` nodes
  into MotionBuilder 2018 FBX 7500 layout.
"""

from __future__ import annotations

import array
import copy
import io
import os
import struct
import zlib
from collections import Counter, namedtuple
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Iterable

import numpy as np

from .motion_units import _content_dirs, _wrapper_prefixes

VERSION = 7500
MAGIC = b"Kaydara FBX Binary  \x00\x1a\x00"
SENTINEL_7500 = b"\x00" * 25
ALWAYS = {b"AnimationStack", b"AnimationLayer"}
FOOT = bytes.fromhex("fabcaa0cd5c9d56bbd7ef28914f52377")
TAIL_MAGIC = bytes.fromhex("f85a8c6adef5d97eece90ce3758f290b")
CREATOR = b"FBX SDK/FBX Plugins version 2018.1.1 build=20170505"
CREATOR_SHORT = b"FBX SDK/FBX Plugins version 2018.1.1"
ATTR_DATA = array.array("f")
ATTR_DATA.frombytes(bytes.fromhex("0000000000000000050d050d00000000"))

L, S, I, C, D = (ord(ch) for ch in "LSICD")

FBXElem = namedtuple("FBXElem", ("id", "props", "props_type", "elems"))

_ARRAY_READERS = {
    b"f": ("f", 4),
    b"i": ("i", 4),
    b"d": ("d", 8),
    b"l": ("q", 8),
    b"b": ("b", 1),
    b"c": ("B", 1),
}


def _unpack_one(read_fn, fmt: str):
    size = struct.calcsize(fmt)
    data = read_fn(size)
    if len(data) != size:
        raise EOFError("Unexpected EOF while reading FBX binary stream")
    return struct.unpack(fmt, data)[0]


def _read_fbx_array(read_fn, array_type: str, length_bytes: int, is_byteswap: bool) -> array.array:
    length = _unpack_one(read_fn, "<I")
    encoding = _unpack_one(read_fn, "<I")
    comp_len = _unpack_one(read_fn, "<I")
    data = read_fn(comp_len)
    if len(data) != comp_len:
        raise EOFError("Unexpected EOF while reading FBX array payload")
    if encoding == 1:
        data = zlib.decompress(data)
    if length * length_bytes != len(data):
        raise ValueError("FBX array byte size mismatch")
    arr = array.array(array_type)
    arr.frombytes(data)
    if is_byteswap:
        arr.byteswap()
    return arr


def _read_prop(read_fn, data_type: bytes, is_byteswap: bool):
    if data_type == b"Z":
        return _unpack_one(read_fn, "<b")
    if data_type == b"Y":
        return _unpack_one(read_fn, "<h")
    if data_type == b"I":
        return _unpack_one(read_fn, "<i")
    if data_type == b"F":
        return _unpack_one(read_fn, "<f")
    if data_type == b"D":
        return _unpack_one(read_fn, "<d")
    if data_type == b"L":
        return _unpack_one(read_fn, "<q")
    if data_type == b"C":
        return _unpack_one(read_fn, "?")
    if data_type in (b"R", b"S"):
        length = _unpack_one(read_fn, "<I")
        raw = read_fn(length)
        if len(raw) != length:
            raise EOFError("Unexpected EOF while reading FBX string/bytes property")
        return raw
    spec = _ARRAY_READERS.get(data_type)
    if spec is not None:
        return _read_fbx_array(read_fn, spec[0], spec[1], is_byteswap)
    raise ValueError(f"Unsupported FBX property type: {data_type!r}")


def parse_fbx_stream(stream: BinaryIO) -> tuple[FBXElem, int]:
    """Thread-safe pure-Python binary FBX parser matching Blender's ``fbx2json``."""
    read = stream.read
    tell = stream.tell
    if read(len(MAGIC)) != MAGIC:
        raise ValueError("Invalid FBX binary header")
    fbx_version = _unpack_one(read, "<I")
    if fbx_version < 7500:
        uint_fmt = "<I"
        sentinel_len = 13
    else:
        uint_fmt = "<Q"
        sentinel_len = 25
    sentinel_data = b"\x00" * sentinel_len
    is_byteswap = array.array("i", [1]).tobytes()[0] != 1

    def read_elem() -> FBXElem | None:
        end_offset = _unpack_one(read, uint_fmt)
        if end_offset == 0:
            if read(sentinel_len - (4 if fbx_version < 7500 else 8)) != sentinel_data[
                (4 if fbx_version < 7500 else 8) :
            ]:
                raise ValueError("Corrupt FBX block sentinel")
            return None
        prop_count = _unpack_one(read, uint_fmt)
        prop_bytes_len = _unpack_one(read, uint_fmt)
        id_len = _unpack_one(read, "B")
        elem_id = read(id_len)
        props: list = []
        props_type = bytearray(prop_count)
        for idx in range(prop_count):
            dtype = read(1)
            props.append(_read_prop(read, dtype, is_byteswap))
            props_type[idx] = dtype[0]
        elems: list[FBXElem] = []
        if tell() < end_offset:
            while tell() < (end_offset - sentinel_len):
                child = read_elem()
                if child is None:
                    break
                elems.append(child)
            if read(sentinel_len) != sentinel_data:
                raise ValueError("Expected FBX nested sentinel")
        if tell() != end_offset:
            raise ValueError("FBX scope length not reached")
        return FBXElem(elem_id, props, props_type, elems)

    root_elems: list[FBXElem] = []
    while True:
        elem = read_elem()
        if elem is None:
            break
        root_elems.append(elem)
    return FBXElem(b"", [], bytearray(0), root_elems), fbx_version


def parse_fbx(path: str | os.PathLike[str]) -> tuple[FBXElem, int]:
    with open(path, "rb") as fh:
        return parse_fbx_stream(fh)


def _binary_fbx_stream_has_c3d(stream: BinaryIO) -> bool:
    """Inspect only ``Objects -> Model / NodeAttribute`` headers without decompressing curves."""
    read = stream.read
    tell = stream.tell
    seek = stream.seek
    if read(len(MAGIC)) != MAGIC:
        return False
    fbx_version = _unpack_one(read, "<I")
    uint_fmt = "<I" if fbx_version < 7500 else "<Q"
    uint_size = 4 if fbx_version < 7500 else 8
    sentinel_len = 13 if fbx_version < 7500 else 25
    sentinel_tail = b"\x00" * (sentinel_len - uint_size)
    is_byteswap = array.array("i", [1]).tobytes()[0] != 1

    while True:
        end_offset = _unpack_one(read, uint_fmt)
        if end_offset == 0:
            return False
        prop_count = _unpack_one(read, uint_fmt)
        prop_bytes_len = _unpack_one(read, uint_fmt)
        id_len = _unpack_one(read, "B")
        elem_id = read(id_len)
        if elem_id != b"Objects":
            seek(end_offset)
            continue
        if prop_bytes_len:
            seek(prop_bytes_len, os.SEEK_CUR)
        while tell() < (end_offset - sentinel_len):
            child_end = _unpack_one(read, uint_fmt)
            if child_end == 0:
                if read(sentinel_len - uint_size) != sentinel_tail:
                    return False
                break
            c_prop_count = _unpack_one(read, uint_fmt)
            _c_prop_bytes = _unpack_one(read, uint_fmt)
            c_id_len = _unpack_one(read, "B")
            c_id = read(c_id_len)
            if c_id in (b"Model", b"NodeAttribute") and c_prop_count >= 3:
                props = []
                for _ in range(min(c_prop_count, 3)):
                    dtype = read(1)
                    props.append(_read_prop(read, dtype, is_byteswap))
                raw_name = props[1] if isinstance(props[1], (bytes, bytearray)) else b""
                raw_cls = props[2] if isinstance(props[2], (bytes, bytearray)) else b""
                short_name = bytes(raw_name).split(b"\x00\x01", 1)[0]
                if short_name.startswith(b"C3D:") or bytes(raw_cls) in (
                    b"Optical",
                    b"OpticalMarker",
                ):
                    return True
            seek(child_end)
        return False


def fbx_bytes_have_c3d(data: bytes) -> bool:
    """Return True if an FBX byte buffer already contains C3D optical marker data."""
    if not data:
        return False
    if data[: len(MAGIC)] == MAGIC:
        # In binary FBX, Model / NodeAttribute names and classes are stored as
        # uncompressed 'S' properties, so absence of both tokens guarantees False.
        if b"C3D:" not in data and b"Optical" not in data:
            return False
        try:
            return _binary_fbx_stream_has_c3d(io.BytesIO(data))
        except Exception:
            return b"C3D:" in data or b"OpticalMarker" in data
    # ASCII FBX fallback
    return (
        b'"Model::C3D:' in data
        or b"Model::C3D:" in data
        or b'"OpticalMarker"' in data
        or b'"Optical"' in data
    )


def fbx_file_has_c3d(path: str | os.PathLike[str]) -> bool:
    """Return True if the FBX file at ``path`` already contains C3D optical marker data."""
    p = Path(path)
    if not p.is_file():
        return False
    with p.open("rb") as fh:
        head = fh.read(len(MAGIC))
        fh.seek(0)
        if head == MAGIC:
            try:
                return _binary_fbx_stream_has_c3d(fh)
            except Exception:
                fh.seek(0)
                return fbx_bytes_have_c3d(fh.read())
        return fbx_bytes_have_c3d(fh.read())


def pair_fbx_and_c3d_paths(rel_paths: Iterable[str]) -> list[tuple[str, str]]:
    """Find same-named ``(fbx_rel, c3d_rel)`` pairs in a folder or archive.

    Strips top-level archive wrappers and format-container folders such as
    ``20261124_PP_FBX`` / ``20261124_PP_C3D`` (matching ``motion_units.py``),
    with a fallback unique-stem match when custom directory names are used.
    """
    cleaned = [str(rel).strip().strip("/").replace("\\", "/") for rel in rel_paths if str(rel).strip()]
    if not cleaned:
        return []
    wrappers = _wrapper_prefixes(cleaned)
    fbx_by_key: dict[tuple[tuple[str, ...], str], list[str]] = {}
    c3d_by_key: dict[tuple[tuple[str, ...], str], list[str]] = {}
    for rel in cleaned:
        p = PurePosixPath(rel)
        ext = p.suffix.lower().lstrip(".")
        if ext not in ("fbx", "c3d"):
            continue
        stem_key = p.stem.strip().lower()
        if not stem_key:
            continue
        cdir = _content_dirs(rel, wrappers)
        key = (cdir, stem_key)
        if ext == "fbx":
            fbx_by_key.setdefault(key, []).append(rel)
        else:
            c3d_by_key.setdefault(key, []).append(rel)

    pairs: list[tuple[str, str]] = []
    matched_fbx: set[str] = set()
    matched_c3d: set[str] = set()
    for key, fbx_list in fbx_by_key.items():
        c3d_list = c3d_by_key.get(key)
        if not c3d_list:
            continue
        if len(fbx_list) == 1 and len(c3d_list) == 1:
            pairs.append((fbx_list[0], c3d_list[0]))
            matched_fbx.add(fbx_list[0])
            matched_c3d.add(c3d_list[0])

    # Fallback: match remaining unique stems across custom folder names
    rem_fbx_by_stem: dict[str, list[str]] = {}
    rem_c3d_by_stem: dict[str, list[str]] = {}
    for rel in cleaned:
        p = PurePosixPath(rel)
        ext = p.suffix.lower().lstrip(".")
        stem_key = p.stem.strip().lower()
        if not stem_key:
            continue
        if ext == "fbx" and rel not in matched_fbx:
            rem_fbx_by_stem.setdefault(stem_key, []).append(rel)
        elif ext == "c3d" and rel not in matched_c3d:
            rem_c3d_by_stem.setdefault(stem_key, []).append(rel)
    for stem_key, fbx_list in rem_fbx_by_stem.items():
        c3d_list = rem_c3d_by_stem.get(stem_key)
        if c3d_list and len(fbx_list) == 1 and len(c3d_list) == 1:
            pairs.append((fbx_list[0], c3d_list[0]))

    return pairs


def _elem(eid: bytes, props: list, types: Iterable[int], children: list[FBXElem] | None = None) -> FBXElem:
    return FBXElem(eid, list(props), bytearray(types), list(children or []))


def _enc_prop(typ: int, val) -> bytes:
    if typ == C:
        return struct.pack("?", bool(val))
    if typ == ord("Z"):
        return struct.pack("<b", int(val))
    if typ == ord("Y"):
        return struct.pack("<h", int(val))
    if typ == I:
        return struct.pack("<i", int(val))
    if typ == ord("F"):
        return struct.pack("<f", float(val))
    if typ == D:
        return struct.pack("<d", float(val))
    if typ == L:
        return struct.pack("<q", int(val))
    if typ in (ord("R"), S):
        raw = bytes(val)
        return struct.pack("<I", len(raw)) + raw
    if typ in (ord("f"), ord("i"), ord("d"), ord("l"), ord("b"), ord("c")):
        raw = val.tobytes()
        n = len(val)
        if n > 128:
            comp = zlib.compress(raw, 1)
            return struct.pack("<III", n, 1, len(comp)) + comp
        return struct.pack("<III", n, 0, len(raw)) + raw
    raise TypeError(typ)


def _props_blob(elem: FBXElem) -> bytes:
    if len(elem.props) != len(elem.props_type):
        raise RuntimeError(f"prop length mismatch on {elem.id!r}")
    parts: list[bytes] = []
    for typ, val in zip(elem.props_type, elem.props):
        parts.append(bytes((typ,)))
        parts.append(_enc_prop(typ, val))
    return b"".join(parts)


def write_fbx(path: str | os.PathLike[str], root: FBXElem) -> None:
    meta: dict[int, tuple[int, bytes]] = {}

    def calc(elem: FBXElem, offset: int, is_last: bool) -> int:
        blob = _props_blob(elem)
        offset += 25 + len(elem.id) + len(blob)
        if elem.elems:
            last = len(elem.elems) - 1
            for i, child in enumerate(elem.elems):
                offset = calc(child, offset, i == last)
            offset += 25
        elif (not elem.props) or elem.id in ALWAYS:
            if not is_last:
                offset += 25
        meta[id(elem)] = (offset, blob)
        return offset

    def write_elem(fh: BinaryIO, elem: FBXElem, is_last: bool) -> None:
        end, blob = meta[id(elem)]
        fh.write(struct.pack("<QQQ", end, len(elem.props), len(blob)))
        fh.write(bytes((len(elem.id),)))
        fh.write(elem.id)
        fh.write(blob)
        if elem.elems:
            last = len(elem.elems) - 1
            for i, child in enumerate(elem.elems):
                write_elem(fh, child, i == last)
            fh.write(SENTINEL_7500)
        elif (not elem.props) or elem.id in ALWAYS:
            if not is_last:
                fh.write(SENTINEL_7500)
        if fh.tell() != end:
            raise RuntimeError(f"offset drift on {elem.id!r}")

    offset = len(MAGIC) + 4
    last = len(root.elems) - 1
    for i, child in enumerate(root.elems):
        offset = calc(child, offset, i == last)
    offset += 25
    with open(path, "wb") as fh:
        fh.write(MAGIC)
        fh.write(struct.pack("<I", VERSION))
        for i, child in enumerate(root.elems):
            write_elem(fh, child, i == last)
        fh.write(SENTINEL_7500)
        if fh.tell() != offset:
            raise RuntimeError("root offset drift")
        fh.write(FOOT)
        fh.write(b"\x00" * 8)
        fh.write(struct.pack("<I", VERSION))
        fh.write(b"\x00" * 120)
        fh.write(TAIL_MAGIC)


def _name_of(elem: FBXElem) -> bytes:
    return elem.props[1].split(b"\x00\x01")[0]


def _set_name(elem: FBXElem, name: bytes, suffix: bytes) -> None:
    elem.props[1] = name + b"\x00\x01" + suffix


def _find_child(elem: FBXElem, eid: bytes) -> FBXElem | None:
    for child in elem.elems:
        if child.id == eid:
            return child
    return None


def _objects_of(root: FBXElem) -> FBXElem:
    return next(e for e in root.elems if e.id == b"Objects")


def _conns_of(root: FBXElem) -> FBXElem:
    return next(e for e in root.elems if e.id == b"Connections")


def _index_ids(objects: FBXElem) -> dict[int, FBXElem]:
    return {
        int(e.props[0]): e
        for e in objects.elems
        if e.props and isinstance(e.props[0], int)
    }


def _oo_children(conns: FBXElem, parent: int) -> list[int]:
    return [
        int(c.props[1])
        for c in conns.elems
        if c.props[0] == b"OO" and int(c.props[2]) == parent
    ]


def _scene_link(conns: FBXElem, child: int) -> FBXElem | None:
    found = [
        c
        for c in conns.elems
        if c.props[0] == b"OO" and int(c.props[1]) == child and int(c.props[2]) == 0
    ]
    if len(found) > 1:
        raise RuntimeError(f"multiple scene parents for {child}")
    return found[0] if found else None


def _blank_null() -> FBXElem:
    return _elem(
        b"Model",
        [0, b"\x00\x01Model", b"Null"],
        [L, S, S],
        [
            _elem(b"Version", [232], [I]),
            _elem(
                b"Properties70",
                [],
                [],
                [
                    _elem(
                        b"P",
                        [b"ScalingMax", b"Vector3D", b"Vector", b"", 0.0, 0.0, 0.0],
                        [S, S, S, S, D, D, D],
                    ),
                ],
            ),
            _elem(b"Shading", [True], [C]),
            _elem(b"Culling", [b"CullingOff"], [S]),
        ],
    )


def _shift_take(root: FBXElem) -> tuple[int, int]:
    objects = _objects_of(root)
    nkeys: int | None = None
    tick: int | None = None
    for elem in objects.elems:
        if elem.id != b"AnimationCurve":
            continue
        times = values = flags = data = ref = None
        for child in elem.elems:
            if child.id == b"KeyTime":
                times = child
            elif child.id == b"KeyValueFloat":
                values = child
            elif child.id == b"KeyAttrFlags":
                flags = child
            elif child.id == b"KeyAttrDataFloat":
                data = child
            elif child.id == b"KeyAttrRefCount":
                ref = child
        if times is None or values is None or flags is None or data is None or ref is None:
            raise RuntimeError("incomplete AnimationCurve element")
        raw = times.props[0]
        if len(raw) < 2 or int(raw[0]) != 0:
            raise RuntimeError("curve does not start with the ChingMU rest key")
        cur_tick = int(raw[1])
        if cur_tick <= 0:
            raise RuntimeError(f"invalid FBX curve key tick: {cur_tick}")
        if tick is None:
            tick = cur_tick
        elif cur_tick != tick:
            raise RuntimeError("curve does not start with the ChingMU rest key")
        nt = array.array("q")
        nt.frombytes((np.asarray(raw[1:], dtype=np.int64) - tick).tobytes())
        nv = array.array("f")
        nv.frombytes(np.asarray(values.props[0][1:], dtype=np.float32).tobytes())
        times.props[0] = nt
        values.props[0] = nv
        flags.props[0] = array.array("i", [int(flags.props[0][0])])
        data.props[0] = array.array("f", list(data.props[0][:4]))
        ref.props[0] = array.array("i", [len(nt)])
        if nkeys is None:
            nkeys = len(nt)
        elif len(nt) != nkeys:
            raise RuntimeError("curves disagree on length")

    if nkeys is None or tick is None:
        raise RuntimeError("FBX contains no AnimationCurve keys")

    def walk(elem: FBXElem) -> None:
        if elem.id == b"P" and elem.props and elem.props[0] in (b"LocalStop", b"ReferenceStop"):
            if int(elem.props[4]) > tick:
                elem.props[4] = int(elem.props[4]) - tick
        elif elem.id in (b"LocalTime", b"ReferenceTime") and int(elem.props[1]) > tick:
            elem.props[1] = int(elem.props[1]) - tick
        for child in elem.elems:
            walk(child)

    walk(root)
    return nkeys, tick


def _load_c3d(path: str | os.PathLike[str]) -> tuple[list[str], np.ndarray, np.ndarray]:
    import warnings

    import c3d

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with open(path, "rb") as handle:
            reader = c3d.Reader(handle)
            labels: list[str] = []
            for key in ("LABELS", "LABELS2", "LABELS3", "LABELS4", "LABELS5"):
                param = reader.get("POINT:" + key)
                if param is None:
                    continue
                labels.extend(item.replace("\x00", "").strip() for item in param.string_array)
            frames = [np.array(points, copy=True) for _frame, points, _analog in reader.read_frames()]
    if not frames:
        raise RuntimeError("C3D contains no frames")
    stack = np.stack(frames).astype(np.float32)
    xyz = stack[:, :, :3]
    valid = np.isfinite(xyz).all(axis=2) & (stack[:, :, 3] >= 0)
    if len(labels) < xyz.shape[1]:
        labels.extend(f"point_{i:03d}" for i in range(len(labels), xyz.shape[1]))
    return labels, xyz, valid


def _optical_label(raw: str, index: int, used: set[str]) -> str:
    text = (raw or "").replace("\x00", "").strip()
    if not text:
        base = f"point_{index:03d}"
    elif text.lower().startswith("unlabel"):
        rest = text[len("unlabel") :].lstrip("_")
        base = f"Unlabeled_{rest}" if rest else f"Unlabeled_{index}"
    else:
        base = text
    name = base
    serial = 2
    while name in used:
        name = f"{base}_{serial}"
        serial += 1
    used.add(name)
    return name


def _f32(values) -> array.array:
    out = array.array("f")
    out.frombytes(np.asarray(values, dtype=np.float32).tobytes())
    return out


def _add_optical(root: FBXElem, c3d_path: str | os.PathLike[str], nframes: int, tick: int) -> int:
    labels, xyz, valid = _load_c3d(c3d_path)
    if xyz.shape[0] != nframes:
        raise RuntimeError(f"C3D frames {xyz.shape[0]} != FBX keys {nframes}")
    fbx = np.empty_like(xyz)
    fbx[:, :, 0] = -xyz[:, :, 0] * 0.1
    fbx[:, :, 1] = xyz[:, :, 2] * 0.1
    fbx[:, :, 2] = xyz[:, :, 1] * 0.1
    objects = _objects_of(root)
    conns = _conns_of(root)
    byid = _index_ids(objects)
    next_id = max(byid) + 1

    def alloc() -> int:
        nonlocal next_id
        value = next_id
        next_id += 1
        return value

    def add(elem: FBXElem) -> FBXElem:
        objects.elems.append(elem)
        byid[int(elem.props[0])] = elem
        return elem

    layer_id = int(next(e for e in objects.elems if e.id == b"AnimationLayer").props[0])
    times = array.array("q")
    times.frombytes((np.arange(nframes, dtype=np.int64) * tick).tobytes())
    clock = np.arange(nframes)

    def curve(default: float, values, flags: int) -> FBXElem:
        return add(
            _elem(
                b"AnimationCurve",
                [alloc(), b"\x00\x01AnimCurve", b""],
                [L, S, S],
                [
                    _elem(b"Default", [float(default)], [D]),
                    _elem(b"KeyVer", [4009], [I]),
                    _elem(b"KeyTime", [times], [ord("l")]),
                    _elem(b"KeyValueFloat", [_f32(values)], [ord("f")]),
                    _elem(b"KeyAttrFlags", [array.array("i", [flags])], [ord("i")]),
                    _elem(b"KeyAttrDataFloat", [array.array("f", ATTR_DATA)], [ord("f")]),
                    _elem(b"KeyAttrRefCount", [array.array("i", [nframes])], [ord("i")]),
                ],
            )
        )

    def channel_node(title: bytes, props: list[FBXElem]) -> FBXElem:
        return add(
            _elem(
                b"AnimationCurveNode",
                [alloc(), title, b""],
                [L, S, S],
                [_elem(b"Properties70", [], [], props)],
            )
        )

    def number_prop(axis: bytes, default: float) -> FBXElem:
        return _elem(b"P", [axis, b"Number", b"", b"A", float(default)], [S, S, S, S, D])

    def link_node(node: FBXElem, model_id: int, prop: bytes) -> None:
        conns.elems.append(_elem(b"C", [b"OO", int(node.props[0]), layer_id], [S, L, L]))
        conns.elems.append(_elem(b"C", [b"OP", int(node.props[0]), model_id, prop], [S, L, L, S]))

    def link_curve(curve_elem: FBXElem, node: FBXElem, prop: bytes) -> None:
        conns.elems.append(
            _elem(
                b"C",
                [b"OP", int(curve_elem.props[0]), int(node.props[0]), prop],
                [S, L, L, S],
            )
        )

    optical_id = alloc()
    add(
        _elem(
            b"Model",
            [optical_id, b"C3D:optical\x00\x01Model", b"Optical"],
            [L, S, S],
            [
                _elem(b"Version", [232], [I]),
                _elem(
                    b"Properties70",
                    [],
                    [],
                    [
                        _elem(
                            b"P",
                            [b"ScalingMax", b"Vector3D", b"Vector", b"", 0.0, 0.0, 0.0],
                            [S, S, S, S, D, D, D],
                        ),
                        _elem(
                            b"P",
                            [b"DefaultAttributeIndex", b"int", b"Integer", b"", 0],
                            [S, S, S, S, I],
                        ),
                    ],
                ),
                _elem(b"Shading", [True], [C]),
                _elem(b"Culling", [b"CullingOff"], [S]),
            ],
        )
    )
    optical_attr = add(
        _elem(
            b"NodeAttribute",
            [alloc(), b"OpticalAttrib\x00\x01NodeAttribute", b"Optical"],
            [L, S, S],
        )
    )
    conns.elems.append(_elem(b"C", [b"OO", int(optical_attr.props[0]), optical_id], [S, L, L]))
    conns.elems.append(_elem(b"C", [b"OO", optical_id, 0], [S, L, L]))

    null_src = next(
        (e for e in objects.elems if e.id == b"Model" and e.props[2] == b"Null"),
        None,
    ) or _blank_null()
    marker_root = copy.deepcopy(null_src)
    marker_root.props[0] = alloc()
    _set_name(marker_root, b"Marker Null Root", b"Model")
    add(marker_root)
    marker_attr = add(
        _elem(
            b"NodeAttribute",
            [alloc(), b"Marker Null Root\x00\x01NodeAttribute", b"Null"],
            [L, S, S],
            [_elem(b"TypeFlags", [b"Null"], [S])],
        )
    )
    conns.elems.append(
        _elem(b"C", [b"OO", int(marker_attr.props[0]), int(marker_root.props[0])], [S, L, L])
    )
    conns.elems.append(_elem(b"C", [b"OO", int(marker_root.props[0]), 0], [S, L, L]))

    used: set[str] = set()
    made = 0
    for index in range(fbx.shape[1]):
        good = np.flatnonzero(valid[:, index])
        if len(good) == 0:
            continue
        filled = np.empty((nframes, 3), dtype=np.float32)
        if len(good) == 1:
            filled[:] = fbx[good[0], index]
        else:
            for axis in range(3):
                filled[:, axis] = np.interp(clock, good, fbx[good, index, axis]).astype(np.float32)
        label = _optical_label(labels[index], index, used)
        model = add(
            _elem(
                b"Model",
                [alloc(), ("C3D:" + label).encode() + b"\x00\x01Model", b"OpticalMarker"],
                [L, S, S],
                [
                    _elem(b"Version", [232], [I]),
                    _elem(
                        b"Properties70",
                        [],
                        [],
                        [
                            _elem(
                                b"P",
                                [b"ScalingMax", b"Vector3D", b"Vector", b"", 0.0, 0.0, 0.0],
                                [S, S, S, S, D, D, D],
                            ),
                            _elem(
                                b"P",
                                [b"DefaultAttributeIndex", b"int", b"Integer", b"", 0],
                                [S, S, S, S, I],
                            ),
                        ],
                    ),
                    _elem(b"Shading", [True], [C]),
                    _elem(b"Culling", [b"CullingOff"], [S]),
                ],
            )
        )
        attr = add(
            _elem(
                b"NodeAttribute",
                [alloc(), label.encode() + b"\x00\x01NodeAttribute", b"OpticalMarker"],
                [L, S, S],
                [
                    _elem(
                        b"Properties70",
                        [],
                        [],
                        [
                            _elem(
                                b"P",
                                [b"Color", b"ColorRGB", b"Color", b"", 0.3, 0.9, 1.0],
                                [S, S, S, S, D, D, D],
                            ),
                            _elem(b"P", [b"Occlusion", b"Occlusion", b"", b"A+", 0.0], [S, S, S, S, D]),
                        ],
                    ),
                    _elem(b"TypeFlags", [b"Marker"], [S]),
                ],
            )
        )
        mid = int(model.props[0])
        conns.elems.append(_elem(b"C", [b"OO", mid, optical_id], [S, L, L]))
        conns.elems.append(_elem(b"C", [b"OO", int(attr.props[0]), mid], [S, L, L]))
        tnode = channel_node(
            b"T\x00\x01AnimCurveNode",
            [number_prop(b"d|X", 0.0), number_prop(b"d|Y", 0.0), number_prop(b"d|Z", 0.0)],
        )
        rnode = channel_node(
            b"R\x00\x01AnimCurveNode",
            [number_prop(b"d|X", 0.0), number_prop(b"d|Y", 0.0), number_prop(b"d|Z", 0.0)],
        )
        vnode = channel_node(
            b"Visibility\x00\x01AnimCurveNode",
            [_elem(b"P", [b"d|Visibility", b"Visibility", b"", b"A", 1.0], [S, S, S, S, D])],
        )
        onode = channel_node(
            b"Occlusion\x00\x01AnimCurveNode",
            [_elem(b"P", [b"d|Occlusion", b"Occlusion", b"", b"A", 0.0], [S, S, S, S, D])],
        )
        link_node(tnode, mid, b"Lcl Translation")
        link_node(rnode, mid, b"Lcl Rotation")
        link_node(vnode, mid, b"Visibility")
        conns.elems.append(_elem(b"C", [b"OO", int(onode.props[0]), layer_id], [S, L, L]))
        conns.elems.append(
            _elem(b"C", [b"OP", int(onode.props[0]), int(attr.props[0]), b"Occlusion"], [S, L, L, S])
        )
        for axis in range(3):
            link_curve(curve(0.0, filled[:, axis], 8456), tnode, (b"d|X", b"d|Y", b"d|Z")[axis])
        vis = valid[:, index].astype(np.float32)
        link_curve(curve(1.0, vis, 8450), vnode, b"d|Visibility")
        link_curve(
            curve(0.0, np.where(valid[:, index], np.float32(0.0), np.float32(100.0)), 8450),
            onode,
            b"d|Occlusion",
        )
        made += 1
    return made


def _to_pingpong(root: FBXElem) -> None:
    objects = _objects_of(root)
    conns = _conns_of(root)
    byid = _index_ids(objects)
    next_id = max(byid) + 1

    def alloc() -> int:
        nonlocal next_id
        value = next_id
        next_id += 1
        return value

    def add(elem: FBXElem) -> FBXElem:
        objects.elems.append(elem)
        byid[int(elem.props[0])] = elem
        return elem

    def connect(props: list, types: list[int]) -> None:
        conns.elems.append(_elem(b"C", props, types))

    def attribute_of(model_id: int) -> FBXElem | None:
        for child in _oo_children(conns, model_id):
            elem = byid.get(child)
            if elem is not None and elem.id == b"NodeAttribute":
                return elem
        return None

    def model_tree(root_id: int) -> list[int]:
        order: list[int] = []
        stack = [root_id]
        while stack:
            current = stack.pop()
            order.append(current)
            for child in _oo_children(conns, current):
                elem = byid.get(child)
                if elem is not None and elem.id == b"Model":
                    stack.append(child)
        return order

    def make_attr(name: bytes, cls: bytes, flags: list[bytes]) -> FBXElem:
        return add(
            _elem(
                b"NodeAttribute",
                [alloc(), name + b"\x00\x01NodeAttribute", cls],
                [L, S, S],
                [_elem(b"TypeFlags", list(flags), [S] * len(flags))],
            )
        )

    def ensure_attr(model_id: int, cls: bytes, flags: list[bytes]) -> None:
        if attribute_of(model_id) is None:
            attr = make_attr(_name_of(byid[model_id]), cls, flags)
            connect([b"OO", int(attr.props[0]), model_id], [S, L, L])

    candidates = [
        e
        for e in objects.elems
        if e.id == b"Model"
        and e.props[2] == b"Null"
        and _name_of(e) != b"Marker Null Root"
        and not _name_of(e).startswith(b"C3D:")
    ]
    null_template = copy.deepcopy(candidates[0]) if candidates else _blank_null()

    rigid_ids: list[int] = []
    for elem in candidates:
        if _scene_link(conns, int(elem.props[0])) is not None:
            rigid_ids.append(int(elem.props[0]))

    skeletons = [
        e
        for e in objects.elems
        if e.id == b"Model" and e.props[2] == b"Root" and _name_of(e).startswith(b"Skeleton_")
    ]
    if not skeletons:
        raise RuntimeError("no skeleton root")

    def make_model(name: bytes, cls: bytes) -> FBXElem:
        elem = copy.deepcopy(null_template)
        elem.props[0] = alloc()
        _set_name(elem, name, b"Model")
        elem.props[2] = cls
        return add(elem)

    for skel in skeletons:
        original = _name_of(skel).decode()
        parts = original.split("_")
        if len(parts) < 3 or not parts[1].isdigit():
            raise RuntimeError(f"unexpected skeleton name {original}")
        index = int(parts[1])
        old_prefix = f"Skeleton_{index}_".encode()
        new_prefix = f"Skeleton {index:03d}_".encode()
        for model_id in model_tree(int(skel.props[0])):
            model = byid[model_id]
            old = _name_of(model)
            if not old.startswith(old_prefix):
                raise RuntimeError(f"bone outside prefix: {old!r}")
            new = new_prefix + old[len(old_prefix) :]
            _set_name(model, new, b"Model")
            attr = attribute_of(model_id)
            if attr is not None:
                _set_name(attr, new, b"NodeAttribute")
        skel.props[2] = b"LimbNode"
        attr = attribute_of(int(skel.props[0]))
        if attr is None:
            raise RuntimeError("skeleton has no attribute")
        attr.props[2] = b"LimbNode"
        flags = _find_child(attr, b"TypeFlags")
        if flags is None:
            flags = _elem(b"TypeFlags", [b"Skeleton"], [S])
            attr.elems.append(flags)
        else:
            flags.props[:] = [b"Skeleton"]
            flags.props_type[:] = bytes((S,))
        root_name = f"Skeleton {index:03d}_Root".encode()
        root_model = make_model(root_name, b"Null")
        root_attr = make_attr(root_name, b"Null", [b"Null"])
        connect([b"OO", int(root_attr.props[0]), int(root_model.props[0])], [S, L, L])
        connect([b"OO", int(root_model.props[0]), 0], [S, L, L])
        link = _scene_link(conns, int(skel.props[0]))
        if link is None:
            raise RuntimeError("skeleton is not a scene root")
        link.props[2] = int(root_model.props[0])

    def clone_channels(src_id: int, dst_id: int) -> None:
        links = [
            c
            for c in conns.elems
            if c.props[0] == b"OP"
            and int(c.props[2]) == src_id
            and c.props[3] in (b"Lcl Translation", b"Lcl Rotation")
        ]
        for link in links:
            node = byid[int(link.props[1])]
            new_node = copy.deepcopy(node)
            new_node.props[0] = alloc()
            add(new_node)
            layer = next(
                int(c.props[2])
                for c in conns.elems
                if c.props[0] == b"OO" and int(c.props[1]) == int(node.props[0])
            )
            connect([b"OO", int(new_node.props[0]), layer], [S, L, L])
            connect([b"OP", int(new_node.props[0]), dst_id, link.props[3]], [S, L, L, S])
            curves = [
                c
                for c in conns.elems
                if c.props[0] == b"OP" and int(c.props[2]) == int(node.props[0])
            ]
            for curve_link in curves:
                cloned = copy.deepcopy(byid[int(curve_link.props[1])])
                cloned.props[0] = alloc()
                add(cloned)
                connect(
                    [b"OP", int(cloned.props[0]), int(new_node.props[0]), curve_link.props[3]],
                    [S, L, L, S],
                )

    for body_id in rigid_ids:
        label = _name_of(byid[body_id])
        root_model = make_model(label + b"_Root", b"Null")
        root_attr = make_attr(label + b"_Root", b"Null", [b"Null"])
        connect([b"OO", int(root_attr.props[0]), int(root_model.props[0])], [S, L, L])
        connect([b"OO", int(root_model.props[0]), 0], [S, L, L])
        slink = _scene_link(conns, body_id)
        if slink is not None:
            slink.props[2] = int(root_model.props[0])
        ensure_attr(body_id, b"Null", [b"Null"])
        bone = make_model(label + b"_Bone", b"Root")
        bone_attr = make_attr(label + b"_Bone", b"Root", [b"Null", b"Skeleton", b"Root"])
        connect([b"OO", int(bone_attr.props[0]), int(bone.props[0])], [S, L, L])
        connect([b"OO", int(bone.props[0]), int(root_model.props[0])], [S, L, L])
        clone_channels(body_id, int(bone.props[0]))

    header = next(e for e in root.elems if e.id == b"FBXHeaderExtension")
    for child in header.elems:
        if child.id == b"FBXVersion":
            child.props[0] = VERSION
        elif child.id == b"Creator":
            child.props[0] = CREATOR_SHORT
    for elem in root.elems:
        if elem.id == b"Creator":
            elem.props[0] = CREATOR
    settings = next(e for e in root.elems if e.id == b"GlobalSettings")
    p70 = _find_child(settings, b"Properties70")
    if p70 is not None:
        for prop in p70.elems:
            if prop.props[0] == b"TimeMode":
                prop.props[4] = 1

    counts = Counter(elem.id for elem in objects.elems)
    definitions = next(e for e in root.elems if e.id == b"Definitions")
    total = 0
    for elem in definitions.elems:
        if elem.id != b"ObjectType":
            continue
        key = elem.props[0]
        count = 1 if key == b"GlobalSettings" else counts.get(key, 0)
        total += count
        for child in elem.elems:
            if child.id == b"Count":
                child.props[0] = count
            elif child.id == b"PropertyTemplate" and key == b"NodeAttribute":
                child.props[0] = b"FbxOpticalReference"
    for elem in definitions.elems:
        if elem.id == b"Count":
            elem.props[0] = total


def _snapshot(root: FBXElem) -> dict[int, dict[bytes, bytes]]:
    snap: dict[int, dict[bytes, bytes]] = {}
    for elem in _objects_of(root).elems:
        if elem.id != b"AnimationCurve":
            continue
        item: dict[bytes, bytes] = {}
        for child in elem.elems:
            if child.id in (b"KeyTime", b"KeyValueFloat"):
                item[child.id] = child.props[0].tobytes()
        snap[int(elem.props[0])] = item
    return snap


def merge_c3d_into_fbx(
    fbx_path: str | os.PathLike[str],
    c3d_path: str | os.PathLike[str],
    dst_path: str | os.PathLike[str],
) -> tuple[int, int]:
    """Merge ``c3d_path`` optical markers into ``fbx_path`` and write ``dst_path``.

    Returns ``(marker_count, frame_count)``.
    """
    fbx_p = Path(fbx_path)
    c3d_p = Path(c3d_path)
    dst_p = Path(dst_path)
    dst_p.parent.mkdir(parents=True, exist_ok=True)

    root, version = parse_fbx(fbx_p)
    if version < 7500:
        raise RuntimeError(f"{fbx_p.name} 的 FBX 版本是 {version}，需要 7500 及以上")
    nkeys, tick = _shift_take(root)
    made = _add_optical(root, c3d_p, nkeys, tick)
    before = _snapshot(root)
    _to_pingpong(root)
    tmp_p = dst_p.with_name(dst_p.name + ".tmp")
    try:
        write_fbx(tmp_p, root)
        check, written = parse_fbx(tmp_p)
        if written != VERSION:
            raise RuntimeError(f"写出的版本是 {written}")
        for elem in _objects_of(check).elems:
            if elem.id != b"AnimationCurve" or int(elem.props[0]) not in before:
                continue
            original = before[int(elem.props[0])]
            for child in elem.elems:
                if child.id in original and child.props[0].tobytes() != original[child.id]:
                    raise RuntimeError(f"曲线在写出后发生变化：{fbx_p.name}")
        os.replace(tmp_p, dst_p)
    except Exception:
        tmp_p.unlink(missing_ok=True)
        raise
    return made, nkeys
