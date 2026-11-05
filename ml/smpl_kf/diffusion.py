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

    def ddim(self, x: torch.Tensor, pred_x0: torch.Tensor, t: int, t_prev: int) -> torch.Tensor:
        alpha = self.alpha_bar[t].to(dtype=x.dtype)
        eps = (x - alpha.sqrt() * pred_x0) / (1.0 - alpha).clamp(min=1e-8).sqrt()
        if t_prev < 0:
            return pred_x0
        alpha_prev = self.alpha_bar[t_prev].to(dtype=x.dtype)
        return alpha_prev.sqrt() * pred_x0 + (1.0 - alpha_prev).clamp(min=0).sqrt() * eps


def rot6d_to_matrix(rot6d: torch.Tensor) -> torch.Tensor:
    a1 = rot6d[..., 0:3]
    a2 = rot6d[..., 3:6]
    b1 = torch.nn.functional.normalize(a1, dim=-1, eps=1e-8)
    b2 = a2 - (b1 * a2).sum(dim=-1, keepdim=True) * b1
    b2 = torch.nn.functional.normalize(b2, dim=-1, eps=1e-8)
    b3 = torch.cross(b1, b2, dim=-1)
    return torch.stack((b1, b2, b3), dim=-1)


def _neighbor_weight(key_mask, present):
    """关键帧前后各 5 帧的损失乘 3，逼模型提前转到关键帧姿势。"""
    if key_mask is None:
        return present
    is_key = (key_mask.reshape(key_mask.shape[0], key_mask.shape[1], -1) > 0.5).any(dim=-1, keepdim=True)
    kernel = present.new_ones(1, 1, 11)
    dilated = torch.nn.functional.conv1d(is_key.float().transpose(1, 2), kernel, padding=5)
    dilated = dilated.transpose(1, 2)[:, : is_key.shape[1]].clamp(max=1.0)
    return present * (1.0 + 2.0 * dilated)


def _joint_positions(feat):
    joints = len(REST)
    relative = feat[..., POS_SLICE].reshape(*feat.shape[:-1], joints, 3)
    root = feat[..., ROOT_SLICE]
    pos = relative.clone()
    pos[..., 0] = pos[..., 0] + root[..., 0].unsqueeze(-1)
    pos[..., 2] = pos[..., 2] + root[..., 2].unsqueeze(-1)
    return pos


def _masked_mean(values, present):
    weight = present.squeeze(-1)
    return (values * weight).sum(dim=-1) / weight.sum(dim=-1).clamp(min=1.0)


def _masked_range(values, present):
    weight = present.squeeze(-1) > 0.5
    hi = torch.where(weight, values, torch.full_like(values, -1e4)).amax(dim=-1)
    lo = torch.where(weight, values, torch.full_like(values, 1e4)).amin(dim=-1)
    return (hi - lo).clamp(min=0.0)


def motion_loss(pred, target, valid, key_mask=None):
    """各分量平滑 L1，旋转用测地线。关键帧附近更重，整段的速度和骨盆起伏要接近原片。"""
    pred = pred.float()
    target = target.float()
    present = (valid > 0.5).float()
    frame_w = _neighbor_weight(key_mask, present)

    def part(span, weight):
        err = torch.nn.functional.smooth_l1_loss(pred[..., span], target[..., span], reduction="none")
        err = err.mean(dim=-1, keepdim=True)
        return weight * (err * frame_w).sum() / frame_w.sum().clamp(min=1.0)

    loss = part(ROOT_SLICE, 10.0)
    loss = loss + part(HEAD_SLICE, 2.0)
    loss = loss + part(POS_SLICE, 10.0)
    loss = loss + part(VEL_SLICE, 3.0)
    loss = loss + part(CONTACT_SLICE, 4.0)

    joints = len(REST)
    pred_rot = rot6d_to_matrix(pred[..., ANG_SLICE].reshape(*pred.shape[:-1], joints, 6))
    tgt_rot = rot6d_to_matrix(target[..., ANG_SLICE].reshape(*target.shape[:-1], joints, 6))
    relative = tgt_rot.transpose(-1, -2).matmul(pred_rot)
    trace = relative[..., 0, 0] + relative[..., 1, 1] + relative[..., 2, 2]
    cosine = ((trace - 1.0) * 0.5).clamp(-1.0 + 1e-4, 1.0 - 1e-4)
    geodesic = torch.acos(cosine).mean(dim=-1, keepdim=True) / torch.pi
    loss = loss + 10.0 * (geodesic * frame_w).sum() / frame_w.sum().clamp(min=1.0)

    pred_pos = _joint_positions(pred)
    tgt_pos = _joint_positions(target)
    step_w = present[:, 1:] * present[:, :-1]
    pred_speed = (pred_pos[:, 1:] - pred_pos[:, :-1]).norm(dim=-1).mean(dim=-1)
    tgt_speed = (tgt_pos[:, 1:] - tgt_pos[:, :-1]).norm(dim=-1).mean(dim=-1)
    speed_gap = (_masked_mean(pred_speed, step_w) - _masked_mean(tgt_speed, step_w)).abs()
    speed_scale = _masked_mean(tgt_speed, step_w).clamp(min=1e-3)
    height_gap = (_masked_range(pred[..., 1], present) - _masked_range(target[..., 1], present)).abs()
    height_scale = _masked_range(target[..., 1], present).clamp(min=0.05)
    loss = loss + 2.0 * (speed_gap / speed_scale).mean()
    loss = loss + 2.0 * (height_gap / height_scale).mean()

    relative_pos = target[..., POS_SLICE].reshape(*target.shape[:-1], joints, 3)
    root = target[..., ROOT_SLICE]
    truth = relative_pos.clone()
    truth[..., 0] = truth[..., 0] + root[..., 0:1]
    truth[..., 2] = truth[..., 2] + root[..., 2:3]
    rest = pred.new_tensor(REST)
    positions = []
    for index, parent in enumerate(PARENTS[:joints]):
        if parent < 0:
            positions.append(truth[..., 0, :])
        else:
            offset = torch.matmul(pred_rot[..., parent, :, :], rest[index].view(3, 1)).squeeze(-1)
            positions.append(positions[parent] + offset)
    fk_err = torch.nn.functional.smooth_l1_loss(torch.stack(positions, dim=-2), truth, reduction="none").mean(dim=-1)
    fk_loss = (fk_err * frame_w).sum() / (frame_w.sum().clamp(min=1.0) * joints)
    return loss + 5.0 * fk_loss


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
):
    """每一步都把已知通道写回带噪动作，模型只生成未知的部分。

    cfg_scale 大于 1 时，用空关键帧再预测一次，把结果往「有关键帧」的方向推。
    soft_tail 大于 0 时，最后几步把关键帧权重从 1 收到 soft_strength。
    返回前仍把已知通道钉回目标。
    """
    was_training = model.training
    model.eval()
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
            pred = model(x_in, guide, current, valid).float()
            if float(cfg_scale) != 1.0:
                blank = torch.zeros_like(guide)
                uncond = model(x, blank, current, valid).float()
                pred = uncond + float(cfg_scale) * (pred - uncond)
            pred = guide * target + (1.0 - guide) * pred
            x = schedule.ddim(x, pred, int(timestep), previous)
            x = guide * target + (1.0 - guide) * x
            x = torch.where(valid > 0.5, x, torch.zeros_like(x))
        if tail:
            x = mask * target + (1.0 - mask) * x
            x = torch.where(valid > 0.5, x, torch.zeros_like(x))
        return x
    finally:
        model.train(was_training)
