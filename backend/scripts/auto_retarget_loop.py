"""Keep retargeting human motions onto every holosoma robot style.

For each data unit that has human motion and is missing one or more robot styles,
pick a source file (skeleton before merged, then fbx, bvh, smpl) and run
holosoma_retargeting's batch_retarget_to_csv.process_one. Outputs are headerless
30 Hz CSVs under data/robot/<style>/motion/csv/<batch>/...

Run on the host with the holosoma virtualenv:

    /media/noetix/my_passport1/noetix_robot_data_hub/.venv-retarget/bin/python \
        backend/scripts/auto_retarget_loop.py
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

HUB = Path("/media/noetix/my_passport1/noetix_robot_data_hub/data/hub_repo")
PKG = Path(
    "/home/noetix/Desktop/new_home/learning_based/wbc/open_src/omni_retarget/"
    "holosoma/src/holosoma_retargeting"
)
BACKEND = Path("/media/noetix/my_passport1/noetix_robot_data_hub/backend")
STATE_PATH = HUB / "index" / "auto_retarget_state.json"
LOG_PATH = HUB / "index" / "auto_retarget.log"

sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(PKG))
sys.path.insert(0, str(PKG / "holosoma_retargeting" / "data_utils"))

from app.services.retarget_select import (  # noqa: E402
    choose_human_source,
    human_height_m,
    missing_robot_styles,
    motion_kind,
    output_stem,
)
from app.services.unit_names import normalize_unit_stem  # noqa: E402

STYLES = [
    "unitree_g1",
    "noetix_e2",
]
# Each retarget uses about one core and 1–2 GB. Leave room for other jobs on this machine.
WORKERS = max(1, int(os.environ.get("AUTO_RETARGET_WORKERS", "4")))
# These taxonomy names, and every node under them, run only after other batches.
LOW_PRIORITY_NAMES = ("开源数据", "其他数据集")
# Resume full speed only after the seat has been idle this long.
IDLE_RESUME_MS = 90_000
# Do not start a new wave below this much free RAM.
MEM_PAUSE_MB = 8 * 1024


def log(message: str) -> None:
    line = f"{datetime.now(timezone.utc).isoformat()} {message}"
    print(line, flush=True)
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def load_state() -> dict:
    if not STATE_PATH.is_file():
        return {"failures": {}}
    try:
        return json.loads(STATE_PATH.read_text())
    except json.JSONDecodeError:
        return {"failures": {}}


def save_state(state: dict) -> None:
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def unit_name_for(sub_path: str, stem: str) -> str:
    raw = f"{sub_path}_{stem}" if sub_path else stem
    return normalize_unit_stem(raw.replace("/", "_")) or raw.replace("/", "_")


def iter_motion_files() -> list[dict]:
    records = []
    human_root = HUB / "data" / "human" / "motion"
    if human_root.is_dir():
        for fmt_dir in human_root.iterdir():
            if not fmt_dir.is_dir():
                continue
            for path in fmt_dir.rglob("*"):
                if not path.is_file() or path.name.startswith("."):
                    continue
                rel = path.relative_to(fmt_dir)
                if len(rel.parts) < 2:
                    continue
                batch = rel.parts[0]
                sub = "/".join(rel.parts[1:-1])
                records.append(
                    {
                        "ontology": "human",
                        "modality": "motion",
                        "format": path.suffix.lstrip(".").lower(),
                        "name": path.name,
                        "batch": batch,
                        "sub_path": sub,
                        "path": path.relative_to(HUB).as_posix(),
                        "abs": path,
                        "unit": unit_name_for(sub, path.stem),
                    }
                )
    robot_root = HUB / "data" / "robot"
    if robot_root.is_dir():
        for style_dir in robot_root.iterdir():
            motion = style_dir / "motion"
            if not motion.is_dir():
                continue
            for path in motion.rglob("*.csv"):
                rel = path.relative_to(motion)
                # motion/<fmt>/<batch>/...
                if len(rel.parts) < 3:
                    continue
                fmt, batch = rel.parts[0], rel.parts[1]
                sub = "/".join(rel.parts[2:-1])
                records.append(
                    {
                        "ontology": "robot",
                        "modality": "motion",
                        "format": "csv",
                        "name": path.name,
                        "batch": batch,
                        "sub_path": sub,
                        "robot_style": style_dir.name,
                        "path": path.relative_to(HUB).as_posix(),
                        "unit": unit_name_for(sub, path.stem),
                    }
                )
    return records


def attach_annotations(records: list[dict]) -> None:
    meta_path = HUB / "index" / "repository.json"
    if not meta_path.is_file():
        return
    data = json.loads(meta_path.read_text())
    files = data.get("files") or {}
    units = data.get("units") or {}
    for record in records:
        row = files.get(record["path"]) or {}
        record["annotation"] = dict(row.get("annotation") or {})
        unit_row = units.get(f"{record['batch']}::{record['unit']}") or {}
        unit_ann = dict(unit_row.get("annotation") or {})
        if not record["annotation"].get("motion_kind") and unit_ann.get("motion_kind"):
            record["annotation"]["motion_kind"] = unit_ann["motion_kind"]
        if unit_ann.get("height") and not record["annotation"].get("height"):
            record["annotation"]["height"] = unit_ann["height"]


def group_units(records: list[dict]) -> dict[tuple[str, str], list[dict]]:
    grouped: dict[tuple[str, str], list[dict]] = {}
    for record in records:
        grouped.setdefault((record["batch"], record["unit"]), []).append(record)
    return grouped


def low_priority_node_ids() -> set[int]:
    """Node ids for 开源数据 / 其他数据集, including children such as AMASS."""
    import subprocess

    sql = """
    WITH RECURSIVE tree AS (
      SELECT id FROM taxonomy_nodes WHERE name IN ('开源数据', '其他数据集')
      UNION ALL
      SELECT n.id FROM taxonomy_nodes n JOIN tree t ON n.parent_id = t.id
    )
    SELECT id FROM tree;
    """
    try:
        proc = subprocess.run(
            ["docker", "exec", "noetix_robot_data_hub-db-1", "psql", "-U", "motion", "-d", "motion", "-tA", "-c", sql],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return set()
    ids = set()
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if line.isdigit():
            ids.add(int(line))
    return ids


def batch_tag_ids() -> dict[str, set[int]]:
    meta_path = HUB / "index" / "repository.json"
    if not meta_path.is_file():
        return {}
    data = json.loads(meta_path.read_text())
    out: dict[str, set[int]] = {}
    for name, row in (data.get("batches") or {}).items():
        tags = (row or {}).get("taxonomy_tag_ids") or {}
        ids = set()
        for value in tags.values():
            try:
                ids.add(int(value))
            except (TypeError, ValueError):
                continue
        out[str(name)] = ids
    return out


def sort_jobs(jobs: list[dict], grouped: dict[tuple[str, str], list[dict]]) -> list[dict]:
    """Small batches first. 开源数据 and 其他数据集 stay behind everything else."""
    low_ids = low_priority_node_ids()
    tags = batch_tag_ids()
    counts: dict[str, int] = {}
    for (batch, _unit), files in grouped.items():
        if choose_human_source(files) is None:
            continue
        counts[batch] = counts.get(batch, 0) + 1

    def key(job: dict) -> tuple:
        batch = job["batch"]
        low = 1 if low_ids and (tags.get(batch) or set()) & low_ids else 0
        style_order = STYLES.index(job["style"]) if job["style"] in STYLES else len(STYLES)
        return (low, counts.get(batch, 10**9), batch, job["unit"], style_order)

    jobs.sort(key=key)
    return jobs


def user_idle_ms() -> int | None:
    """Milliseconds since the last keyboard or pointer event. None if unknown."""
    import subprocess

    try:
        proc = subprocess.run(
            [
                "gdbus", "call", "--session",
                "--dest", "org.gnome.Mutter.IdleMonitor",
                "--object-path", "/org/gnome/Mutter/IdleMonitor/Core",
                "--method", "org.gnome.Mutter.IdleMonitor.GetIdletime",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    text = (proc.stdout or "").strip()
    digits = "".join(ch for ch in text if ch.isdigit())
    if not digits:
        return None
    return int(digits)


def mem_available_mb() -> int:
    avail = 0
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            avail = int(line.split()[1]) // 1024
            break
    return avail


def yield_reason() -> str | None:
    """Why the next wave should wait. Current jobs are left to finish."""
    idle = user_idle_ms()
    if idle is not None and idle < IDLE_RESUME_MS:
        return f"正在使用电脑（空闲 {idle / 1000:.0f} 秒）"
    free = mem_available_mb()
    if free < MEM_PAUSE_MB:
        return f"可用内存仅 {free} MB"
    return None


def wait_until_host_free() -> None:
    announced = False
    while True:
        reason = yield_reason()
        if reason is None:
            return
        if not announced:
            log(f"暂停新任务，把 CPU 和内存让出来：{reason}")
            announced = True
        time.sleep(15)


def collect_jobs(grouped: dict[tuple[str, str], list[dict]], state: dict) -> list[dict]:
    failures = state.get("failures") or {}
    now = time.time()
    jobs = []
    for (batch, unit), files in grouped.items():
        source = choose_human_source(files)
        if source is None:
            continue
        source = dict(source)
        source["abs"] = str(source.get("abs") or "")
        for style in missing_robot_styles(files, STYLES):
            key = f"{batch}::{unit}::{style}::{source['path']}"
            until = float(failures.get(key) or 0)
            if until > now:
                continue
            stem = output_stem(source["name"])
            sub = source.get("sub_path") or ""
            dest = HUB / "data" / "robot" / style / "motion" / "csv" / batch
            if sub:
                dest = dest / sub
            dest = dest / f"{stem}.csv"
            if dest.is_file() and dest.stat().st_size > 0:
                continue
            jobs.append(
                {
                    "batch": batch,
                    "unit": unit,
                    "style": style,
                    "source": source,
                    "dest": str(dest),
                    "failure_key": key,
                    "kind": motion_kind(source.get("annotation")),
                    "height": human_height_m(source.get("annotation")),
                }
            )
    return jobs


def remember_files(rows: list[tuple[str, dict]]) -> None:
    if not rows:
        return
    meta_path = HUB / "index" / "repository.json"
    data = json.loads(meta_path.read_text())
    now = datetime.now(timezone.utc).isoformat()
    for rel, annotation in rows:
        row = data.setdefault("files", {}).setdefault(rel, {})
        ann = dict(row.get("annotation") or {})
        ann.update(annotation)
        row["annotation"] = ann
        row["updated_at"] = now
        target = HUB / rel
        if not target.is_file():
            continue
        media = data.setdefault("file_media", {}).setdefault(rel, {})
        media["fps"] = 30
        media["size"] = target.stat().st_size
        media["mtime"] = int(target.stat().st_mtime)
    data["version"] = int(data.get("version") or 1) + 1
    tmp = meta_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(meta_path)


def _shared_height(source: Path, skeletons: list, annotation_height: float | None) -> float | None:
    """Match batch_retarget_to_csv: multi-skeleton FBX shares one estimated height.

    A height stored on the data unit overrides that estimate.
    """
    if annotation_height is not None:
        return annotation_height
    if len(skeletons) <= 1 or source.suffix.lower() != ".fbx":
        return None
    try:
        import numpy as np
        from prep_fbx_for_rt import estimate_skeleton_heights

        heights = estimate_skeleton_heights(source)
    except Exception:
        return None
    if not heights:
        return None
    return float(np.mean(list(heights.values())))


_JOINTS: dict[str, list[str]] = {}


def _joint_names(style: str) -> list[str]:
    cached = _JOINTS.get(style)
    if cached is not None:
        return cached
    from retarget_to_csv import mjcf_joint_names

    names = mjcf_joint_names(style)
    _JOINTS[style] = names
    return names


def retarget(job: dict) -> list[Path]:
    from batch_retarget_to_csv import process_one
    from retarget_to_csv import list_input_skeletons

    source = Path(job["source"]["abs"])
    skeletons = list_input_skeletons(source) or [None]
    joint_names = _joint_names(job["style"])
    dest = Path(job["dest"])
    dest.parent.mkdir(parents=True, exist_ok=True)
    height = _shared_height(source, skeletons, job["height"])
    multi = len(skeletons) > 1
    written: list[Path] = []
    # Canonical CSV is written last. Until it exists the unit still looks unfinished,
    # so a crash mid-way is retried and already-written skeleton files are skipped.
    for index, skeleton in enumerate(skeletons):
        last = index == len(skeletons) - 1
        if last or not skeleton:
            target = dest
        else:
            target = dest.with_name(f"{output_stem(source.name, skeleton)}.csv")
        if target.is_file() and target.stat().st_size > 0:
            written.append(target)
            continue
        process_one(
            source,
            target,
            job["style"],
            joint_names,
            skeleton=skeleton,
            preserve_world=multi,
            human_height=height,
            quiet=True,
        )
        written.append(target)
    return written


def _worker(job: dict) -> tuple[str, list[str] | None, str | None]:
    try:
        written = [str(path) for path in retarget(job)]
        return job["failure_key"], written, None
    except Exception as exc:
        return job["failure_key"], None, f"{exc}\n{traceback.format_exc().splitlines()[-1]}"


def rebuild_catalog() -> None:
    import subprocess

    subprocess.run(
        [
            "docker",
            "exec",
            "noetix_robot_data_hub-api-1",
            "python",
            "-c",
            "from app.services.disk_repository import rebuild_catalog; rebuild_catalog()",
        ],
        check=False,
        stdout=subprocess.DEVNULL,
    )


def _record_wave(jobs: list[dict], results: list[tuple[str, list[str] | None, str | None]]) -> int:
    state = load_state()
    failures = state.setdefault("failures", {})
    rows: list[tuple[str, dict]] = []
    done = 0
    for job, (key, written, error) in zip(jobs, results):
        if error:
            failures[key] = time.time() + 30 * 60
            log(f"失败 {key}: {error}")
            continue
        failures.pop(key, None)
        state["last_ok"] = key
        note = f"由 {job['source']['name']} 自动重定向"
        for path_str in written or []:
            path = Path(path_str)
            if not path.is_file():
                continue
            rows.append(
                (
                    path.relative_to(HUB).as_posix(),
                    {
                        "robot_style": job["style"],
                        "motion_kind": job["kind"],
                        "fps": 30,
                        "note": note,
                    },
                )
            )
        done += 1
        log(f"完成 {Path(job['dest']).relative_to(HUB).as_posix()}")
    save_state(state)
    remember_files(rows)
    return done


def main() -> None:
    try:
        os.nice(15)
    except OSError:
        pass
    import subprocess

    subprocess.run(["ionice", "-c", "3", "-p", str(os.getpid())], check=False)
    log(f"自动重定向已启动，并行 {WORKERS} 路；小批次优先，开源数据和其他数据集最后")
    pool = ProcessPoolExecutor(max_workers=WORKERS)
    since_catalog = 0
    try:
        while True:
            try:
                log("正在扫描待重定向的数据")
                records = iter_motion_files()
                attach_annotations(records)
                grouped = group_units(records)
                jobs = sort_jobs(collect_jobs(grouped, load_state()), grouped)
                if not jobs:
                    if since_catalog:
                        rebuild_catalog()
                        since_catalog = 0
                    log("没有待重定向的数据单元，60 秒后再检查")
                    time.sleep(60)
                    continue
                log(f"本轮 {len(jobs)} 条，先做 {jobs[0]['batch']}，{WORKERS} 路并行")
                for offset in range(0, len(jobs), WORKERS):
                    wait_until_host_free()
                    wave = jobs[offset : offset + WORKERS]
                    for job in wave:
                        log(
                            f"重定向 {job['batch']} / {job['unit']} -> {job['style']} "
                            f"来源 {job['source']['name']}"
                        )
                    results = list(pool.map(_worker, wave))
                    since_catalog += _record_wave(wave, results)
                    if since_catalog >= 40:
                        rebuild_catalog()
                        since_catalog = 0
            except KeyboardInterrupt:
                log("已停止")
                return
            except Exception as exc:
                state = load_state()
                state.setdefault("failures", {})["loop"] = time.time() + 30 * 60
                save_state(state)
                log(f"失败 loop: {exc}\n{traceback.format_exc().splitlines()[-1]}")
                time.sleep(5)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    main()
