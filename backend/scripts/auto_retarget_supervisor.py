"""Start the auto-retarget loop when the web control file asks for it.

This process stays small and outside the retarget memory limit. If the heavy
loop is stopped from the page, it is left stopped. If the page asks it to run
and the loop has exited, this starts it again.
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HUB = ROOT / "data" / "hub_repo"
BACKEND = ROOT / "backend"
PYTHON = ROOT / ".venv-retarget" / "bin" / "python"
LOOP = BACKEND / "scripts" / "auto_retarget_loop.py"
UNIT = "hub-auto-retarget.service"

sys.path.insert(0, str(BACKEND))

from app.services.retarget_control import load_control  # noqa: E402


def _run(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=False, text=True, capture_output=True)


def loop_is_active() -> bool:
    result = _run(["systemctl", "--user", "is-active", UNIT])
    return result.stdout.strip() == "active"


def start_loop() -> bool:
    restarted = _run(["systemctl", "--user", "restart", UNIT])
    if restarted.returncode == 0:
        return True
    created = _run(
        [
            "systemd-run",
            "--user",
            f"--unit={UNIT.removesuffix('.service')}",
            f"--working-directory={ROOT}",
            "-p",
            "MemoryMax=56G",
            "-p",
            "CPUQuota=800%",
            str(PYTHON),
            "-u",
            str(LOOP),
        ]
    )
    if created.returncode != 0:
        print(created.stderr.strip() or created.stdout.strip(), flush=True)
    return created.returncode == 0


def main() -> None:
    fail_streak = 0
    not_before = 0.0
    while True:
        try:
            desired = load_control(HUB)["desired"]
        except Exception as exc:
            print(f"读取控制文件失败: {exc}", flush=True)
            time.sleep(5)
            continue
        active = loop_is_active()
        now = time.time()
        if desired == "running" and not active:
            if now < not_before:
                time.sleep(5)
                continue
            if start_loop():
                fail_streak = 0
                not_before = now + 20
                print("已启动自动重定向", flush=True)
            else:
                fail_streak += 1
                not_before = now + min(120, 10 * fail_streak)
                print(f"启动失败，{int(not_before - now)} 秒后再试", flush=True)
        elif active:
            fail_streak = 0
        time.sleep(5)


if __name__ == "__main__":
    main()
