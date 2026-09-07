"""On-demand media/motion metadata for storage repository files."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import wave
from pathlib import Path
from typing import Any

MEDIA_FIELDS = (
    "fps",
    "frame_count",
    "duration_sec",
    "width",
    "height",
    "joint_count",
    "sample_rate",
    "column_count",
)

VIDEO_FORMATS = {"mp4", "webm", "mov", "mkv", "avi", "m4v", "mpeg", "mpg"}
AUDIO_FORMATS = {"wav", "mp3", "flac", "ogg", "aac", "m4a", "wma"}
IMAGE_FORMATS = {"png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"}


def public_media(payload: dict[str, Any] | None) -> dict[str, Any]:
    source = payload or {}
    return {key: source.get(key) for key in MEDIA_FIELDS}


def probe_file(path: Path, *, modality: str = "", fmt: str = "") -> dict[str, Any]:
    fmt = (fmt or path.suffix.lstrip(".")).lower()
    modality = (modality or "").lower()
    info: dict[str, Any] = {key: None for key in MEDIA_FIELDS}

    if fmt == "bvh" or path.suffix.lower() == ".bvh":
        info.update(_probe_bvh(path))
    elif fmt == "csv" or path.suffix.lower() == ".csv":
        info.update(_probe_csv(path))
    elif fmt in {"npz", "npy"} or path.suffix.lower() in {".npz", ".npy"}:
        info.update(_probe_numpy(path))
    elif fmt in IMAGE_FORMATS or modality in {"tpv_video", "fpv_video"} and fmt in IMAGE_FORMATS:
        info.update(_probe_image(path))
    elif fmt == "wav" or path.suffix.lower() == ".wav":
        info.update(_probe_wav(path))
    elif fmt in VIDEO_FORMATS or fmt in AUDIO_FORMATS or modality in {
        "tpv_video",
        "fpv_video",
        "audio",
    }:
        probed = _probe_ffprobe(path)
        if probed:
            info.update(probed)
        elif fmt in IMAGE_FORMATS:
            info.update(_probe_image(path))

    return {key: info.get(key) for key in MEDIA_FIELDS}


def _duration(fps: float | None, frames: int | None) -> float | None:
    if fps and frames and fps > 0:
        return frames / fps
    return None


def _probe_bvh(path: Path) -> dict[str, Any]:
    frames = None
    fps = None
    joints = 0
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as handle:
            for index, raw in enumerate(handle):
                line = raw.strip()
                upper = line.upper()
                if upper.startswith("ROOT ") or upper.startswith("JOINT "):
                    joints += 1
                match = re.match(r"Frames:\s*(\d+)", line, re.IGNORECASE)
                if match:
                    frames = int(match.group(1))
                match = re.match(r"Frame Time:\s*([0-9.eE+-]+)", line, re.IGNORECASE)
                if match:
                    frame_time = float(match.group(1))
                    if frame_time > 0:
                        fps = 1.0 / frame_time
                if frames is not None and fps is not None and index > 20:
                    break
                if index > 8000:
                    break
    except OSError:
        return {}
    return {
        "fps": fps,
        "frame_count": frames,
        "duration_sec": _duration(fps, frames),
        "joint_count": joints or None,
    }


def _probe_csv(path: Path) -> dict[str, Any]:
    fps = None
    headers: list[str] | None = None
    rows = 0
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as handle:
            for raw in handle:
                line = raw.strip()
                if not line:
                    continue
                if line.startswith("#"):
                    match = re.search(r"fps\s*[:=]\s*([0-9.]+)", line, re.I)
                    if match:
                        fps = float(match.group(1))
                    continue
                if headers is None:
                    headers = [item.strip() for item in line.split(",")]
                    continue
                rows += 1
    except OSError:
        return {}
    return {
        "fps": fps,
        "frame_count": rows or None,
        "duration_sec": _duration(fps, rows or None),
        "column_count": len(headers) if headers else None,
    }


def _probe_numpy(path: Path) -> dict[str, Any]:
    try:
        import numpy as np
    except ImportError:
        return {}
    try:
        payload = np.load(path, mmap_mode="r", allow_pickle=False)
    except Exception:
        return {}
    fps = None
    frames = None
    try:
        if hasattr(payload, "files"):
            keys = list(payload.files)
            for key in ("fps", "mocap_framerate", "frame_rate"):
                if key in payload:
                    fps = float(np.asarray(payload[key]).reshape(-1)[0])
                    break
            for key in ("poses", "qpos", "q", "joint_pos", "data"):
                if key in payload:
                    array = payload[key]
                    if getattr(array, "ndim", 0) >= 1:
                        frames = int(array.shape[0])
                        break
            if frames is None:
                for key in keys:
                    array = payload[key]
                    if getattr(array, "ndim", 0) >= 2:
                        frames = int(array.shape[0])
                        break
        elif getattr(payload, "ndim", 0) >= 1:
            frames = int(payload.shape[0])
    except Exception:
        return {}
    return {
        "fps": fps,
        "frame_count": frames,
        "duration_sec": _duration(fps, frames),
    }


def _probe_image(path: Path) -> dict[str, Any]:
    try:
        from PIL import Image
    except ImportError:
        return {}
    try:
        with Image.open(path) as image:
            width, height = image.size
            frames = getattr(image, "n_frames", 1) or 1
            duration = None
            if frames > 1:
                durations = []
                for index in range(frames):
                    image.seek(index)
                    durations.append(image.info.get("duration") or 0)
                total_ms = sum(durations)
                if total_ms > 0:
                    duration = total_ms / 1000.0
            return {
                "width": int(width),
                "height": int(height),
                "frame_count": int(frames) if frames > 1 else None,
                "duration_sec": duration,
            }
    except Exception:
        return {}


def _probe_wav(path: Path) -> dict[str, Any]:
    try:
        with wave.open(str(path), "rb") as handle:
            rate = handle.getframerate()
            frames = handle.getnframes()
            duration = frames / rate if rate else None
            return {
                "sample_rate": rate or None,
                "frame_count": frames or None,
                "duration_sec": duration,
            }
    except Exception:
        return _probe_ffprobe(path) or {}


def _parse_frame_rate(value: str | None) -> float | None:
    if not value or value in {"0/0", "N/A"}:
        return None
    try:
        if "/" in value:
            num, den = value.split("/", 1)
            denom = float(den)
            if denom <= 0:
                return None
            return float(num) / denom
        return float(value)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _probe_ffprobe(path: Path) -> dict[str, Any] | None:
    executable = shutil.which("ffprobe")
    if not executable:
        return None
    try:
        completed = subprocess.run(
            [
                executable,
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=20,
            check=True,
        )
        data = json.loads(completed.stdout or "{}")
    except Exception:
        return None
    streams = data.get("streams") or []
    video = next((item for item in streams if item.get("codec_type") == "video"), None)
    audio = next((item for item in streams if item.get("codec_type") == "audio"), None)
    chosen = video or audio or {}
    duration = None
    for source in (chosen, data.get("format") or {}):
        raw = source.get("duration")
        if raw not in (None, "N/A", ""):
            try:
                duration = float(raw)
                break
            except (TypeError, ValueError):
                continue
    nb_frames = chosen.get("nb_frames")
    try:
        frame_count = int(nb_frames) if nb_frames not in (None, "N/A") else None
    except (TypeError, ValueError):
        frame_count = None
    fps = _parse_frame_rate(chosen.get("avg_frame_rate") or chosen.get("r_frame_rate"))
    sample_rate = None
    raw_rate = chosen.get("sample_rate")
    if raw_rate:
        try:
            sample_rate = int(float(raw_rate))
        except (TypeError, ValueError):
            sample_rate = None
    width = chosen.get("width")
    height = chosen.get("height")
    if duration is None:
        duration = _duration(fps, frame_count)
    if frame_count is None and duration and fps:
        frame_count = int(round(duration * fps))
    return {
        "fps": fps,
        "frame_count": frame_count,
        "duration_sec": duration,
        "width": int(width) if width else None,
        "height": int(height) if height else None,
        "sample_rate": sample_rate,
    }
