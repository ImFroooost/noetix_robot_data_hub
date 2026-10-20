"""Keep retargeting human motions onto every holosoma robot style.

For each data unit that has human motion and is missing one or more robot styles,
pick a source file (skeleton before merged, then fbx, bvh, smpl) and run
holosoma_retargeting's data_utils/batch_retarget_to_csv.py in a fresh process
(same flags as the official batch command). Outputs are headerless
30 Hz CSVs under data/robot/<style>/motion/csv/<batch>/...

Run on the host with the holosoma virtualenv:

    /media/noetix/my_passport1/noetix_robot_data_hub/.venv-retarget/bin/python \
        backend/scripts/auto_retarget_loop.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
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
STATUS_PATH = HUB / "index" / "auto_retarget_status.json"
_status_lock = threading.Lock()
_status: dict = {}

sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(PKG))
sys.path.insert(0, str(PKG / "holosoma_retargeting" / "data_utils"))

from app.services.retarget_priority import (  # noqa: E402
    ROBOTS,
    UNLISTED,
    config_path,
    describe_rule,
    job_queue,
    load_config,
    load_pins,
    pin_index,
    pins_path,
)
from app.services.retarget_select import (  # noqa: E402
    choose_human_source,
    human_height_m,
    motion_kind,
    output_stem,
)
from app.services.unit_names import normalize_unit_stem  # noqa: E402

STYLES = list(ROBOTS)
# Interpreter that can run data_utils/batch_retarget_to_csv.py. A fresh process
# each job so a long-lived worker cannot keep an old copy of the solver.
RETARGET_PYTHON = Path(
    os.environ.get(
        "HOLOSOMA_PYTHON",
        "/home/noetix/.holosoma_deps/miniconda3/envs/hsretargeting/bin/python",
    )
)
INNER = PKG / "holosoma_retargeting"
RETARGET_METHOD = "batch_retarget_to_csv"
# CSVs written by the in-process loop on this day used a stale solver and are redone.
REDO_AFTER = datetime(2026, 9, 24).timestamp()
# Eight one-thread jobs. A 26-way wave filled swap and the desktop OOM killer
# stopped Cursor and Chrome, so the ceiling stays well under the 32 cores.
WORKERS = max(1, int(os.environ.get("AUTO_RETARGET_WORKERS", "8")))
RESERVED_CPUS = max(1, (os.cpu_count() or 8) - WORKERS)
# These taxonomy names, and every node under them, run only after other batches.
LOW_PRIORITY_NAMES = ("开源数据", "其他数据集")
# A full 8-wide wave previously took about 6.5 minutes. Used until this process
# finishes a wave and replaces it with a measured pace.
SEED_SECONDS_PER_JOB = 390 / 8
_pace = {"seconds_per_job": SEED_SECONDS_PER_JOB, "measured": False}
# Below this free RAM a new job is likely to be killed, so wait instead of starting one.
MEM_FLOOR_MB = 16 * 1024
# Keep this much RAM aside for the desktop, then one slot per 3 GB.
MEM_RESERVE_MB = 32 * 1024
MEM_PER_JOB_MB = 3 * 1024


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dump_status_locked() -> None:
    STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(_status, ensure_ascii=False)
    tmp = STATUS_PATH.with_suffix(".json.tmp")
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(STATUS_PATH)


def publish_status(**fields: object) -> None:
    with _status_lock:
        _status.update(fields)
        _status["updated_at"] = _now()
        _dump_status_locked()


def _status_heartbeat() -> None:
    while True:
        time.sleep(10)
        with _status_lock:
            if not _status:
                continue
            _status["updated_at"] = _now()
            try:
                _dump_status_locked()
            except OSError:
                pass


def _fill_eta(queues: list[dict]) -> None:
    pace = float(_pace["seconds_per_job"] or 0)
    ahead = 0
    for row in queues:
        remaining = max(0, int(row["total"]) - int(row["done"]) - int(row["failed"]))
        row["remaining"] = remaining
        if pace > 0:
            row["eta_seconds"] = int(remaining * pace)
            row["eta_after_seconds"] = int((ahead + remaining) * pace)
        else:
            row["eta_seconds"] = None
            row["eta_after_seconds"] = None
        ahead += remaining


def fresh_queues(jobs: list[dict], rules: list[dict]) -> list[dict]:
    seen_robots: set[str] = set()
    rows = []
    pinned = [job for job in jobs if job.get("queue") == "pinned"]
    if pinned:
        parts: list[str] = []
        seen: list[str] = []
        for job in pinned:
            label = str(job.get("batch") or "")
            if label and label not in seen:
                seen.append(label)
            if len(seen) >= 6:
                break
        title = "、".join(seen) if seen else "数据管理里指定的批次或单元"
        if len({job.get("batch") for job in pinned}) > len(seen):
            title += " 等"
        rows.append(
            {
                "key": "pinned",
                "rule_id": "pinned",
                "rank": "优先",
                "title": title,
                "total": len(pinned),
                "done": 0,
                "failed": 0,
                "active": False,
            }
        )
    for index, rule in enumerate(rules):
        rows.append(
            {
                "key": rule["id"],
                "rule_id": rule["id"],
                "rank": str(index + 1),
                "title": describe_rule(rule, seen_robots),
                "total": 0,
                "done": 0,
                "failed": 0,
                "active": False,
            }
        )
        seen_robots.update(rule.get("robots") or [])
    by_key = {row["key"]: row for row in rows}
    other = 0
    for job in jobs:
        row = by_key.get(job.get("queue") or "")
        if row is None:
            other += 1
        else:
            row["total"] += 1
    if other:
        rows.append(
            {
                "key": UNLISTED,
                "rule_id": UNLISTED,
                "rank": str(len(rows) + 1),
                "title": "还没有写进规则的机器人，排在最后",
                "total": other,
                "done": 0,
                "failed": 0,
                "active": False,
            }
        )
    _fill_eta(rows)
    return rows


def _priority_mtime() -> float:
    stamps = []
    for path in (config_path(HUB), pins_path(HUB)):
        try:
            stamps.append(path.stat().st_mtime)
        except OSError:
            continue
    return max(stamps) if stamps else 0.0


def _load_pace() -> None:
    if not STATUS_PATH.is_file():
        return
    try:
        data = json.loads(STATUS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    value = data.get("seconds_per_job")
    if data.get("pace_measured") and isinstance(value, (int, float)) and float(value) > 0:
        _pace["seconds_per_job"] = float(value)
        _pace["measured"] = True


def _observe_pace(elapsed: float, count: int) -> None:
    if count < 1 or elapsed <= 0:
        return
    sample = elapsed / count
    if _pace["measured"]:
        _pace["seconds_per_job"] = float(_pace["seconds_per_job"]) * 0.6 + sample * 0.4
    else:
        _pace["seconds_per_job"] = sample
    _pace["measured"] = True


def _pace_fields() -> dict:
    return {
        "seconds_per_job": round(float(_pace["seconds_per_job"]), 2),
        "pace_measured": bool(_pace["measured"]),
    }


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
        record["tag_ids"] = _tag_ids(row.get("taxonomy_tag_ids")) | _tag_ids(
            unit_row.get("taxonomy_tag_ids")
        )


def group_units(records: list[dict]) -> dict[tuple[str, str], list[dict]]:
    grouped: dict[tuple[str, str], list[dict]] = {}
    for record in records:
        grouped.setdefault((record["batch"], record["unit"]), []).append(record)
    return grouped


def _tag_ids(raw) -> set[int]:
    ids: set[int] = set()
    if isinstance(raw, dict):
        values = list(raw.values())
    elif isinstance(raw, (list, tuple, set)):
        values = list(raw)
    else:
        values = [raw]
    for value in values:
        if isinstance(value, (dict, list, tuple, set)):
            ids |= _tag_ids(value)
            continue
        try:
            ids.add(int(value))
        except (TypeError, ValueError):
            continue
    return ids


def _taxonomy_ids(sql: str) -> set[int]:
    import subprocess

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


def low_priority_node_ids() -> set[int]:
    """Node ids for 开源数据 / 其他数据集, including children such as AMASS."""
    names = ", ".join(f"'{name}'" for name in LOW_PRIORITY_NAMES)
    return _taxonomy_ids(
        f"""
        WITH RECURSIVE tree AS (
          SELECT id FROM taxonomy_nodes WHERE name IN ({names})
          UNION ALL
          SELECT n.id FROM taxonomy_nodes n JOIN tree t ON n.parent_id = t.id
        )
        SELECT id FROM tree;
        """
    )


def _sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def taxonomy_name_groups(scheme: str, names: list[str]) -> list[set[int]]:
    """Tag ids for each name, in the given order, including that node's children."""
    groups = [set() for _ in names]
    if not scheme or not names:
        return groups
    listed = ", ".join(_sql_quote(name) for name in names)
    sql = f"""
        WITH RECURSIVE tree AS (
          SELECT id, name AS root_name FROM taxonomy_nodes
          WHERE scheme = {_sql_quote(scheme)} AND name IN ({listed})
          UNION ALL
          SELECT n.id, t.root_name FROM taxonomy_nodes n JOIN tree t ON n.parent_id = t.id
        )
        SELECT root_name || '|' || id::text FROM tree;
        """
    import subprocess

    try:
        proc = subprocess.run(
            ["docker", "exec", "noetix_robot_data_hub-db-1", "psql", "-U", "motion", "-d", "motion", "-tA", "-c", sql],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return groups
    index = {name: pos for pos, name in enumerate(names)}
    for line in (proc.stdout or "").splitlines():
        root, _, raw_id = line.strip().partition("|")
        pos = index.get(root)
        if pos is None or not raw_id.isdigit():
            continue
        groups[pos].add(int(raw_id))
    return groups


def taxonomy_tree_ids(scheme: str, names: list[str]) -> set[int]:
    """Node ids for these names in one scheme, including every child."""
    ids: set[int] = set()
    for group in taxonomy_name_groups(scheme, names):
        ids |= group
    return ids


def _priority_picks(rule: dict, pick_key: str, name_key: str) -> list[dict]:
    raw = rule.get(pick_key)
    picks: list[dict] = []
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            scheme = str(item.get("scheme") or "").strip()
            name = str(item.get("name") or "").strip()
            if scheme and name:
                picks.append({"scheme": scheme, "name": name})
    if picks:
        return picks
    scheme = str(rule.get("scheme") or "").strip()
    return [
        {"scheme": scheme, "name": str(name)}
        for name in (rule.get(name_key) or [])
        if scheme and str(name).strip()
    ]


def prepare_rules() -> tuple[list[tuple], list[dict], float]:
    """Enabled rules plus the tag sets a taxonomy rule matches."""
    config = load_config(HUB)
    compiled: list[tuple[dict, set[int], set[int], list[set[int]]]] = []
    enabled: list[dict] = []
    for rule in config["rules"]:
        if not rule.get("enabled"):
            continue
        if rule.get("data_mode") == "taxonomy":
            include_picks = _priority_picks(rule, "include_picks", "include_names")
            exclude_picks = _priority_picks(rule, "exclude_picks", "exclude_names")
            names_by_scheme: dict[str, list[str]] = {}
            for pick in include_picks:
                bucket = names_by_scheme.setdefault(pick["scheme"], [])
                if pick["name"] not in bucket:
                    bucket.append(pick["name"])
            resolved = {
                scheme: taxonomy_name_groups(scheme, names)
                for scheme, names in names_by_scheme.items()
            }
            include_groups = []
            for pick in include_picks:
                names = names_by_scheme.get(pick["scheme"]) or []
                groups = resolved.get(pick["scheme"]) or []
                include_groups.append(groups[names.index(pick["name"])] if pick["name"] in names else set())
            include_ids = set()
            scope_sets: list[set[int]] = []
            for scheme, groups in resolved.items():
                union: set[int] = set()
                for group in groups:
                    union |= group
                include_ids |= union
                scope_sets.append(union)
            exclude_ids: set[int] = set()
            excluded: dict[str, list[str]] = {}
            for pick in exclude_picks:
                bucket = excluded.setdefault(pick["scheme"], [])
                if pick["name"] not in bucket:
                    bucket.append(pick["name"])
            for scheme, names in excluded.items():
                exclude_ids |= taxonomy_tree_ids(scheme, names)
            if include_picks and not include_ids:
                log(f"规则没有解析到分类节点：{describe_rule(rule)}")
        else:
            include_ids = set()
            exclude_ids = set()
            include_groups = []
            scope_sets = []
        compiled.append((rule, include_ids, exclude_ids, include_groups, scope_sets))
        enabled.append(rule)
    return compiled, enabled, _priority_mtime()


def batch_tag_ids() -> dict[str, set[int]]:
    meta_path = HUB / "index" / "repository.json"
    if not meta_path.is_file():
        return {}
    data = json.loads(meta_path.read_text())
    out: dict[str, set[int]] = {}
    for name, row in (data.get("batches") or {}).items():
        out[str(name)] = _tag_ids((row or {}).get("taxonomy_tag_ids"))
    return out


def sort_jobs(
    jobs: list[dict],
    grouped: dict[tuple[str, str], list[dict]],
    compiled: list[tuple[dict, set[int], set[int], list[set[int]]]],
) -> list[dict]:
    """First matching rule, then click order of robots and categories."""
    low_ids = low_priority_node_ids()
    tags = batch_tag_ids()
    counts: dict[str, int] = {}
    for (batch, _unit), files in grouped.items():
        if choose_human_source(files) is None:
            continue
        counts[batch] = counts.get(batch, 0) + 1
    pins = load_pins(HUB)
    order = {rule["id"]: index for index, (rule, *_rest) in enumerate(compiled)}
    order[UNLISTED] = len(compiled)
    grouped_rules = {
        rule["id"]: (rule, include_groups)
        for rule, _include, _exclude, include_groups, _scopes in compiled
    }

    for job in jobs:
        if pin_index(pins, job["batch"], job["unit"]) is not None:
            job["queue"] = "pinned"
        else:
            job["queue"] = job_queue(job["style"], set(job.get("tag_ids") or ()), compiled)

    def selection_rank(job: dict) -> tuple[int, int]:
        found = grouped_rules.get(job["queue"])
        if found is None:
            return (10**6, 10**6)
        rule, include_groups = found
        robots = list(rule.get("robots") or [])
        robot_rank = robots.index(job["style"]) if job["style"] in robots else len(robots)
        if rule.get("data_mode") != "taxonomy" or not include_groups:
            return (robot_rank, 0)
        job_tags = set(job.get("tag_ids") or ())
        for index, group in enumerate(include_groups):
            if group and job_tags & group:
                return (robot_rank, index)
        return (robot_rank, len(include_groups))

    def key(job: dict) -> tuple:
        batch = job["batch"]
        low = 1 if low_ids and (tags.get(batch) or set()) & low_ids else 0
        robot_rank, category_rank = selection_rank(job)
        pinned = 0 if job.get("queue") == "pinned" else 1
        return (
            pinned,
            order.get(job["queue"], len(compiled)),
            robot_rank,
            category_rank,
            low,
            counts.get(batch, 10**9),
            batch,
            job["unit"],
        )

    jobs.sort(key=key)
    return jobs


def mem_available_mb() -> int:
    avail = 0
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            avail = int(line.split()[1]) // 1024
            break
    return avail


def choose_wave_size() -> tuple[int, str]:
    """Start as many jobs as memory allows, up to the reserved-CPU ceiling.

    CPU, disk and GPU load no longer shrink the wave. The ceiling itself leaves
    cores free, and a low memory pool waits instead of starting another job.
    """
    free = mem_available_mb()
    if free < MEM_FLOOR_MB:
        return 0, f"可用内存仅 {free} MB，暂缓新任务"
    mem_slots = max(1, (free - MEM_RESERVE_MB) // MEM_PER_JOB_MB)
    size = max(1, min(WORKERS, mem_slots))
    return size, f"可用内存 {free // 1024} GB · 保留 {RESERVED_CPUS} 核和 {MEM_RESERVE_MB // 1024} GB"


def _source_is_motion(source: dict) -> bool:
    """Shape files and GRAB stage-i captures have no pose sequence."""
    name = Path(str(source.get("name") or source.get("path") or "")).name.lower()
    if name == "shape.npz" or name.endswith("_stagei.npz"):
        return False
    return True


def collect_jobs(grouped: dict[tuple[str, str], list[dict]], state: dict) -> list[dict]:
    failures = state.get("failures") or {}
    pins = load_pins(HUB)
    now = time.time()
    jobs = []
    for (batch, unit), files in grouped.items():
        source = choose_human_source(files)
        if source is None or not _source_is_motion(source):
            continue
        source = dict(source)
        source["abs"] = str(source.get("abs") or "")
        tag_ids: set[int] = set()
        for item in files:
            tag_ids |= set(item.get("tag_ids") or ())
        tag_list = sorted(tag_ids)
        for style in STYLES:
            key = f"{batch}::{unit}::{style}::{source['path']}"
            until = float(failures.get(key) or 0)
            if until > now and pin_index(pins, batch, unit) is None:
                continue
            stem = output_stem(source["name"])
            sub = source.get("sub_path") or ""
            dest = HUB / "data" / "robot" / style / "motion" / "csv" / batch
            if sub:
                dest = dest / sub
            dest = dest / f"{stem}.csv"
            if not needs_official_retarget(dest, files, style):
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
                    "tag_ids": tag_list,
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


def needs_official_retarget(dest: Path, files: list[dict], style: str) -> bool:
    """True when this style still needs data_utils/batch_retarget_to_csv.py.

    Files written on 2026-09-24 by the long-lived in-process solver are redone.
    A later run stamps retarget_method and is kept, including a genuinely still clip.
    """
    if not dest.is_file() or dest.stat().st_size <= 0:
        return True
    rel = dest.relative_to(HUB).as_posix()
    for item in files:
        if item.get("robot_style") != style:
            continue
        if item.get("path") != rel:
            continue
        if (item.get("annotation") or {}).get("retarget_method") == RETARGET_METHOD:
            return False
    return dest.stat().st_mtime >= REDO_AFTER


def _solver_reason(log_path: Path) -> str:
    text = ""
    if log_path.is_file():
        text = log_path.read_text(encoding="utf-8", errors="replace")
    exception = ""
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("Traceback") or stripped.startswith("File "):
            continue
        if stripped.startswith("- "):
            continue
        if "Error:" in stripped or stripped.startswith("Skipping skeleton"):
            exception = stripped
    if exception:
        return exception
    lines = [line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith("- ")]
    return lines[-1] if lines else "重定向没有写出 csv"


def retarget(job: dict) -> list[Path]:
    """Run data_utils/batch_retarget_to_csv.py the same way as the official command.

    One source file is linked into a temporary input dir. ``--jobs`` matches the
    documented batch command; with a single file the script still uses one worker.
    The loop's own pool supplies the parallelism across files.
    """
    from retarget_to_csv import list_input_skeletons, output_csv_for_skeleton

    source = Path(job["source"]["abs"])
    skeletons = list_input_skeletons(source) or [None]
    dest = Path(job["dest"])
    dest.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["TMPDIR"] = "/tmp"
    for key in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        env[key] = "1"
    with tempfile.TemporaryDirectory(prefix="hub_retarget_", dir="/tmp") as raw:
        tmp = Path(raw)
        in_dir = tmp / "in"
        out_dir = tmp / "out"
        in_dir.mkdir()
        (in_dir / source.name).symlink_to(source)
        log_path = tmp / "run.log"
        cmd = [
            str(RETARGET_PYTHON),
            "-u",
            str(INNER / "data_utils" / "batch_retarget_to_csv.py"),
            "--robot",
            job["style"],
            "--input-dir",
            str(in_dir),
            "--output-dir",
            str(out_dir),
            "--jobs",
            "1",
            "--skip-existing",
        ]
        with log_path.open("w", encoding="utf-8") as handle:
            proc = subprocess.run(
                cmd,
                cwd=str(INNER),
                env=env,
                stdout=handle,
                stderr=subprocess.STDOUT,
                check=False,
            )
        base = out_dir / Path(source.name).with_suffix(".csv")
        written: list[Path] = []
        for index, skeleton in enumerate(skeletons):
            produced = output_csv_for_skeleton(base, skeleton)
            if proc.returncode != 0 or not produced.is_file():
                raise RuntimeError(_solver_reason(log_path))
            last = index == len(skeletons) - 1
            if last or not skeleton:
                target = dest
            else:
                target = dest.with_name(f"{output_stem(source.name, skeleton)}.csv")
            target.parent.mkdir(parents=True, exist_ok=True)
            staged = target.with_suffix(target.suffix + ".tmp")
            shutil.copyfile(produced, staged)
            staged.replace(target)
            written.append(target)
    return written


def _worker(job: dict) -> tuple[str, list[str] | None, str | None]:
    try:
        written = [str(path) for path in retarget(job)]
        return job["failure_key"], written, None
    except Exception as exc:
        reason = str(exc).strip().splitlines()[-1] if str(exc).strip() else "重定向失败"
        return job["failure_key"], None, reason


def index_new_files(paths: list[str]) -> None:
    import subprocess

    paths = [path for path in paths if path]
    if not paths:
        return
    subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            "noetix_robot_data_hub-api-1",
            "python",
            "-c",
            "import json,sys\n"
            "from app.services.disk_repository import refresh_catalog_paths\n"
            "refresh_catalog_paths(json.load(sys.stdin))\n",
        ],
        input=json.dumps(paths).encode(),
        check=False,
        stdout=subprocess.DEVNULL,
    )


def _record_wave(jobs: list[dict], results: list[tuple[str, list[str] | None, str | None]]) -> list[str]:
    state = load_state()
    failures = state.setdefault("failures", {})
    rows: list[tuple[str, dict]] = []
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
                        "retarget_method": RETARGET_METHOD,
                        "note": note,
                    },
                )
            )
        log(f"完成 {Path(job['dest']).relative_to(HUB).as_posix()}")
    save_state(state)
    remember_files(rows)
    return [rel for rel, _annotation in rows]


def _mark_active(queues: list[dict], current: list[dict]) -> None:
    active = current[0]["queue"] if current else ""
    if not active:
        for row in queues:
            if row["done"] + row["failed"] < row["total"]:
                active = row["key"]
                break
    for row in queues:
        row["active"] = row["key"] == active


def main() -> None:
    try:
        os.nice(10)
    except OSError:
        pass
    import subprocess

    subprocess.run(["ionice", "-c", "2", "-n", "4", "-p", str(os.getpid())], check=False)
    threading.Thread(target=_status_heartbeat, name="retarget-status", daemon=True).start()
    _load_pace()
    started_at = _now()
    publish_status(
        phase="scanning",
        running=True,
        started_at=started_at,
        priority_style="",
        styles=list(STYLES),
        workers=WORKERS,
        reserved_cpus=RESERVED_CPUS,
        mem_reserve_gb=MEM_RESERVE_MB // 1024,
        priority_note="优先级按页面上保存的规则执行：每条规则指定机器人和数据分类，排在上面的先做。",
        queues=[],
        current=[],
        recent=[],
        round_total=0,
        round_done=0,
        round_failed=0,
        round_running=0,
        round_started_at=None,
        message="正在扫描待重定向的数据",
        **_pace_fields(),
    )
    log(
        f"自动重定向已启动，最多 {WORKERS} 路，"
        f"保留 {RESERVED_CPUS} 核和 {MEM_RESERVE_MB // 1024} GB 内存"
    )
    pending_paths: list[str] = []
    recent: list[dict] = []
    while True:
        try:
            log("正在扫描待重定向的数据")
            publish_status(
                phase="scanning",
                running=True,
                current=[],
                round_running=0,
                message="正在扫描待重定向的数据",
                **_pace_fields(),
            )
            compiled, rules, priority_mtime = prepare_rules()
            records = iter_motion_files()
            attach_annotations(records)
            grouped = group_units(records)
            jobs = sort_jobs(collect_jobs(grouped, load_state()), grouped, compiled)
            if not jobs:
                if pending_paths:
                    index_new_files(pending_paths)
                    pending_paths = []
                log("没有待重定向的数据单元，60 秒后再检查")
                publish_status(
                    phase="idle",
                    running=True,
                    current=[],
                    round_running=0,
                    round_total=0,
                    round_done=0,
                    round_failed=0,
                    queues=fresh_queues([], rules),
                    message="没有待重定向的数据",
                    recent=recent,
                    **_pace_fields(),
                )
                time.sleep(60)
                continue
            queues = fresh_queues(jobs, rules)
            done = 0
            failed = 0
            round_started = _now()
            log(f"本轮 {len(jobs)} 条，先做 {describe_rule(rules[0], set()) if rules else '未列入规则'}，最多 {WORKERS} 路并行")

            def snapshot(phase: str, current: list[dict], message: str) -> None:
                _mark_active(queues, current)
                _fill_eta(queues)
                publish_status(
                    phase=phase,
                    running=True,
                    round_total=len(jobs),
                    round_done=done,
                    round_failed=failed,
                    round_running=len(current),
                    round_started_at=round_started,
                    queues=queues,
                    current=current,
                    recent=recent,
                    message=message,
                    **_pace_fields(),
                )

            cursor = 0
            announced_size = -1
            snapshot("running", [], f"本轮 {len(jobs)} 条")
            while cursor < len(jobs):
                if _priority_mtime() != priority_mtime:
                    log("优先级已调整，重新扫描")
                    snapshot("scanning", [], "优先级已调整，正在重新扫描")
                    break
                # Workers from the previous wave have already exited, so this
                # check sees memory that is actually free.
                size, detail = choose_wave_size()
                if size != announced_size:
                    if size < 1:
                        log(detail)
                    else:
                        log(f"本波 {size} 路 · {detail}")
                    announced_size = size
                if size < 1:
                    snapshot("waiting", [], detail)
                    time.sleep(15)
                    continue
                wave = jobs[cursor : cursor + size]
                cursor += len(wave)
                current = [
                    {
                        "batch": job["batch"],
                        "unit": job["unit"],
                        "style": job["style"],
                        "source": job["source"]["name"],
                        "queue": job.get("queue") or UNLISTED,
                    }
                    for job in wave
                ]
                for job in wave:
                    log(
                        f"重定向 {job['batch']} / {job['unit']} -> {job['style']} "
                        f"来源 {job['source']['name']}"
                    )
                snapshot("running", current, f"本波 {len(wave)} 路")
                # One process per job. It exits when the job finishes, which
                # returns the solver heap instead of leaving it in a pool worker.
                wave_started = time.monotonic()
                with ProcessPoolExecutor(max_workers=len(wave), max_tasks_per_child=1) as pool:
                    results = list(pool.map(_worker, wave))
                _observe_pace(time.monotonic() - wave_started, len(wave))
                notes: list[dict] = []
                for job, (_key, _written, error) in zip(wave, results):
                    row = next((item for item in queues if item["key"] == job.get("queue")), None)
                    note = {
                        "at": _now(),
                        "batch": job["batch"],
                        "unit": job["unit"],
                        "style": job["style"],
                        "status": "failed" if error else "done",
                        "error": (error or "").splitlines()[-1] if error else "",
                    }
                    if error:
                        failed += 1
                        if row is not None:
                            row["failed"] += 1
                    else:
                        done += 1
                        if row is not None:
                            row["done"] += 1
                    notes.append(note)
                recent[:] = (notes + recent)[:30]
                pending_paths.extend(_record_wave(wave, results))
                snapshot("running", [], f"本轮已处理 {done + failed} / {len(jobs)}")
                if len(pending_paths) >= 40:
                    index_new_files(pending_paths)
                    pending_paths = []
        except KeyboardInterrupt:
            publish_status(phase="stopped", running=False, current=[], round_running=0, message="已停止")
            log("已停止")
            return
        except Exception as exc:
            state = load_state()
            state.setdefault("failures", {})["loop"] = time.time() + 30 * 60
            save_state(state)
            message = traceback.format_exc().splitlines()[-1]
            publish_status(phase="error", running=True, current=[], round_running=0, message=message)
            log(f"失败 loop: {exc}\n{message}")
            time.sleep(5)


if __name__ == "__main__":
    main()
