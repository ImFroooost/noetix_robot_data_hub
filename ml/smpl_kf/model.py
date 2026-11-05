"""两段去噪网络：先预测全局根，再在局部根条件下预测身体。输入是带噪动作、已知通道和掩码。"""

from __future__ import annotations

import math

import torch
from torch import nn


def sinusoidal(length: int, dim: int) -> torch.Tensor:
    position = torch.arange(length)[:, None]
    half = dim // 2
    freq = torch.exp(-math.log(10000.0) * torch.arange(half) / half)
    angle = position * freq[None]
    encoded = torch.cat((angle.sin(), angle.cos()), dim=-1)
    if dim % 2:
        encoded = nn.functional.pad(encoded, (0, 1))
    return encoded


class TimeEmbed(nn.Module):
    def __init__(self, dim: int):
        super().__init__()
        self.dim = dim
        self.mlp = nn.Sequential(nn.Linear(dim, dim * 4), nn.SiLU(), nn.Linear(dim * 4, dim))

    def forward(self, timesteps: torch.Tensor) -> torch.Tensor:
        half = self.dim // 2
        freq = torch.exp(-math.log(10000.0) * torch.arange(half, device=timesteps.device) / half)
        angle = timesteps.float()[:, None] * freq[None]
        encoded = torch.cat((angle.sin(), angle.cos()), dim=-1)
        if self.dim % 2:
            encoded = nn.functional.pad(encoded, (0, 1))
        return self.mlp(encoded)


class _Stage(nn.Module):
    def __init__(self, in_dim: int, out_dim: int, d_model: int, nhead: int, num_layers: int, dropout: float, max_len: int):
        super().__init__()
        self.max_len = max_len
        self.in_proj = nn.Linear(in_dim, d_model)
        self.time_embed = TimeEmbed(d_model)
        self.register_buffer("pos", sinusoidal(max_len, d_model), persistent=False)
        layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=nhead,
            dim_feedforward=d_model * 4,
            dropout=dropout,
            activation="gelu",
            batch_first=True,
            norm_first=True,
        )
        self.encoder = nn.TransformerEncoder(layer, num_layers=num_layers, enable_nested_tensor=False)
        self.out = nn.Linear(d_model, out_dim)
        nn.init.zeros_(self.out.weight)
        nn.init.zeros_(self.out.bias)

    def forward(self, tokens: torch.Tensor, timesteps: torch.Tensor, pad: torch.Tensor) -> torch.Tensor:
        frames = tokens.shape[1]
        if frames > self.max_len:
            raise ValueError(f"序列长度 {frames} 超过位置编码 {self.max_len}")
        hidden = self.in_proj(tokens) + self.pos[:frames] + self.time_embed(timesteps)[:, None]
        if bool(pad.all(dim=1).any()):
            pad = pad.clone()
            pad[:, 0] = False
        return self.out(self.encoder(hidden, src_key_padding_mask=pad))


def global_root_to_local(root: torch.Tensor) -> torch.Tensor:
    """全局根 (xyz + cos/sin) -> 转向角速度、水平速度和高度。"""
    xz = root[..., [0, 2]]
    height = root[..., 1:2]
    heading = torch.atan2(root[..., 4], root[..., 3])
    delta = torch.zeros_like(heading)
    delta[:, 1:] = heading[:, 1:] - heading[:, :-1]
    delta = (delta + torch.pi) % (2 * torch.pi) - torch.pi
    vel_xz = torch.zeros_like(xz)
    vel_xz[:, 1:] = xz[:, 1:] - xz[:, :-1]
    return torch.cat((delta.unsqueeze(-1), vel_xz, height), dim=-1)


class TwoStageDenoiser(nn.Module):
    """每一步去噪都先走根网络，再走身体网络。"""

    def __init__(
        self,
        feat_dim: int,
        root_dim: int = 5,
        d_model: int = 512,
        nhead: int = 8,
        num_layers: int = 4,
        dropout: float = 0.1,
        max_len: int = 512,
    ):
        super().__init__()
        if d_model % nhead != 0:
            raise ValueError("d_model 必须能被 nhead 整除")
        self.feat_dim = feat_dim
        self.root_dim = root_dim
        body_dim = feat_dim - root_dim
        self.root_stage = _Stage(feat_dim * 2, root_dim, d_model, nhead, num_layers, dropout, max_len)
        self.body_stage = _Stage(4 + body_dim * 2, body_dim, d_model, nhead, num_layers, dropout, max_len)

    def forward(self, x_in: torch.Tensor, mask: torch.Tensor, timesteps: torch.Tensor, valid: torch.Tensor) -> torch.Tensor:
        pad = valid.squeeze(-1) < 0.5
        root = self.root_stage(torch.cat((x_in, mask), dim=-1), timesteps, pad)
        # 已经给定的根通道用输入里的值，身体不跟着一条和约束打架的根。
        root_for_body = torch.where(mask[..., : self.root_dim] > 0.5, x_in[..., : self.root_dim], root)
        local_root = global_root_to_local(root_for_body)
        body_in = torch.cat((local_root, x_in[..., self.root_dim :], mask[..., self.root_dim :]), dim=-1)
        body = self.body_stage(body_in, timesteps, pad)
        return torch.cat((root, body), dim=-1)


def build_denoiser(config: dict) -> TwoStageDenoiser:
    if config.get("arch") != "motion":
        raise RuntimeError(f"这个权重是旧格式（{config.get('arch')}），当前代码只支持关键帧动作模型")
    return TwoStageDenoiser(
        feat_dim=config["feat_dim"],
        root_dim=config.get("root_dim", 5),
        d_model=config["d_model"],
        nhead=config["nhead"],
        num_layers=config["num_layers"],
        dropout=config.get("dropout", 0.0),
        max_len=config.get("max_len", 512),
    )
