"""用一个权重生成固定的几段预览：写进浏览页的预览目录，并画出原片和生成的并排对比视频。"""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

from smpl_kf.checkpoint import load_trained
from smpl_kf.evaluate import sequence_stats
from smpl_kf.generate import generate_motion
from smpl_kf.geometry import (
    ROT_DIM,
    apply_feature_rotation,
    feat_to_motion,
    load_npz_motion,
    rot6d_to_matrix,
    save_smpl_npz,
)
from smpl_kf.kimodo_rep import PARENTS, fk_local

REPO = Path(__file__).resolve().parents[2]
SMPL_DIR = REPO / "data/hub_repo/data/human/motion/skeleton/smpl"
PREVIEW_DIR = SMPL_DIR / "_kf_preview"
VIDEO_DIR = Path("/home/noetix/smpl_kf_cache/compare_videos")
FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
WIDTH, HEIGHT, FPS = 1280, 720, 30
BONES = [(int(parent), child) for child, parent in enumerate(PARENTS[:22]) if int(parent) >= 0]

# 预览文件名、视频文件名、标题、源动作、关键帧方案。
CASES = [
    ("行走_每秒一帧", "行走_对比.mp4", "行走，每秒一帧", "251225_walk/CSC-向前走_001.npz", "every"),
    ("奔跑_每秒一帧", "奔跑_对比.mp4", "奔跑，每秒一帧", "260108_run/CSC-直线跑-快_001.npz", "every"),
    ("跳跃_每秒一帧", "跳跃_对比.mp4", "跳跃，每秒一帧", "260603_high_jump/自由发挥跳高_001.npz", "every"),
    ("空翻_每秒一帧", "空翻_对比.mp4", "空翻，每秒一帧", "251218_backflip/20251218空翻跪地_001.npz", "every"),
    ("手翻_每秒一帧", "手翻_对比.mp4", "手翻，每秒一帧", "251118_highly_dynamic/前手翻.npz", "every"),
    ("舞蹈_每秒一帧", "舞蹈_对比.mp4", "舞蹈，每秒一帧", "260211_dance/孔雀舞_动作大.npz", "every"),
    ("向前走_三帧补全", "向前走_三帧_对比.mp4", "向前走，三帧", "251225_walk/CSC-向前走_001.npz", "0,90,180"),
]


def _keys(mode: str, frames: int) -> np.ndarray:
    if mode == "every":
        keys = list(range(0, frames, 30))
        if keys[-1] != frames - 1:
            keys.append(frames - 1)
        return np.asarray(keys, np.int64)
    return np.asarray([int(part) for part in mode.split(",")], np.int64)


def _max_rotation_step(feat: np.ndarray) -> float:
    """相邻两帧之间单个关节局部旋转的最大转角（度）。"""
    mats = rot6d_to_matrix(feat[:, :ROT_DIM].reshape(len(feat), -1, 6))
    rel = np.matmul(np.swapaxes(mats[:-1], -1, -2), mats[1:])
    trace = rel[..., 0, 0] + rel[..., 1, 1] + rel[..., 2, 2]
    return float(np.degrees(np.arccos(np.clip((trace - 1.0) / 2.0, -1.0, 1.0))).max())


def _project(pos: np.ndarray) -> np.ndarray:
    angle = np.deg2rad(32)
    return np.stack((pos[..., 0] * np.cos(angle) + pos[..., 2] * np.sin(angle), pos[..., 1]), axis=-1)


def render_video(path: Path, title: str, truth: np.ndarray, generated: np.ndarray, keys: np.ndarray) -> None:
    font = ImageFont.truetype(FONT, 28)
    small = ImageFont.truetype(FONT, 22)
    truth_pos, _world = fk_local(truth[:, :ROT_DIM], truth[:, ROT_DIM:])
    gen_pos, _world = fk_local(generated[:, :ROT_DIM], generated[:, ROT_DIM:])
    frames = len(truth)
    key_set = set(int(index) for index in keys)
    heights = np.concatenate((truth_pos[:, :, 1].reshape(-1), gen_pos[:, :, 1].reshape(-1)))
    scale = (HEIGHT * 0.62) / max(float(np.percentile(heights, 98) - np.percentile(heights, 2)), 0.5)
    ground = float(min(truth_pos[:, [7, 8, 10, 11], 1].min(), gen_pos[:, [7, 8, 10, 11], 1].min()))
    path.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS), "-i", "-",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart",
            str(path),
        ],
        stdin=subprocess.PIPE,
    )
    trails = ([], [])
    for frame in range(frames):
        focus = 0.5 * (truth_pos[frame, 0] + gen_pos[frame, 0])

        def to_pixels(pos, panel):
            shifted = np.array(pos, dtype=np.float64, copy=True)
            shifted[..., 0] -= focus[0]
            shifted[..., 2] -= focus[2]
            plane = _project(shifted)
            x = panel + WIDTH // 4 + plane[..., 0] * scale
            y = int(HEIGHT * 0.78) - (plane[..., 1] - ground) * scale
            return np.stack((x, y), axis=-1)

        image = Image.new("RGB", (WIDTH, HEIGHT), (22, 24, 28))
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 0, WIDTH, 56), fill=(14, 16, 20))
        draw.line((WIDTH // 2, 56, WIDTH // 2, HEIGHT), fill=(50, 54, 62), width=2)
        mark = "  关键帧" if frame in key_set else ""
        draw.text((24, 14), f"{title}    {frame / FPS:0.2f}s{mark}", fill=(230, 232, 236), font=font)
        draw.text((24, 70), "原片", fill=(126, 184, 255), font=small)
        draw.text((WIDTH // 2 + 24, 70), "生成", fill=(255, 186, 110), font=small)
        for panel, pos, trail, color in (
            (0, truth_pos[frame], trails[0], (126, 184, 255)),
            (WIDTH // 2, gen_pos[frame], trails[1], (255, 176, 92)),
        ):
            floor = int(HEIGHT * 0.78)
            draw.line((panel + 40, floor, panel + WIDTH // 2 - 40, floor), fill=(58, 64, 74), width=2)
            points = to_pixels(pos, panel)
            trail.append((float(points[0, 0]), float(points[0, 1])))
            if len(trail) > 45:
                trail.pop(0)
            if len(trail) >= 2:
                draw.line(trail, fill=tuple(int(c * 0.45) for c in color), width=2)
            width = 5 if frame in key_set else 4
            for parent, child in BONES:
                draw.line((*points[parent], *points[child]), fill=color, width=width)
            for x, y in points:
                draw.ellipse((x - 4, y - 4, x + 4, y + 4), fill=color)
            if frame in key_set:
                x, y = points[0]
                draw.ellipse((x - 10, y - 10, x + 10, y + 10), outline=(255, 92, 92), width=3)
        proc.stdin.write(image.tobytes())
    proc.stdin.close()
    if proc.wait() != 0:
        raise RuntimeError(f"ffmpeg 没有写出 {path}")


def main():
    parser = argparse.ArgumentParser(description="生成固定预览和对比视频")
    parser.add_argument("--ckpt", type=Path, required=True)
    parser.add_argument("--steps", type=int, default=40)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--videos", type=Path, default=VIDEO_DIR)
    parser.add_argument("--preview-dir", type=Path, default=PREVIEW_DIR)
    parser.add_argument("--cfg", type=float, default=2.0, help="关键帧引导强度，1 表示不引导")
    parser.add_argument("--raw", action="store_true", help="不做旋转稳定和脚锁定，只看模型本身的输出")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = parser.parse_args()
    model, schedule, _mean, _std, checkpoint = load_trained(args.ckpt, args.device)
    config = checkpoint["config"]
    window = int(config.get("window", 300))
    overlap = int(config.get("overlap", 30))
    print(f"权重 {args.ckpt}，第 {checkpoint.get('step')} 步", flush=True)
    print(
        f"{'片段':<12}{'帧':>5}{'关键帧cm':>9}{'中间帧cm':>9}{'幅度':>7}{'起伏':>7}{'速度':>7}{'脚滑cm':>12}{'最大转角°':>9}",
        flush=True,
    )
    for name, video, title, source, mode in CASES:
        torch.manual_seed(args.seed)
        motion = load_npz_motion(SMPL_DIR / source, align_up=True)
        feat = motion["feat"]
        if mode == "every":
            feat = feat[: min(len(feat), 240)]
        keys = _keys(mode, len(feat))
        feat = feat[: int(keys[-1]) + 1]
        pred = generate_motion(
            model,
            schedule,
            feat[keys],
            keys,
            len(feat),
            window,
            overlap,
            args.steps,
            args.device,
            foot_lock=not args.raw,
            cfg_scale=args.cfg,
            settle=not args.raw,
        )
        saved = apply_feature_rotation(pred, np.linalg.inv(motion["align"]))
        poses, trans = feat_to_motion(saved)
        args.preview_dir.mkdir(parents=True, exist_ok=True)
        save_smpl_npz(args.preview_dir / f"{name}.npz", poses, trans, motion["betas"])
        render_video(args.videos / video, title, feat, pred, keys)
        gen, gt = sequence_stats(pred), sequence_stats(feat)
        pred_pos, _w = fk_local(pred[:, :ROT_DIM], pred[:, ROT_DIM:])
        true_pos, _w = fk_local(feat[:, :ROT_DIM], feat[:, ROT_DIM:])
        gap = np.linalg.norm(pred_pos - true_pos, axis=-1).mean(axis=1) * 100.0
        between = np.ones(len(feat), dtype=bool)
        between[keys] = False
        print(
            f"{name:<12}{len(feat):>5}{gap[keys].mean():>9.2f}{gap[between].mean():>9.1f}"
            f"{gen['joint_speed'] / gt['joint_speed']:>7.2f}"
            f"{gen['height_range'] / max(gt['height_range'], 1e-6):>7.2f}{gen['root_speed'] / max(gt['root_speed'], 1e-6):>7.2f}"
            f"{gen['slide_cm']:>6.2f}/{gt['slide_cm']:<5.2f}{_max_rotation_step(pred):>9.0f}",
            flush=True,
        )
    print(f"预览写进 {args.preview_dir}，视频写进 {args.videos}", flush=True)


if __name__ == "__main__":
    main()
