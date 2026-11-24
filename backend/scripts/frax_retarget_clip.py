"""Retarget one human clip onto a robot URDF with frax.

The CSV matches the hub's omniretarget skeleton files: metres, Z-up, root
position, quaternion xyzw, then actuated joints in URDF order. A merged FBX
keeps the capture origin so rigid bodies exported beside it stay aligned.
Any other clip is scaled from the human leg length onto the robot.

Run with the frax virtualenv:

    JAX_PLATFORMS=cpu /path/to/frax/.venv/bin/python \\
        backend/scripts/frax_retarget_clip.py \\
        --urdf robot.urdf --input clip.fbx --output clip.csv
"""

from __future__ import annotations

import os

os.environ.setdefault("JAX_PLATFORMS", "cpu")
os.environ.setdefault("JAX_ENABLE_X64", "1")
os.environ.setdefault(
    "XLA_FLAGS",
    "--xla_cpu_multi_thread_eigen=false "
    "--xla_cpu_scheduler_type=CPU_SCHEDULER_TYPE_MEMORY_OPTIMIZED",
)
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

import argparse
import re
import sys
import tempfile
from pathlib import Path

import numpy as np

FRAX_ROOT = Path(
    os.environ.get(
        "FRAX_ROOT",
        "/media/noetix/samsung_9901/new_home_2/code/open_src/frax",
    )
)
sys.path.insert(0, str(FRAX_ROOT))
sys.path.insert(0, str(FRAX_ROOT / "examples" / "ik" / "merged_fbx"))
sys.path.insert(0, str(FRAX_ROOT / "examples" / "ik" / "lafan1"))

from frax import Robot  # noqa: E402
from frax.ik import (  # noqa: E402
    DiffIKSolver,
    FrameTask,
    JointLimits,
    OfflineRetargeter,
    Retargeter,
    load_bvh,
    resample_poses,
)
from frax.utils.rotation_utils import quat_wxyz_to_rmat, rmat_to_quat_wxyz  # noqa: E402

import jax  # noqa: E402
import jax.numpy as jnp  # noqa: E402

Y_UP_TO_Z_UP = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]])
POSE_ORDER = (
    "Hips",
    "LeftUpLeg",
    "LeftLeg",
    "LeftFootMod",
    "RightUpLeg",
    "RightLeg",
    "RightFootMod",
    "Spine2",
    "LeftArm",
    "LeftForeArm",
    "LeftHand",
    "RightArm",
    "RightForeArm",
    "RightHand",
)
# Human slot, position weight, rotation weight, joint-name fragments.
# The first fragment that matches a robot joint wins.
TRACK = (
    (0, 80.0, 40.0, ("pelvis", "waist_yaw", "torso", "base_link", "root", "hips")),
    (1, 0.0, 10.0, ("l_leg_hip_yaw", "left_hip_yaw", "hip_yaw_l", "l_hip_yaw")),
    (2, 0.0, 10.0, ("l_leg_knee", "left_knee", "knee_pitch_l", "l_knee")),
    (3, 100.0, 10.0, ("l_leg_ankle_roll", "left_ankle_roll", "l_ankle_roll", "l_leg_ankle", "left_ankle")),
    (4, 0.0, 10.0, ("r_leg_hip_yaw", "right_hip_yaw", "hip_yaw_r", "r_hip_yaw")),
    (5, 0.0, 10.0, ("r_leg_knee", "right_knee", "knee_pitch_r", "r_knee")),
    (6, 100.0, 10.0, ("r_leg_ankle_roll", "right_ankle_roll", "r_ankle_roll", "r_leg_ankle", "right_ankle")),
    (7, 0.0, 40.0, ("waist_pitch", "torso_pitch", "spine_pitch", "waist_roll", "torso")),
    (8, 0.0, 20.0, ("l_arm_shoulder_yaw", "left_shoulder_yaw", "l_shoulder_yaw", "l_arm_shoulder", "left_shoulder")),
    (9, 0.0, 10.0, ("l_arm_elbow", "left_elbow", "l_elbow")),
    (10, 10.0, 10.0, ("l_arm_wrist_yaw", "left_wrist_yaw", "l_wrist_yaw", "l_arm_wrist", "left_wrist", "l_hand")),
    (11, 0.0, 20.0, ("r_arm_shoulder_yaw", "right_shoulder_yaw", "r_shoulder_yaw", "r_arm_shoulder", "right_shoulder")),
    (12, 0.0, 10.0, ("r_arm_elbow", "right_elbow", "r_elbow")),
    (13, 10.0, 10.0, ("r_arm_wrist_yaw", "right_wrist_yaw", "r_wrist_yaw", "r_arm_wrist", "right_wrist", "r_hand")),
)
GAIN = 30.0
# Same names the robot preview skips, so the CSV columns line up with the URDF it loads.
_FLOATING_JOINT = re.compile(
    r"floor_2_base|floating_base|floatingbase|root_joint|base_joint|world_to_",
    re.IGNORECASE,
)
_ACTUATED_TYPES = frozenset({"revolute", "continuous", "prismatic"})


def _norm(name: str) -> str:
    return name.lower().replace("-", "_").replace(" ", "")


def _viewer_joint_order(path: Path) -> list[str]:
    """Actuated joints in the order the robot preview reads from the URDF."""
    text = path.read_text(errors="replace")
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    names: list[str] = []
    for match in re.finditer(r"<joint\b([^>]*)>", text, flags=re.IGNORECASE):
        tag = match.group(1)
        name = re.search(r'name\s*=\s*"([^"]+)"', tag, flags=re.IGNORECASE)
        kind = re.search(r'type\s*=\s*"([^"]+)"', tag, flags=re.IGNORECASE)
        if name is None or kind is None:
            continue
        joint = name.group(1)
        if kind.group(1).lower() not in _ACTUATED_TYPES or _FLOATING_JOINT.search(joint):
            continue
        names.append(joint)
    if not names:
        raise RuntimeError(f"{path.name} 里没有可驱动关节")
    return names


def _match_joint(names: list[str], patterns: tuple[str, ...]) -> str | None:
    folded = [(_norm(name), name) for name in names]
    for pattern in patterns:
        token = pattern.replace("_", "")
        for key, original in folded:
            if token in key.replace("_", ""):
                return original
    return None


def _inflate(path: Path) -> Path:
    if not path.name.lower().endswith(".zst"):
        return path
    import zstandard

    raw = zstandard.ZstdDecompressor().decompress(path.read_bytes())
    temporary = Path(tempfile.mkdtemp(prefix="frax_fbx_")) / path.name[: -len(".zst")]
    temporary.write_bytes(raw)
    return temporary


def _bvh_fps(path: Path) -> float:
    for line in path.read_text(errors="replace").splitlines():
        if line.strip().startswith("Frame Time:"):
            step = float(line.split()[-1])
            return 1.0 / step if step > 0 else 30.0
    return 30.0


def _bone(poses: np.ndarray, names: list[str], candidates: tuple[str, ...]) -> np.ndarray | None:
    lookup = {name: index for index, name in enumerate(names)}
    for candidate in candidates:
        if candidate in lookup:
            return poses[:, lookup[candidate]]
        for name, index in lookup.items():
            if name.endswith("_" + candidate) or name.endswith(candidate):
                return poses[:, index]
    return None


def _poses_from_bvh(path: Path, fps: float) -> np.ndarray:
    native = _bvh_fps(path)
    poses, names = load_bvh(path, Y_UP_TO_Z_UP, scale=0.01)
    if abs(native - fps) > 0.5 and len(poses) >= 2:
        poses = resample_poses(poses, native, fps)
    slots = {
        "Hips": ("Hips",),
        "LeftUpLeg": ("LeftUpLeg",),
        "LeftLeg": ("LeftLeg",),
        "LeftFoot": ("LeftFoot",),
        "LeftToe": ("LeftToeBase", "LeftToe"),
        "RightUpLeg": ("RightUpLeg",),
        "RightLeg": ("RightLeg",),
        "RightFoot": ("RightFoot",),
        "RightToe": ("RightToeBase", "RightToe"),
        "Spine2": ("Spine2", "Spine1", "Spine"),
        "LeftArm": ("LeftArm",),
        "LeftForeArm": ("LeftForeArm",),
        "LeftHand": ("LeftHand",),
        "RightArm": ("RightArm",),
        "RightForeArm": ("RightForeArm",),
        "RightHand": ("RightHand",),
    }
    found = {slot: _bone(poses, names, candidates) for slot, candidates in slots.items()}
    missing = [slot for slot in ("Hips", "LeftFoot", "RightFoot", "LeftLeg", "RightLeg") if found.get(slot) is None]
    if missing:
        raise RuntimeError(f"{path.name} 缺少骨架关节：{', '.join(missing)}")

    def foot(side: str) -> np.ndarray:
        pose = found[f"{side}Foot"].copy()
        toe = found.get(f"{side}Toe")
        if toe is not None:
            pose[:, 3:] = toe[:, 3:]
        return pose

    columns = []
    for slot in POSE_ORDER:
        if slot == "LeftFootMod":
            columns.append(foot("Left"))
        elif slot == "RightFootMod":
            columns.append(foot("Right"))
        else:
            bone = found.get(slot)
            if bone is None:
                raise RuntimeError(f"{path.name} 缺少骨架关节：{slot}")
            columns.append(bone)
    return np.stack(columns, axis=1)


def _load_humans(path: Path, fps: float) -> list[np.ndarray]:
    path = _inflate(path)
    suffix = path.suffix.lower()
    if suffix == ".bvh":
        return [_poses_from_bvh(path, fps)]
    if suffix != ".fbx":
        raise RuntimeError(f"frax 目前接受 .fbx 和 .bvh，不能读 {path.name}")
    from fbx_scene import load_clip

    clip = load_clip(path, fps=fps)
    if not clip.skeletons:
        raise RuntimeError(f"{path.name} 里没有可重定向的人体骨架")
    return [skeleton.poses for skeleton in clip.skeletons]


def _mapping(robot: Robot) -> tuple[list[int], list[str], np.ndarray, np.ndarray]:
    actuated = list(robot.joint_names[robot.nv_floating :])
    slots: list[int] = []
    chosen: list[str] = []
    pos_w: list[float] = []
    rot_w: list[float] = []
    used: set[str] = set()
    for slot, position, rotation, patterns in TRACK:
        name = _match_joint([item for item in actuated if item not in used], patterns)
        if name is None:
            continue
        used.add(name)
        slots.append(slot)
        chosen.append(name)
        pos_w.append(position)
        rot_w.append(rotation)
    if len(chosen) < 8:
        raise RuntimeError(
            "URDF 里对不上足够的人体关节，无法用 frax 重定向：" + ", ".join(actuated)
        )
    return slots, chosen, np.asarray(pos_w), np.asarray(rot_w)


def _frame_rotation(robot: Robot, q: np.ndarray, names: list[str]) -> np.ndarray:
    frames = np.array([robot.joint_name_to_index[name] for name in names])
    transforms = np.asarray(robot.joint_to_world_transforms(jnp.asarray(q)))
    return transforms[frames, :3, :3]


def _frame_position(robot: Robot, q: np.ndarray, name: str) -> np.ndarray:
    index = int(robot.joint_name_to_index[name])
    transforms = np.asarray(robot.joint_to_world_transforms(jnp.asarray(q)))
    return np.asarray(transforms[index, :3, 3])


def _scale_and_shift(poses: np.ndarray, robot: Robot, preserve: bool) -> tuple[float, float]:
    if preserve:
        return 1.0, 0.0
    human = poses[0]
    human_leg = float(
        np.linalg.norm(human[1, :3] - human[2, :3]) + np.linalg.norm(human[2, :3] - human[3, :3])
    )
    q = np.zeros(robot.nq)
    q[3] = 1.0
    names = list(robot.joint_names)
    robot_leg = 0.0
    hip = _match_joint(names, ("l_leg_hip_yaw", "left_hip_yaw", "l_hip_yaw"))
    knee = _match_joint(names, ("l_leg_knee", "left_knee", "l_knee"))
    ankle = _match_joint(names, ("l_leg_ankle_roll", "left_ankle_roll", "l_leg_ankle", "left_ankle"))
    if hip and knee and ankle:
        points = [_frame_position(robot, q, name) for name in (hip, knee, ankle)]
        robot_leg = float(
            np.linalg.norm(points[0] - points[1]) + np.linalg.norm(points[1] - points[2])
        )
    scale = robot_leg / human_leg if human_leg > 1e-4 and robot_leg > 1e-4 else 1.0
    foot_z = scale * np.stack([poses[0, 3, 2], poses[0, 6, 2]])
    return scale, float(-np.min(foot_z))


def _rest_offsets(poses: np.ndarray, robot: Robot, slots: list[int], joints: list[str]) -> np.ndarray:
    from scipy.spatial.transform import Rotation

    q = np.zeros(robot.nq)
    q[3] = 1.0
    human = Rotation.from_quat(poses[0, slots, 3:], scalar_first=True).as_matrix()
    robot_rot = _frame_rotation(robot, q, joints)
    return np.einsum("nji,njk->nik", human, robot_rot)


def build_retargeter(robot: Robot, poses: np.ndarray, preserve: bool) -> Retargeter:
    slots, joints, weight_pos, weight_rot = _mapping(robot)
    offsets = _rest_offsets(poses, robot, slots, joints)
    scale, shift = _scale_and_shift(poses, robot, preserve)
    print(
        f"tracking {len(joints)} frames, scale {scale:.3f}, floor shift {shift:.3f} m",
        flush=True,
    )
    for slot, name, position, rotation in zip(slots, joints, weight_pos, weight_rot):
        print(f"  {POSE_ORDER[slot]} -> {name} pos {position:.0f} rot {rotation:.0f}", flush=True)

    slot_index = jnp.asarray(slots)
    offset_j = jnp.asarray(offsets)
    scale_j = jnp.asarray(scale)
    shift_j = jnp.asarray([0.0, 0.0, shift])

    def preprocess(human_poses):
        selected = human_poses[slot_index]
        position = selected[:, :3] * scale_j + shift_j
        rotation = jax.vmap(quat_wxyz_to_rmat)(selected[:, 3:]) @ offset_j
        return {"frame_pos": position, "frame_rmat": rotation}

    def initial_q(human_poses):
        ref = preprocess(human_poses)
        root_quat = rmat_to_quat_wxyz(ref["frame_rmat"][0])
        q = jnp.asarray(robot.default_configuration).at[:3].set(ref["frame_pos"][0])
        return q.at[3:7].set(root_quat)

    task = FrameTask(
        robot,
        [robot.joint_name_to_index[name] for name in joints],
        gain_pos=GAIN,
        gain_rot=GAIN,
        weight_pos=weight_pos,
        weight_rot=weight_rot,
    )
    damping = np.full(robot.nv, 10.0)
    for name in robot.joint_names:
        index = robot.joint_name_to_index.get(name) if isinstance(robot.joint_name_to_index, dict) else None
        if index is None:
            try:
                index = robot.joint_name_to_index[name]
            except Exception:
                continue
        if int(index) >= robot.nv:
            continue
        folded = _norm(name)
        if "shoulder" in folded and "yaw" in folded:
            damping[int(index)] = 1000.0
        elif "shoulder" in folded or "wrist" in folded:
            damping[int(index)] = 100.0
        elif "hip" in folded or "knee" in folded:
            damping[int(index)] = 80.0
    solver = DiffIKSolver(robot, [task], [JointLimits(robot)], regularization=damping)
    return Retargeter(solver, preprocess, initial_q)


def _write_csv(path: Path, q: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    root_pos = np.asarray(q[:, :3])
    root_quat_xyzw = np.asarray(q[:, [4, 5, 6, 3]])
    joints = np.asarray(q[:, 7:])
    table = np.concatenate([root_pos, root_quat_xyzw, joints], axis=1)
    temporary = path.with_suffix(path.suffix + ".tmp")
    np.savetxt(temporary, table, delimiter=",", fmt="%.8f")
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser(description="用 frax 把一条人体动作重定向成机器人骨架 CSV")
    parser.add_argument("--urdf", type=Path, required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--preserve-world", action="store_true")
    parser.add_argument("--max-frames", type=int, default=0)
    args = parser.parse_args()
    if not args.urdf.is_file():
        raise SystemExit(f"找不到 URDF：{args.urdf}")
    if not args.input.is_file():
        raise SystemExit(f"找不到输入：{args.input}")

    clips = _load_humans(args.input, args.fps)
    if args.max_frames > 1:
        clips = [clip[: args.max_frames] for clip in clips]
    robot = Robot(
        str(args.urdf),
        floating_base="quaternion",
        joint_ordering=_viewer_joint_order(args.urdf),
    )
    retargeter = build_retargeter(robot, clips[0], args.preserve_world)
    # The tracked pose width must match the joints chosen inside build_retargeter.
    # build_retargeter slices by its own joint count via the preprocess of full 14.
    solved = OfflineRetargeter(retargeter, 1.0 / args.fps)(clips)
    _write_csv(args.output, solved[0])
    print(f"wrote {args.output} frames {solved[0].shape[0]} joints {solved[0].shape[1] - 7}", flush=True)
    for index, configuration in enumerate(solved[1:], start=1):
        extra = args.output.with_name(f"{args.output.stem}_skeleton_{index}.csv")
        _write_csv(extra, configuration)
        print(f"wrote {extra}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
