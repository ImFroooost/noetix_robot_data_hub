"""用训练好的模型，从任意个 SMPL 关键帧生成整段动作。"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch

from smpl_kf.checkpoint import load_trained
from smpl_kf.diffusion import impute_sample
from smpl_kf.geometry import (
    DST_FPS,
    FEAT_DIM,
    ROT_DIM,
    align_to_y_up,
    apply_feature_rotation,
    feat_to_motion,
    load_npz_motion,
    motion_to_feat,
    save_smpl_npz,
)
from smpl_kf.kimodo_rep import (
    decode_motion,
    fk_local,
    foot_contacts,
    foot_lock_legacy,
    keyframe_targets,
    settle_rotations,
)


def plan_windows(length: int, window: int, overlap: int) -> list[int]:
    if length <= 0:
        raise ValueError("长度必须为正")
    if length <= window:
        return [0]
    stride = window - overlap
    if stride <= 0:
        raise ValueError("overlap 必须小于 window")
    starts = list(range(0, length - window, stride))
    last = length - window
    if not starts or starts[-1] != last:
        starts.append(last)
    return starts


def parse_keys(spec: str, length: int) -> np.ndarray:
    spec = spec.strip()
    if spec.startswith("every:"):
        stride = int(spec.split(":", 1)[1])
        if stride <= 0:
            raise ValueError("every 的间隔必须为正")
        idx = list(range(0, length, stride))
        if idx[-1] != length - 1:
            idx.append(length - 1)
        return np.asarray(idx, np.int64)
    values = [int(part) for part in spec.split(",") if part.strip() != ""]
    if not values:
        raise ValueError("没有解析到关键帧")
    return np.unique(np.asarray(values, np.int64))


def generate_motion(
    model,
    schedule,
    key_feats: np.ndarray,
    key_idx: np.ndarray,
    length: int,
    window: int,
    overlap: int,
    steps: int,
    device: str,
    foot_lock: bool = True,
) -> np.ndarray:
    """10 秒以内一次生成。更长的动作分窗，下一窗把上一窗最后一段当作已知帧接着生成。"""
    key_idx = np.asarray(key_idx, np.int64)
    key_feats = np.asarray(key_feats, np.float32)
    if key_idx.size == 0 or int(key_idx[0]) != 0:
        raise ValueError("时间轴要从第一帧关键帧开始")
    if int(key_idx[-1]) >= length:
        raise ValueError("关键帧落在要生成的长度之外")
    world = np.zeros((length, FEAT_DIM), np.float32)
    known = np.zeros(length, dtype=bool)
    world[key_idx] = key_feats
    known[key_idx] = True
    for start in plan_windows(length, window, overlap):
        count = min(window, length - start)
        rows = np.flatnonzero(known[start : start + count])
        if rows.size == 0 or int(rows[0]) != 0:
            raise RuntimeError("窗口第一帧没有已知姿态")
        first = world[start]
        origin = (float(first[ROT_DIM]), float(first[ROT_DIM + 2]))
        target, mask = keyframe_targets(world[start + rows], rows, count, origin)
        valid = np.ones((count, 1), np.float32)
        pred = impute_sample(
            model,
            schedule,
            torch.from_numpy(target)[None].to(device),
            torch.from_numpy(mask)[None].to(device),
            torch.from_numpy(valid)[None].to(device),
            steps,
            soft_tail=min(5, max(steps - 1, 0)),
            soft_strength=0.5,
            cfg_scale=2.0,
        )
        decoded = decode_motion(pred.float().cpu().numpy()[0], origin)
        fresh = ~known[start : start + count]
        world[start : start + count][fresh] = decoded[fresh]
        known[start : start + count] = True
    world = settle_rotations(world, key_idx)
    if foot_lock:
        pos, _world = fk_local(world[:, :ROT_DIM], world[:, ROT_DIM:])
        world = foot_lock_legacy(world, foot_contacts(pos), pinned=key_idx)
        # 锁定只小步改腿，这里再把仍然超过 30° 的接缝摊开，关键帧继续钉住。
        world = settle_rotations(world, key_idx)
    return world.astype(np.float32)


def _rows_from_poses(poses: np.ndarray, trans: np.ndarray) -> np.ndarray:
    poses = np.asarray(poses)
    if poses.ndim == 3:
        poses = poses.reshape(poses.shape[0], -1)
    return motion_to_feat(poses[:, :66], np.asarray(trans, np.float32).reshape(-1, 3))


def load_keyframe_bank(path: Path, align_up: bool = False):
    data = np.load(path, allow_pickle=True)
    if "poses" not in data.files or "trans" not in data.files:
        raise ValueError("关键帧文件需要 poses 和 trans")
    poses = np.asarray(data["poses"])
    trans = np.asarray(data["trans"], np.float32).reshape(-1, 3)
    if "times" in data.files:
        times = np.asarray(data["times"], np.float64).reshape(-1)
    elif "frame_idx" in data.files:
        times = np.asarray(data["frame_idx"], np.float64).reshape(-1) / DST_FPS
    else:
        raise ValueError("关键帧文件需要 times（秒）或 frame_idx")
    order = np.argsort(times)
    times = times[order]
    poses = poses[order]
    trans = trans[order]
    align = np.eye(3, dtype=np.float64)
    if align_up:
        aa = np.asarray(poses, np.float64)
        if aa.ndim == 3:
            aa = aa.reshape(len(aa), -1)
        aa, trans, align = align_to_y_up(aa[:, :66], trans)
        poses = aa
    feat = _rows_from_poses(poses, trans)
    index = np.rint((times - times[0]) * DST_FPS).astype(np.int64)
    chosen = {}
    for row, frame in enumerate(index.tolist()):
        chosen[int(frame)] = row
    frames = np.asarray(sorted(chosen), np.int64)
    rows = np.stack([feat[chosen[int(frame)]] for frame in frames], axis=0)
    betas = None
    if "betas" in data.files:
        betas = np.asarray(data["betas"], np.float32).reshape(-1)[:16]
    length = int(frames[-1]) + 1
    return rows, frames, length, betas, align


def _key_error_cm(pred: np.ndarray, key_feats: np.ndarray, key_idx: np.ndarray) -> float:
    pred_pos, _world = fk_local(pred[key_idx, :ROT_DIM], pred[key_idx, ROT_DIM:])
    key_pos, _world = fk_local(key_feats[:, :ROT_DIM], key_feats[:, ROT_DIM:])
    return float(np.linalg.norm(pred_pos - key_pos, axis=-1).mean() * 100.0)


def main():
    parser = argparse.ArgumentParser(description="从关键帧生成整段 SMPL 动作")
    parser.add_argument("--ckpt", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--source", type=Path, default=None, help="已有动作。--keys 是重采样到 30fps 后的帧号")
    parser.add_argument("--keys", default=None, help="帧号，如 0,45,90；或 every:30")
    parser.add_argument("--keyframes", type=Path, default=None, help="含 poses、trans、times 的 npz")
    parser.add_argument("--seconds", type=float, default=0.0, help="只有一个关键帧时，要生成的时长")
    parser.add_argument("--steps", type=int, default=40)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--no-foot-lock", action="store_true")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = parser.parse_args()
    if args.device.startswith("cuda") and not torch.cuda.is_available():
        raise RuntimeError("没有可用的 CUDA")
    torch.manual_seed(args.seed)
    model, schedule, _mean, _std, checkpoint = load_trained(args.ckpt, args.device)
    config = checkpoint["config"]
    window = int(config.get("window", 300))
    overlap = int(config.get("overlap", 30))
    betas = None
    align = np.eye(3, dtype=np.float64)
    if args.keyframes:
        key_feats, key_idx, length, betas, align = load_keyframe_bank(args.keyframes, align_up=True)
        if len(key_idx) == 1:
            if args.seconds <= 0:
                raise SystemExit("只有一个关键帧时需要 --seconds")
            length = int(round(args.seconds * DST_FPS)) + 1
    elif args.source:
        motion = load_npz_motion(args.source, align_up=True)
        align = motion["align"]
        feat = motion["feat"]
        betas = motion["betas"]
        if not args.keys:
            raise SystemExit("使用 --source 时需要 --keys")
        indices = parse_keys(args.keys, len(feat))
        indices = indices[(indices >= 0) & (indices < len(feat))]
        if len(indices) == 0:
            raise SystemExit("关键帧落在动作外面")
        start = int(indices[0])
        if len(indices) == 1:
            if args.seconds <= 0:
                raise SystemExit("只有一个关键帧时需要 --seconds")
            length = min(int(round(args.seconds * DST_FPS)) + 1, len(feat) - start)
        else:
            length = int(indices[-1]) - start + 1
        key_idx = indices - start
        key_feats = feat[indices]
    else:
        raise SystemExit("需要 --source 或 --keyframes")
    pred = generate_motion(
        model,
        schedule,
        key_feats,
        key_idx,
        length,
        window,
        overlap,
        args.steps,
        args.device,
        foot_lock=not args.no_foot_lock,
    )
    print(f"关键帧关节误差 {_key_error_cm(pred, key_feats, key_idx):.2f} cm", flush=True)
    pred = apply_feature_rotation(pred, np.linalg.inv(align))
    poses, trans = feat_to_motion(pred)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    save_smpl_npz(args.out, poses, trans, betas)
    print(f"写出 {args.out}，{len(poses)} 帧，{DST_FPS} fps", flush=True)


if __name__ == "__main__":
    main()
