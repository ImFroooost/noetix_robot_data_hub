"""固定评测。验证集里按动作类别挑固定窗口，用三种关键帧方案生成。

看四件事：关键帧有没有对上；脚滑和抖动；动作幅度、骨盆起伏、移动速度和原片同类动作比是不是一样大；
翻腾类里有没有真的头朝下。比值接近 1 说明生成出来的动作和数据集里的同类动作一样有劲。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from smpl_kf.dataset import CATEGORIES, CATEGORY_NAMES, DYNAMIC, compute_tags
from smpl_kf.diffusion import impute_sample
from smpl_kf.geometry import FEAT_DIM as LEGACY_DIM
from smpl_kf.geometry import ROT_DIM
from smpl_kf.kimodo_rep import FEAT_DIM as MOTION_DIM
from smpl_kf.kimodo_rep import FOOT_JOINTS, decode_motion, fk_local, foot_contacts, foot_lock_legacy, keyframe_targets

EVAL_VERSION = 1
EVAL_LENGTH = 240
SCHEMES = ("ends", "three", "every30")
SCHEME_NAMES = {"ends": "只给首尾", "three": "给三帧", "every30": "每秒一帧"}


def build_eval_set(cache: Path, per_category: int = 8, length: int = EVAL_LENGTH) -> dict:
    cache = Path(cache)
    path = cache / f"eval_set_v{EVAL_VERSION}.npz"
    if path.exists():
        saved = np.load(path, allow_pickle=False)
        return {name: saved[name] for name in saved.files}
    offsets = np.load(cache / "offsets.npy")
    splits = np.load(cache / "splits.npy")
    tags = compute_tags(cache)
    meta = [json.loads(line) for line in (cache / "meta.jsonl").read_text(encoding="utf-8").splitlines()]
    meta = [row for row in meta if row.get("ok")]
    data = np.load(cache / "data.npy", mmap_mode="r")
    lengths = np.diff(offsets)
    windows, sizes, cats, sources = [], [], [], []
    for index, name in enumerate(CATEGORIES):
        members = np.flatnonzero((splits == 1) & (tags["category"] == index) & (lengths >= 90))
        if members.size == 0:
            continue
        rng = np.random.default_rng(1000 + index)
        picked = np.sort(rng.choice(members, size=min(per_category, members.size), replace=False))
        for clip in picked.tolist():
            start, end = int(offsets[clip]), int(offsets[clip + 1])
            size = min(length, end - start)
            if name in DYNAMIC:
                marked = np.flatnonzero(tags["dynamic"][start:end])
                anchor = int(np.median(marked)) if marked.size else (end - start) // 2
            else:
                anchor = (end - start) // 2
            offset = int(np.clip(anchor - size // 2, 0, end - start - size))
            window = np.zeros((length, LEGACY_DIM), np.float32)
            window[:size] = np.asarray(data[start + offset : start + offset + size], np.float32)
            windows.append(window)
            sizes.append(size)
            cats.append(index)
            sources.append(meta[clip]["src"])
    result = {
        "windows": np.stack(windows),
        "lengths": np.asarray(sizes, np.int64),
        "category": np.asarray(cats, np.int64),
        "source": np.asarray(sources),
    }
    np.savez(path, **result)
    return result


def scheme_keys(name: str, frames: int) -> np.ndarray:
    if name == "ends":
        keys = [0, frames - 1]
    elif name == "three":
        keys = [0, frames // 2, frames - 1]
    elif name == "every30":
        keys = list(range(0, frames, 30)) + [frames - 1]
    else:
        raise ValueError(name)
    return np.unique(np.asarray(keys, np.int64))


def sequence_stats(feat: np.ndarray) -> dict:
    pos, world = fk_local(feat[:, :ROT_DIM], feat[:, ROT_DIM:])
    step = np.linalg.norm(np.diff(pos, axis=0), axis=-1)
    pelvis = pos[:, 0]
    contacts = foot_contacts(pos) > 0.5
    feet = pos[:, FOOT_JOINTS][:, :, [0, 2]]
    slide = np.linalg.norm(np.diff(feet, axis=0), axis=-1)
    planted = contacts[1:] & contacts[:-1]
    jerk = np.diff(pos, n=3, axis=0) if len(pos) > 3 else np.zeros((1,) + pos.shape[1:])
    return {
        "joint_speed": float(step.mean() * 30.0),
        "height_range": float(pelvis[:, 1].max() - pelvis[:, 1].min()),
        "root_speed": float(np.linalg.norm(np.diff(pelvis[:, [0, 2]], axis=0), axis=-1).mean() * 30.0),
        "inverted": float((world[:, 0, 1, 1] < 0.0).mean()),
        "jerk": float(np.linalg.norm(jerk, axis=-1).mean() * 30.0**3),
        "slide_cm": float(slide[planted].mean() * 100.0) if planted.any() else 0.0,
    }


def _key_error_cm(pred: np.ndarray, truth: np.ndarray, keys: np.ndarray) -> float:
    pred_pos, _world = fk_local(pred[keys, :ROT_DIM], pred[keys, ROT_DIM:])
    true_pos, _world = fk_local(truth[keys, :ROT_DIM], truth[keys, ROT_DIM:])
    return float(np.linalg.norm(pred_pos - true_pos, axis=-1).mean() * 100.0)


@torch.no_grad()
def run_eval(model, schedule, eval_set: dict, device: str, steps: int = 20, foot_lock: bool = False, seed: int = 0) -> dict:
    windows = eval_set["windows"]
    lengths = eval_set["lengths"]
    cats = eval_set["category"]
    total = len(windows)
    pad = windows.shape[1]
    rows = []
    devices = [torch.device(device)] if str(device).startswith("cuda") else []
    with torch.random.fork_rng(devices=devices):
        torch.manual_seed(seed)
        for scheme in SCHEMES:
            targets = np.zeros((total, pad, MOTION_DIM), np.float32)
            masks = np.zeros_like(targets)
            valid = np.zeros((total, pad, 1), np.float32)
            keys_all, origins = [], []
            for item in range(total):
                frames = int(lengths[item])
                keys = scheme_keys(scheme, frames)
                window = windows[item]
                origin = (float(window[0, ROT_DIM]), float(window[0, ROT_DIM + 2]))
                target, mask = keyframe_targets(window[keys], keys, pad, origin)
                targets[item] = target
                masks[item] = mask
                valid[item, :frames] = 1.0
                keys_all.append(keys)
                origins.append(origin)
            pred = impute_sample(
                model,
                schedule,
                torch.from_numpy(targets).to(device),
                torch.from_numpy(masks).to(device),
                torch.from_numpy(valid).to(device),
                steps,
            ).float().cpu().numpy()
            for item in range(total):
                frames = int(lengths[item])
                motion = decode_motion(pred[item, :frames], origins[item])
                if foot_lock:
                    pos, _world = fk_local(motion[:, :ROT_DIM], motion[:, ROT_DIM:])
                    motion = foot_lock_legacy(motion, foot_contacts(pos), pinned=keys_all[item])
                truth = windows[item, :frames]
                rows.append(
                    {
                        "scheme": scheme,
                        "category": CATEGORIES[int(cats[item])],
                        "key_cm": _key_error_cm(motion, truth, keys_all[item]),
                        "gen": sequence_stats(motion),
                        "gt": sequence_stats(truth),
                    }
                )
    return summarize(rows)


def _group(rows: list[dict]) -> dict:
    def mean(path):
        side, name = path
        return float(np.mean([row[side][name] for row in rows]))

    def ratio(name):
        truth = mean(("gt", name))
        return float(mean(("gen", name)) / truth) if truth > 1e-8 else float("nan")

    return {
        "count": len(rows),
        "key_cm": float(np.mean([row["key_cm"] for row in rows])),
        "energy": ratio("joint_speed"),
        "height": ratio("height_range"),
        "speed": ratio("root_speed"),
        "jerk": ratio("jerk"),
        "slide_cm": mean(("gen", "slide_cm")),
        "slide_gt_cm": mean(("gt", "slide_cm")),
        "inverted": mean(("gen", "inverted")),
        "inverted_gt": mean(("gt", "inverted")),
    }


def summarize(rows: list[dict]) -> dict:
    sparse = [row for row in rows if row["scheme"] != "every30"]
    report = {"overall": _group(sparse), "by_scheme": {}, "by_category": {}}
    for scheme in SCHEMES:
        chosen = [row for row in rows if row["scheme"] == scheme]
        if chosen:
            report["by_scheme"][scheme] = _group(chosen)
    for name in CATEGORIES:
        chosen = [row for row in sparse if row["category"] == name]
        if chosen:
            report["by_category"][name] = _group(chosen)
    return report


def log_line(step: int, report: dict) -> str:
    overall = report["overall"]
    cats = " ".join(f"{name} {group['energy']:.2f}" for name, group in report["by_category"].items())
    return (
        f"eval step {step} key {overall['key_cm']:.2f}cm energy {overall['energy']:.2f} "
        f"height {overall['height']:.2f} speed {overall['speed']:.2f} jerk {overall['jerk']:.2f} "
        f"slide {overall['slide_cm']:.2f}/{overall['slide_gt_cm']:.2f}cm | {cats}"
    )


def format_report(report: dict) -> str:
    lines = ["幅度、起伏、速度、抖动都是「生成 ÷ 原片」，1.0 表示一样大。只统计「只给首尾」和「给三帧」。"]
    header = f"{'类别':<8}{'窗口':>5}{'关键帧cm':>9}{'幅度':>7}{'起伏':>7}{'速度':>7}{'抖动':>7}{'脚滑cm':>12}{'头朝下':>12}"
    lines.append(header)

    def row(label, group):
        return (
            f"{label:<8}{group['count']:>5}{group['key_cm']:>9.2f}{group['energy']:>7.2f}{group['height']:>7.2f}"
            f"{group['speed']:>7.2f}{group['jerk']:>7.2f}{group['slide_cm']:>6.2f}/{group['slide_gt_cm']:<5.2f}"
            f"{group['inverted'] * 100:>5.1f}%/{group['inverted_gt'] * 100:<4.1f}%"
        )

    for name, group in report["by_category"].items():
        lines.append(row(CATEGORY_NAMES[name], group))
    lines.append(row("合计", report["overall"]))
    lines.append("按关键帧方案（全部类别）：")
    for scheme, group in report["by_scheme"].items():
        lines.append(row(SCHEME_NAMES[scheme], group))
    return "\n".join(lines)


def main():
    from smpl_kf.checkpoint import load_trained
    from smpl_kf.prepare import DEFAULT_CACHE

    parser = argparse.ArgumentParser(description="固定评测")
    parser.add_argument("--ckpt", type=Path, required=True)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--steps", type=int, default=40)
    parser.add_argument("--foot-lock", action="store_true")
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = parser.parse_args()
    model, schedule, _mean, _std, checkpoint = load_trained(args.ckpt, args.device)
    report = run_eval(model, schedule, build_eval_set(args.cache), args.device, args.steps, args.foot_lock)
    print(f"权重 {args.ckpt}，第 {checkpoint.get('step')} 步", flush=True)
    print(format_report(report), flush=True)
    if args.out:
        args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
