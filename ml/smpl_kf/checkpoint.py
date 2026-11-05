"""模型权重与归一化统计量的读写。"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch

from smpl_kf.diffusion import Schedule
from smpl_kf.model import build_denoiser


def atomic_save(payload: dict, path: Path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    torch.save(payload, temporary)
    temporary.replace(path)


def load_trained(path: str | Path, device: str):
    checkpoint = torch.load(path, map_location=device, weights_only=False)
    config = checkpoint["config"]
    model = build_denoiser(config)
    state = checkpoint.get("ema") or checkpoint["model"]
    model.load_state_dict(state)
    mean = checkpoint["mean"]
    std = checkpoint["std"]
    if torch.is_tensor(mean):
        mean = mean.detach().cpu().numpy()
    if torch.is_tensor(std):
        std = std.detach().cpu().numpy()
    mean = np.asarray(mean, np.float32)
    std = np.asarray(std, np.float32)
    model.set_normalizer(mean, std)
    model.to(device).eval()
    schedule = Schedule(int(config["diffusion_steps"])).to(device)
    return model, schedule, mean, std, checkpoint
