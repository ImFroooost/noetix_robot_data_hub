"""Drop extra Motive skeletons that stay in a T-pose.

Some takes export the solved actor as ``Skeleton_1`` and also leave the
default ``Skeleton_0`` in the file. That default skeleton keeps a bind pose:
its limbs never rotate. Takes that only contain ``Skeleton_0`` are the real
capture and are left alone.

Run with the FBX SDK interpreter::

    /home/noetix/miniforge3/envs/fbx_sdk/bin/python \\
        backend/scripts/strip_default_fbx_skeleton.py --batch 261113_PP
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import fbx

sys.path.insert(0, str(Path(__file__).resolve().parent))
import export_human_merged_fbx as merged  # noqa: E402
import merge_batch_c3d_into_fbx as prep  # noqa: E402

HUB = merged.HUB
LIMBS = ("LeftUpLeg", "RightUpLeg", "LeftLeg", "LeftArm", "RightArm", "Spine")


def _pose_span(hips, start: float, stop: float) -> float:
    span = 0.0
    for suffix in LIMBS:
        limb = prep._limb(hips, suffix)
        if limb is None:
            continue
        span = max(span, prep._rotation_span(limb, start, stop))
    return span


def still_skeletons(scene) -> tuple[list, list]:
    stack = scene.GetCurrentAnimationStack()
    span = stack.GetLocalTimeSpan()
    start = span.GetStart().GetSecondDouble()
    stop = span.GetStop().GetSecondDouble()
    moving = []
    still = []
    for hips in prep._hips_roots(scene.GetRootNode()):
        if _pose_span(hips, start, stop) < 3.0:
            still.append(hips)
        else:
            moving.append(hips)
    return moving, still


def _destroy_tree(node) -> None:
    # Destroying a parent first detaches its children and leaves them, and
    # their curves, in the scene. The viewer then crashes on those curves.
    children = [node.GetChild(index) for index in range(node.GetChildCount())]
    for child in children:
        _destroy_tree(child)
    parent = node.GetParent()
    if parent is not None:
        parent.RemoveChild(node)
    node.Destroy()


def _reachable(scene) -> set[int]:
    found: set[int] = set()

    def walk(node) -> None:
        found.add(node.GetUniqueID())
        for index in range(node.GetChildCount()):
            walk(node.GetChild(index))

    walk(scene.GetRootNode())
    return found


def _sweep(scene) -> int:
    """Remove nodes and curves left behind by an earlier incomplete delete."""
    live = _reachable(scene)
    node_type = fbx.FbxCriteria.ObjectType(fbx.FbxNode.ClassId)
    floating = []
    for index in range(scene.GetSrcObjectCount(node_type)):
        node = scene.GetSrcObject(node_type, index)
        if node.GetUniqueID() not in live:
            floating.append(node)
    for node in floating:
        node.Destroy()
    live = _reachable(scene)
    curve_type = fbx.FbxCriteria.ObjectType(fbx.FbxAnimCurveNode.ClassId)
    orphans = []
    for index in range(scene.GetSrcObjectCount(curve_type)):
        curve = scene.GetSrcObject(curve_type, index)
        connected = False
        for slot in range(curve.GetDstPropertyCount()):
            owner = curve.GetDstProperty(slot).GetFbxObject()
            if isinstance(owner, fbx.FbxNode) and owner.GetUniqueID() in live:
                connected = True
                break
        if not connected:
            orphans.append(curve)
    for curve in orphans:
        curve.Destroy()
    return len(floating) + len(orphans)


def strip_file(path: Path) -> str:
    manager, scene, _stack, _layer, ios = merged.load_scene(path)
    tmp = path.with_suffix(".fbx.tmp")
    try:
        moving, still = still_skeletons(scene)
        dropped: list[str] = []
        kept: list[str] = []
        if still and moving:
            dropped = [node.GetName()[: -len("_Hips")] for node in still]
            kept = [node.GetName()[: -len("_Hips")] for node in moving]
            for node in still:
                _destroy_tree(node)
        swept = _sweep(scene)
        if not dropped and swept == 0:
            return "keep"
        merged.export_scene(manager, scene, ios, tmp)
    finally:
        manager.Destroy()
    if not tmp.is_file():
        return "keep"
    tmp.replace(path)
    if dropped:
        return f"drop {', '.join(dropped)} keep {', '.join(kept)}"
    return f"sweep {swept}"


def main() -> int:
    parser = argparse.ArgumentParser(description="删除人体 FBX 里不动的默认骨架")
    parser.add_argument("--batch", default="261113_PP")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    root = HUB / "data/human/motion"
    folders = [root / kind / "fbx" / args.batch for kind in ("skeleton", "merged")]
    failed = 0
    started = time.time()
    for folder in folders:
        files = sorted(folder.glob("*.fbx"))
        if args.limit:
            files = files[: args.limit]
        print(f"{folder.relative_to(HUB)} files {len(files)}", flush=True)
        dropped = 0
        for index, path in enumerate(files, start=1):
            try:
                detail = strip_file(path)
            except Exception as exc:
                failed += 1
                tmp = path.with_suffix(".fbx.tmp")
                if tmp.exists():
                    tmp.unlink()
                print(f"[{index}/{len(files)}] FAIL {path.name}: {exc}", flush=True)
                continue
            if detail != "keep":
                dropped += 1
            if detail != "keep" or index == 1 or index == len(files):
                print(f"[{index}/{len(files)}] {path.name} {detail}", flush=True)
        print(f"{folder.name} dropped {dropped}", flush=True)
    print(f"done failed {failed} elapsed {time.time() - started:.1f}s", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
