"""网络前向、已知通道在采样里保持不变，以及几十步就能把损失压下去。"""

from __future__ import annotations

import numpy as np
import torch

from smpl_kf.diffusion import Schedule, impute_sample, motion_loss
from smpl_kf.kimodo_rep import ANG_SLICE, FEAT_DIM
from smpl_kf.model import TwoStageDenoiser


def _small_model(device):
    return TwoStageDenoiser(FEAT_DIM, d_model=64, nhead=4, num_layers=1, dropout=0.0, max_len=64).to(device)


def test_known_channels_stay_fixed():
    device = "cuda" if torch.cuda.is_available() else "cpu"
    torch.manual_seed(0)
    model = _small_model(device)
    schedule = Schedule(50).to(device)
    target = torch.randn(2, 32, FEAT_DIM, device=device) * 0.3
    mask = torch.zeros_like(target)
    mask[:, 0, :40] = 1.0
    mask[:, -1, :40] = 1.0
    valid = torch.ones(2, 32, 1, device=device)
    valid[1, 20:] = 0.0
    sampled = impute_sample(model, schedule, target, mask, valid, steps=5)
    err = float(((sampled - target).abs() * mask * valid).max())
    if err > 1e-5:
        raise AssertionError(f"已知通道被改动了，误差 {err}")
    softened = impute_sample(model, schedule, target, mask, valid, steps=5, soft_tail=3, soft_strength=0.5)
    err = float(((softened - target).abs() * mask * valid).max())
    if err > 1e-5:
        raise AssertionError(f"软采样结束后已知通道没有钉回，误差 {err}")
    guided = impute_sample(model, schedule, target, mask, valid, steps=5, cfg_scale=2.0)
    err = float(((guided - target).abs() * mask * valid).max())
    if err > 1e-5:
        raise AssertionError(f"引导采样后已知通道被改动了，误差 {err}")
    if float(sampled[1, 20:].abs().max()) != 0.0:
        raise AssertionError("填充帧不是 0")


def test_geodesic_penalizes_flip():
    target = torch.zeros(1, 4, FEAT_DIM)
    eye = torch.tensor([1.0, 0.0, 0.0, 0.0, 1.0, 0.0])
    target[..., ANG_SLICE] = eye.repeat(22)
    target[0, :, 1] = torch.tensor([0.9, 1.0, 1.3, 0.95])
    valid = torch.ones(1, 4, 1)
    same = float(motion_loss(target, target, valid))
    flipped = target.clone()
    start = ANG_SLICE.start + 16 * 6
    flipped[..., start : start + 6] = torch.tensor([-1.0, 0.0, 0.0, 0.0, -1.0, 0.0])
    worse = float(motion_loss(flipped, target, valid))
    if worse < same + 0.2:
        raise AssertionError(f"翻转肩膀的损失不够大: {same:.4f} -> {worse:.4f}")


def test_loss_drops():
    device = "cuda" if torch.cuda.is_available() else "cpu"
    torch.manual_seed(0)
    model = _small_model(device)
    schedule = Schedule(50).to(device)
    x = torch.randn(4, 32, FEAT_DIM, device=device) * 0.3
    mask = torch.zeros_like(x)
    mask[:, 0] = 1.0
    valid = torch.ones(4, 32, 1, device=device)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3)
    losses = []
    for _ in range(150):
        timesteps = torch.randint(0, schedule.steps, (4,), device=device)
        noisy = schedule.q_sample(x, timesteps, torch.randn_like(x))
        x_in = mask * x + (1.0 - mask) * noisy
        loss = motion_loss(model(x_in, mask, timesteps, valid), x, valid)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        losses.append(float(loss.detach()))
    early = float(np.mean(losses[:5]))
    late = float(np.mean(losses[-5:]))
    if not late < early * 0.8:
        raise AssertionError(f"损失没有下降: {early:.4f} -> {late:.4f}")
    print(f"loss {early:.4f} -> {late:.4f}")


def main():
    test_geodesic_penalizes_flip()
    test_known_channels_stay_fixed()
    test_loss_drops()
    print("model tests passed")


if __name__ == "__main__":
    main()
