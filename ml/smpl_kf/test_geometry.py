"""几何变换和关键帧掩码的回归测试。"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation

from smpl_kf.dataset import MotionDataset, sample_key_frames
from smpl_kf.kimodo_rep import FEAT_DIM as MOTION_DIM
from smpl_kf.kimodo_rep import (
    KEY_SLICES,
    MIRROR_PAIRS,
    decode_motion,
    encode_motion,
    fk_local,
    foot_lock_legacy,
    keyframe_targets,
    settle_rotations,
    mirror_motion,
    resample_window,
)
from smpl_kf.generate import plan_windows
from smpl_kf.geometry import (
    AA_DIM,
    ROT_DIM,
    align_to_y_up,
    apply_canon,
    apply_decanon,
    apply_feature_rotation,
    canon_factors,
    feat_to_motion,
    interpolate_keyframes,
    load_npz_motion,
    matrix_to_rot6d,
    motion_metrics,
    motion_to_feat,
    resample_motion,
    rot6d_to_matrix,
    save_smpl_npz,
    slerp_quat,
    stabilize_feature,
)


def check(cond, message):
    if not cond:
        raise AssertionError(message)


def test_rot6d_roundtrip():
    mats = Rotation.random(32, random_state=1).as_matrix()
    back = rot6d_to_matrix(matrix_to_rot6d(mats))
    check(np.allclose(mats, back, atol=1e-5), "6D 旋转来回变换误差过大")


def test_slerp_endpoints():
    q0 = Rotation.random(6, random_state=2).as_quat()
    q1 = Rotation.random(6, random_state=3).as_quat()
    start = slerp_quat(q0, q1, np.zeros(6))
    end = slerp_quat(q0, q1, np.ones(6))
    check(np.allclose(np.abs(np.sum(start * q0, axis=-1)), 1.0, atol=1e-5), "slerp 起点不是原四元数")
    end_r = Rotation.from_quat(end).as_matrix()
    q1_r = Rotation.from_quat(q1).as_matrix()
    check(np.allclose(end_r, q1_r, atol=1e-5), "slerp 终点旋转不一致")


def test_canon_roundtrip_and_heading():
    yaw = np.pi / 2
    root = Rotation.from_rotvec([0.0, yaw, 0.0]).as_matrix()
    body = Rotation.random(21, random_state=4).as_matrix()
    mats = np.concatenate((root[None], body), axis=0)
    rot6d = matrix_to_rot6d(mats).reshape(1, ROT_DIM)
    rot6d = np.repeat(rot6d, 5, axis=0)
    trans = np.stack(
        (np.linspace(1, 3, 5), np.linspace(0.8, 1.1, 5), np.linspace(-2, 0, 5)),
        axis=1,
    )
    feat = np.concatenate((rot6d, trans), axis=1).astype(np.float32)
    ry, origin, _yaw = canon_factors(feat[0, :6], feat[0, ROT_DIM:])
    rot_c, trans_c = apply_canon(feat[:, :ROT_DIM], feat[:, ROT_DIM:], ry, origin)
    forward = rot6d_to_matrix(rot_c[0, :6])[:, 2]
    check(abs(forward[0]) < 1e-4 and forward[2] > 0.99, "规范化后没有面朝 +Z")
    check(abs(trans_c[0, 0]) < 1e-4 and abs(trans_c[0, 2]) < 1e-4, "参考帧水平位置不是原点")
    check(np.allclose(rot_c[:, 6:], feat[:, 6:ROT_DIM], atol=1e-5), "身体关节被朝向规范化改动了")
    rot_w, trans_w = apply_decanon(rot_c, trans_c, ry, origin)
    check(np.allclose(rot_w[:, :6], feat[:, :6], atol=1e-4), "根朝向没有变回去")
    check(np.allclose(trans_w, trans, atol=1e-4), "位移没有变回去")


def test_resample_endpoints():
    frames = 61
    aa = np.zeros((frames, AA_DIM), np.float32)
    aa[:, 1] = np.linspace(0, 0.4, frames)
    trans = np.stack((np.linspace(0, 2, frames), np.ones(frames), np.linspace(0, -1, frames)), axis=1)
    aa_d, trans_d = resample_motion(aa, trans, 60, 30)
    check(aa_d.shape[0] == 31, f"60fps 的 1 秒应变成 31 帧，实际 {aa_d.shape[0]}")
    check(np.allclose(trans_d[0], trans[0], atol=1e-5), "重采样没有保留起点")
    check(np.allclose(trans_d[-1], trans[-1], atol=1e-4), "重采样没有保留终点")


def test_feat_motion_roundtrip():
    aa = Rotation.random(40, random_state=5).as_rotvec().reshape(2, 20, 3)
    # 22 joints
    aa = Rotation.random(44, random_state=5).as_rotvec().reshape(2, 22, 3)
    trans = np.array([[0.0, 0.9, 0.0], [0.2, 0.95, 0.3]], np.float32)
    feat = motion_to_feat(aa.reshape(2, -1), trans)
    poses, trans_b = feat_to_motion(feat)
    mats = Rotation.from_rotvec(aa.reshape(-1, 3)).as_matrix()
    back = Rotation.from_rotvec(poses[:, :AA_DIM].reshape(-1, 3)).as_matrix()
    check(np.allclose(mats, back, atol=1e-4), "轴角经 6D 后对不上")
    check(np.allclose(trans, trans_b, atol=1e-5), "位移经特征后对不上")
    check(np.allclose(poses[:, AA_DIM:], 0), "导出的手部关节不是 0")


def _walk(frames: int = 60) -> np.ndarray:
    rng = np.random.default_rng(3)
    aa = rng.normal(scale=0.25, size=(frames, AA_DIM)).astype(np.float32)
    aa[:, 3:] += np.sin(np.linspace(0, 6, frames))[:, None] * 0.2
    trans = np.stack((np.linspace(0.3, 2.3, frames), 0.9 + 0.05 * np.sin(np.linspace(0, 9, frames)), np.linspace(-1, 1, frames)), axis=1)
    return motion_to_feat(aa, trans.astype(np.float32))


def test_key_frame_sampling():
    rng = np.random.default_rng(0)
    counts = []
    for _ in range(400):
        keys = sample_key_frames(120, rng)
        check(bool(np.all((keys >= 0) & (keys < 120))), "关键帧越界")
        check(len(np.unique(keys)) == len(keys), "关键帧有重复")
        counts.append(len(keys))
    counts = np.asarray(counts)
    check(0.04 < float(np.mean(counts == 0)) < 0.18, "不给关键帧的比例不对")
    check(float(np.mean(counts >= 5)) > 0.35, "每 0.5–1 秒一帧的比例不够")


def test_motion_encode_decode_and_keys():
    feat = _walk()
    packed = encode_motion(feat)
    check(packed.shape == (len(feat), MOTION_DIM), "特征维数不对")
    check(abs(float(packed[0, 0])) < 1e-6 and abs(float(packed[0, 2])) < 1e-6, "第一帧骨盆没放到原点")
    origin = (float(feat[0, ROT_DIM]), float(feat[0, ROT_DIM + 2]))
    back = decode_motion(packed, origin)
    check(np.allclose(back[:, ROT_DIM:], feat[:, ROT_DIM:], atol=1e-4), "骨盆位移没有还原")
    src, _world = fk_local(feat[:, :ROT_DIM], feat[:, ROT_DIM:])
    rec, _world = fk_local(back[:, :ROT_DIM], back[:, ROT_DIM:])
    check(float(np.abs(src - rec).max()) < 1e-4, "关节位置没有还原")
    keys = np.array([0, 17, 59])
    target, mask = keyframe_targets(feat[keys], keys, len(feat), origin)
    for part in KEY_SLICES:
        check(np.allclose(target[keys, part], packed[keys, part], atol=1e-4), f"关键帧约束和训练特征不一致 {part}")
    check(float(mask[keys].sum()) > 0 and float(np.delete(mask, keys, axis=0).sum()) == 0, "非关键帧上有约束")


def test_mirror_and_resample():
    feat = _walk()
    mirrored = mirror_motion(feat)
    check(np.allclose(mirror_motion(mirrored), feat, atol=1e-6), "镜像两次没有还原")
    src, _world = fk_local(feat[:, :ROT_DIM], feat[:, ROT_DIM:])
    mir, _world = fk_local(mirrored[:, :ROT_DIM], mirrored[:, ROT_DIM:])
    expected = np.array(src, copy=True)
    for left, right in MIRROR_PAIRS:
        expected[:, [left, right]] = src[:, [right, left]]
    expected[..., 0] = -expected[..., 0]
    check(float(np.abs(mir - expected).max()) < 1e-4, "镜像后的关节位置不对")
    slow = resample_window(feat, 80)
    check(slow.shape == (80, feat.shape[1]), "重采样长度不对")
    check(np.allclose(slow[0], feat[0], atol=1e-5) and np.allclose(slow[-1], feat[-1], atol=1e-5), "重采样没有保留首尾")


def test_dataset_batch():
    with tempfile.TemporaryDirectory() as tmp:
        cache = Path(tmp)
        clips = [_walk(70), _walk(150), _walk(40)]
        data = np.concatenate(clips).astype(np.float32)
        np.save(cache / "data.npy", data)
        np.save(cache / "offsets.npy", np.cumsum([0] + [len(c) for c in clips]).astype(np.int64))
        np.save(cache / "groups.npy", np.array([1, 0, 1], np.int8))
        np.save(cache / "splits.npy", np.zeros(3, np.int8))
        dataset = MotionDataset(cache, "train", batch_size=6, min_len=60, max_len=120)
        x, mask, valid = dataset.batch(np.random.default_rng(1))
        check(x.shape[0] == 6 and x.shape[2] == MOTION_DIM, "批次形状不对")
        check(60 <= x.shape[1] <= 120, "批次长度不在范围内")
        check(bool(torch_all_finite(x)), "批次里有 NaN")
        check(float((mask * (1 - valid)).abs().sum()) == 0, "填充帧上有约束")


def torch_all_finite(tensor) -> bool:
    import torch

    return bool(torch.isfinite(tensor).all())


def test_windows_cover_the_span():
    for length in (1, 128, 129, 160, 300, 400):
        starts = plan_windows(length, 128, 32)
        check(starts[0] == 0, "窗口没有从 0 开始")
        check(starts[-1] + 128 >= length or length <= 128, "最后一个窗口没有覆盖结尾")
        covered = np.zeros(length, dtype=bool)
        for start in starts:
            covered[start : start + 128] = True
        check(bool(covered.all()), f"长度 {length} 的窗口有空洞 {starts}")
        for left, right in zip(starts, starts[1:]):
            check(left < right < left + 128, f"窗口没有重叠: {starts}")


def test_interpolate_and_metrics():
    frames = 20
    aa = np.zeros((frames, AA_DIM), np.float32)
    trans = np.stack((np.linspace(0, 1, frames), np.ones(frames), np.zeros(frames)), axis=1)
    feat = motion_to_feat(aa, trans)
    mask = np.zeros(frames, dtype=bool)
    mask[0] = True
    mask[-1] = True
    filled = interpolate_keyframes(feat, mask)
    check(np.allclose(filled[0], feat[0], atol=1e-5), "插值没有钉住起点")
    check(np.allclose(filled[-1], feat[-1], atol=1e-5), "插值没有钉住终点")
    check(motion_metrics(feat, feat, ~mask)["trans_cm"] < 1e-3, "相同轨迹的误差不是 0")


def test_align_z_up_and_restore():
    frames = 40
    aa = np.zeros((frames, AA_DIM), np.float32)
    # 绕 X 轴 -90°，使身体的「上」从 Y 转到 Z，模拟自采数据。
    aa[:, 0] = -np.pi / 2
    trans = np.stack((np.zeros(frames), np.linspace(0, -3, frames), np.full(frames, 0.9)), axis=1).astype(np.float32)
    aligned_aa, aligned_trans, rotation = align_to_y_up(aa, trans)
    up = Rotation.from_rotvec(aligned_aa[:, :3]).apply(np.array([0.0, 1.0, 0.0])).mean(0)
    check(up[1] > 0.95, f"对齐后身体没有朝向 Y 轴: {up}")
    feat = apply_feature_rotation(motion_to_feat(aligned_aa, aligned_trans), np.linalg.inv(rotation))
    poses, trans_back = feat_to_motion(feat)
    check(np.allclose(trans_back, trans, atol=1e-4), "转回原坐标后位移对不上")
    check(np.allclose(poses[:, :3], aa[:, :3], atol=1e-4), "转回原坐标后根朝向对不上")


def test_stabilize_removes_keyframe_jump():
    frames = 61
    trans = np.stack((np.zeros(frames), np.zeros(frames), np.linspace(0, 2, frames)), axis=1)
    trans[30:] += 1.2
    trans[-1, 2] = 2.0
    aa = np.zeros((frames, AA_DIM), np.float32)
    feat = motion_to_feat(aa, trans.astype(np.float32))
    feat[-1, ROT_DIM:] = np.array([0.0, 0.0, 2.0], np.float32)
    feat[0, ROT_DIM:] = np.array([0.0, 0.0, 0.0], np.float32)
    fixed = stabilize_feature(feat, np.array([0, frames - 1]))
    step = np.linalg.norm(np.diff(fixed[:, ROT_DIM:], axis=0), axis=1)
    check(float(step.max()) < 0.3, f"关键帧跳跃还在，最大步长 {step.max():.3f} m")
    check(np.allclose(fixed[0, ROT_DIM:], feat[0, ROT_DIM:], atol=1e-4), "起点被改动")
    check(np.allclose(fixed[-1, ROT_DIM:], feat[-1, ROT_DIM:], atol=1e-4), "终点被改动")


def test_settle_spreads_rotation_and_keeps_keys():
    frames = 31
    aa = np.zeros((frames, AA_DIM), np.float32)
    trans = np.tile(np.array([0.0, 0.9, 0.0], np.float32), (frames, 1))
    feat = motion_to_feat(aa, trans)
    # 左肩在关键帧前一帧绕开 150°，关键帧本身仍是原姿态。
    jumped = np.array(feat, copy=True)
    spin = Rotation.from_rotvec([0.0, 0.0, np.deg2rad(150.0)]).as_matrix()
    local = rot6d_to_matrix(jumped[:, :ROT_DIM].reshape(frames, 22, 6))
    local[30, 16] = spin
    # 把跳变放在进入终点关键帧的那一帧。
    local[29, 16] = spin
    local[30, 16] = np.eye(3)
    jumped[:, :ROT_DIM] = matrix_to_rot6d(local).reshape(frames, ROT_DIM)
    fixed = settle_rotations(jumped, np.array([0, 30]))
    check(np.allclose(fixed[0], feat[0], atol=1e-5), "旋转稳定改动了起点")
    check(np.allclose(fixed[-1], feat[-1], atol=1e-5), "旋转稳定改动了终点")
    check(np.allclose(fixed[:, ROT_DIM:], feat[:, ROT_DIM:], atol=1e-6), "旋转稳定改动了骨盆位移")
    mats = rot6d_to_matrix(fixed[:, :ROT_DIM].reshape(frames, 22, 6))
    rel = np.matmul(np.swapaxes(mats[:-1, 16], -1, -2), mats[1:, 16])
    trace = rel[..., 0, 0] + rel[..., 1, 1] + rel[..., 2, 2]
    step = np.degrees(np.arccos(np.clip((trace - 1.0) / 2.0, -1.0, 1.0)))
    check(float(step.max()) <= 30.5, f"旋转跳变没有摊开，最大 {step.max():.1f}°")
    # 肘的纯拧转不应留下，腕关节位置不变。
    twisted = np.array(feat, copy=True)
    mats = rot6d_to_matrix(twisted[:, :ROT_DIM].reshape(frames, 22, 6))
    mats[10:20, 18] = Rotation.from_rotvec([np.deg2rad(80.0), 0.0, 0.0]).as_matrix()
    twisted[:, :ROT_DIM] = matrix_to_rot6d(mats).reshape(frames, ROT_DIM)
    before, _world = fk_local(twisted[:, :ROT_DIM], twisted[:, ROT_DIM:])
    settled = settle_rotations(twisted, np.array([0, 30]))
    after, _world = fk_local(settled[:, :ROT_DIM], settled[:, ROT_DIM:])
    check(float(np.abs(before[:, 20] - after[:, 20]).max()) < 1e-4, "去掉肘拧转时腕的位置变了")
    mid = rot6d_to_matrix(settled[15, 18 * 6 : 19 * 6])
    twist = np.degrees(np.linalg.norm(Rotation.from_matrix(mid).as_rotvec()))
    check(twist < 5.0, f"肘的拧转还在，{twist:.1f}°")


def test_foot_lock():
    frames = 30
    aa = np.zeros((frames, AA_DIM), np.float32)
    aa[:, 1] = 0.4
    aa[:, 12] = 1.1
    aa[:, 15] = 1.1
    trans = np.tile(np.array([0.2, 0.9, 0.1], np.float32), (frames, 1))
    feat = motion_to_feat(aa, trans)
    shifted = np.array(feat, copy=True)
    shifted[6:, ROT_DIM] += 0.08
    contacts = np.zeros((frames, 4), np.float32)
    contacts[4:, 0] = 1.0
    locked = foot_lock_legacy(shifted, contacts)
    before, _world = fk_local(shifted[:, :ROT_DIM], shifted[:, ROT_DIM:])
    after, _world = fk_local(locked[:, :ROT_DIM], locked[:, ROT_DIM:])
    held = float(np.linalg.norm(after[12, 7] - after[4, 7]))
    moved = float(np.linalg.norm(before[12, 7] - before[4, 7]))
    check(moved > 0.05, "测试没有把脚移开")
    check(held < 0.02, f"脚锁没有把脚踝留在落点，偏差 {held:.3f} m")


def test_npz_roundtrip_parser():
    frames = 40
    aa = Rotation.identity(frames * 22).as_rotvec().reshape(frames, AA_DIM).astype(np.float32)
    aa[:, 1] = np.linspace(0, 0.2, frames)
    trans = np.stack((np.linspace(0, 1, frames), np.full(frames, 0.9), np.zeros(frames)), axis=1).astype(np.float32)
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "clip.npz"
        poses = np.zeros((frames, 72), np.float32)
        poses[:, :AA_DIM] = aa
        save_smpl_npz(path, poses, trans, np.zeros(10, np.float32))
        loaded = load_npz_motion(path)
        check(loaded["feat"].shape[0] == frames, "30fps 文件重采样后帧数变了")
        repo = Path(__file__).resolve().parents[2]
        sys.path.insert(0, str(repo / "backend"))
        from app.worker.parsers import load_smpl_motion

        preview = load_smpl_motion(path)
        check(preview["frame_count"] == frames, "预览解析没有读到全部帧")
        check(len(preview["poses"][0]) == 72, "预览姿态不是 72 维")


def main():
    test_rot6d_roundtrip()
    test_slerp_endpoints()
    test_canon_roundtrip_and_heading()
    test_resample_endpoints()
    test_feat_motion_roundtrip()
    test_key_frame_sampling()
    test_motion_encode_decode_and_keys()
    test_mirror_and_resample()
    test_dataset_batch()
    test_windows_cover_the_span()
    test_interpolate_and_metrics()
    test_align_z_up_and_restore()
    test_stabilize_removes_keyframe_jump()
    test_settle_spreads_rotation_and_keeps_keys()
    test_foot_lock()
    test_npz_roundtrip_parser()
    print("geometry tests passed")


if __name__ == "__main__":
    main()
