"""Strip default T-pose skeletons and merge the matching C3D into each FBX.

The Motive export for 261116_GMT_B_CKX_F_PM stores five calibration actors
that never leave a T-pose, plus the solved ``Skeleton_0`` take. This keeps
the solved skeleton, deletes the calibration skeletons, and writes every C3D
point into that same FBX in the skeleton's centimetre Y-up frame.

Run with the FBX SDK interpreter::

    /home/noetix/miniforge3/envs/fbx_sdk/bin/python \\
        backend/scripts/merge_batch_c3d_into_fbx.py --batch 261116_GMT_B_CKX_F_PM
"""

from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path

import fbx
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import export_human_merged_fbx as merged  # noqa: E402

HUB = merged.HUB
ROBOT_CSV = (
    HUB
    / "data/robot/unitree_g1/motion/frax/skeleton/csv"
)


def read_labels(path: Path) -> tuple[list[str], np.ndarray, np.ndarray]:
    labels, points, valid = merged.read_c3d(path, swap_words=True)
    data = path.read_bytes()
    names: list[str] = []
    for block in ("LABELS", "LABELS2"):
        if data.find(block.encode("ascii")) < 0:
            continue
        _kind, _dims_n, dims, start = merged._param_payload(data, block)
        width, count = dims[:2]
        for index in range(count):
            raw = data[start + index * width : start + (index + 1) * width]
            names.append(raw.split(b"\x00", 1)[0].decode("latin1").strip())
    if len(names) == points.shape[1]:
        labels = names
    elif len(names) > len(labels):
        labels = (names + labels)[: points.shape[1]]
    return labels, points, valid


def _person(label: str) -> str | None:
    match = re.fullmatch(r"h_([A-Za-z0-9]+)_(\d+)_.+", label)
    if not match:
        return None
    return f"{match.group(1)}_{match.group(2)}"


def _part(label: str) -> str | None:
    upper = label.upper()
    if "HIP" in upper:
        return "Hips"
    if "HEAD" in upper:
        return "Head"
    side = "Left" if re.search(r"(^|_)L-", upper) else "Right" if re.search(r"(^|_)R-", upper) else ""
    if not side:
        return None
    if "FOOT" in upper:
        return f"{side}Foot"
    if "HAND" in upper or "WIST" in upper:
        return f"{side}Hand"
    return None


def _limb(node, suffix: str):
    if node.GetName().endswith(suffix) and not node.GetName().endswith(suffix + "End"):
        return node
    for index in range(node.GetChildCount()):
        found = _limb(node.GetChild(index), suffix)
        if found is not None:
            return found
    return None


def _rotation_span(node, start: float, stop: float) -> float:
    clock = fbx.FbxTime()
    samples = []
    for step in range(6):
        clock.SetSecondDouble(start + (stop - start) * step / 5.0)
        rotation = node.EvaluateLocalTransform(clock).GetR()
        samples.append((rotation[0], rotation[1], rotation[2]))
    return float(np.max(np.ptp(np.asarray(samples), axis=0)))


def _hips_roots(root) -> list:
    found = []
    for index in range(root.GetChildCount()):
        child = root.GetChild(index)
        if child.GetName().endswith("_Hips"):
            found.append(child)
    return found


def classify_skeletons(scene) -> tuple[list, list]:
    """Return (keep, drop) hip roots. Calibration actors stay in a T-pose."""
    stack = scene.GetCurrentAnimationStack()
    span = stack.GetLocalTimeSpan()
    start = span.GetStart().GetSecondDouble()
    stop = span.GetStop().GetSecondDouble()
    keep = []
    drop = []
    for hips in _hips_roots(scene.GetRootNode()):
        prefix = hips.GetName()[: -len("_Hips")]
        limb = _limb(hips, "LeftLeg") or _limb(hips, "LeftArm") or hips
        still = _rotation_span(limb, start, stop) < 3.0
        if prefix.startswith("Skeleton") or not still:
            keep.append(hips)
        else:
            drop.append(hips)
    if not keep:
        raise RuntimeError("没有可保留的采集骨架")
    return keep, drop


def _remove(node) -> None:
    parent = node.GetParent()
    if parent is not None:
        parent.RemoveChild(node)
    node.Destroy()


def marker_groups(labels: list[str]) -> dict[str, dict[str, list[int]]]:
    groups: dict[str, dict[str, list[int]]] = {}
    for index, label in enumerate(labels):
        person = _person(label)
        part = _part(label)
        if person and part:
            groups.setdefault(person, {}).setdefault(part, []).append(index)
    return groups


def _bones_by_prefix(root) -> dict[str, dict[str, object]]:
    found: dict[str, dict[str, object]] = {}

    def walk(node) -> None:
        name = node.GetName()
        if name.endswith("_Hips"):
            prefix = name[: -len("_Hips")]
            for part in ("Hips", "Head", "LeftFoot", "RightFoot", "LeftHand", "RightHand"):
                bone = _limb(node, part)
                if bone is not None:
                    found.setdefault(prefix, {})[part] = bone
        for index in range(node.GetChildCount()):
            walk(node.GetChild(index))

    walk(root)
    return found


def fit_c3d(labels, points, valid, bones, times: list[float]) -> tuple[int, float, float, np.ndarray, np.ndarray]:
    groups = marker_groups(labels)
    best = None
    for lag in (1, 0, 2, 3):
        src = []
        dst = []
        step = max(1, (len(times) - lag) // 30)
        for key in range(lag, len(times), step):
            frame = key - lag
            if frame >= len(points):
                break
            clock = fbx.FbxTime()
            clock.SetSecondDouble(times[key])
            for person, parts in groups.items():
                skeleton = bones.get(person) or {}
                for part, indexes in parts.items():
                    node = skeleton.get(part)
                    if node is None:
                        continue
                    center = merged._mean_valid(points, valid, indexes, frame)
                    if center is None:
                        continue
                    translation = node.EvaluateGlobalTransform(clock).GetT()
                    src.append(center)
                    dst.append((translation[0], translation[1], translation[2]))
        if len(src) < 12:
            continue
        scale, rotation, translation, error = merged._umeyama(
            np.asarray(src), np.asarray(dst, dtype=np.float64)
        )
        if best is None or error < best[0]:
            best = (error, lag, scale, rotation, translation)
    if best is None:
        raise RuntimeError("C3D 对不上骨架")
    error, lag, scale, rotation, translation = best
    if error > 15.0:
        raise RuntimeError(f"对齐误差 {error:.1f} cm，超过 15 cm")
    return lag, error, scale, rotation, translation


def display_name(label: str, used: set[str]) -> str:
    person = _person(label)
    if person:
        number = 1
        while f"C3D:{person}_Marker_{number:03d}" in used:
            number += 1
        name = f"C3D:{person}_Marker_{number:03d}"
    else:
        unlabeled = re.fullmatch(r"unlabel_(\d+)", label, flags=re.IGNORECASE)
        if unlabeled:
            name = "C3D:Unlabeled_" + unlabeled.group(1)
        else:
            cleaned = re.sub(r"[^0-9A-Za-z_]+", "_", label).strip("_") or "point"
            name = "C3D:" + cleaned
    while name in used:
        name += "_"
    used.add(name)
    return name


def write_markers(scene, layer, labels, world, valid, times, lag: int) -> int:
    root = scene.GetRootNode()
    optical = fbx.FbxNode.Create(scene, "C3D:optical")
    optical.SetNodeAttribute(fbx.FbxNull.Create(scene, "C3D:optical"))
    root.AddChild(optical)
    clocks = []
    for second in times:
        moment = fbx.FbxTime()
        moment.SetSecondDouble(second)
        clocks.append(moment)
    used: set[str] = set()
    written = 0
    # Rewrite names in person order so each cloud gets Marker_001...
    order = sorted(range(len(labels)), key=lambda index: (_person(labels[index]) or "zzz", index))
    renamed = list(labels)
    for index in order:
        if not np.any(valid[:, index]):
            continue
        renamed[index] = display_name(labels[index], used)
    for index, label in enumerate(renamed):
        if not np.any(valid[:, index]):
            continue
        track = merged._fill_gaps(world[:, index], valid[:, index])
        sampled = np.zeros((len(times), 3), dtype=np.float64)
        last = track[0]
        for key in range(len(times)):
            frame = key - lag
            if 0 <= frame < len(track):
                last = track[frame]
            sampled[key] = last
        node = fbx.FbxNode.Create(scene, label)
        node.SetNodeAttribute(fbx.FbxMarker.Create(scene, label))
        optical.AddChild(node)
        merged._add_curve(node, layer, clocks, sampled)
        written += 1
    return written


def csv_for(batch: str, stem: str, index: int) -> Path:
    folder = ROBOT_CSV / batch
    if index == 0:
        return folder / f"{stem}.csv"
    return folder / f"{stem}_skeleton_{index}.csv"


def convert_one(fbx_path: Path, c3d_path: Path, out: Path) -> tuple[str, list[Path], Path | None]:
    labels, points, valid = read_labels(c3d_path)
    manager, scene, _stack, layer, ios = merged.load_scene(fbx_path)
    try:
        keep, drop = classify_skeletons(scene)
        bones = _bones_by_prefix(scene.GetRootNode())
        times = merged._key_times(keep[0], layer)
        if len(times) < 2:
            raise RuntimeError("采集骨架没有位移曲线")
        lag, error, scale, rotation, translation = fit_c3d(labels, points, valid, bones, times)
        world = scale * np.einsum("ij,fnj->fni", rotation, points) + translation
        dropped = [node.GetName() for node in drop]
        order = [hips.GetName()[: -len("_Hips")] for hips in _hips_roots(scene.GetRootNode())]
        kept_prefixes = {node.GetName()[: -len("_Hips")] for node in keep}
        for node in list(drop):
            _remove(node)
        count = write_markers(scene, layer, labels, world, valid, times, lag)
        merged.export_scene(manager, scene, ios, out)
    finally:
        manager.Destroy()
    remove_csv = []
    kept_csvs = []
    for index, prefix in enumerate(order):
        path = csv_for(fbx_path.parent.name, fbx_path.stem, index)
        if prefix not in kept_prefixes:
            if path.is_file():
                remove_csv.append(path)
        elif path.is_file():
            kept_csvs.append(path)
    main_csv = csv_for(fbx_path.parent.name, fbx_path.stem, 0)
    promote = kept_csvs[0] if main_csv in remove_csv and len(kept_csvs) == 1 else None
    detail = (
        f"drop {len(dropped)} keep {', '.join(sorted(kept_prefixes))} "
        f"lag {lag} fit {error:.2f} cm scale {scale:.4f} markers {count}"
    )
    return detail, remove_csv, promote


def main() -> int:
    parser = argparse.ArgumentParser(description="去掉 T-pose 骨架，并把同名 C3D 合并进 FBX")
    parser.add_argument("--batch", default="261116_GMT_B_CKX_F_PM")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--output", type=Path, default=None, help="只处理第一条并写到这个路径")
    args = parser.parse_args()
    root = HUB / "data/human/motion/skeleton"
    fbx_dir = root / "fbx" / args.batch
    c3d_dir = root / "c3d" / args.batch
    jobs = []
    for fbx_path in sorted(fbx_dir.glob("*.fbx")):
        c3d_path = c3d_dir / f"{fbx_path.stem}.c3d"
        if c3d_path.is_file():
            jobs.append((fbx_path, c3d_path))
    if args.limit:
        jobs = jobs[: args.limit]
    if args.output is not None:
        jobs = jobs[:1]
    print(f"jobs {len(jobs)}", flush=True)
    manifest = Path("/tmp") / f"ckx_csv_{args.batch}.txt"
    lines = []
    failed = 0
    started = time.time()
    for index, (fbx_path, c3d_path) in enumerate(jobs, start=1):
        out = args.output if args.output is not None else fbx_path.with_suffix(".fbx.tmp")
        try:
            detail, remove_csv, promote = convert_one(fbx_path, c3d_path, out)
            if args.output is None:
                out.replace(fbx_path)
            rel_remove = [path.relative_to(HUB).as_posix() for path in remove_csv]
            rel_promote = promote.relative_to(HUB).as_posix() if promote else ""
            lines.append(fbx_path.stem + "\t" + rel_promote + "\t" + "|".join(rel_remove))
            print(f"[{index}/{len(jobs)}] {fbx_path.name} {detail}", flush=True)
        except Exception as exc:
            failed += 1
            if out.exists() and out != args.output:
                out.unlink()
            print(f"[{index}/{len(jobs)}] FAIL {fbx_path.name}: {exc}", flush=True)
    if lines:
        manifest.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"manifest {manifest}", flush=True)
    print(f"done failed {failed} elapsed {time.time() - started:.1f}s", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
