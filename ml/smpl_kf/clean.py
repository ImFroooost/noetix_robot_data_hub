"""找出动捕数据里整套姿势单帧跳变的帧，标成坏帧。训练时避开含坏帧的窗口。

跳变通常是一整套姿势同时出错（一帧里平均十来个关节一起大转），单个关节插值修不干净，所以只标不修。
结果写进缓存里的 fix_v2.npz，不改 data.npy 和原始 npz。
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np

from smpl_kf.geometry import N_JOINTS, ROT_DIM, rot6d_to_matrix
from smpl_kf.prepare import DEFAULT_CACHE

FIX_VERSION = 2
# 30fps 下单帧转 90° 等于每秒 2700°，人的关节做不到，只会是动捕跳变。
JUMP_DEG = 90.0
# 骨盆单帧移动超过 0.5 米（每秒 15 米）也是跳变。
ROOT_JUMP_M = 0.5
# 相隔不超过这么多帧的两次跳变，中间整段都当成跳出去的姿势。
MAX_SPAN = 15
BAD_PAD = 10


def fix_path(cache: Path) -> Path:
    return Path(cache) / f"fix_v{FIX_VERSION}.npz"


def _step_degrees(mats: np.ndarray) -> np.ndarray:
    rel = np.matmul(np.swapaxes(mats[:-1], -1, -2), mats[1:])
    trace = rel[..., 0, 0] + rel[..., 1, 1] + rel[..., 2, 2]
    return np.degrees(np.arccos(np.clip((trace - 1.0) / 2.0, -1.0, 1.0)))


def bad_frames(feat: np.ndarray) -> np.ndarray:
    """feat 是 135 维局部 6D 旋转加骨盆位移。返回每帧是否落在跳变段里。"""
    frames = len(feat)
    bad = np.zeros(frames, dtype=bool)
    if frames < 2:
        return bad
    mats = rot6d_to_matrix(np.asarray(feat[:, :ROT_DIM], np.float64).reshape(frames, N_JOINTS, 6))
    jumps = (_step_degrees(mats) > JUMP_DEG).any(axis=1)
    jumps |= np.linalg.norm(np.diff(np.asarray(feat[:, ROT_DIM:], np.float64), axis=0), axis=1) > ROOT_JUMP_M
    marks = np.flatnonzero(jumps)
    for index in marks.tolist():
        bad[max(0, index - BAD_PAD) : index + BAD_PAD + 2] = True
    for left, right in zip(marks[:-1].tolist(), marks[1:].tolist()):
        if right - left <= MAX_SPAN:
            bad[left : right + 2] = True
    return bad


def build_fix(cache: Path) -> dict:
    cache = Path(cache)
    started = time.time()
    data = np.load(cache / "data.npy", mmap_mode="r")
    offsets = np.load(cache / "offsets.npy")
    bad = np.zeros(int(offsets[-1]), np.uint8)
    clips = 0
    for clip in range(len(offsets) - 1):
        start, end = int(offsets[clip]), int(offsets[clip + 1])
        marked = bad_frames(np.asarray(data[start:end]))
        if marked.any():
            clips += 1
            bad[start:end] = marked
    np.savez(fix_path(cache), bad=bad, frames=np.int64(offsets[-1]))
    return {"clips": clips, "bad_frames": int(bad.sum()), "total_frames": int(offsets[-1]), "seconds": time.time() - started}


def load_bad(cache: Path) -> np.ndarray | None:
    path = fix_path(cache)
    if not path.exists():
        return None
    return np.load(path)["bad"].astype(bool)


def main():
    parser = argparse.ArgumentParser(description="标出动捕跳变帧，结果写进缓存")
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    args = parser.parse_args()
    report = build_fix(args.cache)
    total = report["total_frames"]
    print(
        f"含跳变的片段 {report['clips']}，坏帧 {report['bad_frames']}（{report['bad_frames'] / total:.2%}），"
        f"用时 {report['seconds']:.0f} 秒",
        flush=True,
    )


if __name__ == "__main__":
    main()
