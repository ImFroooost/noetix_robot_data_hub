"""余弦噪声日程、按特征分量加权的损失，以及把已知通道写回带噪动作的采样。"""

from __future__ import annotations

import numpy as np
import torch
from torch import nn

from smpl_kf.kimodo_rep import (
    ANG_SLICE,
    CONTACT_SLICE,
    HEAD_SLICE,
    PARENTS,
    POS_SLICE,
    REST,
    ROOT_SLICE,
    VEL_SLICE,
)


def cosine_alpha_bar(steps: int, s: float = 0.008) -> np.ndarray:
    grid = np.arange(steps + 1, dtype=np.float64)
    curve = np.cos(((grid / steps) + s) / (1.0 + s) * np.pi * 0.5) ** 2
    alpha = curve / curve[0]
    return np.clip(alpha[:-1], 1e-5, 1.0).astype(np.float32)


class Schedule(nn.Module):
    def __init__(self, steps: int = 1000):
        super().__init__()
        self.steps = steps
        self.register_buffer("alpha_bar", torch.from_numpy(cosine_alpha_bar(steps)))

    def q_sample(self, x0: torch.Tensor, timesteps: torch.Tensor, noise: torch.Tensor) -> torch.Tensor:
        alpha = self.alpha_bar[timesteps].to(dtype=x0.dtype).view(-1, 1, 1)
        return alpha.sqrt() * x0 + (1.0 - alpha).clamp(min=0).sqrt() * noise

    def ddim(self, x: torch.Tensor, pred_x0: torch.Tensor, t: int, t_prev: int, eta: float = 0.0) -> torch.Tensor:
        """eta=0 是确定性的 DDIM；eta=1 每步重新注入噪声，后面的步可以改掉前面猜错的部分。"""
        alpha = self.alpha_bar[t].to(dtype=x.dtype)
        eps = (x - alpha.sqrt() * pred_x0) / (1.0 - alpha).clamp(min=1e-8).sqrt()
        if t_prev < 0:
            return pred_x0
        alpha_prev = self.alpha_bar[t_prev].to(dtype=x.dtype)
        sigma = eta * ((1.0 - alpha_prev) / (1.0 - alpha) * (1.0 - alpha / alpha_prev)).clamp(min=0).sqrt()
        direction = (1.0 - alpha_prev - sigma * sigma).clamp(min=0).sqrt() * eps
        out = alpha_prev.sqrt() * pred_x0 + direction
        if eta > 0:
            out = out + sigma * torch.randn_like(x)
        return out


def rot6d_to_matrix(rot6d: torch.Tensor) -> torch.Tensor:
    a1 = rot6d[..., 0:3]
    a2 = rot6d[..., 3:6]
    b1 = torch.nn.functional.normalize(a1, dim=-1, eps=1e-8)
    b2 = a2 - (b1 * a2).sum(dim=-1, keepdim=True) * b1
    b2 = torch.nn.functional.normalize(b2, dim=-1, eps=1e-8)
    b3 = torch.cross(b1, b2, dim=-1)
    return torch.stack((b1, b2, b3), dim=-1)


# 关节位置误差按这个尺度（米）换算成和归一化特征差不多大的数。
FK_SCALE = 0.2
# 相邻帧关节位移的误差按这个尺度（米/帧）换算。
STEP_SCALE = 0.01


def _fk_positions(rot, root):
    rest = rot.new_tensor(REST)
    positions = [root]
    for index, parent in enumerate(PARENTS[: len(REST)]):
        if parent < 0:
            continue
        offset = torch.matmul(rot[..., parent, :, :], rest[index].view(3, 1)).squeeze(-1)
        positions.append(positions[parent] + offset)
    return torch.stack(positions, dim=-2)


def motion_loss(pred, target, valid, mean=None, std=None, normalized=True, temporal=0.0):
    """逐分量平滑 L1，加上用预测旋转做正向运动学后的关节位置误差。

    normalized 为 True 时 pred、target 是归一化特征，各分量等权；否则是原始单位，沿用原来的权重。
    temporal 大于 0 时，再比较相邻帧之间关节位置的变化，压住逐帧各自乱抖。
    temporal 可以是每个样本一个权重（形状为批大小），用来按噪声大小调。
    """
    pred = pred.float()
    target = target.float()
    present = (valid > 0.5).float()

    def part(span, weight):
        err = torch.nn.functional.smooth_l1_loss(pred[..., span], target[..., span], reduction="none")
        err = err.mean(dim=-1, keepdim=True)
        return weight * (err * present).sum() / present.sum().clamp(min=1.0)

    weights = (1.0, 1.0, 1.0, 1.0, 1.0, 0.5) if normalized else (10.0, 2.0, 10.0, 3.0, 10.0, 4.0)
    spans = (ROOT_SLICE, HEAD_SLICE, POS_SLICE, VEL_SLICE, ANG_SLICE, CONTACT_SLICE)
    loss = sum(part(span, weight) for span, weight in zip(spans, weights))

    if mean is not None and std is not None:
        raw_pred = pred * std + mean
        raw_target = target * std + mean
    else:
        raw_pred, raw_target = pred, target
    joints = len(REST)
    rot = rot6d_to_matrix(raw_pred[..., ANG_SLICE].reshape(*pred.shape[:-1], joints, 6))
    relative = raw_target[..., POS_SLICE].reshape(*target.shape[:-1], joints, 3)
    root = raw_target[..., ROOT_SLICE]
    truth = relative.clone()
    truth[..., 0] = truth[..., 0] + root[..., 0:1]
    truth[..., 2] = truth[..., 2] + root[..., 2:3]
    fk = _fk_positions(rot, truth[..., 0, :])
    if normalized:
        fk_err = torch.nn.functional.smooth_l1_loss(fk / FK_SCALE, truth / FK_SCALE, reduction="none").mean(dim=-1)
        fk_weight = 1.0
    else:
        fk_err = torch.nn.functional.smooth_l1_loss(fk, truth, reduction="none").mean(dim=-1)
        fk_weight = 5.0
    loss = loss + fk_weight * (fk_err * present).sum() / (present.sum().clamp(min=1.0) * joints)

    temporal = torch.as_tensor(temporal, dtype=pred.dtype, device=pred.device)
    if bool((temporal > 0).any()):
        moving = _fk_positions(rot, raw_pred[..., ROOT_SLICE])
        step_pred = moving[:, 1:] - moving[:, :-1]
        step_true = truth[:, 1:] - truth[:, :-1]
        pair = present[:, 1:] * present[:, :-1]
        step_err = torch.nn.functional.smooth_l1_loss(
            step_pred / STEP_SCALE, step_true / STEP_SCALE, reduction="none"
        ).mean(dim=-1)
        per_sample = temporal.reshape(-1, 1, 1) if temporal.dim() else temporal
        loss = loss + (step_err * pair * per_sample).sum() / (pair.sum().clamp(min=1.0) * joints)
    return loss


@torch.no_grad()
def impute_sample(
    model,
    schedule: Schedule,
    target,
    mask,
    valid,
    steps: int,
    soft_tail: int = 0,
    soft_strength: float = 0.5,
    cfg_scale: float = 1.0,
    eta: float = 0.0,
):
    """每一步都把已知通道写回带噪动作，模型只生成未知的部分。target 和返回值都是原始单位。

    cfg_scale 大于 1 时，用空关键帧再预测一次，把结果往「有关键帧」的方向推。
    soft_tail 大于 0 时，最后几步写回关键帧的权重从 1 收到 soft_strength；喂给模型的掩码仍是 0/1。
    返回前仍把已知通道钉回目标。
    """
    was_training = model.training
    model.eval()
    target = model.normalize(target)
    x = torch.randn_like(target)
    x = torch.where(valid > 0.5, x, torch.zeros_like(x))
    grid = torch.linspace(schedule.steps - 1, 0, steps, device=target.device).round().long()
    grid = torch.unique_consecutive(grid)
    count = len(grid)
    tail = max(0, int(soft_tail))
    try:
        for index, timestep in enumerate(grid.tolist()):
            previous = int(grid[index + 1]) if index + 1 < count else -1
            current = torch.full((target.shape[0],), int(timestep), device=target.device, dtype=torch.long)
            strength = 1.0
            if tail and index >= count - tail:
                rank = index - (count - tail) + 1
                strength = 1.0 - (1.0 - float(soft_strength)) * (rank / tail)
            guide = mask * strength
            x_in = guide * target + (1.0 - guide) * x
            pred = model(x_in, mask, current, valid).float()
            if float(cfg_scale) != 1.0:
                blank = torch.zeros_like(guide)
                uncond = model(x, blank, current, valid).float()
                pred = uncond + float(cfg_scale) * (pred - uncond)
            pred = guide * target + (1.0 - guide) * pred
            x = schedule.ddim(x, pred, int(timestep), previous, eta)
            x = guide * target + (1.0 - guide) * x
            x = torch.where(valid > 0.5, x, torch.zeros_like(x))
        x = mask * target + (1.0 - mask) * x
        x = model.denormalize(x)
        return torch.where(valid > 0.5, x, torch.zeros_like(x))
    finally:
        model.train(was_training)
