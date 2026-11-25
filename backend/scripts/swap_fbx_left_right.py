"""Swap Left/Right bone names in a mirrored capture FBX.

omniretarget_data stores a mirrored skeleton: the joint named Left sits on the
anatomical right of the direction the toes, the hands and the hips travel.
Positions, the capture origin and the rigid body stay put. Only the side
tokens in node names are exchanged, so a later retarget faces the toes.

The files are FBX 7700 binary. Left is one byte shorter than Right, so the
node offsets are rewritten. A file whose labeled left already agrees with the
toes is left unchanged, and running this twice does not swap back.

    .venv-retarget/bin/python backend/scripts/swap_fbx_left_right.py [fbx ...]
"""

from __future__ import annotations

import argparse
import os
import struct
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

HUB = Path(__file__).resolve().parents[2] / "data" / "hub_repo"
DEFAULT_ROOT = HUB / "data/human/motion/merged/fbx/omniretarget_data"
_HEADER = 27
_NULL = 25
_SIDE_WORDS = ("Left", "Right")
_SHORT_STEMS = ("Index", "Middle", "Pinky", "Ring", "Thumb", "Toe")


def swap_side_text(text: str) -> str:
    """Exchange Left/Right and the short L/R prefixes used on end sites."""
    pieces: list[str] = []
    i = 0
    while i < len(text):
        if text.startswith("Left", i) and _boundary(text, i, i + 4):
            pieces.append("Right")
            i += 4
            continue
        if text.startswith("Right", i) and _boundary(text, i, i + 5):
            pieces.append("Left")
            i += 5
            continue
        if text[i] in "LR" and _boundary(text, i, i + 1):
            stem = next((item for item in _SHORT_STEMS if text.startswith(item, i + 1)), None)
            if stem is not None:
                pieces.append(("R" if text[i] == "L" else "L") + stem)
                i += 1 + len(stem)
                continue
        pieces.append(text[i])
        i += 1
    return "".join(pieces)


def _boundary(text: str, start: int, end: int) -> bool:
    before_ok = start == 0 or not text[start - 1].isalpha()
    after_ok = end == len(text) or not text[end].islower()
    return before_ok and after_ok


class _Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.i = _HEADER

    def u8(self) -> int:
        value = self.data[self.i]
        self.i += 1
        return value

    def u32(self) -> int:
        value = struct.unpack_from("<I", self.data, self.i)[0]
        self.i += 4
        return value

    def u64(self) -> int:
        value = struct.unpack_from("<Q", self.data, self.i)[0]
        self.i += 8
        return value


def _read_property(reader: _Reader) -> bytes:
    start = reader.i
    kind = reader.u8()
    if kind == ord("Y"):
        reader.i += 2
    elif kind == ord("C"):
        reader.i += 1
    elif kind in (ord("I"), ord("F")):
        reader.i += 4
    elif kind in (ord("D"), ord("L")):
        reader.i += 8
    elif kind in (ord("S"), ord("R")):
        length = reader.u32()
        reader.i += length
    elif kind in b"fdlib":
        reader.u32()
        reader.u32()
        length = reader.u32()
        reader.i += length
    else:
        raise ValueError(f"unknown FBX property type {kind!r} at {start}")
    return reader.data[start : reader.i]


def _read_node(reader: _Reader):
    end = reader.u64()
    count = reader.u64()
    prop_len = reader.u64()
    name_len = reader.u8()
    if end == 0:
        return None
    name = reader.data[reader.i : reader.i + name_len]
    reader.i += name_len
    prop_at = reader.i
    props = [_read_property(reader) for _ in range(count)]
    if reader.i != prop_at + prop_len:
        raise ValueError(f"property block of {name!r} does not match its length")
    children = []
    sentinel = False
    while reader.i < end:
        child = _read_node(reader)
        if child is None:
            sentinel = True
            break
        children.append(child)
    if reader.i != end:
        raise ValueError(f"node {name!r} ended at {reader.i}, expected {end}")
    return {"name": name, "props": props, "children": children, "sentinel": sentinel}


def _load(data: bytes):
    if data[:20] != b"Kaydara FBX Binary  " or struct.unpack_from("<I", data, 23)[0] != 7700:
        raise ValueError("only FBX 7700 binary is rewritten")
    reader = _Reader(data)
    roots = []
    while reader.i < len(data):
        node = _read_node(reader)
        if node is None:
            break
        roots.append(node)
    return roots, data[reader.i :]


def _swap_bytes(raw: bytes) -> bytes:
    text = raw.decode("latin1")
    swapped = swap_side_text(text)
    if swapped == text:
        return raw
    return swapped.encode("latin1")


def _swap_property(prop: bytes) -> bytes:
    if prop[:1] != b"S":
        return prop
    length = struct.unpack_from("<I", prop, 1)[0]
    body = prop[5 : 5 + length]
    marker = b"\x00\x01"
    if marker in body:
        name, rest = body.split(marker, 1)
        new_name = _swap_bytes(name)
        if new_name == name:
            return prop
        new_body = new_name + marker + rest
    else:
        new_body = _swap_bytes(body)
        if new_body == body:
            return prop
    return b"S" + struct.pack("<I", len(new_body)) + new_body


def _swap_node(node: dict) -> None:
    node["name"] = _swap_bytes(node["name"])
    node["props"] = [_swap_property(prop) for prop in node["props"]]
    for child in node["children"]:
        _swap_node(child)


def _write_node(out: bytearray, node: dict) -> None:
    header = len(out)
    out.extend(b"\x00" * 24)
    name = node["name"]
    if len(name) > 255:
        raise ValueError(f"FBX node name is longer than 255 bytes: {name!r}")
    out.append(len(name))
    out.extend(name)
    for prop in node["props"]:
        out.extend(prop)
    for child in node["children"]:
        _write_node(out, child)
    if node["sentinel"] or node["children"]:
        out.extend(b"\x00" * _NULL)
    end = len(out)
    prop_len = sum(len(prop) for prop in node["props"])
    struct.pack_into("<QQQ", out, header, end, len(node["props"]), prop_len)


def rewrite(data: bytes, swap: bool) -> bytes:
    roots, footer = _load(data)
    if swap:
        for node in roots:
            _swap_node(node)
    out = bytearray(data[:_HEADER])
    for node in roots:
        _write_node(out, node)
    out.extend(b"\x00" * _NULL)
    out.extend(footer)
    return bytes(out)


def _chirality(path: Path) -> float:
    """Median dot of (labeled-left × up) with the toe direction. Negative means mirrored."""
    pkg = Path(
        "/home/noetix/Desktop/new_home/learning_based/wbc/open_src/omni_retarget/"
        "holosoma/src/holosoma_retargeting"
    )
    for item in (str(pkg), str(pkg / "holosoma_retargeting" / "data_utils")):
        if item not in sys.path:
            sys.path.insert(0, item)
    import prep_fbx_for_rt as prep
    from holosoma_retargeting.config_types.data_type import BVH_DEMO_JOINTS
    from prep_bvh_for_rt import resolve_joint_indices

    scene = prep._require_pufbx().load_fbx(str(path))
    parents = prep._parent_map(scene)
    data, _times, node_names = prep.bake_fbx_local_channels(scene)
    node_names = list(node_names)
    skeletons = prep.discover_skeleton_names(node_names)
    if not skeletons:
        raise ValueError("no skeleton")
    _prefixed, bare, sep = prep._nodes_for_skeleton(node_names, skeletons[0])
    resolved = resolve_joint_indices(bare)
    names = list(BVH_DEMO_JOINTS)
    fk = [prep._prefixed(bare[resolved[joint]], skeletons[0], sep) for joint in names]
    points = prep.world_positions_from_local(data, _times, node_names, parents, fk)
    index = {name: i for i, name in enumerate(names)}
    dots = []
    step = max(1, points.shape[0] // 8)
    up = np.array([0.0, 1.0, 0.0])
    for frame in range(0, points.shape[0], step):
        def at(name: str) -> np.ndarray:
            return points[frame, index[name]]

        left = (at("LeftUpLeg") - at("RightUpLeg")) + (at("LeftArm") - at("RightArm"))
        left[1] = 0.0
        left = left / (np.linalg.norm(left) + 1e-9)
        toe = (at("LeftToeBase") - at("LeftFoot")) + (at("RightToeBase") - at("RightFoot"))
        toe[1] = 0.0
        toe = toe / (np.linalg.norm(toe) + 1e-9)
        forward = np.cross(left, up)
        forward = forward / (np.linalg.norm(forward) + 1e-9)
        dots.append(float(np.dot(forward, toe)))
    return float(np.median(dots))


def convert_file(path: Path) -> str:
    score = _chirality(path)
    if score > 0.5:
        return "already"
    if score >= -0.5:
        return f"unclear {score:+.3f}"
    original = path.read_bytes()
    rewritten = rewrite(original, swap=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".fbx", dir=path.parent)
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        tmp.write_bytes(rewritten)
        os.replace(tmp, path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    return "swapped"


def _convert_one(path: str) -> tuple[str, str]:
    try:
        return path, convert_file(Path(path))
    except Exception as exc:
        return path, f"ERR {exc}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", type=Path)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    paths = [str(path) for path in (args.paths or sorted(DEFAULT_ROOT.rglob("*.fbx")))]
    counts = {"swapped": 0, "already": 0, "other": 0, "error": 0}
    with ProcessPoolExecutor(max_workers=max(1, args.workers)) as pool:
        for index, (path, result) in enumerate(pool.map(_convert_one, paths, chunksize=4), start=1):
            if result.startswith("ERR"):
                counts["error"] += 1
                print(f"{result} {path}", flush=True)
            else:
                key = result if result in counts else "other"
                counts[key] += 1
                if result not in {"swapped", "already"}:
                    print(f"{result} {path}", flush=True)
            if index % 100 == 0 or index == len(paths):
                print(
                    f"{index}/{len(paths)} swapped {counts['swapped']} "
                    f"already {counts['already']} other {counts['other']} error {counts['error']}",
                    flush=True,
                )


if __name__ == "__main__":
    main()
