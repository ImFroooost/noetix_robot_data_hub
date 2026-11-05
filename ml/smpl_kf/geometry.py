"""SMPL 身体轨迹的几何变换。

每帧特征 135 维：22 个关节的 6D 旋转（132）接根节点位移 xyz（3）。
关节 0 是根朝向，布局与 AMASS / 自采 npz 的前 66 维轴角一致。
自采数据多出来的两个手部关节、AMASS 的手指和 DMPL 都不进模型。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation

N_JOINTS = 22
AA_DIM = N_JOINTS * 3
ROT_DIM = N_JOINTS * 6
TRANS_DIM = 3
FEAT_DIM = ROT_DIM + TRANS_DIM
DST_FPS = 30


def rot6d_to_matrix(r6: np.ndarray) -> np.ndarray:
    """Zhou 6D -> 旋转矩阵，最后一维是列向量。"""
    r6 = np.asarray(r6, np.float64)
    a1 = r6[..., 0:3]
    a2 = r6[..., 3:6]
    b1 = a1 / np.clip(np.linalg.norm(a1, axis=-1, keepdims=True), 1e-8, None)
    b2 = a2 - np.sum(b1 * a2, axis=-1, keepdims=True) * b1
    b2 = b2 / np.clip(np.linalg.norm(b2, axis=-1, keepdims=True), 1e-8, None)
    b3 = np.cross(b1, b2, axis=-1)
    return np.stack((b1, b2, b3), axis=-1)


def matrix_to_rot6d(rot: np.ndarray) -> np.ndarray:
    return np.concatenate((rot[..., :, 0], rot[..., :, 1]), axis=-1)


def slerp_quat(q0: np.ndarray, q1: np.ndarray, t: np.ndarray) -> np.ndarray:
    """四元数 slerp。t 可广播到 q0 去掉最后一维之后的形状。"""
    q0 = np.asarray(q0, np.float64)
    q1 = np.asarray(q1, np.float64)
    weight = np.asarray(t, np.float64)
    target = q0.shape[:-1]
    if weight.shape != target:
        if weight.ndim < len(target):
            weight = weight.reshape(weight.shape + (1,) * (len(target) - weight.ndim))
        weight = np.broadcast_to(weight, target)
    weight = weight[..., None]
    dot = np.sum(q0 * q1, axis=-1, keepdims=True)
    q1 = np.where(dot < 0.0, -q1, q1)
    dot = np.clip(np.sum(q0 * q1, axis=-1, keepdims=True), -1.0, 1.0)
    omega = np.arccos(dot)
    sin_o = np.sin(omega)
    small = np.abs(sin_o) < 1e-4
    s0 = np.sin((1.0 - weight) * omega) / np.clip(sin_o, 1e-8, None)
    s1 = np.sin(weight * omega) / np.clip(sin_o, 1e-8, None)
    blended = s0 * q0 + s1 * q1
    lerp = (1.0 - weight) * q0 + weight * q1
    lerp = lerp / np.clip(np.linalg.norm(lerp, axis=-1, keepdims=True), 1e-8, None)
    return np.where(small, lerp, blended)


def motion_to_feat(aa: np.ndarray, trans: np.ndarray) -> np.ndarray:
    aa = np.asarray(aa, np.float64).reshape(-1, N_JOINTS, 3)
    mats = Rotation.from_rotvec(aa.reshape(-1, 3)).as_matrix().reshape(-1, N_JOINTS, 3, 3)
    rot6d = matrix_to_rot6d(mats).reshape(len(aa), ROT_DIM)
    trans = np.asarray(trans, np.float64).reshape(len(aa), 3)
    return np.concatenate((rot6d, trans), axis=-1).astype(np.float32)


def feat_to_motion(feat: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    feat = np.asarray(feat, np.float64)
    mats = rot6d_to_matrix(feat[:, :ROT_DIM].reshape(-1, N_JOINTS, 6))
    aa = Rotation.from_matrix(mats.reshape(-1, 3, 3)).as_rotvec().reshape(-1, AA_DIM)
    poses = np.zeros((len(feat), 72), np.float32)
    poses[:, :AA_DIM] = aa.astype(np.float32)
    trans = feat[:, ROT_DIM : ROT_DIM + TRANS_DIM].astype(np.float32)
    return poses, trans


def resample_motion(aa: np.ndarray, trans: np.ndarray, src_fps: float, dst_fps: float = DST_FPS):
    aa = np.asarray(aa, np.float64)
    trans = np.asarray(trans, np.float64)
    if aa.ndim == 3:
        aa = aa.reshape(aa.shape[0], -1)
    if aa.shape[0] < 2:
        raise ValueError("short")
    if aa.shape[1] < AA_DIM:
        raise ValueError("pose_dim")
    aa = aa[:, :AA_DIM]
    trans = trans.reshape(aa.shape[0], -1)[:, :3]
    if trans.shape[0] != aa.shape[0]:
        n = min(trans.shape[0], aa.shape[0])
        aa = aa[:n]
        trans = trans[:n]
    if not np.isfinite(aa).all() or not np.isfinite(trans).all():
        raise ValueError("nan")
    dt = 1.0 / float(src_fps)
    speed = np.linalg.norm(np.diff(trans, axis=0), axis=-1) / dt
    if speed.size and float(np.nanmax(speed)) > 40.0:
        raise ValueError("speed")
    frames = aa.shape[0]
    duration = (frames - 1) / float(src_fps)
    n_dst = max(2, int(round(duration * dst_fps)) + 1)
    t_src = np.linspace(0.0, duration, frames)
    t_dst = np.linspace(0.0, duration, n_dst)
    trans_d = np.stack([np.interp(t_dst, t_src, trans[:, i]) for i in range(3)], axis=1)
    quats = Rotation.from_rotvec(aa.reshape(-1, 3)).as_quat().reshape(frames, N_JOINTS, 4)
    seg = np.clip(np.searchsorted(t_src, t_dst, side="right") - 1, 0, frames - 2)
    denom = np.maximum(t_src[seg + 1] - t_src[seg], 1e-8)
    alpha = (t_dst - t_src[seg]) / denom
    alpha[0] = 0.0
    alpha[-1] = 1.0
    blended = slerp_quat(quats[seg], quats[seg + 1], alpha)
    aa_d = Rotation.from_quat(blended.reshape(-1, 4)).as_rotvec().reshape(n_dst, AA_DIM)
    return aa_d.astype(np.float32), trans_d.astype(np.float32)


def canon_factors(root6: np.ndarray, trans_ref: np.ndarray):
    """把参考帧转到面朝 +Z、水平位置在原点，高度保留。"""
    rot = rot6d_to_matrix(np.asarray(root6, np.float64))
    forward = rot[:, 2]
    horiz = float(np.hypot(forward[0], forward[2]))
    yaw = 0.0 if horiz < 1e-6 else float(np.arctan2(forward[0], forward[2]))
    cos_y, sin_y = np.cos(-yaw), np.sin(-yaw)
    ry = np.array(
        [[cos_y, 0.0, sin_y], [0.0, 1.0, 0.0], [-sin_y, 0.0, cos_y]],
        dtype=np.float64,
    )
    origin = np.asarray(trans_ref, np.float64).copy()
    origin[1] = 0.0
    return ry, origin, yaw


def apply_canon(rot6d: np.ndarray, trans: np.ndarray, ry: np.ndarray, origin: np.ndarray):
    trans_c = (np.asarray(trans, np.float64) - origin) @ ry.T
    roots = rot6d_to_matrix(np.asarray(rot6d, np.float64)[:, :6])
    roots_c = np.einsum("ij,tjk->tik", ry, roots)
    out = np.asarray(rot6d, np.float64).copy()
    out[:, :6] = matrix_to_rot6d(roots_c)
    return out, trans_c


def apply_decanon(rot6d: np.ndarray, trans: np.ndarray, ry: np.ndarray, origin: np.ndarray):
    trans_w = np.asarray(trans, np.float64) @ ry + origin
    roots = rot6d_to_matrix(np.asarray(rot6d, np.float64)[:, :6])
    roots_w = np.einsum("ij,tjk->tik", ry.T, roots)
    out = np.asarray(rot6d, np.float64).copy()
    out[:, :6] = matrix_to_rot6d(roots_w)
    return out, trans_w


def canonicalize_feat(feat: np.ndarray, ref: int = 0):
    ry, origin, yaw = canon_factors(feat[ref, :6], feat[ref, ROT_DIM:])
    rot, trans = apply_canon(feat[:, :ROT_DIM], feat[:, ROT_DIM:], ry, origin)
    out = np.concatenate((rot, trans), axis=-1).astype(np.float32)
    return out, (ry, origin, yaw)


def decanonicalize_feat(feat: np.ndarray, ry: np.ndarray, origin: np.ndarray) -> np.ndarray:
    rot, trans = apply_decanon(feat[:, :ROT_DIM], feat[:, ROT_DIM:], ry, origin)
    return np.concatenate((rot, trans), axis=-1).astype(np.float32)


def _restore_pinned(values: np.ndarray, keys: np.ndarray, original: np.ndarray) -> np.ndarray:
    if len(keys) == 0:
        return values
    error = np.asarray(original, np.float64)[keys] - values[keys]
    if np.allclose(error, 0):
        return values
    correction = np.stack(
        [np.interp(np.arange(len(values)), keys, error[:, dim]) for dim in range(values.shape[1])],
        axis=1,
    )
    return values + correction


def _repair_vector_spikes(values: np.ndarray, keys: np.ndarray, factor: float, floor: float) -> np.ndarray:
    """只平滑明显快于附近动作的帧，关键帧保持不动。"""
    out = np.array(values, dtype=np.float64, copy=True)
    pinned = np.zeros(len(out), dtype=bool)
    pinned[keys] = True
    for _ in range(24):
        step = np.linalg.norm(np.diff(out, axis=0), axis=1)
        limit = max(floor, factor * float(np.median(step)))
        hot = np.flatnonzero(step > limit)
        if len(hot) == 0:
            break
        touched = np.zeros(len(out), dtype=bool)
        touched[hot] = True
        touched[hot + 1] = True
        updated = out.copy()
        for index in np.flatnonzero(touched & ~pinned):
            if index == 0 or index == len(out) - 1:
                continue
            updated[index] = 0.5 * out[index] + 0.25 * out[index - 1] + 0.25 * out[index + 1]
        out = updated
        out[pinned] = values[pinned]
    return out


def _quat_step(quats: np.ndarray) -> np.ndarray:
    delta = (Rotation.from_quat(quats[:-1]).inv() * Rotation.from_quat(quats[1:])).as_rotvec()
    return np.linalg.norm(delta, axis=1)


def _repair_quat_spikes(quats: np.ndarray, keys: np.ndarray, factor: float, floor: float) -> np.ndarray:
    out = np.array(quats, dtype=np.float64, copy=True)
    pinned = np.zeros(len(out), dtype=bool)
    pinned[keys] = True
    for _ in range(24):
        step = _quat_step(out)
        limit = max(floor, factor * float(np.median(step)))
        hot = np.flatnonzero(step > limit)
        if len(hot) == 0:
            break
        touched = np.zeros(len(out), dtype=bool)
        touched[hot] = True
        touched[np.clip(hot + 1, 0, len(out) - 1)] = True
        updated = out.copy()
        for index in np.flatnonzero(touched & ~pinned):
            if index == 0 or index == len(out) - 1:
                continue
            averaged = slerp_quat(
                slerp_quat(out[index - 1], out[index + 1], 0.5),
                out[index],
                0.5,
            )
            updated[index] = np.asarray(averaged, np.float64).reshape(4)
        out = updated
        out[pinned] = quats[pinned]
    return out


def _restore_pinned_quat(quats: np.ndarray, original: np.ndarray, keys: np.ndarray) -> np.ndarray:
    """把钉住帧的旋转误差沿时间摊开，避免只改关键帧那一帧。"""
    if len(keys) < 2:
        quats = np.array(quats, copy=True)
        quats[keys] = original[keys]
        return quats
    out = np.array(quats, dtype=np.float64, copy=True)
    for start, end in zip(keys[:-1], keys[1:]):
        gap = int(end - start)
        if gap <= 0:
            continue
        err_start = (Rotation.from_quat(out[start]).inv() * Rotation.from_quat(original[start])).as_rotvec()
        err_end = (Rotation.from_quat(out[end]).inv() * Rotation.from_quat(original[end])).as_rotvec()
        for offset in range(gap + 1):
            weight = offset / gap
            correction = (1.0 - weight) * err_start + weight * err_end
            out[start + offset] = (Rotation.from_quat(out[start + offset]) * Rotation.from_rotvec(correction)).as_quat()
    return out


def _speed_limit(values: np.ndarray, max_step: float) -> np.ndarray:
    out = np.array(values, dtype=np.float64, copy=True)
    for index in range(1, len(out)):
        delta = out[index] - out[index - 1]
        length = float(np.linalg.norm(delta))
        if length > max_step:
            out[index] = out[index - 1] + delta / length * max_step
    return out


def _limit_quat_steps(quats: np.ndarray, max_step: float) -> np.ndarray:
    out = np.array(quats, dtype=np.float64, copy=True)
    for index in range(1, len(out)):
        delta = (Rotation.from_quat(out[index - 1]).inv() * Rotation.from_quat(out[index])).as_rotvec()
        length = float(np.linalg.norm(delta))
        if length > max_step:
            stepped = Rotation.from_quat(out[index - 1]) * Rotation.from_rotvec(delta / length * max_step)
            out[index] = stepped.as_quat()
    return out


def stabilize_feature(
    feat: np.ndarray,
    key_idx: np.ndarray,
    max_trans_step: float = 0.08,
    max_rot_step: float = 0.8,
) -> np.ndarray:
    """去掉关键帧上的单帧跳跃，同时留下步态里的往复动作。

    模型常把整段位移做短，再在关键帧那一帧硬跳回去。这里先限制每帧的变化量，
    再把缓慢的走偏换成关键帧之间的直线（或球面插值），只保留较快的动作细节。
    """
    feat = np.array(feat, dtype=np.float64, copy=True)
    keys = np.unique(np.asarray(key_idx, np.int64))
    keys = keys[(keys >= 0) & (keys < len(feat))]
    if len(keys) < 2:
        return feat.astype(np.float32)

    limited_trans = _speed_limit(feat[:, ROT_DIM:], max_trans_step)
    trans = np.array(limited_trans, copy=True)
    for start, end in zip(keys[:-1], keys[1:]):
        count = int(end - start + 1)
        if count < 3:
            continue
        chord = np.linspace(feat[start, ROT_DIM:], feat[end, ROT_DIM:], count)
        piece = limited_trans[start : end + 1]
        trend = np.linspace(piece[0], piece[-1], count)
        trans[start : end + 1] = chord + (piece - trend)
    trans[keys] = feat[keys, ROT_DIM:]
    trans = _repair_vector_spikes(trans, keys, factor=4.0, floor=0.12)
    trans = _restore_pinned(trans, keys, feat[:, ROT_DIM:])

    rot6d = feat[:, :ROT_DIM].reshape(-1, N_JOINTS, 6)
    mats = rot6d_to_matrix(rot6d)
    quats = Rotation.from_matrix(mats.reshape(-1, 3, 3)).as_quat().reshape(len(feat), N_JOINTS, 4)
    limited_q = np.stack([_limit_quat_steps(quats[:, joint], max_rot_step) for joint in range(N_JOINTS)], axis=1)
    out_q = np.array(limited_q, copy=True)
    for joint in range(N_JOINTS):
        for start, end in zip(keys[:-1], keys[1:]):
            count = int(end - start + 1)
            if count < 3:
                continue
            weights = np.linspace(0.0, 1.0, count)
            true_chord = slerp_quat(
                np.broadcast_to(quats[start, joint], (count, 4)),
                np.broadcast_to(quats[end, joint], (count, 4)),
                weights,
            )
            own_chord = slerp_quat(
                np.broadcast_to(limited_q[start, joint], (count, 4)),
                np.broadcast_to(limited_q[end, joint], (count, 4)),
                weights,
            )
            detail = (Rotation.from_quat(own_chord).inv() * Rotation.from_quat(limited_q[start : end + 1, joint])).as_rotvec()
            blended = Rotation.from_quat(true_chord) * Rotation.from_rotvec(detail)
            out_q[start : end + 1, joint] = blended.as_quat()
    out_q[keys] = quats[keys]
    # 关节角速度不再做尖峰抑制。空翻、手翻的合法快速转动会被全局中位数当成异常。
    out_mats = Rotation.from_quat(out_q.reshape(-1, 4)).as_matrix().reshape(len(feat), N_JOINTS, 3, 3)
    out = np.concatenate(
        (matrix_to_rot6d(out_mats).reshape(len(feat), ROT_DIM), trans),
        axis=-1,
    ).astype(np.float32)
    out[keys] = feat[keys]
    return out


def align_to_y_up(aa: np.ndarray, trans: np.ndarray):
    """把片段旋到身体的「上」对准世界 Y 轴。

    自采数据是 Z 轴朝上，AMASS 是 Y 轴朝上。混在一起时，朝前走会被记成身高变化。
    返回对齐后的轴角、位移，以及作用在原始数据上的旋转矩阵。
    """
    aa = np.array(aa, dtype=np.float64, copy=True)
    trans = np.array(trans, dtype=np.float64, copy=True)
    roots = Rotation.from_rotvec(aa[:, :3])
    body_up = roots.apply(np.array([0.0, 1.0, 0.0]))
    mean_up = body_up.mean(axis=0)
    if float(np.linalg.norm(mean_up)) < 0.35:
        return aa.astype(np.float32), trans.astype(np.float32), np.eye(3, dtype=np.float64)
    mean_up = mean_up / np.linalg.norm(mean_up)
    target = np.array([0.0, 1.0, 0.0])
    cosine = float(np.clip(np.dot(mean_up, target), -1.0, 1.0))
    if cosine > 0.999:
        rotation = np.eye(3, dtype=np.float64)
    elif cosine < -0.999:
        rotation = Rotation.from_rotvec([np.pi, 0.0, 0.0]).as_matrix()
    else:
        axis = np.cross(mean_up, target)
        rotation = Rotation.from_rotvec(axis / np.linalg.norm(axis) * np.arccos(cosine)).as_matrix()
    aligned = Rotation.from_matrix(rotation)
    trans = aligned.apply(trans)
    aa[:, :3] = (aligned * roots).as_rotvec()
    return aa.astype(np.float32), trans.astype(np.float32), rotation


def apply_feature_rotation(feat: np.ndarray, rotation: np.ndarray) -> np.ndarray:
    """用一个世界旋转同时转根朝向和根位移。身体局部关节不变。"""
    feat = np.array(feat, dtype=np.float64, copy=True)
    aligned = Rotation.from_matrix(np.asarray(rotation, np.float64))
    roots = Rotation.from_matrix(rot6d_to_matrix(feat[:, :6]))
    feat[:, :6] = matrix_to_rot6d((aligned * roots).as_matrix())
    feat[:, ROT_DIM:] = aligned.apply(feat[:, ROT_DIM:])
    return feat.astype(np.float32)


def read_fps(data) -> float:
    for key in ("mocap_framerate", "mocap_frame_rate", "fps", "frame_rate"):
        if key not in data.files:
            continue
        value = float(np.asarray(data[key]).reshape(-1)[0])
        if value > 1.0:
            return value
    raise ValueError("fps")


def load_npz_motion(path: str | Path, dst_fps: float = DST_FPS, align_up: bool = True) -> dict:
    data = np.load(path, allow_pickle=True)
    if "poses" not in data.files:
        raise ValueError("no_pose")
    poses = np.asarray(data["poses"])
    if poses.ndim == 3:
        poses = poses.reshape(poses.shape[0], -1)
    if poses.ndim != 2 or poses.shape[1] < AA_DIM:
        raise ValueError("pose_dim")
    if "trans" not in data.files:
        raise ValueError("no_trans")
    trans = np.asarray(data["trans"], np.float32).reshape(-1, 3)
    frames = min(int(poses.shape[0]), int(trans.shape[0]))
    src_fps = read_fps(data)
    aa, trans_d = resample_motion(poses[:frames, :AA_DIM], trans[:frames], src_fps, dst_fps)
    if aa.shape[0] < 16:
        raise ValueError("short")
    align = np.eye(3, dtype=np.float64)
    if align_up:
        aa, trans_d, align = align_to_y_up(aa, trans_d)
    betas = None
    if "betas" in data.files:
        betas = np.asarray(data["betas"], np.float32).reshape(-1)[:16].astype(np.float32)
    return {
        "feat": motion_to_feat(aa, trans_d),
        "fps": dst_fps,
        "src_fps": src_fps,
        "betas": betas,
        "align": align,
        "path": str(path),
    }


def interpolate_keyframes(feat: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """在关键帧之间对旋转做 slerp、对位移做线性插值。mask 为 True 的帧保持原值。"""
    feat = np.asarray(feat, np.float32)
    mask = np.asarray(mask, bool).reshape(-1)
    idx = np.flatnonzero(mask)
    if len(idx) == 0:
        raise ValueError("至少需要一个关键帧")
    frames = feat.shape[0]
    quats = np.zeros((frames, N_JOINTS, 4), np.float64)
    key_rot = rot6d_to_matrix(feat[idx, :ROT_DIM].reshape(-1, N_JOINTS, 6))
    key_q = Rotation.from_matrix(key_rot.reshape(-1, 3, 3)).as_quat().reshape(len(idx), N_JOINTS, 4)
    trans = np.empty((frames, 3), np.float64)
    if len(idx) == 1:
        quats[:] = key_q[0]
        trans[:] = feat[idx[0], ROT_DIM:]
    else:
        quats[: idx[0]] = key_q[0]
        quats[idx[-1] :] = key_q[-1]
        for i, (left, right) in enumerate(zip(idx[:-1], idx[1:])):
            span = np.arange(left, right + 1)
            weight = (span - left) / max(int(right - left), 1)
            q0 = np.broadcast_to(key_q[i], (len(span), N_JOINTS, 4))
            q1 = np.broadcast_to(key_q[i + 1], (len(span), N_JOINTS, 4))
            quats[left : right + 1] = slerp_quat(q0, q1, weight)
        for dim in range(3):
            trans[:, dim] = np.interp(np.arange(frames), idx, feat[idx, ROT_DIM + dim])
    mats = Rotation.from_quat(quats.reshape(-1, 4)).as_matrix().reshape(frames, N_JOINTS, 3, 3)
    rot6d = matrix_to_rot6d(mats).reshape(frames, ROT_DIM).astype(np.float32)
    out = np.concatenate((rot6d, trans.astype(np.float32)), axis=-1)
    out[idx] = feat[idx]
    return out


def motion_metrics(pred: np.ndarray, gt: np.ndarray, unknown: np.ndarray) -> dict:
    unknown = np.asarray(unknown, bool).reshape(-1)
    count = int(unknown.sum())
    if count == 0:
        return {"trans_cm": 0.0, "rot_deg": 0.0, "unknown_frames": 0}
    delta = pred[unknown, ROT_DIM:] - gt[unknown, ROT_DIM:]
    trans_cm = float(np.linalg.norm(delta, axis=-1).mean() * 100.0)
    pred_r = rot6d_to_matrix(pred[unknown, :ROT_DIM].reshape(-1, 6))
    gt_r = rot6d_to_matrix(gt[unknown, :ROT_DIM].reshape(-1, 6))
    relative = np.einsum("nji,njk->nik", pred_r, gt_r)
    trace = relative[..., 0, 0] + relative[..., 1, 1] + relative[..., 2, 2]
    cosine = np.clip((trace - 1.0) * 0.5, -1.0, 1.0)
    rot_deg = float(np.degrees(np.arccos(cosine)).mean())
    return {"trans_cm": trans_cm, "rot_deg": rot_deg, "unknown_frames": count}


def save_smpl_npz(path: str | Path, poses: np.ndarray, trans: np.ndarray, betas: np.ndarray | None = None):
    if betas is None:
        betas = np.zeros(10, np.float32)
    frames = poses.shape[0]
    np.savez(
        path,
        poses=poses.astype(np.float32),
        trans=trans.astype(np.float32),
        betas=np.asarray(betas, np.float32).reshape(-1),
        gender=np.array("neutral"),
        mocap_frame_rate=np.array(DST_FPS, dtype=np.int64),
        dmpls=np.zeros((frames, 8), np.float32),
    )
