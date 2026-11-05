"""网络前向、已知通道在采样里保持不变，以及几十步就能把损失压下去。"""

from __future__ import annotations

import numpy as np
import torch

from smpl_kf.diffusion import Schedule, impute_sample, motion_loss
from smpl_kf.geometry import AA_DIM, motion_to_feat
from smpl_kf.kimodo_rep import ANG_SLICE, FEAT_DIM, encode_motion
from smpl_kf.model import TwoStageDenoiser


def _small_model(device, normalized=False):
    model = TwoStageDenoiser(
        FEAT_DIM, d_model=64, nhead=4, num_layers=1, dropout=0.0, max_len=64, normalized=normalized
    )
    if normalized:
        rng = np.random.default_rng(5)
        model.set_normalizer(rng.normal(size=FEAT_DIM) * 0.2, rng.uniform(0.01, 2.0, size=FEAT_DIM))
    return model.to(device)


def test_known_channels_stay_fixed():
    device = "cuda" if torch.cuda.is_available() else "cpu"
    torch.manual_seed(0)
    for normalized in (False, True):
        model = _small_model(device, normalized)
        schedule = Schedule(50).to(device)
        target = torch.randn(2, 32, FEAT_DIM, device=device) * 0.3
        mask = torch.zeros_like(target)
        mask[:, 0, :40] = 1.0
        mask[:, -1, :40] = 1.0
        valid = torch.ones(2, 32, 1, device=device)
        valid[1, 20:] = 0.0
        for kwargs in ({}, {"soft_tail": 3, "soft_strength": 0.5}, {"cfg_scale": 2.0}):
            sampled = impute_sample(model, schedule, target, mask, valid, steps=5, **kwargs)
            err = float(((sampled - target).abs() * mask * valid).max())
            if err > 1e-4:
                raise AssertionError(f"已知通道被改动了（归一化 {normalized}，{kwargs}），误差 {err}")
            if float(sampled[1, 20:].abs().max()) != 0.0:
                raise AssertionError("填充帧不是 0")


def test_normalizer_roundtrip():
    model = _small_model("cpu", normalized=True)
    x = torch.randn(2, 8, FEAT_DIM)
    back = model.denormalize(model.normalize(x))
    if float((back - x).abs().max()) > 1e-5:
        raise AssertionError("归一化来回变换不一致")


def test_flip_is_penalized():
    frames = 4
    trans = np.stack((np.zeros(frames), [0.9, 1.0, 1.3, 0.95], np.zeros(frames)), axis=1).astype(np.float32)
    feat = motion_to_feat(np.zeros((frames, AA_DIM), np.float32), trans)
    target = torch.from_numpy(encode_motion(feat))[None]
    valid = torch.ones(1, frames, 1)
    same = float(motion_loss(target, target, valid))
    flipped = target.clone()
    start = ANG_SLICE.start + 16 * 6
    flipped[..., start : start + 6] = torch.tensor([-1.0, 0.0, 0.0, 0.0, -1.0, 0.0])
    worse = float(motion_loss(flipped, target, valid))
    if worse < same + 0.05:
        raise AssertionError(f"翻转肩膀的损失不够大: {same:.4f} -> {worse:.4f}")


def test_temporal_loss_penalizes_jitter():
    frames = 12
    trans = np.stack((np.linspace(0, 1, frames), np.full(frames, 0.9), np.zeros(frames)), axis=1).astype(np.float32)
    target = torch.from_numpy(encode_motion(motion_to_feat(np.zeros((frames, AA_DIM), np.float32), trans)))[None]
    valid = torch.ones(1, frames, 1)
    shaky = target.clone()
    shaky[0, 1::2, 0] += 0.03
    base = float(motion_loss(shaky, target, valid, normalized=False))
    with_steps = float(motion_loss(shaky, target, valid, normalized=False, temporal=0.5))
    if with_steps < base + 0.2:
        raise AssertionError(f"相邻帧损失没有罚抖动: {base:.4f} -> {with_steps:.4f}")


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
    for _ in range(400):
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
    test_normalizer_roundtrip()
    test_flip_is_penalized()
    test_temporal_loss_penalizes_jitter()
    test_known_channels_stay_fixed()
    test_loss_drops()
    print("model tests passed")


if __name__ == "__main__":
    main()
