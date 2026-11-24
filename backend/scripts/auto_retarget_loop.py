"""Keep retargeting human motions onto every holosoma robot style.

For each data unit that has human motion and is missing one or more robot styles,
pick a source file (merged before skeleton, then fbx, bvh, smpl) and run
holosoma_retargeting's data_utils/batch_retarget_to_csv.py in a fresh process
(same flags as the official batch command). Merged FBX keeps the capture
origin: Y-up becomes Z-up, then the human and the rigid bodies are scaled by
the same robot-height factor. Rigid bodies and markers are written as object
XML and CSV in that frame. The retargeted
robot and those objects are also written as one merged FBX, plus the
robot merged npz and the zip of skeleton CSV plus object CSV/XML. Robot skeleton
CSVs stay headerless 30 Hz under
data/robot/<style>/motion/omniretarget/skeleton/csv/<batch>/...

Run on the host with the holosoma virtualenv:

    /media/noetix/my_passport1/noetix_robot_data_hub/.venv-retarget/bin/python \
        backend/scripts/auto_retarget_loop.py
"""

from __future__ import annotations

import ast
import csv
import json
import os
import shutil
import xml.etree.ElementTree as ET
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import zipfile
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
# Rotated to auto_retarget.log.1 … .3 past this size.
LOG_MAX_BYTES = 200 * 1024 * 1024
STATUS_PATH = HUB / "index" / "auto_retarget_status.json"
_status_lock = threading.Lock()
_status: dict = {}

sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(PKG))
sys.path.insert(0, str(PKG / "holosoma_retargeting" / "data_utils"))

from app.services.file_lock import locked, rotate_if_large, write_text_atomic  # noqa: E402
from app.services.retarget_control import load_control, wave_plan  # noqa: E402
from app.services.retarget_priority import (  # noqa: E402
    FOLDER_SCHEME,
    UNLISTED,
    config_path,
    describe_rule,
    rule_rank_label,
    folder_constraints,
    batch_reserved_for,
    job_queue,
    load_config,
    load_pins,
    load_redo,
    migrate_pins_into_rules,
    pin_index,
    pins_path,
    redo_generation,
    robot_catalog,
    scheduled_robots,
    settle_redo,
    targets_match,
)
from app.services.retarget_select import (  # noqa: E402
    choose_human_source,
    choose_scene_source,
    human_height_m,
    output_stem,
)
from app.services.unit_names import (  # noqa: E402
    FILE_VERSION_DIR,
    ORIGINAL_FILE_VERSION,
    normalize_unit_stem,
    split_file_version,
)

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
# FBX SDK bindings in this tree are built for Python 3.7.
FBX_PYTHON = Path(
    os.environ.get(
        "FBX_PYTHON",
        "/home/noetix/miniforge3/pkgs/python-3.7.12-hf930737_100_cpython/bin/python3.7",
    )
)
FBX_PYTHONPATH = Path(
    os.environ.get(
        "FBX_PYTHONPATH",
        "/home/noetix/Desktop/new_home/softwares/fbx202021_fbxpythonsdk_linux/lib/Python37_x64",
    )
)
# CSVs written by the in-process loop on this day used a stale solver and are redone.
REDO_AFTER = datetime(2026, 9, 24).timestamp()
# Acquire-method directory inserted under robot/<style>/motion/.
_ACQUIRE_METHODS = frozenset({"omniretarget", "umr", "gmr", "frax"})
FRAX_ROOT = Path(
    os.environ.get(
        "FRAX_ROOT",
        "/media/noetix/samsung_9901/new_home_2/code/open_src/frax",
    )
)
FRAX_PYTHON = Path(
    os.environ.get("FRAX_PYTHON", str(FRAX_ROOT / ".venv" / "bin" / "python"))
)
# Outputs finished in this process. A priority rescan can happen before the
# next catalog pass attaches them to their data unit.
_finished_outputs: set[str] = set()
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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dump_status_locked() -> None:
    STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(_status, ensure_ascii=False)
    write_text_atomic(STATUS_PATH, payload)


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
            try:
                desired = load_control(HUB)["desired"]
                phase = _status.get("phase")
                if desired == "stopped" and phase != "stopped":
                    if phase != "stopping":
                        _status["resume_phase"] = phase
                        _status["resume_message"] = _status.get("message")
                    _status["phase"] = "stopping"
                    _status["message"] = "正在停止，当前这一波结束后停下"
                elif desired == "running" and phase == "stopping":
                    _status["phase"] = _status.pop("resume_phase", None) or "running"
                    _status["message"] = _status.pop("resume_message", None) or "正在重定向"
            except Exception:
                pass
            _status["updated_at"] = _now()
            try:
                _dump_status_locked()
            except OSError:
                pass


def _performance_fields(plan: dict | None = None) -> dict:
    if plan is None:
        stored = _pace.get("plan")
        plan = stored if isinstance(stored, dict) else wave_plan(HUB, last_wave=int(_pace.get("last_wave") or 0))
    return {
        "workers": int(plan["cap"] or plan["size"] or 0),
        "mem_reserve_gb": int(plan["reserve_gb"]),
        "performance": plan["performance"],
        "performance_note": plan["detail"],
        "desired": "stopped" if plan["stop"] else "running",
    }


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


def fresh_queues(
    jobs: list[dict],
    rules: list[dict],
    scope: dict[str, dict[str, int]] | None = None,
) -> list[dict]:
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
                "rank": rule_rank_label(rule, index),
                "title": describe_rule(rule, seen_robots, rules),
                "total": 0,
                "done": 0,
                "failed": 0,
                "active": False,
            }
        )
        seen_robots.update(rule.get("robots") or [])
    by_key = {row["key"]: row for row in rows}
    other = 0
    if scope is None:
        for job in jobs:
            row = by_key.get(job.get("queue") or "")
            if row is None:
                other += 1
            else:
                row["total"] += 1
    else:
        for key, counts in scope.items():
            if key == "pinned":
                continue
            row = by_key.get(key)
            if row is None and key == UNLISTED and int(counts.get("total") or 0) > 0:
                rows.append(
                    {
                        "key": UNLISTED,
                        "rule_id": UNLISTED,
                        "rank": str(len(rows) + 1),
                        "title": "还没有写进规则的机器人，排在最后",
                        "total": 0,
                        "done": 0,
                        "failed": 0,
                        "active": False,
                    }
                )
                row = rows[-1]
                by_key[key] = row
            if row is None:
                continue
            row["total"] = int(counts.get("total") or 0)
            row["done"] = int(counts.get("done") or 0)
        other = 0
    if other and not any(row["key"] == UNLISTED for row in rows):
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


def _redo_generation() -> int:
    try:
        return redo_generation(HUB)
    except OSError:
        return 0


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
    rotate_if_large(LOG_PATH, max_bytes=LOG_MAX_BYTES)
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


def robot_csv_batch(rel_parts: tuple[str, ...]) -> tuple[str, str, str] | None:
    """batch, sub_path and file_version for a file under robot/<style>/motion.

    Accepts ``omniretarget/skeleton/csv/<batch>/...`` and the older layouts
    that omit the motion kind or the acquire method.
    ``.file_versions/<name>/`` after the batch stays on the same unit.
    """
    if len(rel_parts) < 3:
        return None
    idx = 1 if rel_parts[0] in _ACQUIRE_METHODS else 0
    if idx < len(rel_parts) and rel_parts[idx] in {"skeleton", "object", "merged"}:
        idx += 1
    if len(rel_parts) < idx + 3 or rel_parts[idx] != "csv":
        return None
    batch = rel_parts[idx + 1]
    version, rest = split_file_version(rel_parts[idx + 2 :])
    if not rest:
        return None
    sub = "/".join(rest[:-1])
    return batch, sub, version


def iter_motion_files() -> list[dict]:
    records = []
    human_root = HUB / "data" / "human" / "motion"
    if human_root.is_dir():
        for kind_dir in human_root.iterdir():
            if not kind_dir.is_dir() or kind_dir.name not in {"skeleton", "object", "merged"}:
                continue
            for fmt_dir in kind_dir.iterdir():
                if not fmt_dir.is_dir():
                    continue
                for path in fmt_dir.rglob("*"):
                    if not path.is_file() or path.name.startswith("."):
                        continue
                    rel = path.relative_to(fmt_dir)
                    if len(rel.parts) < 2:
                        continue
                    batch = rel.parts[0]
                    version, rest = split_file_version(rel.parts[1:])
                    if not rest:
                        continue
                    sub = "/".join(rest[:-1])
                    records.append(
                        {
                            "ontology": "human",
                            "modality": "motion",
                            "format": path.suffix.lstrip(".").lower(),
                            "name": path.name,
                            "batch": batch,
                            "sub_path": sub,
                            "file_version": version,
                            "path": path.relative_to(HUB).as_posix(),
                            "abs": path,
                            "unit": unit_name_for(sub, path.stem),
                            "path_motion_kind": kind_dir.name,
                        }
                    )
    robot_root = HUB / "data" / "robot"
    if robot_root.is_dir():
        for style_dir in robot_root.iterdir():
            motion = style_dir / "motion"
            if not motion.is_dir():
                continue
            for path in motion.rglob("*.csv"):
                located = robot_csv_batch(path.relative_to(motion).parts)
                if located is None:
                    continue
                batch, sub, version = located
                records.append(
                    {
                        "ontology": "robot",
                        "modality": "motion",
                        "format": "csv",
                        "name": path.name,
                        "batch": batch,
                        "sub_path": sub,
                        "file_version": version,
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
    batch_orders: dict[str, dict[str, int]] = {}
    for batch_name, row in (data.get("batches") or {}).items():
        mapping = {ORIGINAL_FILE_VERSION: 0}
        for item in (row or {}).get("file_versions") or []:
            if isinstance(item, dict) and item.get("name"):
                mapping[str(item["name"])] = int(item.get("order") or 0)
        batch_orders[str(batch_name)] = mapping
    for record in records:
        version = str(record.get("file_version") or ORIGINAL_FILE_VERSION)
        record["file_version"] = version
        orders = batch_orders.get(str(record.get("batch") or ""), {ORIGINAL_FILE_VERSION: 0})
        if version in orders:
            record["file_version_order"] = orders[version]
        elif version == ORIGINAL_FILE_VERSION:
            record["file_version_order"] = 0
        else:
            record["file_version_order"] = 1 + max(orders.values(), default=0)
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
    migrate_pins_into_rules(HUB)
    config = load_config(HUB)
    compiled: list[tuple[dict, set[int], set[int], list[set[int]]]] = []
    enabled: list[dict] = []
    for rule in config["rules"]:
        if not rule.get("enabled"):
            continue
        if rule.get("data_mode") == "taxonomy":
            include_picks = [
                pick
                for pick in _priority_picks(rule, "include_picks", "include_names")
                if pick["scheme"] != FOLDER_SCHEME
            ]
            exclude_picks = [
                pick
                for pick in _priority_picks(rule, "exclude_picks", "exclude_names")
                if pick["scheme"] != FOLDER_SCHEME
            ]
            folder_include, folder_exclude = folder_constraints(rule)
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
            folder_include, folder_exclude = [], []
        compiled.append(
            (rule, include_ids, exclude_ids, include_groups, scope_sets, folder_include, folder_exclude)
        )
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
        for rule, _include, _exclude, include_groups, *_rest in compiled
    }

    for job in jobs:
        if pin_index(pins, job["batch"], job["unit"]) is not None:
            job["queue"] = "pinned"
        else:
            source = job.get("source") or {}
            job["queue"] = job_queue(
                job["style"],
                set(job.get("tag_ids") or ()),
                compiled,
                batch=job["batch"],
                unit=job["unit"],
                sub_path=str(source.get("sub_path") or ""),
            )

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
            0 if job.get("object_only") or job.get("merged_only") else 1,
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


def choose_wave_size() -> tuple[int, str]:
    """Follow the web performance setting, and pause when the page says stop."""
    plan = wave_plan(HUB, last_wave=int(_pace.get("last_wave") or 0))
    _pace["plan"] = plan
    if plan["size"] > 0:
        _pace["last_wave"] = plan["size"]
    return int(plan["size"]), str(plan["detail"])


def _stop_if_requested() -> bool:
    if load_control(HUB)["desired"] != "stopped":
        return False
    log("已按页面操作停止")
    publish_status(
        phase="stopped",
        running=False,
        current=[],
        round_running=0,
        message="已停止",
        **_performance_fields(),
    )
    return True


# Same pose widths batch_retarget_to_csv.py accepts: SMPL 72, SMPL-H 156, SMPL-X 165.
_AMASS_POSE_DIMS = frozenset({72, 156, 165})
_amass_npz_cache: dict[str, tuple[int, int, bool]] = {}
_last_skipped_npz = -1


def _npy_shape(prefix: bytes) -> tuple[int, ...] | None:
    """Read a ``.npy`` shape from its header without loading the array."""
    if len(prefix) < 10 or prefix[:6] != b"\x93NUMPY":
        return None
    major = prefix[6]
    if major == 1:
        header_len = struct.unpack_from("<H", prefix, 8)[0]
        start = 10
    elif major in (2, 3):
        if len(prefix) < 12:
            return None
        header_len = struct.unpack_from("<I", prefix, 8)[0]
        start = 12
    else:
        return None
    if len(prefix) < start + header_len:
        return None
    header = prefix[start : start + header_len].decode("latin1").strip()
    try:
        meta = ast.literal_eval(header)
        shape = tuple(int(item) for item in meta["shape"])
    except (SyntaxError, ValueError, KeyError, TypeError):
        return None
    return shape


def _npz_is_amass_smpl(path: Path) -> bool:
    """True when the npz is raw AMASS SMPL, matching holosoma's input filter.

    LocoMujoco mocap stores MuJoCo ``qpos`` for a robot (Atlas, Apollo, G1, …).
    Those files sit under the smpl tree but have no ``poses``/``trans``, so
    batch_retarget_to_csv.py ignores them and reports an empty input dir.
    """
    try:
        stat = path.stat()
    except OSError:
        return False
    key = str(path)
    token = (stat.st_size, stat.st_mtime_ns)
    cached = _amass_npz_cache.get(key)
    if cached is not None and cached[:2] == token:
        return cached[2]
    ok = False
    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
            if "poses.npy" in names and "trans.npy" in names:
                with archive.open("poses.npy") as handle:
                    shape = _npy_shape(handle.read(65536))
                ok = shape is not None and len(shape) == 2 and shape[-1] in _AMASS_POSE_DIMS
    except (OSError, zipfile.BadZipFile, KeyError):
        ok = False
    _amass_npz_cache[key] = (token[0], token[1], ok)
    return ok


def _source_is_motion(source: dict) -> bool:
    """Shape files, GRAB stage-i captures, and non-AMASS npz have no SMPL sequence."""
    name = Path(str(source.get("name") or source.get("path") or "")).name.lower()
    if name == "shape.npz" or name.endswith("_stagei.npz"):
        return False
    if name.endswith(".npz"):
        abs_path = source.get("abs")
        if not abs_path:
            return False
        return _npz_is_amass_smpl(Path(abs_path))
    return True


def _note_skipped_npz(count: int) -> None:
    global _last_skipped_npz
    if count != _last_skipped_npz:
        if count:
            log(f"跳过 {count} 个 npz：不是 AMASS 人体骨架（没有 SMPL poses/trans），不送去重定向")
        _last_skipped_npz = count


def _styles_for_scene(files: list[dict], scheduled: list[str]) -> list[str]:
    """Scheduled styles, plus any style that already has a skeleton CSV for this unit."""
    ordered = list(scheduled)
    seen = set(ordered)
    for item in files:
        if str(item.get("ontology") or "") != "robot":
            continue
        name = str(item.get("name") or "")
        fmt = str(item.get("format") or "").lower()
        if fmt != "csv" and not name.lower().endswith(".csv"):
            continue
        path = str(item.get("path") or "").replace("\\", "/")
        if "/object/" in path or "/skeleton/csv/" not in path:
            continue
        style = str(item.get("robot_style") or "").strip()
        if style and style not in seen:
            ordered.append(style)
            seen.add(style)
    return ordered


def _acquire_in_path(path: str) -> str:
    parts = str(path or "").replace("\\", "/").split("/")
    if "motion" in parts:
        index = parts.index("motion") + 1
        if index < len(parts) and parts[index] in _ACQUIRE_METHODS:
            return parts[index]
    return "omniretarget"


def _frax_source(source: dict) -> bool:
    name = str(source.get("name") or "").lower()
    return name.endswith(".fbx") or name.endswith(".bvh") or name.endswith(".fbx.zst")


def _planned_skeleton_dest(
    style: str, source: dict, batch: str, method: str = "omniretarget"
) -> Path:
    stem = output_stem(source["name"])
    sub = source.get("sub_path") or ""
    version = str(source.get("file_version") or ORIGINAL_FILE_VERSION)
    dest = HUB / "data" / "robot" / style / "motion" / method / "skeleton" / "csv" / batch
    if version and version != ORIGINAL_FILE_VERSION:
        dest = dest / FILE_VERSION_DIR / version
    if sub:
        dest = dest / sub
    return dest / f"{stem}.csv"


def _scene_skeleton_dests(
    files: list[dict],
    style: str,
    source: dict,
    batch: str,
    scheduled: bool,
    method: str = "omniretarget",
) -> list[Path]:
    dests: list[Path] = []
    seen: set[str] = set()
    for item in files:
        if str(item.get("robot_style") or "") != style:
            continue
        path = str(item.get("path") or "").replace("\\", "/")
        if "/skeleton/csv/" not in path or not path.endswith(".csv"):
            continue
        if _acquire_in_path(path) != method:
            continue
        if path in seen:
            continue
        seen.add(path)
        dests.append(HUB / path)
    if scheduled:
        planned = _planned_skeleton_dest(style, source, batch, method)
        key = planned.relative_to(HUB).as_posix()
        if key not in seen:
            dests.append(planned)
    return dests


def _active_retarget_method() -> str:
    method = str(load_control(HUB).get("method") or "omniretarget")
    if method not in {"omniretarget", "frax"}:
        return "omniretarget"
    return method


def _style_method_dests(
    files: list[dict],
    style: str,
    source: dict,
    batch: str,
    scheduled: bool,
    method: str | None = None,
):
    chosen = method or _active_retarget_method()
    if chosen == "frax" and not _frax_source(source):
        return
    for dest in _scene_skeleton_dests(files, style, source, batch, scheduled, chosen):
        yield chosen, dest


def collect_jobs(
    grouped: dict[tuple[str, str], list[dict]],
    state: dict,
    compiled: list[tuple] | None = None,
    redo: dict[str, float] | None = None,
    acquire_method: str | None = None,
) -> list[dict]:
    failures = state.get("failures") or {}
    pins = load_pins(HUB)
    rules = load_config(HUB)["rules"]
    styles = scheduled_robots(HUB, rules)
    targeted = [
        rule
        for rule in rules
        if rule.get("enabled") and rule.get("data_mode") == "targets"
    ]
    redo = dict(redo or {})
    compiled = compiled or []
    pending_redo: set[str] = set()
    scope: dict[str, dict[str, int]] = {}
    now = time.time()
    jobs = []
    skipped_npz = 0
    redo_jobs = 0
    for (batch, unit), files in grouped.items():
        source = choose_human_source(files)
        if source is None:
            continue
        if not _source_is_motion(source):
            if str(source.get("name") or "").lower().endswith(".npz"):
                skipped_npz += 1
            continue
        source = dict(source)
        source["abs"] = str(source.get("abs") or "")
        scene = choose_scene_source(files)
        scene_payload = None
        if scene is not None:
            scene_abs = str(scene.get("abs") or "")
            recorded = (state.get("no_scene") or {}).get(scene_abs)
            try:
                scene_mtime = Path(scene_abs).stat().st_mtime if scene_abs else None
            except OSError:
                scene_mtime = None
            if recorded is None or scene_mtime is None or float(recorded) != float(scene_mtime):
                scene_payload = dict(scene)
                scene_payload["abs"] = scene_abs
        tag_ids: set[int] = set()
        for item in files:
            tag_ids |= set(item.get("tag_ids") or ())
        tag_list = sorted(tag_ids)
        pinned = pin_index(pins, batch, unit) is not None
        for style in _styles_for_scene(files, styles):
            if batch_reserved_for(compiled, style, batch) is False:
                continue
            scheduled = style in styles
            for method, dest in _style_method_dests(
                files, style, source, batch, scheduled, acquire_method
            ):
                needs = scheduled and needs_official_retarget(dest, files, style, redo_after=None)
                needs_objects = (
                    scene_payload is not None
                    and not scene_outputs_ready(dest)
                    and scene_copy_available(dest)
                )
                needs_merged = (
                    scene_payload is not None
                    and dest.is_file()
                    and dest.stat().st_size > 0
                    and scene_outputs_ready(dest)
                    and not merged_fbx_ready(dest)
                )
                needs_packages = (
                    dest.is_file()
                    and dest.stat().st_size > 0
                    and scene_outputs_ready(dest)
                    and not packages_ready(dest)
                )
                if not scheduled:
                    needs = False
                object_only = (not needs) and needs_objects
                merged_only = (not needs) and (not needs_objects) and needs_merged
                package_only = (
                    (not needs) and (not needs_objects) and (not needs_merged) and needs_packages
                )
                needs_work = needs or needs_objects or needs_merged or needs_packages
                key = f"{batch}::{unit}::{style}::{source['path']}"
                if method != "omniretarget":
                    key += f"::{method}"
                if object_only:
                    key += "::object"
                elif merged_only:
                    key += "::merged"
                elif package_only:
                    key += "::package"
                until = float(failures.get(key) or 0)
                redo_after = None
                scope_queue = ""
                if compiled and scheduled:
                    scope_queue = job_queue(
                        style,
                        set(tag_list),
                        compiled,
                        batch=batch,
                        unit=unit,
                        sub_path=str(source.get("sub_path") or ""),
                    )
                    redo_after = redo.get(scope_queue)
                    if redo_after is not None and not object_only and not merged_only and not package_only:
                        needs = needs_official_retarget(dest, files, style, redo_after=redo_after)
                        object_only = (not needs) and needs_objects
                        merged_only = (not needs) and (not needs_objects) and needs_merged
                        package_only = (
                            (not needs)
                            and (not needs_objects)
                            and (not needs_merged)
                            and needs_packages
                        )
                        needs_work = needs or needs_objects or needs_merged or needs_packages
                if scope_queue:
                    bucket = scope.setdefault(scope_queue, {"total": 0, "done": 0})
                    bucket["total"] += 1
                    if not needs_work:
                        bucket["done"] += 1
                if redo_after is not None and not object_only and not merged_only and not package_only:
                    failed_at = until - 30 * 60
                    cooling = until > now and failed_at >= redo_after
                    if cooling or needs:
                        pending_redo.add(scope_queue)
                    if cooling or not needs_work:
                        continue
                elif until > now and not pinned and not any(
                    targets_match(rule, batch, unit) for rule in targeted
                ):
                    continue
                elif not needs_work:
                    continue
                if redo_after is not None and needs:
                    redo_jobs += 1
                jobs.append(
                    {
                        "batch": batch,
                        "unit": unit,
                        "style": style,
                        "source": source,
                        "scene_source": scene_payload,
                        "object_only": object_only,
                        "merged_only": merged_only,
                        "package_only": package_only,
                        "dest": str(dest),
                        "method": method,
                        "failure_key": key,
                        "kind": "skeleton",
                        "height": human_height_m(source.get("annotation")),
                        "tag_ids": tag_list,
                        "redo_after": redo_after,
                        "scope_queue": scope_queue,
                    }
                )
    _note_skipped_npz(skipped_npz)
    if redo_jobs:
        log(f"全部重做 {redo_jobs} 条，新的 CSV 写好后覆盖原来的文件")
    if redo and compiled:
        settle_redo(HUB, redo, pending_redo)
    return jobs, scope


def remember_files(rows: list[tuple[str, dict]]) -> None:
    if not rows:
        return
    meta_path = HUB / "index" / "repository.json"
    # Same lock as the API's update_metadata: without it a tag saved in the
    # page between this read and write is overwritten.
    with locked(meta_path):
        _remember_files_locked(meta_path, rows)


def _remember_files_locked(meta_path: Path, rows: list[tuple[str, dict]]) -> None:
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
    write_text_atomic(meta_path, json.dumps(data, ensure_ascii=False, separators=(",", ":")))


def mark_finished_output(rel: str) -> None:
    if rel:
        _finished_outputs.add(rel)


def _redo_epoch(files: list[dict], rel: str, style: str) -> float:
    for item in files:
        if item.get("path") != rel:
            continue
        item_style = str(item.get("robot_style") or "")
        if style and item_style and item_style != style:
            continue
        try:
            return float((item.get("annotation") or {}).get("redo_epoch") or 0)
        except (TypeError, ValueError):
            return 0.0
    return 0.0


def needs_official_retarget(
    dest: Path,
    files: list[dict],
    style: str,
    *,
    redo_after: float | None = None,
) -> bool:
    """True when this style still needs data_utils/batch_retarget_to_csv.py.

    Files written on 2026-09-24 by the long-lived in-process solver are redone.
    A later run stamps retarget_method and is kept, including a genuinely still clip.
    A file finished in this process is kept even when the unit list has not
    picked up that stamp yet.
    A tier redo runs again even when that stamp is present. The existing CSV
    stays in place until the new file is ready, then replaces it. redo_epoch
    records which request already overwrote it.
    """
    rel = dest.relative_to(HUB).as_posix()
    if redo_after is not None:
        if dest.is_file() and dest.stat().st_size > 0 and _redo_epoch(files, rel, style) >= redo_after:
            return False
        _finished_outputs.discard(rel)
        return True
    if not dest.is_file() or dest.stat().st_size <= 0:
        return True
    if rel in _finished_outputs:
        return False
    for item in files:
        if item.get("path") != rel:
            continue
        item_style = str(item.get("robot_style") or "")
        if style and item_style and item_style != style:
            continue
        if (item.get("annotation") or {}).get("retarget_method") in {RETARGET_METHOD, "frax"}:
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
        if stripped.startswith("- ") or stripped.startswith("Command ["):
            continue
        if "CalledProcessError" in stripped:
            continue
        if "Error:" in stripped or stripped.startswith("Skipping skeleton"):
            exception = stripped
    if exception:
        return exception
    lines = [line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith("- ")]
    return lines[-1] if lines else "重定向没有写出 csv"


def source_keeps_capture(job: dict) -> bool:
    """Merged or object human data stays on the capture origin."""
    source = job.get("source") or {}
    kind = str(source.get("path_motion_kind") or "")
    path = str(source.get("path") or "").replace("\\", "/")
    return kind in {"merged", "object"} or "/merged/" in path or "/object/" in path


def scene_output_paths(job: dict) -> tuple[Path, Path]:
    """Object files sit with the robot, beside the skeleton CSV.

    ``.../omniretarget/skeleton/csv/<batch>/name.csv`` becomes
    ``.../omniretarget/object/xml/<batch>/name.xml`` and ``object/csv/...csv``.
    """
    dest = Path(job["dest"])
    parts = list(dest.parts)
    for index in range(len(parts) - 1):
        if parts[index] == "skeleton" and parts[index + 1] == "csv":
            parts[index] = "object"
            break
    else:
        raise ValueError(f"机器人骨架路径里没有 skeleton/csv：{dest}")

    def place(fmt: str) -> Path:
        copied = list(parts)
        copied[copied.index("object") + 1] = fmt
        return Path(*copied).with_suffix(f".{fmt}")

    return place("xml"), place("csv")


def merged_fbx_path(dest: Path) -> Path:
    """``.../skeleton/csv/<batch>/name.csv`` -> ``.../merged/fbx/<batch>/name.fbx``."""
    parts = list(Path(dest).parts)
    for index in range(len(parts) - 1):
        if parts[index] == "skeleton" and parts[index + 1] == "csv":
            parts[index] = "merged"
            parts[index + 1] = "fbx"
            break
    else:
        raise ValueError(f"机器人骨架路径里没有 skeleton/csv：{dest}")
    return Path(*parts).with_suffix(".fbx")


def merged_package_path(dest: Path, fmt: str) -> Path:
    """``.../skeleton/csv/<batch>/name.csv`` -> ``.../merged/<fmt>/<batch>/name.<fmt>``."""
    parts = list(Path(dest).parts)
    for index in range(len(parts) - 1):
        if parts[index] == "skeleton" and parts[index + 1] == "csv":
            parts[index] = "merged"
            parts[index + 1] = fmt
            break
    else:
        raise ValueError(f"机器人骨架路径里没有 skeleton/csv：{dest}")
    return Path(*parts).with_suffix(f".{fmt}")


def packages_ready(dest: Path) -> bool:
    try:
        npz_path = merged_package_path(dest, "npz")
        zip_path = merged_package_path(dest, "zip")
    except ValueError:
        return False
    return (
        npz_path.is_file()
        and zip_path.is_file()
        and npz_path.stat().st_size > 0
        and zip_path.stat().st_size > 0
    )


def export_robot_packages(job: dict, skeleton_csv: Path) -> list[Path]:
    """Write the robot merged npz and the zip of skeleton CSV plus object files."""
    if not skeleton_csv.is_file() or skeleton_csv.stat().st_size <= 0:
        return []
    if not scene_outputs_ready(skeleton_csv):
        return []
    xml_path, csv_path = scene_output_paths({"dest": str(skeleton_csv)})
    style = str(job.get("style") or "")
    urdf = style_urdf(style)
    if urdf is None:
        log(f"缺少 URDF，跳过合并 npz/zip {style}")
        return []
    sys.path.insert(0, str(BACKEND / "scripts"))
    from export_robot_merged_npz import build_one

    written: list[Path] = []
    npz_path = merged_package_path(skeleton_csv, "npz")
    build_one(skeleton_csv, xml_path, csv_path, urdf, npz_path, style)
    written.append(npz_path)
    zip_path = merged_package_path(skeleton_csv, "zip")
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    staged = zip_path.with_suffix(".zip.tmp")
    extra_csvs = sorted(
        path
        for path in skeleton_csv.parent.glob(skeleton_csv.stem + "_skeleton_*.csv")
        if path.is_file() and path.stat().st_size > 0
    )
    with zipfile.ZipFile(staged, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.write(skeleton_csv, f"skeleton/{skeleton_csv.name}")
        for extra in extra_csvs:
            archive.write(extra, f"skeleton/{extra.name}")
        archive.write(csv_path, f"object/{csv_path.name}")
        archive.write(xml_path, f"object/{xml_path.name}")
    staged.replace(zip_path)
    written.append(zip_path)
    log(f"合并 npz/zip {npz_path.relative_to(HUB).as_posix()}")
    return written


def merged_fbx_ready(dest: Path) -> bool:
    try:
        path = merged_fbx_path(dest)
    except ValueError:
        return False
    return path.is_file() and path.stat().st_size > 0


def style_urdf(style: str) -> Path | None:
    folder = HUB / "3d_model" / "robot" / "standard_description" / style / "urdf"
    if not folder.is_dir():
        return None
    named = [path for path in folder.glob(f"{style}*.urdf") if path.is_file()]
    dof = [path for path in named if "dof" in path.name]
    chosen = sorted(dof or named)
    if chosen:
        return chosen[0]
    any_urdf = sorted(path for path in folder.glob("*.urdf") if path.is_file())
    return any_urdf[0] if any_urdf else None


def export_robot_merged(job: dict, skeleton_csv: Path) -> Path | None:
    """Build the robot merged FBX from this style's skeleton CSV and object files."""
    if not skeleton_csv.is_file() or skeleton_csv.stat().st_size <= 0:
        return None
    if not scene_outputs_ready(skeleton_csv):
        return None
    xml_path, csv_path = scene_output_paths({"dest": str(skeleton_csv)})
    out = merged_fbx_path(skeleton_csv)
    robot_csvs = [skeleton_csv]
    robot_csvs.extend(
        sorted(
            path
            for path in skeleton_csv.parent.glob(skeleton_csv.stem + "_skeleton_*.csv")
            if path.is_file() and path.stat().st_size > 0
        )
    )
    urdf = style_urdf(str(job.get("style") or ""))
    if urdf is None:
        log(f"缺少 URDF，跳过合并 FBX {job.get('style')}")
        return None
    if not FBX_PYTHON.is_file() or not FBX_PYTHONPATH.is_dir():
        log("缺少 FBX SDK 的 Python 3.7，跳过合并 FBX")
        return None
    out.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["PYTHONPATH"] = str(FBX_PYTHONPATH)
    proc = subprocess.run(
        [
            str(FBX_PYTHON),
            "-u",
            str(BACKEND / "scripts" / "export_robot_merged_fbx.py"),
            "--urdf",
            str(urdf),
            "--robot-csv",
            str(skeleton_csv),
        ]
        + [arg for path in robot_csvs[1:] for arg in ("--robot-csv", str(path))]
        + [
            "--object-xml",
            str(xml_path),
            "--object-csv",
            str(csv_path),
            "--output",
            str(out),
        ],
        capture_output=True,
        text=True,
        env=env,
    )
    if proc.returncode != 0 or not out.is_file() or out.stat().st_size <= 0:
        detail = (proc.stderr or proc.stdout or "合并 FBX 失败").strip().splitlines()
        raise RuntimeError(detail[-1] if detail else "合并 FBX 失败")
    message = (proc.stdout or "").strip().splitlines()
    if message:
        log(message[-1])
    return out


def capture_scale_from_log(log_path: Path) -> float:
    """Uniform scale the solver applied to the human and the scene points."""
    if not log_path.is_file():
        return 1.0
    scale = 1.0
    for line in log_path.read_text(encoding="utf-8", errors="replace").splitlines():
        if "HOLOSOMA_CAPTURE_SCALE" not in line:
            continue
        try:
            scale = float(line.split()[-1])
        except ValueError:
            continue
    return scale if scale > 0.0 else 1.0


def apply_scene_scale(xml_path: Path, csv_path: Path, target: float) -> None:
    """Scale object positions and mesh vertices onto the robot's frame.

    ``capture_scale`` on the XML is the factor already baked in, so a later
    robot with a different height adjusts instead of scaling twice.
    """
    if target <= 0.0 or not xml_path.is_file() or not csv_path.is_file():
        return
    root = ET.parse(xml_path).getroot()
    applied = float(root.get("capture_scale") or 1.0)
    if applied <= 0.0:
        applied = 1.0
    factor = target / applied
    if abs(factor - 1.0) < 1e-4:
        if root.get("capture_scale") is None:
            root.set("capture_scale", f"{target:.6f}")
            tree = ET.ElementTree(root)
            ET.indent(tree, space="  ")
            tree.write(xml_path, encoding="utf-8", xml_declaration=True)
        return

    def scaled(value: str) -> str:
        return f"{float(value) * factor:.8f}"

    for body in root.findall("body"):
        for key in ("x", "y", "z"):
            if body.get(key) is not None:
                body.set(key, scaled(body.get(key) or "0"))
        for vertex in body.findall("vertices/v"):
            for key in ("x", "y", "z"):
                if vertex.get(key) is not None:
                    vertex.set(key, scaled(vertex.get(key) or "0"))
    root.set("capture_scale", f"{target:.6f}")
    tree = ET.ElementTree(root)
    ET.indent(tree, space="  ")
    tree.write(xml_path, encoding="utf-8", xml_declaration=True)

    with csv_path.open(encoding="utf-8", newline="") as handle:
        rows = list(csv.reader(handle))
    if not rows:
        return
    header = rows[0]
    xyz = [
        index
        for index, name in enumerate(header)
        if name.endswith(("_x", "_y", "_z")) and not name.endswith(("_qx", "_qy", "_qz"))
    ]
    for row in rows[1:]:
        for index in xyz:
            if index < len(row) and row[index]:
                row[index] = f"{float(row[index]) * factor:.8f}"
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        csv.writer(handle).writerows(rows)
    log(f"物体按机器人身高缩放 {target:.4f}（本次 ×{factor:.4f}）{csv_path.name}")


def scene_outputs_ready(dest: Path) -> bool:
    try:
        xml_path, csv_path = scene_output_paths({"dest": str(dest)})
    except ValueError:
        return False
    return (
        xml_path.is_file()
        and csv_path.is_file()
        and xml_path.stat().st_size > 0
        and csv_path.stat().st_size > 0
    )


def _sibling_scene(xml_path: Path, csv_path: Path) -> tuple[Path, Path] | None:
    """Object files are the same capture frame for every robot style."""
    parts = xml_path.parts
    try:
        robot_idx = parts.index("robot")
    except ValueError:
        return None
    style = parts[robot_idx + 1]
    robot_root = Path(*parts[: robot_idx + 1])
    rel_xml = Path(*xml_path.parts[robot_idx + 2 :])
    rel_csv = Path(*csv_path.parts[robot_idx + 2 :])
    if not robot_root.is_dir():
        return None
    for other in robot_root.iterdir():
        if not other.is_dir() or other.name == style:
            continue
        found_xml = other / rel_xml
        found_csv = other / rel_csv
        if (
            found_xml.is_file()
            and found_csv.is_file()
            and found_xml.stat().st_size > 0
            and found_csv.stat().st_size > 0
        ):
            return found_xml, found_csv
    return None


def scene_copy_available(dest: Path) -> bool:
    """True when some other robot style already has this clip's object files."""
    try:
        xml_path, csv_path = scene_output_paths({"dest": str(dest)})
    except ValueError:
        return False
    return _sibling_scene(xml_path, csv_path) is not None


def export_capture_scene(job: dict) -> list[Path]:
    """Write this style's object XML and CSV.

    A style that only lacks object files copies them from the style that
    already has the pair. A fresh retarget may still export from the merged FBX.
    """
    xml_path, csv_path = scene_output_paths(job)
    if scene_outputs_ready(Path(job["dest"])):
        return [xml_path, csv_path]
    sibling = _sibling_scene(xml_path, csv_path)
    if sibling is not None:
        xml_path.parent.mkdir(parents=True, exist_ok=True)
        csv_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(sibling[0], xml_path)
        shutil.copy2(sibling[1], csv_path)
        log(f"物体复制 {sibling[0].relative_to(HUB).as_posix()} -> {xml_path.relative_to(HUB).as_posix()}")
        return [xml_path, csv_path]
    if job.get("object_only"):
        return []
    info = job.get("scene_source") or {}
    if not info and source_keeps_capture(job):
        info = job.get("source") or {}
    source = Path(str(info.get("abs") or ""))
    if not source.is_file() or source.suffix.lower() != ".fbx":
        return []
    xml_path.parent.mkdir(parents=True, exist_ok=True)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        str(RETARGET_PYTHON),
        "-u",
        str(BACKEND / "scripts" / "export_scene_objects.py"),
        "--input",
        str(source),
        "--xml",
        str(xml_path),
        "--csv",
        str(csv_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    message = (proc.stdout or proc.stderr or "").strip().splitlines()
    if message:
        log(message[-1])
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "物体导出失败").strip().splitlines()
        raise RuntimeError(detail[-1] if detail else "物体导出失败")
    if xml_path.is_file() and csv_path.is_file() and xml_path.stat().st_size > 0 and csv_path.stat().st_size > 0:
        return [xml_path, csv_path]
    text = "\n".join(message)
    if "No rigid bodies" in text or "no object" in text.lower():
        raise RuntimeError("no-scene")
    raise RuntimeError("物体导出没有写出文件")


def retarget_with_frax(job: dict) -> list[Path]:
    """Retarget one human clip with frax and write the same files as omniretarget."""
    source = Path(job["source"]["abs"])
    dest = Path(job["dest"])
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not FRAX_PYTHON.is_file():
        raise RuntimeError(f"找不到 frax 解释器：{FRAX_PYTHON}")
    urdf = style_urdf(str(job.get("style") or ""))
    if urdf is None:
        raise RuntimeError(f"款式 {job.get('style')} 没有 URDF，不能用 frax 重定向")
    scenes = export_capture_scene(job)
    log_path = dest.with_suffix(".frax.log")
    cmd = [
        str(FRAX_PYTHON),
        "-u",
        str(BACKEND / "scripts" / "frax_retarget_clip.py"),
        "--urdf",
        str(urdf),
        "--input",
        str(source),
        "--output",
        str(dest),
    ]
    if source_keeps_capture(job):
        cmd.append("--preserve-world")
    env = os.environ.copy()
    env["JAX_PLATFORMS"] = "cpu"
    env["JAX_ENABLE_X64"] = "1"
    env["XLA_FLAGS"] = (
        "--xla_cpu_multi_thread_eigen=false "
        "--xla_cpu_scheduler_type=CPU_SCHEDULER_TYPE_MEMORY_OPTIMIZED"
    )
    env["OPENBLAS_NUM_THREADS"] = "1"
    env["PYTHONPATH"] = str(FRAX_ROOT)
    with log_path.open("w", encoding="utf-8") as handle:
        proc = subprocess.run(
            cmd,
            cwd=str(FRAX_ROOT),
            env=env,
            stdout=handle,
            stderr=subprocess.STDOUT,
            check=False,
        )
    if proc.returncode != 0 or not dest.is_file() or dest.stat().st_size <= 0:
        raise RuntimeError(_solver_reason(log_path))
    log_path.unlink(missing_ok=True)
    written = [dest]
    written.extend(
        path
        for path in dest.parent.glob(dest.stem + "_skeleton_*.csv")
        if path.is_file() and path.stat().st_size > 0
    )
    written.extend(scenes)
    merged = export_robot_merged(job, dest)
    if merged is not None:
        written.append(merged)
    written.extend(export_robot_packages(job, dest))
    return written


def retarget(job: dict) -> list[Path]:
    """Run data_utils/batch_retarget_to_csv.py the same way as the official command.

    One source file is linked into a temporary input dir. ``--jobs`` matches the
    documented batch command; with a single file the script still uses one worker.
    The loop's own pool supplies the parallelism across files.
    """
    from retarget_to_csv import list_input_skeletons, output_csv_for_skeleton

    if job.get("package_only"):
        packages = export_robot_packages(job, Path(job["dest"]))
        if len(packages) < 2:
            raise RuntimeError("没有写出机器人合并 npz/zip")
        return packages
    if job.get("merged_only"):
        merged = export_robot_merged(job, Path(job["dest"]))
        packages = export_robot_packages(job, Path(job["dest"]))
        written = [path for path in [merged, *packages] if path is not None]
        if not written:
            raise RuntimeError("没有写出机器人合并数据")
        return written
    if job.get("object_only"):
        scenes = export_capture_scene(job)
        merged = export_robot_merged(job, Path(job["dest"]))
        if merged is not None:
            scenes.append(merged)
        scenes.extend(export_robot_packages(job, Path(job["dest"])))
        return scenes
    if job.get("method") == "frax" or "/motion/frax/" in str(job.get("dest") or "").replace("\\", "/"):
        return retarget_with_frax(job)
    source = Path(job["source"]["abs"])
    skeletons = list_input_skeletons(source) or [None]
    dest = Path(job["dest"])
    dest.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["TMPDIR"] = "/tmp"
    profile_root = HUB / "index" / "retarget_robots"
    profile_root.mkdir(parents=True, exist_ok=True)
    env["HOLOSOMA_ROBOT_PROFILES"] = str(profile_root)
    for key in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        env[key] = "1"
    with tempfile.TemporaryDirectory(prefix="hub_retarget_", dir="/tmp") as raw:
        tmp = Path(raw)
        in_dir = tmp / "in"
        out_dir = tmp / "out"
        in_dir.mkdir()
        (in_dir / source.name).symlink_to(source)
        from app.services.robot_retarget_profile import ensure_retarget_profile

        ensure_retarget_profile(HUB, job["style"], python=str(RETARGET_PYTHON))
        log_path = tmp / "run.log"
        scenes = export_capture_scene(job)
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
        if source_keeps_capture(job):
            cmd.append("--preserve-capture-frame")
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
        if source_keeps_capture(job):
            xml_path, csv_path = scene_output_paths(job)
            apply_scene_scale(xml_path, csv_path, capture_scale_from_log(log_path))
        written.extend(scenes)
        merged = export_robot_merged(job, dest)
        if merged is not None:
            written.append(merged)
        written.extend(export_robot_packages(job, dest))
    return written


def record_retarget_frame(source: Path) -> None:
    """Keep index/retarget_frames in step so previews place FBX objects next to the robot."""
    if source.suffix.lower() != ".fbx":
        return
    try:
        sys.path.insert(0, str(BACKEND / "scripts"))
        from retarget_frames import FRAME_DIR, write_frame, write_robot_heights

        if not (FRAME_DIR / "robots.json").is_file():
            write_robot_heights()
        write_frame(source)
    except Exception as exc:  # noqa: BLE001
        log(f"记录重定向坐标系失败 {source.name}: {exc}")


def _worker(job: dict) -> tuple[str, list[str] | None, str | None]:
    try:
        written = [str(path) for path in retarget(job)]
        record_retarget_frame(Path(job["source"]["abs"]))
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
        if error == "no-scene":
            src = str((job.get("scene_source") or job.get("source") or {}).get("abs") or "")
            if src:
                try:
                    state.setdefault("no_scene", {})[src] = Path(src).stat().st_mtime
                except OSError:
                    state.setdefault("no_scene", {})[src] = 0
            log(f"无刚体或 marker {job['batch']} / {job['unit']}")
            continue
        if error:
            failures[key] = time.time() + 30 * 60
            log(f"失败 {key}: {error}")
            continue
        failures.pop(key, None)
        state["last_ok"] = key
        note = f"由 {job['source']['name']} 自动重定向"
        capture = source_keeps_capture(job)
        ready = [Path(path_str) for path_str in (written or []) if Path(path_str).is_file()]
        scene_xml = next((path for path in ready if path.suffix.lower() == ".xml"), None)
        scene_csv = next((path for path in ready if "/object/" in path.as_posix() and path.suffix.lower() == ".csv"), None)
        for path in ready:
            rel = path.relative_to(HUB).as_posix()
            mark_finished_output(rel)
            if "/omniretarget/object/" in rel:
                annotation = {
                    "motion_kind": "object",
                    "fps": 30,
                    "world_frame": "capture_z_up",
                    "note": "由合并动捕导出。Y-up 绕 X 轴转 -90 度得到 Z-up，原点与动捕一致",
                }
            elif "/omniretarget/merged/" in rel:
                if rel.endswith(".npz"):
                    note = "机器人合并数据。30Hz，Z-up，米，四元数 xyzw。网格在 3D 模型库。"
                elif rel.endswith(".zip"):
                    note = "机器人合并数据打包：skeleton/*.csv、object/*.csv、object/*.xml。"
                else:
                    note = "由人体合并数据重定向。骨架来自机器人 CSV，刚体和 marker 来自物体轨迹，坐标系与二者相同"
                annotation = {
                    "robot_style": job["style"],
                    "motion_kind": "merged",
                    "fps": 30,
                    "world_frame": "capture_z_up",
                    "note": note,
                }
            else:
                annotation = {
                    "robot_style": job["style"],
                    "motion_kind": job["kind"],
                    "fps": 30,
                    "retarget_method": "frax" if job.get("method") == "frax" else RETARGET_METHOD,
                    "note": note,
                }
                if capture:
                    annotation["world_frame"] = "capture_z_up"
                if scene_xml is not None and scene_csv is not None:
                    annotation["scene_xml"] = scene_xml.relative_to(HUB).as_posix()
                    annotation["scene_csv"] = scene_csv.relative_to(HUB).as_posix()
            if job.get("redo_after"):
                annotation["redo_epoch"] = job["redo_after"]
            rows.append((rel, annotation))
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
        styles=robot_catalog(HUB),
        reserved_cpus=RESERVED_CPUS,
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
        **_performance_fields(),
        **_pace_fields(),
    )
    plan = _pace.get("plan") or {}
    log(f"自动重定向已启动，{plan.get('detail') or '按页面上的占用强度运行'}")
    pending_paths: list[str] = []
    recent: list[dict] = []
    while True:
        try:
            if _stop_if_requested():
                return
            log("正在扫描待重定向的数据")
            publish_status(
                phase="scanning",
                running=True,
                current=[],
                round_running=0,
                message="正在扫描待重定向的数据",
                **_performance_fields(),
                **_pace_fields(),
            )
            compiled, rules, priority_mtime = prepare_rules()
            selected_method = _active_retarget_method()
            records = iter_motion_files()
            attach_annotations(records)
            grouped = group_units(records)
            jobs, scope = collect_jobs(
                grouped, load_state(), compiled, load_redo(HUB), selected_method
            )
            jobs = sort_jobs(jobs, grouped, compiled)
            redo_gen = _redo_generation()
            if _stop_if_requested():
                return
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
                    queues=fresh_queues([], rules, scope),
                    message="没有待重定向的数据",
                    recent=recent,
                    **_performance_fields(),
                    **_pace_fields(),
                )
                time.sleep(60)
                continue
            queues = fresh_queues(jobs, rules, scope)
            done = 0
            failed = 0
            round_started = _now()
            log(
                f"本轮 {len(jobs)} 条（{selected_method}），先做 "
                f"{describe_rule(rules[0], set()) if rules else '未列入规则'}，最多 {WORKERS} 路并行"
            )

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
                    **_performance_fields(),
                    **_pace_fields(),
                )

            cursor = 0
            announced_size = -1
            snapshot("running", [], f"本轮 {len(jobs)} 条")
            while cursor < len(jobs):
                if _stop_if_requested():
                    return
                if _redo_generation() != redo_gen:
                    log("有一档要求全部重做，重新扫描")
                    snapshot("scanning", [], "有一档要求全部重做，正在重新扫描")
                    break
                if _priority_mtime() != priority_mtime:
                    log("优先级已调整，重新扫描")
                    snapshot("scanning", [], "优先级已调整，正在重新扫描")
                    break
                if _active_retarget_method() != selected_method:
                    log(f"重定向方法已切换为 {_active_retarget_method()}，重新扫描")
                    snapshot("scanning", [], "重定向方法已切换，正在重新扫描")
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
                    if _stop_if_requested():
                        return
                    snapshot("waiting", [], detail)
                    time.sleep(15)
                    continue
                _pace["last_wave"] = size
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
                    action = (
                        "复制物体"
                        if job.get("object_only")
                        else "合并 FBX"
                        if job.get("merged_only")
                        else "重定向"
                    )
                    log(
                        f"{action} {job['batch']} / {job['unit']} -> {job['style']} "
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
                    row = next(
                        (item for item in queues if item["key"] == (job.get("scope_queue") or job.get("queue"))),
                        None,
                    )
                    note = {
                        "at": _now(),
                        "batch": job["batch"],
                        "unit": job["unit"],
                        "style": job["style"],
                        "status": "failed" if error else "done",
                        "error": (error or "").splitlines()[-1] if error else "",
                    }
                    if error and error != "no-scene":
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
