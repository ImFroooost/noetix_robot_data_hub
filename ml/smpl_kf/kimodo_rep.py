"""动作特征：骨盆路径、朝向、相对骨盆的关节位置、全局速度、全局 6D 旋转和脚接触。

关键帧只在给定的那几帧上约束根位置、朝向、关节位置和全局旋转，帧与帧之间全部由模型生成。
"""

from __future__ import annotations

import numpy as np
from scipy.spatial.transform import Rotation

from smpl_kf.geometry import N_JOINTS, ROT_DIM, matrix_to_rot6d, rot6d_to_matrix, slerp_quat

PARENTS = np.array(
    [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 12, 12, 13, 14, 16, 17, 18, 19, 20, 21],
    dtype=np.int64,
)
REST = np.array(
    [
        [0.0, 0.0, 0.0],
        [0.065, -0.08, 0.0],
        [-0.065, -0.08, 0.0],
        [0.0, 0.1, 0.0],
        [0.01, -0.37, 0.0],
        [-0.01, -0.37, 0.0],
        [0.0, 0.1, 0.0],
        [0.0, -0.39, 0.0],
        [0.0, -0.39, 0.0],
        [0.0, 0.11, 0.0],
        [0.0, -0.06, 0.1],
        [0.0, -0.06, 0.1],
        [0.0, 0.12, 0.0],
        [0.09, 0.1, 0.0],
        [-0.09, 0.1, 0.0],
        [0.0, 0.1, 0.0],
        [0.08, 0.05, 0.0],
        [-0.08, 0.05, 0.0],
        [0.28, 0.0, 0.0],
        [-0.28, 0.0, 0.0],
        [0.25, 0.0, 0.0],
        [-0.25, 0.0, 0.0],
    ],
    dtype=np.float64,
)
# 左脚跟、左脚尖、右脚跟、右脚尖。脚跟用踝，脚尖用脚。
FOOT_JOINTS = (7, 10, 8, 11)
LEG_CHAINS = ((1, 4, 7), (2, 5, 8))
# 左右对应的关节：髋、膝、踝、脚、锁骨、肩、肘、腕。
MIRROR_PAIRS = ((1, 2), (4, 5), (7, 8), (10, 11), (13, 14), (16, 17), (18, 19), (20, 21))
# 绕骨头轴的拧转不改变子关节位置。这些关节的拧转跟着上一帧，只保留弯曲。
HINGE_BONES = ((4, 7), (5, 8), (12, 15), (13, 16), (14, 17), (16, 18), (17, 19), (18, 20), (19, 21))
MAX_ROT_STEP = np.deg2rad(30.0)
NEAR_KEY_ROT = np.deg2rad(20.0)

ROOT_DIM = 5
POS_DIM = N_JOINTS * 3
VEL_DIM = N_JOINTS * 3
ANG_DIM = N_JOINTS * 6
CONTACT_DIM = 4
FEAT_DIM = ROOT_DIM + POS_DIM + VEL_DIM + ANG_DIM + CONTACT_DIM
ROOT_SLICE = slice(0, 3)
HEAD_SLICE = slice(3, 5)
POS_SLICE = slice(5, 5 + POS_DIM)
VEL_SLICE = slice(5 + POS_DIM, 5 + POS_DIM + VEL_DIM)
ANG_SLICE = slice(5 + POS_DIM + VEL_DIM, 5 + POS_DIM + VEL_DIM + ANG_DIM)
CONTACT_SLICE = slice(FEAT_DIM - CONTACT_DIM, FEAT_DIM)
# 关键帧上已知的通道。速度和脚接触要看相邻帧，关键帧本身给不出来。
KEY_SLICES = (ROOT_SLICE, HEAD_SLICE, POS_SLICE, ANG_SLICE)

_MIRROR_ORDER = np.arange(N_JOINTS)
for _left, _right in MIRROR_PAIRS:
    _MIRROR_ORDER[_left], _MIRROR_ORDER[_right] = _right, _left
# 关于 x=0 平面做镜像：R -> M R M，M = diag(-1, 1, 1)。6D 是旋转矩阵的前两列。
_MIRROR_SIGN = np.array([1.0, -1.0, -1.0, -1.0, 1.0, 1.0], np.float32)


def fk_local(rot6d: np.ndarray, trans: np.ndarray):
    """局部 6D 旋转和骨盆位移 -> 世界坐标位置和世界旋转。"""
    frames = rot6d.shape[0]
    local = rot6d_to_matrix(rot6d.reshape(frames, N_JOINTS, 6))
    pos = np.zeros((frames, N_JOINTS, 3), np.float64)
    world = np.zeros((frames, N_JOINTS, 3, 3), np.float64)
    for index, parent in enumerate(PARENTS[:N_JOINTS]):
        if parent < 0:
            world[:, index] = local[:, index]
            pos[:, index] = trans
        else:
            world[:, index] = np.matmul(world[:, parent], local[:, index])
            offset = np.matmul(world[:, parent], REST[index])
            pos[:, index] = pos[:, parent] + offset
    return pos, world


def _heading(pos: np.ndarray) -> np.ndarray:
    hips = pos[:, 2] - pos[:, 1]
    psi = np.arctan2(hips[:, 2], -hips[:, 0])
    return np.stack((np.cos(psi), np.sin(psi)), axis=-1).astype(np.float32)


def foot_contacts(pos: np.ndarray) -> np.ndarray:
    height = pos[:, FOOT_JOINTS, 1]
    vertical = np.zeros_like(height)
    vertical[1:] = np.abs(height[1:] - height[:-1])
    floor = np.percentile(height, 15, axis=0)
    contact = (height <= floor + 0.04) & (vertical < 0.03)
    if len(contact) > 1:
        contact[0] = contact[1]
    return contact.astype(np.float32)


def _static_channels(pos: np.ndarray, world: np.ndarray, origin) -> tuple[np.ndarray, ...]:
    """只靠单帧就能算出来的通道：根位置、朝向、相对骨盆的关节位置、全局旋转。"""
    pelvis = pos[:, 0]
    root = np.array(pelvis, dtype=np.float64, copy=True)
    root[:, 0] -= origin[0]
    root[:, 2] -= origin[1]
    relative = np.array(pos, dtype=np.float64, copy=True)
    relative[:, :, 0] -= pelvis[:, None, 0]
    relative[:, :, 2] -= pelvis[:, None, 2]
    angles = matrix_to_rot6d(world).reshape(len(pos), -1)
    return root, _heading(pos), relative.reshape(len(pos), -1), angles


def encode_motion(feat: np.ndarray) -> np.ndarray:
    """135 维局部旋转+骨盆位移 -> 273 维特征。第一帧骨盆的水平位置放在原点。"""
    feat = np.asarray(feat, np.float64)
    pos, world = fk_local(feat[:, :ROT_DIM], feat[:, ROT_DIM:])
    origin = (float(pos[0, 0, 0]), float(pos[0, 0, 2]))
    root, heading, relative, angles = _static_channels(pos, world, origin)
    velocity = np.zeros_like(pos)
    velocity[1:] = pos[1:] - pos[:-1]
    packed = np.concatenate(
        (root, heading, relative, velocity.reshape(len(feat), -1), angles, foot_contacts(pos)),
        axis=-1,
    )
    return packed.astype(np.float32)


def key_mask(length: int, key_idx: np.ndarray) -> np.ndarray:
    mask = np.zeros((length, FEAT_DIM), np.float32)
    key_idx = np.asarray(key_idx, np.int64)
    if len(key_idx) == 0:
        return mask
    for part in KEY_SLICES:
        mask[key_idx, part] = 1.0
    return mask


def keyframe_targets(key_feats: np.ndarray, key_idx: np.ndarray, length: int, origin) -> tuple[np.ndarray, np.ndarray]:
    """只用关键帧本身算出约束。origin 是窗口第一帧骨盆的水平位置。"""
    key_idx = np.asarray(key_idx, np.int64)
    target = np.zeros((length, FEAT_DIM), np.float32)
    if len(key_idx) == 0:
        return target, key_mask(length, key_idx)
    key_feats = np.asarray(key_feats, np.float64)
    pos, world = fk_local(key_feats[:, :ROT_DIM], key_feats[:, ROT_DIM:])
    root, heading, relative, angles = _static_channels(pos, world, origin)
    target[key_idx, ROOT_SLICE] = root
    target[key_idx, HEAD_SLICE] = heading
    target[key_idx, POS_SLICE] = relative
    target[key_idx, ANG_SLICE] = angles
    return target, key_mask(length, key_idx)


def decode_motion(feat: np.ndarray, origin=(0.0, 0.0)) -> np.ndarray:
    """273 维特征 -> 135 维局部旋转和骨盆位移。骨架由全局旋转决定，骨盆用预测的根位置。"""
    feat = np.asarray(feat, np.float64)
    frames = feat.shape[0]
    world = rot6d_to_matrix(feat[:, ANG_SLICE].reshape(frames, N_JOINTS, 6))
    local = np.zeros_like(world)
    local[:, 0] = world[:, 0]
    for index, parent in enumerate(PARENTS[:N_JOINTS]):
        if parent < 0:
            continue
        local[:, index] = np.matmul(np.swapaxes(world[:, parent], -1, -2), world[:, index])
    trans = np.array(feat[:, ROOT_SLICE], copy=True)
    trans[:, 0] += origin[0]
    trans[:, 2] += origin[1]
    rot6d = matrix_to_rot6d(local).reshape(frames, ROT_DIM)
    return np.concatenate((rot6d, trans), axis=-1).astype(np.float32)


def mirror_motion(feat: np.ndarray) -> np.ndarray:
    """左右镜像：关节左右对调，旋转和位移关于 x=0 平面翻过去。静止骨架本身左右对称。"""
    feat = np.asarray(feat, np.float32)
    frames = len(feat)
    rot = feat[:, :ROT_DIM].reshape(frames, N_JOINTS, 6)[:, _MIRROR_ORDER] * _MIRROR_SIGN
    trans = np.array(feat[:, ROT_DIM:], copy=True)
    trans[:, 0] = -trans[:, 0]
    return np.concatenate((rot.reshape(frames, ROT_DIM), trans), axis=-1).astype(np.float32)


def resample_window(feat: np.ndarray, out_len: int) -> np.ndarray:
    """把一段动作线性重采样成 out_len 帧。相邻帧旋转差得很小，线性混合后再正交化即可。"""
    feat = np.asarray(feat, np.float64)
    frames = len(feat)
    if frames == out_len:
        return feat.astype(np.float32)
    if frames == 1:
        return np.repeat(feat, out_len, axis=0).astype(np.float32)
    position = np.linspace(0.0, frames - 1, out_len)
    low = np.floor(position).astype(np.int64)
    high = np.minimum(low + 1, frames - 1)
    weight = (position - low)[:, None]
    mixed = feat[low] * (1.0 - weight) + feat[high] * weight
    rot = rot6d_to_matrix(mixed[:, :ROT_DIM].reshape(out_len, N_JOINTS, 6))
    mixed[:, :ROT_DIM] = matrix_to_rot6d(rot).reshape(out_len, ROT_DIM)
    return mixed.astype(np.float32)


def yaw_augment(feat: np.ndarray, yaw: float) -> np.ndarray:
    """绕竖直轴转动整段动作。不把每帧再拧回固定朝向，空翻时朝向可以连续变化。"""
    feat = np.array(feat, dtype=np.float64, copy=True)
    cosine, sine = np.cos(yaw), np.sin(yaw)
    rotation = np.array([[cosine, 0.0, sine], [0.0, 1.0, 0.0], [-sine, 0.0, cosine]], np.float64)
    roots = rot6d_to_matrix(feat[:, :6])
    feat[:, :6] = matrix_to_rot6d(np.matmul(rotation, roots))
    feat[:, ROT_DIM:] = feat[:, ROT_DIM:] @ rotation.T
    return feat.astype(np.float32)


def _rotation_between(source: np.ndarray, target: np.ndarray) -> np.ndarray:
    source = source / max(np.linalg.norm(source), 1e-8)
    target = target / max(np.linalg.norm(target), 1e-8)
    cross = np.cross(source, target)
    cosine = float(np.clip(np.dot(source, target), -1.0, 1.0))
    if cosine > 0.999:
        return np.eye(3)
    if cosine < -0.999:
        axis = np.array([1.0, 0.0, 0.0])
        if abs(source[0]) > 0.9:
            axis = np.array([0.0, 0.0, 1.0])
        axis = np.cross(source, axis)
        axis = axis / np.linalg.norm(axis)
        return Rotation.from_rotvec(axis * np.pi).as_matrix()
    skew = np.array(
        [[0.0, -cross[2], cross[1]], [cross[2], 0.0, -cross[0]], [-cross[1], cross[0], 0.0]]
    )
    return np.eye(3) + skew + skew @ skew * (1.0 / (1.0 + cosine))


def _fk_one(feat: np.ndarray, frame: int):
    pos, world = fk_local(feat[frame : frame + 1, :ROT_DIM], feat[frame : frame + 1, ROT_DIM:])
    return pos[0], world[0]


def _write_local(feat: np.ndarray, world: np.ndarray, frame: int, joint: int) -> None:
    parent = int(PARENTS[joint])
    local = world[joint] if parent < 0 else world[parent].T @ world[joint]
    feat[frame, joint * 6 : (joint + 1) * 6] = matrix_to_rot6d(local)


def _bone_axis(child: int) -> np.ndarray:
    axis = np.asarray(REST[child], np.float64)
    return axis / max(float(np.linalg.norm(axis)), 1e-8)


def _swing_and_twist(rotation: np.ndarray, axis: np.ndarray) -> tuple[np.ndarray, float]:
    """旋转拆成「把骨头指向目标」的弯曲，和绕骨头轴的拧转角。"""
    swing = _rotation_between(axis, rotation @ axis)
    twist = swing.T @ rotation
    angle = float(np.dot(Rotation.from_matrix(twist).as_rotvec(), axis))
    return swing, angle


def _carry_hinge_twist(feat: np.ndarray, keys: np.ndarray) -> None:
    """肘、膝、肩、锁骨和脖子只保留弯曲。绕骨头的拧转在相邻关键帧之间匀速过渡。"""
    frames = len(feat)
    mats = rot6d_to_matrix(feat[:, :ROT_DIM].reshape(frames, N_JOINTS, 6))
    for joint, child in HINGE_BONES:
        axis = _bone_axis(child)
        angles = np.unwrap([_swing_and_twist(mats[frame, joint], axis)[1] for frame in range(frames)])
        for start, end in zip(keys[:-1], keys[1:]):
            start, end = int(start), int(end)
            if end - start < 2:
                continue
            span = np.linspace(angles[start], angles[end], end - start + 1)
            for offset, frame in enumerate(range(start + 1, end)):
                swing = _swing_and_twist(mats[frame, joint], axis)[0]
                twist = Rotation.from_rotvec(axis * float(span[offset + 1])).as_matrix()
                mats[frame, joint] = swing @ twist
    feat[:, :ROT_DIM] = matrix_to_rot6d(mats).reshape(frames, ROT_DIM)


def _hemisphere(quats: np.ndarray) -> np.ndarray:
    out = np.array(quats, dtype=np.float64, copy=True)
    for index in range(1, len(out)):
        if float(np.dot(out[index], out[index - 1])) < 0.0:
            out[index] *= -1.0
    return out


def _step_toward(src: np.ndarray, dst: np.ndarray, max_step: float) -> np.ndarray:
    delta = (Rotation.from_quat(src).inv() * Rotation.from_quat(dst)).as_rotvec()
    length = float(np.linalg.norm(delta))
    if length <= max_step or length < 1e-8:
        return np.asarray(dst, np.float64)
    stepped = Rotation.from_quat(src) * Rotation.from_rotvec(delta / length * max_step)
    return stepped.as_quat()


def _spread_rotation_steps(feat: np.ndarray, keys: np.ndarray, max_step: float) -> None:
    """单帧转角超过 max_step 时，把多出来的角度摊到前后的自由帧上。关键帧保持原样。"""
    frames = len(feat)
    mats = rot6d_to_matrix(feat[:, :ROT_DIM].reshape(frames, N_JOINTS, 6))
    for joint in range(N_JOINTS):
        pred = _hemisphere(Rotation.from_matrix(mats[:, joint]).as_quat())
        out = pred.copy()
        for start, end in zip(keys[:-1], keys[1:]):
            start, end = int(start), int(end)
            if end - start < 2:
                continue
            forward = pred.copy()
            for index in range(start + 1, end):
                forward[index] = _step_toward(forward[index - 1], pred[index], max_step)
            forward[end] = pred[end]
            backward = pred.copy()
            backward[end] = pred[end]
            for index in range(end - 1, start, -1):
                backward[index] = _step_toward(backward[index + 1], pred[index], max_step)
            backward[start] = pred[start]
            span = np.arange(start, end + 1)
            weight = (span - start) / float(end - start)
            mixed = np.asarray(slerp_quat(forward[span], backward[span], weight), np.float64)
            mixed = mixed / np.clip(np.linalg.norm(mixed, axis=-1, keepdims=True), 1e-8, None)
            mixed[0] = pred[start]
            mixed[-1] = pred[end]
            for _ in range(6):
                for index in range(1, len(mixed)):
                    mixed[index] = _step_toward(mixed[index - 1], mixed[index], max_step)
                mixed[-1] = pred[end]
                for index in range(len(mixed) - 2, 0, -1):
                    mixed[index] = _step_toward(mixed[index + 1], mixed[index], max_step)
                mixed[0] = pred[start]
            out[span] = mixed
        out[keys] = pred[keys]
        mats[:, joint] = Rotation.from_quat(out).as_matrix()
    feat[:, :ROT_DIM] = matrix_to_rot6d(mats).reshape(frames, ROT_DIM)


def settle_rotations(feat: np.ndarray, key_idx: np.ndarray, max_step: float = MAX_ROT_STEP) -> np.ndarray:
    """去掉肢体拧转和单帧旋转跳变。只改旋转，骨盆位移不动，关键帧姿态钉住。"""
    feat = np.array(feat, dtype=np.float64, copy=True)
    keys = np.unique(np.asarray(key_idx, np.int64))
    keys = keys[(keys >= 0) & (keys < len(feat))]
    if len(keys) < 2:
        return feat.astype(np.float32)
    original = np.array(feat, copy=True)
    _carry_hinge_twist(feat, keys)
    _spread_rotation_steps(feat, keys, float(max_step))
    feat[keys] = original[keys]
    return feat.astype(np.float32)


def _limit_matrix(delta: np.ndarray, max_step: float) -> np.ndarray:
    rotvec = Rotation.from_matrix(delta).as_rotvec()
    length = float(np.linalg.norm(rotvec))
    if length <= max_step or length < 1e-8:
        return delta
    return Rotation.from_rotvec(rotvec / length * max_step).as_matrix()


def _bend_pole(hip_pos: np.ndarray, knee_pos: np.ndarray, direction: np.ndarray) -> np.ndarray:
    pole = knee_pos - hip_pos
    return pole - direction * float(np.dot(pole, direction))


def foot_lock_legacy(feat: np.ndarray, contacts: np.ndarray, pinned=None) -> np.ndarray:
    """接触段里把脚踝留在落点，并用两段骨骼把腿转过去。关键帧保持原样。

    腿接近伸直时沿用上一帧的膝盖朝向，避免极向量翻面。关键帧相邻帧上，腿的转动不超过 20°。
    """
    feat = np.array(feat, dtype=np.float64, copy=True)
    contacts = np.asarray(contacts, np.float32)
    pinned = {int(frame) for frame in (pinned if pinned is not None else [])}
    adjacent = set()
    for frame in pinned:
        adjacent.add(frame - 1)
        adjacent.add(frame + 1)
    adjacent -= pinned
    for side, (hip, knee, ankle) in enumerate(LEG_CHAINS):
        heel = contacts[:, side * 2] > 0.5
        anchor = None
        last_pole = None
        for frame in range(len(feat)):
            if not heel[frame]:
                anchor = None
                last_pole = None
                continue
            pos, world = _fk_one(feat, frame)
            if frame in pinned:
                anchor = pos[ankle].copy()
                direction = anchor - pos[hip]
                direction = direction / max(float(np.linalg.norm(direction)), 1e-8)
                pole = _bend_pole(pos[hip], pos[knee], direction)
                if float(np.linalg.norm(pole)) >= 1e-4:
                    last_pole = pole
                continue
            if anchor is None:
                anchor = pos[ankle].copy()
                direction = anchor - pos[hip]
                direction = direction / max(float(np.linalg.norm(direction)), 1e-8)
                pole = _bend_pole(pos[hip], pos[knee], direction)
                if float(np.linalg.norm(pole)) >= 1e-4:
                    last_pole = pole
                continue
            hip_pos = pos[hip]
            reach = anchor - hip_pos
            upper = float(np.linalg.norm(REST[knee]))
            lower = float(np.linalg.norm(REST[ankle]))
            distance = float(np.linalg.norm(reach))
            distance = min(max(distance, abs(upper - lower) + 1e-4), upper + lower - 1e-4)
            direction = reach / max(float(np.linalg.norm(reach)), 1e-8)
            pole = _bend_pole(hip_pos, pos[knee], direction)
            if last_pole is not None:
                carried = last_pole - direction * float(np.dot(last_pole, direction))
                short = float(np.linalg.norm(pole)) < 0.02
                flipped = float(np.linalg.norm(carried)) >= 1e-4 and float(np.dot(pole, carried)) < 0.0
                if short or flipped:
                    pole = carried
            if float(np.linalg.norm(pole)) < 1e-5:
                pole = np.cross(direction, np.array([0.0, 1.0, 0.0]))
            if float(np.linalg.norm(pole)) < 1e-5:
                pole = np.cross(direction, np.array([1.0, 0.0, 0.0]))
            pole = pole / max(float(np.linalg.norm(pole)), 1e-8)
            cosine = (upper * upper + distance * distance - lower * lower) / (2.0 * upper * distance)
            cosine = float(np.clip(cosine, -1.0, 1.0))
            sine = float(np.sqrt(max(0.0, 1.0 - cosine * cosine)))
            knee_pos = hip_pos + direction * (upper * cosine) + pole * (upper * sine)
            ankle_pos = hip_pos + direction * distance
            limit = NEAR_KEY_ROT if frame in adjacent else MAX_ROT_STEP
            prev_local = rot6d_to_matrix(feat[frame - 1, :ROT_DIM].reshape(N_JOINTS, 6))
            for joint, child_pos, rest_index in ((hip, knee_pos, knee), (knee, ankle_pos, ankle)):
                desired = child_pos - pos[joint]
                current = world[joint] @ REST[rest_index]
                world[joint] = _rotation_between(current, desired) @ world[joint]
                parent = int(PARENTS[joint])
                local = world[joint] if parent < 0 else world[parent].T @ world[joint]
                local = prev_local[joint] @ _limit_matrix(prev_local[joint].T @ local, limit)
                feat[frame, joint * 6 : (joint + 1) * 6] = matrix_to_rot6d(local)
                pos, world = _fk_one(feat, frame)
            direction = pos[ankle] - pos[hip]
            direction = direction / max(float(np.linalg.norm(direction)), 1e-8)
            solved = _bend_pole(pos[hip], pos[knee], direction)
            if float(np.linalg.norm(solved)) >= 1e-4:
                last_pole = solved
    return feat.astype(np.float32)
