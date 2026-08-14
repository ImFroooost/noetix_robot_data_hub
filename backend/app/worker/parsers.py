"""Lightweight motion file parsers for preview generation and metadata extraction."""

from __future__ import annotations

import json
import re
import struct
from pathlib import Path

import numpy as np


def _duration(fps: float | None, frames: int | None) -> float | None:
    if fps and frames and fps > 0:
        return frames / fps
    return None


def parse_bvh(path: Path) -> dict:
    text = path.read_text(encoding="utf-8", errors="ignore")
    frames = None
    fps = None
    m_frames = re.search(r"Frames:\s*(\d+)", text, re.IGNORECASE)
    m_ft = re.search(r"Frame Time:\s*([0-9.eE+-]+)", text, re.IGNORECASE)
    if m_frames:
        frames = int(m_frames.group(1))
    if m_ft:
        ft = float(m_ft.group(1))
        if ft > 0:
            fps = 1.0 / ft

    # Extract joint names from hierarchy
    joints = re.findall(r"(?:ROOT|JOINT)\s+(\S+)", text)
    motion_idx = text.upper().find("MOTION")
    preview = {"joints": joints, "positions": [], "fps": fps, "frame_count": frames}
    if motion_idx >= 0 and frames:
        motion_part = text[motion_idx:]
        lines = [ln.strip() for ln in motion_part.splitlines() if ln.strip()]
        # Skip MOTION / Frames / Frame Time
        data_lines = [ln for ln in lines if not re.match(r"^(MOTION|Frames:|Frame Time:)", ln, re.I)]
        # For preview: take root XYZ of first 3 channels if present
        positions = []
        for ln in data_lines[: min(frames, 300)]:
            vals = [float(x) for x in ln.split()]
            if len(vals) >= 3:
                positions.append(vals[:3])
        preview["positions"] = positions
        if frames is None:
            frames = len(data_lines)
            preview["frame_count"] = frames

    return {
        "fps": fps,
        "frame_count": frames,
        "duration_sec": _duration(fps, frames),
        "preview": preview,
    }


def parse_csv_motion(path: Path, assume_fps: float | None = None) -> dict:
    """Human CSV with header. Either:
    - columns: time, j1, j2, ...
    - or: j1, j2, ... with optional fps meta line # fps=30
    """
    fps = assume_fps
    rows = []
    headers = None
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if line.startswith("#"):
                m = re.search(r"fps\s*[:=]\s*([0-9.]+)", line, re.I)
                if m:
                    fps = float(m.group(1))
                continue
            if headers is None:
                headers = [h.strip() for h in line.split(",")]
                continue
            parts = [p.strip() for p in line.split(",")]
            try:
                rows.append([float(p) for p in parts])
            except ValueError:
                continue

    if not rows:
        return {"fps": fps, "frame_count": 0, "duration_sec": None, "preview": {"headers": headers or [], "frames": []}}

    arr = np.asarray(rows, dtype=np.float32)
    has_time = headers and headers[0].lower() in ("time", "t", "timestamp")
    if has_time and arr.shape[0] > 1:
        dt = float(arr[-1, 0] - arr[0, 0])
        frames = arr.shape[0]
        if dt > 0:
            fps = (frames - 1) / dt
        joint_data = arr[:, 1:]
        joint_names = headers[1:]
    else:
        frames = arr.shape[0]
        joint_data = arr
        joint_names = headers or [f"j{i}" for i in range(arr.shape[1])]
        if fps is None:
            fps = 30.0

    # Downsample preview to <= 300 frames
    step = max(1, frames // 300)
    preview_frames = joint_data[::step].tolist()
    return {
        "fps": fps,
        "frame_count": frames,
        "duration_sec": _duration(fps, frames),
        "preview": {
            "joint_names": joint_names,
            "frames": preview_frames,
            "fps": fps,
            "frame_count": frames,
        },
    }


# Robot retarget CSV: [root_x, root_y, root_z, qx, qy, qz, qw] + joint angles...
ROBOT_ROOT_COLS = 7


def extract_urdf_actuated_joints(urdf_path: Path) -> list[str]:
    """Ordered actuated joint names from URDF (revolute/continuous/prismatic)."""
    text = urdf_path.read_text(encoding="utf-8", errors="ignore")
    names: list[str] = []
    for tag in re.findall(r"<joint\b[^>]*>", text, flags=re.I):
        nm = re.search(r'name\s*=\s*"([^"]+)"', tag, re.I)
        tp = re.search(r'type\s*=\s*"([^"]+)"', tag, re.I)
        if nm and tp and tp.group(1).lower() in ("revolute", "continuous", "prismatic"):
            names.append(nm.group(1))
    return names


def _is_likely_base_joint(name: str) -> bool:
    n = name.lower()
    return any(
        key in n
        for key in (
            "floor_2_base",
            "floating_base",
            "floatingbase",
            "root_joint",
            "base_joint",
            "world_to_",
        )
    )


def match_joint_names_to_columns(joint_names: list[str], n_cols: int) -> list[str]:
    """Align URDF joint list length to CSV joint-column count."""
    if n_cols <= 0:
        return []
    if not joint_names:
        return [f"j{i}" for i in range(n_cols)]
    if len(joint_names) == n_cols:
        return list(joint_names)

    filtered = [n for n in joint_names if not _is_likely_base_joint(n)]
    if len(filtered) == n_cols:
        return filtered

    # Common: first URDF joint is a base connector not present in CSV
    if len(joint_names) - 1 == n_cols and _is_likely_base_joint(joint_names[0]):
        return list(joint_names[1:])

    if len(joint_names) > n_cols:
        return list(joint_names[:n_cols])

    # pad missing
    out = list(joint_names)
    out.extend(f"j{i}" for i in range(len(out), n_cols))
    return out


def align_robot_joint_columns(
    arr: np.ndarray, joint_names: list[str]
) -> tuple[np.ndarray, np.ndarray | None, list[str], str | None]:
    """Map headerless robot CSV columns.

    Unified layout:
      col0..2  root position xyz
      col3..6  root orientation quaternion xyzw
      col7..   joint angles (same order as robot DOF, excluding floating base)
    """
    if arr.ndim == 1:
        arr = arr.reshape(-1, 1)
    n_cols = int(arr.shape[1])

    if n_cols < ROBOT_ROOT_COLS:
        names = match_joint_names_to_columns(joint_names, n_cols)
        return arr, None, names, f"列数({n_cols})不足 {ROBOT_ROOT_COLS}，按无根位姿处理"

    root = arr[:, :ROBOT_ROOT_COLS]
    data = arr[:, ROBOT_ROOT_COLS:]
    names = match_joint_names_to_columns(joint_names, int(data.shape[1]))
    note = "前 7 列：根 xyz + xyzw 四元数，其后为关节"
    return data, root, names, note


def parse_robot_csv(
    path: Path,
    assume_fps: float | None = None,
    joint_names: list[str] | None = None,
) -> dict:
    """Robot retarget CSV: no header. Every numeric row is one frame.

    Optional comment lines: # fps=30
    """
    fps = assume_fps
    rows: list[list[float]] = []
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if line.startswith("#"):
                m = re.search(r"fps\s*[:=]\s*([0-9.]+)", line, re.I)
                if m:
                    fps = float(m.group(1))
                continue
            parts = [p.strip() for p in line.split(",")]
            try:
                rows.append([float(p) for p in parts])
            except ValueError:
                # skip malformed / non-numeric lines
                continue

    if not rows:
        return {
            "fps": fps,
            "frame_count": 0,
            "duration_sec": None,
            "preview": {"joint_names": joint_names or [], "frames": []},
        }

    arr = np.asarray(rows, dtype=np.float32)
    names = list(joint_names or [])
    joint_data, root, names, note = align_robot_joint_columns(arr, names)
    frames = int(joint_data.shape[0])
    if fps is None:
        fps = 30.0

    step = max(1, frames // 300)
    preview: dict = {
        "joint_names": names,
        "frames": joint_data[::step].tolist(),
        "fps": fps,
        "frame_count": frames,
    }
    if root is not None and root.shape[1] >= 3:
        preview["root_positions"] = root[::step, :3].tolist()
    if root is not None and root.shape[1] >= ROBOT_ROOT_COLS:
        preview["root_quaternions"] = root[::step, 3:7].tolist()  # xyzw
    if note:
        preview["align_note"] = note

    return {
        "fps": fps,
        "frame_count": frames,
        "duration_sec": _duration(fps, frames),
        "preview": preview,
        "meta": {"align_note": note, "raw_columns": int(arr.shape[1])},
    }


def parse_npz_smpl(path: Path) -> dict:
    """Best-effort SMPL npz: poses (T,72) or (T,24,3), betas, optional fps/mocap_framerate."""
    data = np.load(path, allow_pickle=True)
    keys = list(data.keys())
    fps = None
    for k in ("fps", "mocap_framerate", "frame_rate"):
        if k in data:
            try:
                fps = float(np.asarray(data[k]).reshape(-1)[0])
            except Exception:
                pass
    poses = None
    for k in ("poses", "pose", "smpl_poses", "body_pose"):
        if k in data:
            poses = np.asarray(data[k])
            break
    frames = int(poses.shape[0]) if poses is not None else None
    if fps is None:
        fps = 30.0

    preview = {"keys": keys, "fps": fps, "frame_count": frames, "joints": []}
    # Rough joint positions from axis-angle is heavy; store flattened pose subset for frontend curve view
    if poses is not None:
        flat = poses.reshape(poses.shape[0], -1)
        step = max(1, flat.shape[0] // 300)
        preview["pose_preview"] = flat[::step, :72].astype(np.float32).tolist()

    return {
        "fps": fps,
        "frame_count": frames,
        "duration_sec": _duration(fps, frames),
        "preview": preview,
        "meta": {"keys": keys},
    }


def parse_fbx_stub(path: Path) -> dict:
    """FBX binary parsing is complex; store size-based stub and let frontend load original via three.js."""
    size = path.stat().st_size
    return {
        "fps": None,
        "frame_count": None,
        "duration_sec": None,
        "preview": {"type": "fbx", "size": size, "note": "前端使用原始 FBX 加载"},
        "meta": {"size": size},
    }


def parse_human_file(path: Path, fmt: str, fps_hint: float | None = None) -> dict:
    fmt = fmt.lower()
    if fmt == "bvh":
        return parse_bvh(path)
    if fmt in ("csv", "txt"):
        return parse_csv_motion(path, assume_fps=fps_hint)
    if fmt in ("smpl", "npz", "npz_smpl"):
        return parse_npz_smpl(path)
    if fmt == "fbx":
        return parse_fbx_stub(path)
    if fmt == "tak":
        # Autodesk MotionBuilder TAK — store as original download; no lightweight parser
        size = path.stat().st_size
        return {
            "fps": fps_hint,
            "frame_count": None,
            "duration_sec": None,
            "preview": {"type": "tak", "size": size, "note": "TAK 原文件存档，供 MotionBuilder 使用"},
            "meta": {"size": size},
        }
    # Generic binary / unknown
    return {
        "fps": fps_hint,
        "frame_count": None,
        "duration_sec": None,
        "preview": {"type": fmt, "size": path.stat().st_size},
        "meta": {"size": path.stat().st_size},
    }


def parse_robot_file(
    path: Path,
    fmt: str = "csv",
    fps_hint: float | None = None,
    joint_names: list[str] | None = None,
) -> dict:
    fmt = fmt.lower()
    if fmt in ("csv", "txt"):
        return parse_robot_csv(path, assume_fps=fps_hint, joint_names=joint_names)
    if fmt == "npz":
        data = np.load(path, allow_pickle=True)
        arr = None
        for k in ("q", "joint_pos", "positions", "data", "arr_0"):
            if k in data:
                arr = np.asarray(data[k], dtype=np.float32)
                break
        if arr is None:
            # first ndarray
            for k in data.files:
                candidate = np.asarray(data[k])
                if candidate.ndim >= 2:
                    arr = candidate.astype(np.float32)
                    break
        fps = fps_hint or 30.0
        if "fps" in data:
            fps = float(np.asarray(data["fps"]).reshape(-1)[0])
        names = list(joint_names or [])
        if "joint_names" in data:
            names = [str(x) for x in np.asarray(data["joint_names"]).tolist()]
        if arr is None:
            return {
                "fps": fps,
                "frame_count": 0,
                "duration_sec": None,
                "preview": {"joint_names": names, "frames": []},
            }
        joint_data, root, names, note = align_robot_joint_columns(arr, names)
        frames = int(joint_data.shape[0])
        step = max(1, frames // 300) if frames else 1
        preview: dict = {
            "joint_names": names,
            "frames": joint_data[::step].tolist(),
            "fps": fps,
            "frame_count": frames,
        }
        if root is not None and root.shape[1] >= 3:
            preview["root_positions"] = root[::step, :3].tolist()
        if root is not None and root.shape[1] >= ROBOT_ROOT_COLS:
            preview["root_quaternions"] = root[::step, 3:7].tolist()
        if note:
            preview["align_note"] = note
        return {
            "fps": fps,
            "frame_count": frames,
            "duration_sec": _duration(fps, frames),
            "preview": preview,
            "meta": {"align_note": note},
        }
    return parse_robot_csv(path, assume_fps=fps_hint, joint_names=joint_names)


def write_preview_json(path: Path, preview: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(preview), encoding="utf-8")


def write_preview_bin(path: Path, frames: np.ndarray):
    """Write float32 binary: header magic + n_frames + n_joints + data."""
    path.parent.mkdir(parents=True, exist_ok=True)
    arr = np.asarray(frames, dtype=np.float32)
    if arr.ndim == 1:
        arr = arr.reshape(-1, 1)
    with path.open("wb") as f:
        f.write(b"MOT1")
        f.write(struct.pack("<II", arr.shape[0], arr.shape[1]))
        f.write(arr.tobytes())


def render_thumbnail(positions: list[list[float]], out_path: Path):
    """Simple 2D projection thumbnail from root/joint positions."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig, ax = plt.subplots(figsize=(3, 3), dpi=96)
    # 略亮背景 + 高对比轨迹，小尺寸列表里仍可辨认
    ax.set_facecolor("#151a22")
    fig.patch.set_facecolor("#151a22")
    if positions:
        pts = np.asarray(positions, dtype=np.float32)
        if pts.ndim == 2 and pts.shape[1] >= 2:
            y = pts[:, 1] if pts.shape[1] == 2 else pts[:, 2]
            ax.plot(pts[:, 0], y, color="#7ec8ff", lw=2.2, solid_capstyle="round")
            ax.scatter(pts[0, 0], y[0], c="#ffb074", s=36, zorder=3, edgecolors="#1a1d23", linewidths=0.4)
            ax.scatter(pts[-1, 0], y[-1], c="#9ef0c3", s=28, zorder=3, edgecolors="#1a1d23", linewidths=0.4)
            # 留边距，避免轨迹贴边看不清
            pad_x = max(float(np.ptp(pts[:, 0])) * 0.12, 0.05)
            pad_y = max(float(np.ptp(y)) * 0.12, 0.05)
            ax.set_xlim(float(pts[:, 0].min()) - pad_x, float(pts[:, 0].max()) + pad_x)
            ax.set_ylim(float(y.min()) - pad_y, float(y.max()) + pad_y)
    ax.set_aspect("equal", adjustable="datalim")
    ax.set_xticks([])
    ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_visible(False)
    fig.tight_layout(pad=0.15)
    fig.savefig(out_path, facecolor=fig.get_facecolor())
    plt.close(fig)
