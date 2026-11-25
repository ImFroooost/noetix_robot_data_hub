"""Record how holosoma places a human FBX in the robot CSV world.

batch_retarget_to_csv.py converts an FBX with prep_fbx_for_rt (cm -> m,
Y-up -> Z-up, heading to +Y, mirror X, hips XY to the origin, or keep the
world for multi-skeleton files), then preprocess_motion_data lowers the
toes to z = 0 and scales by ROBOT_HEIGHT / human height. Scene objects go
through the same steps, so one affine map per skeleton places every FBX
node next to the retargeted robot.

The map is measured with holosoma's own conversion: the converted joints
are fitted against the raw FBX joints, so later changes to the prep steps
are picked up without copying them here.

Writes index/retarget_frames/<sha1 of the FBX path>.json and
index/retarget_frames/robots.json (ROBOT_HEIGHT per style).

Run on the host with the holosoma virtualenv:
    .venv-retarget/bin/python backend/scripts/retarget_frames.py [--all] [fbx ...]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
HUB = ROOT / "data" / "hub_repo"
PKG = Path(
    "/home/noetix/Desktop/new_home/learning_based/wbc/open_src/omni_retarget/"
    "holosoma/src/holosoma_retargeting"
)
BACKEND = ROOT / "backend"
FRAME_DIR = HUB / "index" / "retarget_frames"
VERSION = 3

sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(PKG))
sys.path.insert(0, str(PKG / "holosoma_retargeting" / "data_utils"))

from app.services.file_lock import write_text_atomic  # noqa: E402
os.environ.setdefault("HOLOSOMA_ROBOT_PROFILES", str(HUB / "index" / "retarget_robots"))

TOE_NAMES = ("LeftToeBase", "RightToeBase", "LeftToe", "RightToe", "L_Foot", "R_Foot")


def frame_path(rel: str) -> Path:
    return FRAME_DIR / f"{hashlib.sha1(rel.encode('utf-8')).hexdigest()}.json"


def _raw_joints_cm(fbx: Path, skeleton: str | None) -> tuple[np.ndarray, np.ndarray]:
    import prep_fbx_for_rt as prep
    from holosoma_retargeting.config_types.data_type import BVH_DEMO_JOINTS
    from prep_bvh_for_rt import resolve_joint_indices

    scene = prep._require_pufbx().load_fbx(str(fbx))
    parents = prep._parent_map(scene)
    data, times, node_names = prep.bake_fbx_local_channels(scene)
    node_names = list(node_names)
    skel = skeleton or ""
    _prefixed_nodes, bare, sep = prep._nodes_for_skeleton(node_names, skel)
    resolved = resolve_joint_indices(bare)
    fk = [prep._prefixed(bare[resolved[j]], skel, sep) for j in BVH_DEMO_JOINTS]
    joints = prep.world_positions_from_local(data, times, node_names, parents, fk)
    return np.asarray(joints, dtype=np.float64), np.asarray(times, dtype=np.float64) - float(times[0])


def _fit_affine(raw_cm: np.ndarray, raw_t: np.ndarray, out_m: np.ndarray, fps: float) -> tuple[np.ndarray, float]:
    """Least-squares 3x4 map from raw FBX cm to converted metres."""
    out_t = np.arange(out_m.shape[0]) / float(fps)
    keep = out_t <= raw_t[-1] + 1e-6
    out_t = out_t[keep]
    target = out_m[keep]
    sampled = np.empty_like(target)
    for joint in range(raw_cm.shape[1]):
        for axis in range(3):
            sampled[:, joint, axis] = np.interp(out_t, raw_t, raw_cm[:, joint, axis])
    src = sampled.reshape(-1, 3)
    dst = target.reshape(-1, 3)
    ok = np.isfinite(src).all(axis=1) & np.isfinite(dst).all(axis=1)
    src, dst = src[ok], dst[ok]
    design = np.hstack([src, np.ones((src.shape[0], 1))])
    solution, *_ = np.linalg.lstsq(design, dst, rcond=None)
    affine = solution.T
    residual = design @ solution - dst
    return affine, float(np.sqrt(np.mean(np.sum(residual**2, axis=1))))


def _body_track(joints: np.ndarray, names: list[str]) -> dict:
    """Hips XY and facing yaw per 30 Hz frame, before floor and robot scale.

    Facing is left x up with left = (left joints - right joints), the same
    forward = +X, left = +Y body axes the robot base uses.
    """
    def column(name: str) -> np.ndarray | None:
        return joints[:, names.index(name)] if name in names else None

    hips = column("Hips")
    if hips is None:
        hips = joints[:, 0]
    lateral = np.zeros((joints.shape[0], 3))
    for left_name, right_name in (("LeftUpLeg", "RightUpLeg"), ("LeftArm", "RightArm"), ("LeftShoulder", "RightShoulder")):
        left, right = column(left_name), column(right_name)
        if left is not None and right is not None:
            lateral += left - right
    yaw = np.arctan2(-lateral[:, 0], lateral[:, 1])
    return {
        "hips_xy": np.round(hips[:, :2], 4).tolist(),
        "yaw": np.round(yaw, 4).tolist(),
    }


def scene_frame(fbx: Path) -> dict:
    from batch_retarget_to_csv import expand_jobs
    from holosoma_retargeting.src.utils import compute_motion_floor_z_offset
    from retarget_to_csv import TASK_NAME, convert_input_to_npz

    with tempfile.TemporaryDirectory(prefix="hub_rtframe_", dir="/tmp") as raw:
        tmp = Path(raw)
        in_dir = tmp / "in"
        in_dir.mkdir()
        link = in_dir / fbx.name
        link.symlink_to(fbx)
        jobs = expand_jobs(in_dir, tmp / "out", [link])
        skeletons: list[dict] = []
        for job in jobs:
            _input, skeleton, _csv, preserve, shared_height = job[:5]
            work = tmp / f"work_{len(skeletons)}"
            work.mkdir()
            convert_input_to_npz(
                link,
                work,
                0,
                None,
                skeleton=skeleton,
                preserve_world=preserve,
                human_height=shared_height,
            )
            data = np.load(work / f"{TASK_NAME}.npz", allow_pickle=True)
            joints = np.asarray(data["global_joint_positions"], dtype=np.float64)
            names = [str(item) for item in data["joint_names"]]
            fps = float(np.asarray(data["fps"]).reshape(()))
            toe_idx = [names.index(name) for name in TOE_NAMES if name in names]
            floor_z = float(compute_motion_floor_z_offset(joints, toe_idx)) if toe_idx else 0.0
            raw_cm, raw_t = _raw_joints_cm(fbx, skeleton)
            affine, rms = _fit_affine(raw_cm, raw_t, joints, fps)
            hips0 = joints[0, names.index("Hips")] if "Hips" in names else joints[0, 0]
            skeletons.append(
                {
                    "skeleton": skeleton or "",
                    "preserve_world": bool(preserve),
                    "affine": affine.round(9).tolist(),
                    "fit_rms_m": round(rms, 5),
                    "floor_z": round(floor_z, 6),
                    "height": round(float(np.asarray(data["height"]).reshape(())), 6),
                    "hips0": [round(float(value), 6) for value in hips0],
                    "fps": fps,
                    "track": _body_track(joints, names),
                }
            )
    return {"version": VERSION, "skeletons": skeletons}


def robot_heights() -> dict[str, float]:
    from app.services.retarget_priority import robot_catalog
    from holosoma_retargeting.config_types.robot import RobotConfig

    heights: dict[str, float] = {}
    for style in robot_catalog(HUB):
        try:
            heights[style] = float(RobotConfig(robot_type=style).ROBOT_HEIGHT)
        except Exception as exc:  # noqa: BLE001
            print(f"  {style}: ROBOT_HEIGHT 不可用（{exc}）", flush=True)
    return heights


def write_robot_heights() -> None:
    FRAME_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"version": VERSION, "robots": robot_heights()}
    write_text_atomic(FRAME_DIR / "robots.json", json.dumps(payload, ensure_ascii=False, indent=2))


def write_frame(fbx: Path, *, force: bool = False) -> Path | None:
    fbx = Path(fbx)
    rel = fbx.relative_to(HUB).as_posix()
    out = frame_path(rel)
    stat = fbx.stat()
    if out.is_file() and not force:
        try:
            old = json.loads(out.read_text(encoding="utf-8"))
            if (
                old.get("version") == VERSION
                and old.get("size") == stat.st_size
                and old.get("mtime") == int(stat.st_mtime)
            ):
                return out
        except (OSError, json.JSONDecodeError):
            pass
    payload = {"path": rel, "size": stat.st_size, "mtime": int(stat.st_mtime), **scene_frame(fbx)}
    FRAME_DIR.mkdir(parents=True, exist_ok=True)
    write_text_atomic(out, json.dumps(payload, ensure_ascii=False, indent=2))
    return out


def human_fbx_files() -> list[Path]:
    root = HUB / "data" / "human" / "motion"
    found: list[Path] = []
    for kind in ("merged", "object", "skeleton"):
        fmt_dir = root / kind / "fbx"
        if fmt_dir.is_dir():
            found.extend(sorted(path for path in fmt_dir.rglob("*.fbx") if path.is_file()))
    return found


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="*", help="FBX files (absolute or relative to hub_repo)")
    parser.add_argument("--all", action="store_true", help="every human merged/object/skeleton FBX")
    parser.add_argument("--merged", action="store_true", help="every human merged FBX")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    write_robot_heights()
    targets = [Path(item) if Path(item).is_absolute() else HUB / item for item in args.paths]
    if args.all:
        targets.extend(human_fbx_files())
    elif args.merged:
        targets.extend(path for path in human_fbx_files() if "/merged/" in path.as_posix())
    for index, fbx in enumerate(targets, 1):
        try:
            out = write_frame(fbx, force=args.force)
            print(f"[{index}/{len(targets)}] {fbx.relative_to(HUB)} -> {out.name if out else '-'}", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[{index}/{len(targets)}] {fbx.relative_to(HUB)} 失败：{exc}", flush=True)


if __name__ == "__main__":
    main()
