"""训练批次：按动作类别抽片段，每批随机 2–10 秒，镜像、变速、绕竖直轴转动，再挖掉大部分帧作为要生成的部分。"""

from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader, IterableDataset

from smpl_kf.geometry import FEAT_DIM as LEGACY_DIM
from smpl_kf.geometry import ROT_DIM
from smpl_kf.kimodo_rep import FEAT_DIM, encode_motion, fk_local, key_mask, mirror_motion, resample_window, yaw_augment

CATEGORIES = ("acro", "floor", "vertical", "run", "walk", "active", "still")
CATEGORY_NAMES = {
    "acro": "翻腾",
    "floor": "地面",
    "vertical": "起落",
    "run": "跑",
    "walk": "走",
    "active": "原地活动",
    "still": "静止",
}
CATEGORY_WEIGHTS = {
    "acro": 0.12,
    "floor": 0.08,
    "vertical": 0.15,
    "run": 0.12,
    "walk": 0.18,
    "active": 0.20,
    "still": 0.15,
}
DYNAMIC = ("acro", "floor", "vertical", "run")
TAGS_VERSION = 1


def compute_tags(cache: Path) -> dict:
    """每个片段一个类别，每一帧一个「是否在做大动作」的标记。算一次存进缓存。"""
    cache = Path(cache)
    path = cache / f"tags_v{TAGS_VERSION}.npz"
    offsets = np.load(cache / "offsets.npy")
    if path.exists():
        saved = np.load(path)
        if int(saved["frames"]) == int(offsets[-1]):
            return {"category": saved["category"], "dynamic": saved["dynamic"]}
    started = time.time()
    data = np.load(cache / "data.npy", mmap_mode="r")
    clips = len(offsets) - 1
    stats = np.zeros((clips, 7), np.float64)
    dynamic = np.zeros(int(offsets[-1]), np.uint8)
    for clip in range(clips):
        start, end = int(offsets[clip]), int(offsets[clip + 1])
        chunk = np.asarray(data[start:end], np.float64)
        pos, _world = fk_local(chunk[:, :ROT_DIM], chunk[:, ROT_DIM:])
        up = chunk[:, 4]
        trans = chunk[:, ROT_DIM:]
        velocity = np.zeros_like(trans)
        velocity[1:] = (trans[1:] - trans[:-1]) * 30.0
        horizontal = np.linalg.norm(velocity[:, [0, 2]], axis=1)
        vertical = np.abs(velocity[:, 1])
        joint_speed = np.zeros(len(chunk))
        joint_speed[1:] = np.linalg.norm(pos[1:] - pos[:-1], axis=-1).mean(axis=1) * 30.0
        rise = float(np.percentile(trans[:, 1], 98) - np.median(trans[:, 1]))
        stats[clip] = (
            (up < 0.0).sum(),
            (up < 0.5).mean(),
            (vertical > 1.0).sum(),
            rise,
            (horizontal > 2.5).sum(),
            horizontal.mean(),
            joint_speed.mean(),
        )
        dynamic[start:end] = ((up < 0.5) | (vertical > 1.0) | (horizontal > 2.5)).astype(np.uint8)
    inverted, tilted, fast_vertical, rise, fast, speed, joint_speed = stats.T
    category = np.full(clips, CATEGORIES.index("still"), np.int8)
    category[joint_speed > np.median(joint_speed)] = CATEGORIES.index("active")
    category[speed > 0.4] = CATEGORIES.index("walk")
    category[fast >= 15] = CATEGORIES.index("run")
    category[(fast_vertical >= 6) & (rise > 0.15)] = CATEGORIES.index("vertical")
    category[tilted > 0.10] = CATEGORIES.index("floor")
    category[inverted >= 5] = CATEGORIES.index("acro")
    np.savez(path, category=category, dynamic=dynamic, frames=np.int64(offsets[-1]))
    print(f"动作分类完成，用时 {time.time() - started:.0f} 秒", flush=True)
    return {"category": category, "dynamic": dynamic}


def sample_key_frames(frames: int, rng: np.random.Generator) -> np.ndarray:
    """一成不给关键帧；一半每 0.5–1 秒一帧；两成长间隔；两成只有 1–4 帧。少数窗口带一段已知开头。"""
    if frames <= 0:
        return np.zeros(0, np.int64)
    draw = float(rng.random())
    if draw < 0.10:
        return np.zeros(0, np.int64)
    if draw < 0.60:
        stride = int(rng.integers(15, 31))
        keys = list(range(0, frames, stride))
    elif draw < 0.80:
        stride = int(rng.integers(30, 61))
        keys = list(range(0, frames, stride))
    else:
        keys = [0]
        if frames > 1 and float(rng.random()) < 0.85:
            keys.append(frames - 1)
        extra = int(rng.integers(0, 3))
        if extra and frames > 2:
            keys += rng.choice(np.arange(1, frames - 1), size=min(extra, frames - 2), replace=False).tolist()
    if keys and keys[-1] != frames - 1:
        keys.append(frames - 1)
    if keys and frames >= 24 and float(rng.random()) < 0.08:
        keys += list(range(int(rng.integers(10, min(41, frames)))))
    return np.unique(np.asarray(keys, np.int64))


class MotionDataset(IterableDataset):
    def __init__(
        self,
        cache: Path,
        split: str = "train",
        batch_size: int = 64,
        min_len: int = 60,
        max_len: int = 300,
        augment: bool = True,
    ):
        cache = Path(cache)
        self.path = cache / "data.npy"
        self.offsets = np.load(cache / "offsets.npy")
        groups = np.load(cache / "groups.npy")
        splits = np.load(cache / "splits.npy")
        tags = compute_tags(cache)
        self.category = tags["category"]
        self.dynamic = tags["dynamic"]
        self.batch_size = batch_size
        self.min_len = min_len
        self.max_len = max_len
        self.augment = augment
        lengths = np.diff(self.offsets)
        ids = np.flatnonzero(splits == (0 if split == "train" else 1))
        self.pools = {}
        for index, name in enumerate(CATEGORIES):
            members = ids[(self.category[ids] == index) & (lengths[ids] >= 16)]
            if members.size == 0:
                continue
            # 自采片段权重加倍，和预览、实际使用的风格更接近。
            weight = np.where(groups[members] == 1, 2.0, 1.0)
            self.pools[name] = (members, weight / weight.sum())
        self.names = list(self.pools)
        probs = np.array([CATEGORY_WEIGHTS[name] for name in self.names], np.float64)
        self.probs = probs / probs.sum()
        self._data = None

    def _memmap(self):
        if self._data is None:
            self._data = np.load(self.path, mmap_mode="r")
        return self._data

    def _window(self, rng: np.random.Generator, clip: int, frames: int, name: str) -> np.ndarray:
        start, end = int(self.offsets[clip]), int(self.offsets[clip + 1])
        length = end - start
        data = self._memmap()
        if length <= frames:
            return np.array(data[start:end], np.float32)
        if name in DYNAMIC and float(rng.random()) < 0.7:
            marked = np.flatnonzero(self.dynamic[start:end])
            if marked.size:
                anchor = int(marked[int(rng.integers(marked.size))])
                low = max(0, anchor - frames + 1)
                high = min(anchor, length - frames)
                offset = int(rng.integers(low, high + 1))
                return np.array(data[start + offset : start + offset + frames], np.float32)
        offset = int(rng.integers(0, length - frames + 1))
        return np.array(data[start + offset : start + offset + frames], np.float32)

    def example(self, rng: np.random.Generator, length: int):
        name = self.names[int(rng.choice(len(self.names), p=self.probs))]
        members, weights = self.pools[name]
        clip = int(members[int(rng.choice(len(members), p=weights))])
        factor = float(rng.uniform(0.9, 1.1)) if self.augment and float(rng.random()) < 0.5 else 1.0
        source = int(round((length - 1) * factor)) + 1
        chunk = self._window(rng, clip, source, name)
        if chunk.shape[1] != LEGACY_DIM:
            raise RuntimeError(f"特征维数是 {chunk.shape[1]}，期望 {LEGACY_DIM}")
        frames = min(length, int(round((len(chunk) - 1) / factor)) + 1)
        if frames != len(chunk):
            chunk = resample_window(chunk, frames)
        if self.augment and float(rng.random()) < 0.5:
            chunk = mirror_motion(chunk)
        if self.augment:
            chunk = yaw_augment(chunk, float(rng.uniform(0.0, 2.0 * np.pi)))
        encoded = encode_motion(chunk)
        keys = sample_key_frames(frames, rng)
        x = np.zeros((length, FEAT_DIM), np.float32)
        mask = np.zeros((length, FEAT_DIM), np.float32)
        valid = np.zeros((length, 1), np.float32)
        x[:frames] = encoded
        mask[:frames] = key_mask(frames, keys)
        valid[:frames] = 1.0
        return x, mask, valid

    def batch(self, rng: np.random.Generator):
        length = int(rng.integers(self.min_len, self.max_len + 1))
        items = [self.example(rng, length) for _ in range(self.batch_size)]
        return tuple(torch.from_numpy(np.stack(part)) for part in zip(*items))

    def __iter__(self):
        rng = np.random.default_rng()
        while True:
            yield self.batch(rng)


def make_loader(dataset: MotionDataset, num_workers: int = 0) -> DataLoader:
    kwargs = {"batch_size": None, "num_workers": num_workers, "pin_memory": torch.cuda.is_available()}
    if num_workers > 0:
        kwargs["persistent_workers"] = True
        kwargs["prefetch_factor"] = 2
    return DataLoader(dataset, **kwargs)
