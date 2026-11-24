"""Web control for the host auto-retarget loop.

The API container and the host loop share this JSON file through hub_repo.
``desired`` starts or stops the loop. ``performance`` sets how hard it runs.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from .file_lock import write_text_atomic

DESIRED = ("running", "stopped")
PERFORMANCE = ("auto", "light", "balanced", "heavy")
# Methods the host loop can actually run. umr and gmr are storage labels only.
RETARGET_METHODS = ("omniretarget", "frax")
DEFAULT_RETARGET_METHOD = "omniretarget"
# Manual ceilings and the RAM left for the desktop, in GB.
PROFILES = {
    "light": {"cap": 2, "reserve_gb": 48, "label": "轻"},
    "balanced": {"cap": 4, "reserve_gb": 32, "label": "均衡"},
    "heavy": {"cap": 8, "reserve_gb": 32, "label": "高"},
    "auto": {"cap": 8, "reserve_gb": 32, "label": "自动"},
}
MEM_FLOOR_MB = 16 * 1024
MEM_PER_JOB_MB = 3 * 1024


def control_path(hub: Path) -> Path:
    return Path(hub) / "index" / "auto_retarget_control.json"


def load_control(hub: Path) -> dict:
    path = control_path(hub)
    raw: dict = {}
    if path.is_file():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                raw = loaded
        except (OSError, json.JSONDecodeError):
            raw = {}
    desired = str(raw.get("desired") or "running")
    performance = str(raw.get("performance") or "heavy")
    if desired not in DESIRED:
        desired = "running"
    if performance not in PERFORMANCE:
        performance = "heavy"
    method = str(raw.get("method") or DEFAULT_RETARGET_METHOD)
    if method not in RETARGET_METHODS:
        method = DEFAULT_RETARGET_METHOD
    return {
        "desired": desired,
        "performance": performance,
        "method": method,
        "updated_at": raw.get("updated_at"),
    }


def save_control(
    hub: Path,
    *,
    desired: str,
    performance: str,
    method: str | None = None,
) -> dict:
    if desired not in DESIRED:
        raise ValueError("运行状态只能是启动或停止")
    if performance not in PERFORMANCE:
        raise ValueError("占用强度只能是自动、轻、均衡或高")
    current = load_control(hub)
    chosen = str(method or current["method"])
    if chosen not in RETARGET_METHODS:
        raise ValueError("重定向方法只能是 omniretarget 或 frax")
    payload = {
        "desired": desired,
        "performance": performance,
        "method": chosen,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    path = control_path(hub)
    write_text_atomic(path, json.dumps(payload, ensure_ascii=False))
    return payload


def mem_available_mb() -> int:
    try:
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    except (OSError, ValueError, IndexError):
        return 0
    return 0


def memory_pressure_pct() -> float | None:
    """PSI 'some' avg10, already a percent. Missing on older kernels."""
    try:
        text = Path("/proc/pressure/memory").read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        if not line.startswith("some "):
            continue
        for part in line.split():
            if part.startswith("avg10="):
                try:
                    return float(part.split("=", 1)[1])
                except ValueError:
                    return None
    return None


def os_cpu_count() -> int:
    return os.cpu_count() or 8


def _cpu_budget(last_wave: int) -> tuple[int, float]:
    cores = os_cpu_count()
    try:
        load1 = float(os.getloadavg()[0])
    except (OSError, AttributeError):
        load1 = 0.0
    headroom = max(2, min(8, (cores + 3) // 4))
    other = max(0.0, load1 - max(0, last_wave))
    budget = int(cores - headroom - other)
    return max(1, budget), load1


def wave_plan(hub: Path, *, last_wave: int = 0) -> dict:
    """How many jobs the next wave may start."""
    ctrl = load_control(hub)
    profile = PROFILES[ctrl["performance"]]
    free = mem_available_mb()
    if ctrl["desired"] == "stopped":
        return {
            "size": 0,
            "stop": True,
            "performance": ctrl["performance"],
            "cap": 0,
            "reserve_gb": profile["reserve_gb"],
            "detail": "已在页面上停止",
        }
    if free < MEM_FLOOR_MB:
        return {
            "size": 0,
            "stop": False,
            "performance": ctrl["performance"],
            "cap": profile["cap"],
            "reserve_gb": profile["reserve_gb"],
            "detail": f"可用内存仅 {free // 1024} GB，暂缓新任务",
        }
    reasons: list[str] = []
    cap = int(profile["cap"])
    reserve_gb = int(profile["reserve_gb"])
    if ctrl["performance"] == "auto":
        pressure = memory_pressure_pct()
        budget, load1 = _cpu_budget(last_wave)
        if pressure is not None and pressure >= 20:
            cap = 1
            reasons.append(f"内存压力 {pressure:.0f}%")
        elif pressure is not None and pressure >= 8:
            cap = min(cap, 3)
            reasons.append(f"内存压力 {pressure:.0f}%")
        if budget < cap:
            cap = budget
            reasons.append(f"CPU 负载 {load1:.1f}")
        if not reasons:
            reasons.append("机器较空闲")
    mem_slots = max(0, (free - reserve_gb * 1024) // MEM_PER_JOB_MB)
    if mem_slots < 1:
        return {
            "size": 0,
            "stop": False,
            "performance": ctrl["performance"],
            "cap": cap,
            "reserve_gb": reserve_gb,
            "detail": f"可用内存 {free // 1024} GB，留给系统 {reserve_gb} GB 后暂缓新任务",
        }
    size = max(1, min(cap, mem_slots))
    if ctrl["performance"] == "auto":
        detail = "自动：" + "，".join(reasons) + f"，本波 {size} 路 · 可用内存 {free // 1024} GB"
    else:
        detail = (
            f"{profile['label']} · 最多 {cap} 路 · 本波 {size} 路 · "
            f"可用内存 {free // 1024} GB · 留给系统 {reserve_gb} GB"
        )
    return {
        "size": size,
        "stop": False,
        "performance": ctrl["performance"],
        "cap": cap,
        "reserve_gb": reserve_gb,
        "detail": detail,
    }
