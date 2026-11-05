"""训练关键帧条件扩散模型。每次训练写进 runs/<名字>/，固定评测按步数定期跑。"""

from __future__ import annotations

import argparse
import json
import math
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch

from smpl_kf.checkpoint import atomic_save
from smpl_kf.dataset import CATEGORY_WEIGHTS, MotionDataset, feature_stats, make_loader
from smpl_kf.diffusion import Schedule, motion_loss
from smpl_kf.evaluate import build_eval_set, format_report, log_line, run_eval
from smpl_kf.geometry import DST_FPS
from smpl_kf.kimodo_rep import FEAT_DIM
from smpl_kf.model import build_denoiser
from smpl_kf.prepare import DEFAULT_CACHE, _cache_is_ready


class EMA:
    def __init__(self, model: torch.nn.Module, decay: float = 0.9999):
        self.decay = decay
        self.shadow = {name: value.detach().clone() for name, value in model.state_dict().items()}

    @torch.no_grad()
    def update(self, model: torch.nn.Module, step: int):
        decay = min(self.decay, (1.0 + step) / (10.0 + step))
        for name, value in model.state_dict().items():
            target = self.shadow[name]
            if torch.is_floating_point(target):
                target.mul_(decay).add_(value.detach(), alpha=1.0 - decay)
            else:
                target.copy_(value)

    def state_dict(self):
        return self.shadow

    def load_state_dict(self, state):
        self.shadow = {name: value.detach().clone() for name, value in state.items()}


class Tee:
    def __init__(self, *streams):
        self.streams = streams

    def write(self, data):
        for stream in self.streams:
            stream.write(data)
            stream.flush()

    def flush(self):
        for stream in self.streams:
            stream.flush()


def learning_rate(step: int, base: float, warmup: int, total: int) -> float:
    if step < warmup:
        return base * (step + 1) / max(warmup, 1)
    progress = min(1.0, (step - warmup) / max(total - warmup, 1))
    return 1e-5 + 0.5 * (base - 1e-5) * (1.0 + math.cos(math.pi * progress))


def main():
    parser = argparse.ArgumentParser(description="训练从任意关键帧生成 SMPL 动作的扩散模型")
    parser.add_argument("--run", required=True, help="这次训练的名字，权重和日志写进 runs/<名字>/")
    parser.add_argument("--root", type=Path, default=None)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--files", nargs="*", default=None)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--val-mod", type=int, default=20)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--steps", type=int, default=300000)
    parser.add_argument("--batch", type=int, default=64)
    parser.add_argument("--micro-batch", type=int, default=32, help="一次放进显卡的片段数，攒够 --batch 再更新")
    parser.add_argument("--min-len", type=int, default=60)
    parser.add_argument("--max-len", type=int, default=300)
    parser.add_argument("--overlap", type=int, default=30)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--warmup", type=int, default=2000)
    parser.add_argument("--layers", type=int, default=4)
    parser.add_argument("--d-model", type=int, default=512)
    parser.add_argument("--nhead", type=int, default=8)
    parser.add_argument("--dropout", type=float, default=0.1)
    parser.add_argument("--diffusion-steps", type=int, default=1000)
    parser.add_argument("--num-workers", type=int, default=4)
    parser.add_argument("--log-every", type=int, default=100)
    parser.add_argument("--eval-every", type=int, default=10000)
    parser.add_argument("--save-every", type=int, default=2000)
    parser.add_argument("--resume", type=Path, default=None)
    parser.add_argument("--no-normalize", action="store_true", help="特征不做归一化，沿用原来的损失权重")
    parser.add_argument("--key-mix", choices=("dense", "sparse"), default="dense", help="训练时关键帧疏密的比例")
    parser.add_argument("--skip-glitches", action="store_true", help="避开 smpl_kf.clean 标出的动捕跳变段")
    parser.add_argument("--keep-every", type=int, default=0, help="每隔多少步留一个 step_*.pt；0 表示每次评测都留")
    parser.add_argument("--temporal-weight", type=float, default=0.3, help="相邻帧关节位移损失的权重，0 表示不用")
    parser.add_argument(
        "--temporal-by-noise",
        action="store_true",
        help="相邻帧损失乘上该步保留的信号比例：噪声小时压抖动，噪声大时不逼模型猜成静止",
    )
    parser.add_argument(
        "--no-impute-loss",
        action="store_true",
        help="损失直接比模型原始输出；默认先像采样时一样把关键帧写回，再算损失",
    )
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = parser.parse_args()
    if args.root is None:
        from smpl_kf.prepare import DEFAULT_ROOT

        args.root = DEFAULT_ROOT
    run_dir = Path(args.cache) / "runs" / args.run
    run_dir.mkdir(parents=True, exist_ok=True)
    log_file = (run_dir / "train.log").open("a", encoding="utf-8")
    sys.stdout = Tee(sys.__stdout__, log_file)
    try:
        _run(args, run_dir)
    finally:
        sys.stdout = sys.__stdout__
        log_file.close()


def ensure_cache(args) -> Path:
    """预处理在单独进程里做。当前进程已经初始化了 CUDA，不能再 fork 工作进程。"""
    cache = Path(args.cache)
    if _cache_is_ready(cache, args.val_mod) and not args.refresh:
        print(f"已有缓存 {cache}", flush=True)
        return cache
    command = [
        sys.executable,
        "-m",
        "smpl_kf.prepare",
        "--cache",
        str(cache),
        "--root",
        str(args.root),
        "--workers",
        str(args.workers),
        "--val-mod",
        str(args.val_mod),
    ]
    if args.limit:
        command += ["--limit", str(args.limit)]
    if args.files:
        command += ["--files", *map(str, args.files)]
    if args.refresh:
        command.append("--refresh")
    env = os.environ.copy()
    env.setdefault("OMP_NUM_THREADS", "1")
    env.setdefault("OPENBLAS_NUM_THREADS", "1")
    subprocess.check_call(command, env=env)
    return cache


def _run(args, run_dir: Path):
    cache = ensure_cache(args)
    device = args.device
    if device.startswith("cuda") and not torch.cuda.is_available():
        raise RuntimeError("没有可用的 CUDA")
    fraction = os.environ.get("SMPL_KF_GPU_FRACTION")
    if fraction and device.startswith("cuda"):
        torch.cuda.set_per_process_memory_fraction(float(fraction))
        print(f"显存上限 {float(fraction):.0%}", flush=True)
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    if device.startswith("cuda"):
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.set_float32_matmul_precision("high")

    if args.batch % args.micro_batch != 0:
        raise RuntimeError("--batch 要是 --micro-batch 的整数倍")
    accum = args.batch // args.micro_batch
    train_set = MotionDataset(
        cache,
        "train",
        args.micro_batch,
        args.min_len,
        args.max_len,
        key_mix=args.key_mix,
        skip_glitches=args.skip_glitches,
    )
    eval_set = build_eval_set(cache)
    pools = ", ".join(f"{name} {len(train_set.pools[name][0])}" for name in train_set.names)
    print(f"训练片段按类别：{pools}", flush=True)
    print(f"固定评测窗口 {len(eval_set['windows'])} 个", flush=True)
    config = {
        "arch": "motion",
        "feat_dim": FEAT_DIM,
        "root_dim": 5,
        "d_model": args.d_model,
        "nhead": args.nhead,
        "num_layers": args.layers,
        "dropout": args.dropout,
        "max_len": max(512, args.max_len),
        "window": args.max_len,
        "min_len": args.min_len,
        "overlap": args.overlap,
        "diffusion_steps": args.diffusion_steps,
        "fps": DST_FPS,
        "up_aligned": True,
        "batch": args.batch,
        "lr": args.lr,
        "steps": args.steps,
        "category_weights": CATEGORY_WEIGHTS,
        "normalized": not args.no_normalize,
        "temporal_weight": args.temporal_weight,
        "temporal_by_noise": args.temporal_by_noise,
        "impute_loss": not args.no_impute_loss,
        "key_mix": args.key_mix,
        "skip_glitches": args.skip_glitches,
    }
    (run_dir / "config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    model = build_denoiser(config).to(device)
    schedule = Schedule(args.diffusion_steps).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    step = 0
    checkpoint = None
    if args.resume:
        checkpoint = torch.load(args.resume, map_location=device, weights_only=False)
        if bool(checkpoint["config"].get("normalized", False)) != config["normalized"]:
            raise RuntimeError("接着训的权重和这次的归一化设置不一致")
        model.load_state_dict(checkpoint["model"])
        if "optim" in checkpoint:
            optimizer.load_state_dict(checkpoint["optim"])
        step = int(checkpoint["step"])
        feat_mean = np.asarray(checkpoint["mean"], np.float32)
        feat_std = np.asarray(checkpoint["std"], np.float32)
        print(f"从 step {step} 继续", flush=True)
    elif config["normalized"]:
        started_stats = time.time()
        feat_mean, feat_std = feature_stats(train_set)
        print(f"特征均值和标准差统计完成，用时 {time.time() - started_stats:.0f} 秒", flush=True)
    else:
        feat_mean = np.zeros(FEAT_DIM, np.float32)
        feat_std = np.ones(FEAT_DIM, np.float32)
    model.set_normalizer(feat_mean, feat_std)
    ema = EMA(model)
    if checkpoint is not None:
        ema.load_state_dict(checkpoint["ema"])

    count = sum(p.numel() for p in model.parameters())
    print(
        f"参数量 {count / 1e6:.2f}M，设备 {device}，每段 {args.layers} 层，批大小 {args.batch}（每次 {args.micro_batch}，攒 {accum} 次）",
        flush=True,
    )
    batches = iter(make_loader(train_set, args.num_workers))
    stop = {"flag": False}

    def _stop(signum, _frame):
        stop["flag"] = True
        print(f"收到信号 {signum}，当前步结束后保存", flush=True)

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    def _save(path: Path, include_optim: bool):
        payload = {
            "model": model.state_dict(),
            "ema": {name: value.detach().clone() for name, value in ema.state_dict().items()},
            "step": step,
            "mean": feat_mean,
            "std": feat_std,
            "config": config,
        }
        if include_optim:
            payload["optim"] = optimizer.state_dict()
        atomic_save(payload, path)
        print(f"保存 {path}", flush=True)

    def _evaluate():
        backup = {name: value.detach().clone() for name, value in model.state_dict().items()}
        model.load_state_dict(ema.state_dict())
        started = time.time()
        report = run_eval(model, schedule, eval_set, device, steps=20)
        model.load_state_dict(backup)
        model.train()
        print(log_line(step, report), flush=True)
        print(format_report(report), flush=True)
        print(f"评测用时 {time.time() - started:.0f} 秒", flush=True)
        (run_dir / f"eval_{step:07d}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        if not args.keep_every or step % args.keep_every == 0:
            _save(run_dir / f"step_{step:07d}.pt", False)

    use_autocast = device.startswith("cuda")
    nan_skips = 0
    started = time.time()
    first_step = step
    pause_file = run_dir / "pause_seconds"
    pause = float(os.environ.get("SMPL_KF_STEP_PAUSE", "0") or 0)
    while step < args.steps:
        if stop["flag"]:
            break
        lr = learning_rate(step, args.lr, args.warmup, args.steps)
        for group in optimizer.param_groups:
            group["lr"] = lr
        optimizer.zero_grad(set_to_none=True)
        total = 0.0
        finite = True
        for _ in range(accum):
            x, key_mask, valid = next(batches)
            key_mask = key_mask.to(device, non_blocking=True)
            valid = valid.to(device, non_blocking=True)
            x = model.normalize(x.to(device, non_blocking=True))
            x = torch.where(valid > 0.5, x, torch.zeros_like(x))
            timesteps = torch.randint(0, schedule.steps, (x.shape[0],), device=device)
            x_t = schedule.q_sample(x, timesteps, torch.randn_like(x))
            x_in = key_mask * x + (1.0 - key_mask) * x_t
            x_in = torch.where(valid > 0.5, x_in, torch.zeros_like(x_in))
            with torch.autocast(device_type="cuda", dtype=torch.bfloat16, enabled=use_autocast):
                pred = model(x_in, key_mask, timesteps, valid)
            if config["impute_loss"]:
                # 采样时关键帧会被原样写回；这里同样写回，相邻帧和关键帧之间的接缝才会进损失。
                pred = key_mask * x + (1.0 - key_mask) * pred.float()
            temporal = args.temporal_weight
            if args.temporal_by_noise:
                temporal = args.temporal_weight * schedule.alpha_bar[timesteps]
            loss = motion_loss(
                pred,
                x,
                valid,
                model.feat_mean,
                model.feat_std,
                normalized=config["normalized"],
                temporal=temporal,
            ) / accum
            if not torch.isfinite(loss):
                finite = False
                break
            loss.backward()
            total += float(loss.detach())
        if not finite:
            nan_skips += 1
            optimizer.zero_grad(set_to_none=True)
            if nan_skips > 20:
                raise RuntimeError("损失连续出现 NaN")
            continue
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        ema.update(model, step)
        step += 1
        # 运行中可以改 pause_seconds 文件里的秒数，白天调大、夜里调小，不用重启。
        if step % 100 == 0 and pause_file.exists():
            try:
                pause = max(0.0, float(pause_file.read_text().strip()))
            except ValueError:
                pass
        if pause > 0:
            time.sleep(pause)
        if step % args.log_every == 0 or step == 1:
            rate = (step - first_step) / max(time.time() - started, 1e-6)
            print(f"step {step} loss {total:.4f} lr {lr:.2e} len {x.shape[1]} {rate:.2f} step/s pause {pause:.2f}", flush=True)
        if args.eval_every and step % args.eval_every == 0:
            _evaluate()
        if step % args.save_every == 0:
            _save(run_dir / "last.pt", True)

    _save(run_dir / "last.pt", True)
    print(f"训练结束 step {step}，权重在 {run_dir}", flush=True)


if __name__ == "__main__":
    main()
