"""Ordered retarget priority. Each rule picks robots and a data scope.

Rules are stored in hub_repo/index/auto_retarget_priority.json. The first
matching enabled rule wins. A taxonomy rule matches a unit tagged with an
included node (or a child of it) and not tagged with an excluded node.
A rest rule matches that robot's jobs which earlier rules did not take.
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .file_lock import write_text_atomic

# Checkbox order used before the list followed 3D model instances.
ROBOTS = ("noetix_e2v2_1015", "unitree_g1", "noetix_e2")
# Styles the holosoma retargeter can actually run. New 3D instances show up
# only when their name is in this list.
RETARGETABLE_ROBOTS = ROBOTS + (
    "noetix_e1",
    "noetix_m4_1",
    "noetix_m5_0",
    "noetix_m5_a",
    "noetix_m5_b",
    "t1",
)
DATA_MODES = ("taxonomy", "rest", "targets")
FOLDER_SCHEME = "folder"
_MOTION_EXTS = frozenset({".fbx", ".bvh", ".npz", ".c3d", ".smpl"})
UNLISTED = "unlisted"
SKIPPED = "skipped"
SKIP_RANK = -1
_SCHEME_RE = re.compile(r"^[A-Za-z0-9_]{1,64}$")
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
_MAX_RULES = 2000
_MAX_RANK = 9999
_MAX_NAMES = 40


def is_skip_rule(rule: dict) -> bool:
    try:
        return int(rule.get("rank") or 1) == SKIP_RANK
    except (TypeError, ValueError):
        return False


def config_path(hub: Path) -> Path:
    return Path(hub) / "index" / "auto_retarget_priority.json"


def presets_path(hub: Path) -> Path:
    return Path(hub) / "index" / "auto_retarget_priority_presets.json"


def pins_path(hub: Path) -> Path:
    return Path(hub) / "index" / "auto_retarget_pins.json"


def redo_path(hub: Path) -> Path:
    return Path(hub) / "index" / "auto_retarget_redo.json"


_MAX_PINS = 40
_MAX_PRESETS = 12
_BUILTIN_PRESET_ID = "builtin"


def default_rules() -> list[dict]:
    """Same order the loop used before rules were editable."""
    return [
        {
            "id": "e2v2-gmt-locomotion",
            "enabled": True,
            "robots": ["noetix_e2v2_1015"],
            "data_mode": "taxonomy",
            "scheme": "custom_6",
            "include_names": ["行走", "奔跑"],
            "exclude_names": ["上下楼梯", "上楼梯", "下楼梯"],
        },
        {
            "id": "e2v2-rest",
            "enabled": True,
            "robots": ["noetix_e2v2_1015"],
            "data_mode": "rest",
            "scheme": "custom_6",
            "include_names": [],
            "exclude_names": [],
        },
        {
            "id": "unitree-g1",
            "enabled": True,
            "robots": ["unitree_g1"],
            "data_mode": "rest",
            "scheme": "custom_6",
            "include_names": [],
            "exclude_names": [],
        },
        {
            "id": "noetix-e2",
            "enabled": True,
            "robots": ["noetix_e2"],
            "data_mode": "rest",
            "scheme": "custom_6",
            "include_names": [],
            "exclude_names": [],
        },
    ]


def describe_targets(rule: dict) -> str:
    parts: list[str] = []
    for item in rule.get("targets") or []:
        batch = str(item.get("batch") or "")
        units = [str(name) for name in (item.get("units") or []) if str(name).strip()]
        if not batch:
            continue
        if not units:
            parts.append(f"{batch}（整批）")
        elif len(units) == 1:
            parts.append(f"{batch} / {units[0]}")
        else:
            parts.append(f"{batch}（{len(units)} 个单元）")
    return "、".join(parts) or "未选数据"


def describe_rule(
    rule: dict,
    earlier_robots: set[str] | None = None,
    rules: list[dict] | None = None,
) -> str:
    robots = " → ".join(rule.get("robots") or []) or "未选机器人"
    if rule.get("data_mode") == "targets":
        return f"{describe_targets(rule)} · {robots}"
    if rule.get("data_mode") == "rest":
        covered = set(rule.get("robots") or [])
        carved = any(
            other.get("enabled", True)
            and other.get("id") != rule.get("id")
            and other.get("data_mode") != "rest"
            and covered & set(other.get("robots") or [])
            for other in (rules or [])
        )
        if (
            not carved
            and earlier_robots is not None
            and covered
            and covered.isdisjoint(earlier_robots)
        ):
            return f"{robots} · 全部数据"
        return f"{robots} · 其余数据"
    picks = rule.get("include_picks") or []
    if picks:
        include = " → ".join(str(item.get("name") or "") for item in picks if item.get("name")) or "未选分类"
    else:
        include = " → ".join(rule.get("include_names") or []) or "未选分类"
    text = f"{robots} · {include}"
    excludes = rule.get("exclude_picks") or []
    if excludes:
        exclude = "、".join(str(item.get("name") or "") for item in excludes if item.get("name"))
    else:
        exclude = "、".join(rule.get("exclude_names") or [])
    if exclude:
        text += f"（不含 {exclude}）"
    schemes = []
    for item in picks:
        scheme = str(item.get("scheme") or "")
        if scheme and scheme not in schemes:
            schemes.append(scheme)
    shown = ["存储结构" if item == FOLDER_SCHEME else item for item in schemes]
    if len(shown) > 1:
        text += f" · {'、'.join(shown)}"
    elif shown and shown[0] != "custom_6":
        text += f" · {shown[0]}"
    elif not schemes:
        scheme = str(rule.get("scheme") or "")
        if scheme and scheme != "custom_6":
            text += f" · {scheme}"
    return text


def batch_reserved_for(compiled: list[tuple], style: str, batch: str) -> bool | None:
    """Whether a whole-batch rule assigns this batch.

    None means no whole-batch assignment. True means this robot is named.
    False means the batch is reserved for other robots (or explicitly skipped
    with rank -1 for this robot), so rest rules must not pick it up.
    """
    assigned = False
    named = False
    for item in compiled:
        rule = item[0]
        if not rule.get("enabled") or rule.get("data_mode") != "targets":
            continue
        for target in rule.get("targets") or []:
            if str(target.get("batch") or "") != batch:
                continue
            names = [str(name).strip() for name in (target.get("units") or []) if str(name).strip()]
            if names:
                continue
            if is_skip_rule(rule):
                if style in (rule.get("robots") or []):
                    return False
                continue
            assigned = True
            if style in (rule.get("robots") or []):
                named = True
    if not assigned:
        return None
    return named


def targets_match(rule: dict, batch: str, unit: str) -> bool:
    for item in rule.get("targets") or []:
        if str(item.get("batch") or "") != batch:
            continue
        names = [str(name) for name in (item.get("units") or []) if str(name).strip()]
        if not names or unit in names:
            return True
    return False


def folder_constraints(rule: dict) -> tuple[list[str], list[str]]:
    return _folder_names(rule, "include_picks"), _folder_names(rule, "exclude_picks")


def storage_structure_nodes(hub: Path) -> list[dict]:
    """Batch and subdirectory nodes for the human motion store."""
    root = Path(hub) / "data" / "human" / "motion"
    found: set[str] = set()
    if root.is_dir():
        for fmt in root.iterdir():
            if not fmt.is_dir() or fmt.name.startswith("."):
                continue
            for dirpath, dirnames, filenames in os.walk(fmt):
                dirnames[:] = [name for name in dirnames if not name.startswith(".")]
                if not any(
                    not name.startswith(".") and Path(name).suffix.lower() in _MOTION_EXTS
                    for name in filenames
                ):
                    continue
                rel = Path(dirpath).relative_to(fmt)
                if not rel.parts:
                    continue
                parts = rel.parts
                for index in range(1, len(parts) + 1):
                    found.add("/".join(parts[:index]))
    ordered = sorted(found, key=str.lower)
    ids = {path: index for index, path in enumerate(ordered, start=1)}
    nodes: list[dict] = []
    for path in ordered:
        parent = path.rsplit("/", 1)[0] if "/" in path else ""
        nodes.append(
            {
                "id": ids[path],
                "scheme": FOLDER_SCHEME,
                "parent_id": ids.get(parent),
                "code": "",
                "name": path.rsplit("/", 1)[-1],
                "path": path,
                "sort_order": 0,
                "description": "",
                "clip_count": 0,
                "child_count": 0,
            }
        )
    return nodes


def _folder_names(rule: dict, pick_key: str) -> list[str]:
    names: list[str] = []
    for item in rule.get(pick_key) or []:
        if not isinstance(item, dict) or str(item.get("scheme") or "") != FOLDER_SCHEME:
            continue
        name = str(item.get("name") or "").strip().strip("/")
        if name and name not in names:
            names.append(name)
    return names


def _location_under(batch: str, sub: str, prefixes: list[str]) -> bool:
    batch = str(batch or "").strip("/")
    sub = str(sub or "").strip("/")
    loc = f"{batch}/{sub}" if batch and sub else batch
    if not loc:
        return False
    for prefix in prefixes:
        if loc == prefix or loc.startswith(prefix + "/"):
            return True
    return False


def _folder_allows(item: tuple, batch: str, sub: str) -> bool:
    include = item[5] if len(item) > 5 else []
    exclude = item[6] if len(item) > 6 else []
    if exclude and _location_under(batch, sub, exclude):
        return False
    if include and not _location_under(batch, sub, include):
        return False
    return True


def _taxonomy_allows(item: tuple, tags: set[int]) -> bool:
    include_ids = item[1] if len(item) > 1 else set()
    scopes = item[4] if len(item) > 4 else None
    groups = scopes if scopes else ([include_ids] if include_ids else [])
    groups = [group for group in groups if group]
    if not groups:
        return True
    return all(tags & group for group in groups)


def _has_folder_scope(item: tuple) -> bool:
    include = item[5] if len(item) > 5 else []
    exclude = item[6] if len(item) > 6 else []
    return bool(include or exclude)


def _specific_rule_matches(
    item: tuple,
    style: str,
    tags: set[int],
    batch: str,
    unit: str,
    sub: str = "",
) -> bool:
    """True when this rule names this job. Rest rules are not specific."""
    rule = item[0]
    if style not in (rule.get("robots") or []):
        return False
    mode = rule.get("data_mode")
    if mode == "rest":
        return False
    if mode == "targets":
        return targets_match(rule, batch, unit)
    include_ids = item[1] if len(item) > 1 else set()
    exclude_ids = item[2] if len(item) > 2 else set()
    if exclude_ids and tags & exclude_ids:
        return False
    if not _folder_allows(item, batch, sub):
        return False
    if not _taxonomy_allows(item, tags):
        return False
    scope_groups = [group for group in (item[4] or []) if group] if len(item) > 4 and item[4] else []
    return bool(include_ids or scope_groups or _has_folder_scope(item))


def _targets_match_kind(rule: dict, batch: str, unit: str) -> str | None:
    """Return 'unit' for explicit unit match, 'batch' for whole-batch match, or None."""
    hit_batch = False
    for item in rule.get("targets") or []:
        if str(item.get("batch") or "") != batch:
            continue
        names = [str(name) for name in (item.get("units") or []) if str(name).strip()]
        if names:
            if unit in names:
                return "unit"
        else:
            hit_batch = True
    return "batch" if hit_batch else None


def job_queue(
    style: str,
    tag_ids: set[int],
    compiled: list[tuple],
    *,
    batch: str = "",
    unit: str = "",
    sub_path: str = "",
) -> str:
    """First matching rule id, SKIPPED when rank == -1, or UNLISTED when uncovered.

    Specificity order:
    1. Explicit unit-level targets rules (-1 skips; otherwise first in compiled order)
    2. Whole-batch targets rules (-1 skips; otherwise first in compiled order)
    3. Taxonomy / folder rules (-1 skips; otherwise first in compiled order)
    4. Rest rules (-1 skips; otherwise first in compiled order)
    """
    tags = set(tag_ids)
    unit_target_pos: str | None = None
    batch_target_skip = False
    batch_target_pos: str | None = None
    taxonomy_skip = False
    taxonomy_pos: str | None = None
    rest_skip = False
    rest_pos: str | None = None

    for item in compiled:
        rule = item[0]
        if not rule.get("enabled"):
            continue
        if style not in (rule.get("robots") or []):
            continue
        mode = rule.get("data_mode")
        skip = is_skip_rule(rule)
        if mode == "targets":
            kind = _targets_match_kind(rule, batch, unit)
            if kind == "unit":
                if skip:
                    return SKIPPED
                if unit_target_pos is None:
                    unit_target_pos = str(rule["id"])
            elif kind == "batch":
                if skip:
                    batch_target_skip = True
                elif batch_target_pos is None:
                    batch_target_pos = str(rule["id"])
            continue
        if mode == "rest":
            if skip:
                rest_skip = True
            elif rest_pos is None:
                rest_pos = str(rule["id"])
            continue
        include_ids = item[1] if len(item) > 1 else set()
        exclude_ids = item[2] if len(item) > 2 else set()
        scopes = item[4] if len(item) > 4 else None
        if exclude_ids and tags & exclude_ids:
            continue
        if not _folder_allows(item, batch, sub_path) or not _taxonomy_allows(item, tags):
            continue
        scope_groups = [group for group in (scopes or []) if group]
        if include_ids or scope_groups or _has_folder_scope(item):
            if skip:
                taxonomy_skip = True
            elif taxonomy_pos is None:
                taxonomy_pos = str(rule["id"])

    if unit_target_pos is not None:
        return unit_target_pos
    if batch_target_skip:
        return SKIPPED
    if batch_target_pos is not None:
        return batch_target_pos
    if taxonomy_skip:
        return SKIPPED
    if taxonomy_pos is not None:
        return taxonomy_pos
    if rest_skip:
        return SKIPPED
    if rest_pos is not None:
        return rest_pos
    return UNLISTED


def _clean_picks(value: object, scheme: str, names: list[str]) -> list[dict]:
    picks: list[dict] = []
    seen: set[tuple[str, str]] = set()

    def add(item_scheme: str, name: str) -> None:
        title = name.strip().replace("\n", " ")
        key = (item_scheme, title)
        if not title or not _SCHEME_RE.match(item_scheme) or key in seen:
            return
        limit = 240 if item_scheme == FOLDER_SCHEME else 80
        if len(title) > limit or len(picks) >= _MAX_NAMES:
            return
        seen.add(key)
        picks.append({"scheme": item_scheme, "name": title})

    if isinstance(value, list):
        for item in value:
            if isinstance(item, dict):
                add(str(item.get("scheme") or "").strip(), str(item.get("name") or ""))
            elif scheme:
                add(scheme, str(item or ""))
    if not picks and scheme:
        for name in names:
            add(scheme, name)
    return picks


def _clean_targets(value: object, *, strict: bool) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list):
        if strict:
            raise ValueError("指定数据格式不正确")
        return []
    items: list[dict] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        batch = str(item.get("batch") or "").strip()
        if not batch or "/" in batch or "\\" in batch or len(batch) > 200:
            if strict:
                raise ValueError("批次名无效")
            continue
        units: list[str] = []
        for name in item.get("units") or []:
            text = str(name or "").strip()
            if not text or "/" in text or "\\" in text or len(text) > 300:
                if strict:
                    raise ValueError("数据单元名无效")
                continue
            if text not in units:
                units.append(text)
        items.append({"batch": batch, "units": units})
    return items


def _model_robot_names(hub: Path) -> set[str]:
    names: set[str] = set()
    root = Path(hub) / "3d_model" / "robot"
    if not root.is_dir():
        return names
    for kind in root.iterdir():
        if not kind.is_dir() or kind.name.startswith("."):
            continue
        for instance in kind.iterdir():
            if instance.is_dir() and not instance.name.startswith("."):
                names.add(instance.name)
    return names


def _urdf_robot_names(hub: Path) -> set[str]:
    root = Path(hub) / "3d_model" / "robot" / "standard_description"
    names: set[str] = set()
    if not root.is_dir():
        return names
    for inst in root.iterdir():
        urdf = inst / "urdf"
        if not inst.is_dir() or not urdf.is_dir():
            continue
        if any(path.suffix.lower() in {".urdf", ".xacro"} and path.is_file() for path in urdf.rglob("*")):
            names.add(inst.name)
    return names


def robot_catalog(hub: Path) -> list[str]:
    """3D model instances the retargeter can run, historical names first.

    A newly uploaded URDF is included even when holosoma has no hand-written
    robot entry. The retarget loop builds that entry from the URDF.
    """
    present = _model_robot_names(hub)
    ready = _urdf_robot_names(hub)
    found: list[str] = []
    for name in [*RETARGETABLE_ROBOTS, *sorted(ready)]:
        if name in found:
            continue
        if name in present or name in ready:
            found.append(name)
    return found or list(ROBOTS)


def scheduled_robots(hub: Path, rules: list[dict] | None = None) -> list[str]:
    """Robots the loop should generate jobs for.

    Any robot with at least one positive-rank enabled rule is scheduled.
    Historical default robots stay scheduled only when no rule mentions them
    at all (so setting a robot column or rest rule to -1 disables it).
    """
    catalog = robot_catalog(hub)
    allowed = set(catalog)
    selected: list[str] = []
    mentioned: set[str] = set()
    rest_skipped: set[str] = set()
    for rule in rules or []:
        if not rule.get("enabled"):
            continue
        rlist = [name for name in (rule.get("robots") or []) if name in allowed]
        mentioned.update(rlist)
        if is_skip_rule(rule):
            if rule.get("data_mode") == "rest":
                rest_skipped.update(rlist)
            continue
        for name in rlist:
            if name not in selected:
                selected.append(name)
    for name in ROBOTS:
        if name in allowed and name not in selected and name not in rest_skipped and name not in mentioned:
            selected.append(name)
    return selected


def _clean_rule(
    raw: object,
    *,
    strict: bool,
    index: int,
    robots: tuple[str, ...] | list[str] | None = None,
) -> dict | None:
    if not isinstance(raw, dict):
        if strict:
            raise ValueError("规则格式不正确")
        return None
    rule_id = str(raw.get("id") or "").strip()
    if not _ID_RE.match(rule_id):
        rule_id = f"rule-{index + 1}" if not strict else uuid.uuid4().hex[:12]
    robots_raw = raw.get("robots")
    if not isinstance(robots_raw, list) or not robots_raw:
        if strict:
            raise ValueError("每条规则至少选一台机器人")
        return None
    allowed = robots if robots is not None else ROBOTS
    robots: list[str] = []
    for item in robots_raw:
        name = str(item or "").strip()
        if name not in allowed:
            if strict:
                raise ValueError(f"未知机器人 {name}")
            continue
        if name not in robots:
            robots.append(name)
    if not robots:
        if strict:
            raise ValueError("每条规则至少选一台机器人")
        return None
    mode = str(raw.get("data_mode") or "taxonomy")
    if mode not in DATA_MODES:
        if strict:
            raise ValueError("数据范围只能是指定分类、指定数据或其余数据")
        mode = "rest"
    targets = _clean_targets(raw.get("targets"), strict=strict) if mode == "targets" else []
    if mode == "targets" and not targets:
        if strict:
            raise ValueError("请指定批次或数据单元")
        return None
    scheme = str(raw.get("scheme") or "").strip()
    if scheme and not _SCHEME_RE.match(scheme):
        if strict and mode == "taxonomy" and not isinstance(raw.get("include_picks"), list):
            raise ValueError("请选择分类方案")
        scheme = ""
    legacy_include = []
    legacy_exclude = []
    for item in raw.get("include_names") or []:
        name = str(item or "").strip()
        if name and name not in legacy_include:
            legacy_include.append(name)
    for item in raw.get("exclude_names") or []:
        name = str(item or "").strip()
        if name and name not in legacy_exclude:
            legacy_exclude.append(name)
    include_picks = [] if mode != "taxonomy" else _clean_picks(raw.get("include_picks"), scheme, legacy_include)
    exclude_picks = [] if mode != "taxonomy" else _clean_picks(raw.get("exclude_picks"), scheme, legacy_exclude)
    if mode == "taxonomy" and not include_picks:
        if strict:
            raise ValueError("指定分类时至少选一个分类")
        return None
    if include_picks:
        scheme = include_picks[0]["scheme"]
    elif mode != "taxonomy":
        scheme = ""
    cleaned = {
        "id": rule_id,
        "enabled": bool(raw.get("enabled", True)),
        "robots": robots,
        "data_mode": mode,
        "scheme": scheme,
        "include_names": [item["name"] for item in include_picks],
        "exclude_names": [item["name"] for item in exclude_picks],
        "include_picks": include_picks,
        "exclude_picks": exclude_picks,
        "targets": targets,
    }
    rank = _clean_rank(raw.get("rank"))
    if rank is not None:
        cleaned["rank"] = rank
    return cleaned


def _clean_rank(value: object) -> int | None:
    """The number the user typed in the priority table (-1 means do not execute)."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        rank = int(value)
    except (TypeError, ValueError):
        return None
    if rank == SKIP_RANK:
        return SKIP_RANK
    return rank if 1 <= rank <= _MAX_RANK else None


def _clean_layout(raw: object, robots: tuple[str, ...] | list[str] | None = None) -> dict | None:
    """Clean optional matrix axis ordering, axis priorities, and manual cell overrides."""
    if not isinstance(raw, dict):
        return None
    allowed = list(robots) if robots is not None else list(ROBOTS)
    allowed_set = set(allowed)
    robot_order: list[str] = []
    raw_order = raw.get("robot_order")
    if isinstance(raw_order, list):
        for item in raw_order:
            name = str(item or "").strip()
            if name in allowed_set and name not in robot_order:
                robot_order.append(name)
    for name in allowed:
        if name not in robot_order:
            robot_order.append(name)

    col_ranks: dict[str, int] = {}
    raw_cols = raw.get("col_ranks")
    if isinstance(raw_cols, dict):
        for key, value in raw_cols.items():
            name = str(key or "").strip()
            if name not in allowed_set:
                continue
            rank = _clean_rank(value)
            if rank is not None:
                col_ranks[name] = rank

    rows_out: list[dict] = []
    raw_rows = raw.get("rows")
    if isinstance(raw_rows, list):
        for item in raw_rows[:_MAX_RULES]:
            if not isinstance(item, dict):
                continue
            mode = str(item.get("kind") or "taxonomy")
            if mode not in DATA_MODES:
                continue
            include = [] if mode != "taxonomy" else _clean_picks(item.get("include"), "", [])
            exclude = [] if mode != "taxonomy" else _clean_picks(item.get("exclude"), "", [])
            targets = _clean_targets(item.get("targets"), strict=False) if mode == "targets" else []
            if mode == "taxonomy" and not include:
                continue
            if mode == "targets" and not targets:
                continue
            row_rank = _clean_rank(item.get("row_rank"))
            if row_rank is None:
                row_rank = len(rows_out) + 1
            overrides: dict[str, int] = {}
            raw_ov = item.get("overrides")
            if isinstance(raw_ov, dict):
                for rname, rval in raw_ov.items():
                    rkey = str(rname or "").strip()
                    if rkey not in allowed_set:
                        continue
                    cleaned_val = _clean_rank(rval)
                    if cleaned_val is not None:
                        overrides[rkey] = cleaned_val
            rows_out.append(
                {
                    "key": str(item.get("key") or ""),
                    "kind": mode,
                    "include": include,
                    "exclude": exclude,
                    "targets": targets,
                    "row_rank": row_rank,
                    "overrides": overrides,
                }
            )
    if not rows_out and not col_ranks and raw_order is None:
        return None
    return {
        "robot_order": robot_order,
        "col_ranks": col_ranks,
        "rows": rows_out,
    }


def rule_rank_label(rule: dict, index: int) -> str:
    return str(rule.get("rank") or index + 1)


def _reject_shadowed(rules: list[dict]) -> None:
    """Two rest rules for one robot would both claim the unnamed jobs."""
    seen_rest: set[str] = set()
    seen_ids: set[str] = set()
    for rule in rules:
        rule_id = rule["id"]
        if rule_id in seen_ids:
            raise ValueError("规则编号重复")
        seen_ids.add(rule_id)
        if not rule["enabled"] or rule["data_mode"] != "rest":
            continue
        robots = set(rule["robots"])
        overlap = robots & seen_rest
        if overlap:
            name = "、".join(sorted(overlap))
            raise ValueError(f"{name} 的其余数据重复了，后面那条不会排到任务")
        seen_rest |= robots


def normalize(
    data: object,
    *,
    strict: bool,
    robots: tuple[str, ...] | list[str] | None = None,
) -> dict:
    raw_rules = data.get("rules") if isinstance(data, dict) else None
    if not isinstance(raw_rules, list):
        if strict:
            raise ValueError("缺少规则列表")
        raw_rules = default_rules()
    if len(raw_rules) > _MAX_RULES:
        if strict:
            raise ValueError(f"最多 {_MAX_RULES} 条规则")
        raw_rules = raw_rules[:_MAX_RULES]
    rules: list[dict] = []
    for index, raw in enumerate(raw_rules):
        cleaned = _clean_rule(raw, strict=strict, index=index, robots=robots)
        if cleaned is not None:
            rules.append(cleaned)
    if strict:
        if not rules:
            raise ValueError("至少保留一条规则")
        _reject_shadowed(rules)
        if not any(rule["enabled"] for rule in rules):
            raise ValueError("至少启用一条规则")
    elif not rules:
        rules = default_rules()
    updated = ""
    raw_layout = None
    if isinstance(data, dict):
        updated = str(data.get("updated_at") or "")
        raw_layout = data.get("layout")
    layout = _clean_layout(raw_layout, robots=robots)
    out: dict = {"version": 1, "rules": rules, "updated_at": updated or None}
    if layout is not None:
        out["layout"] = layout
    return out


def load_config(hub: Path) -> dict:
    path = config_path(hub)
    if not path.is_file():
        return normalize({"rules": default_rules()}, strict=False)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return normalize({"rules": default_rules()}, strict=False)
    return normalize(data, strict=False, robots=robot_catalog(hub))


def _read_redo_file(hub: Path) -> dict:
    path = redo_path(hub)
    if not path.is_file():
        return {"generation": 0, "rules": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"generation": 0, "rules": {}}
    if not isinstance(data, dict):
        return {"generation": 0, "rules": {}}
    return data


def load_redo(hub: Path) -> dict[str, float]:
    """Rule id -> unix time when that tier was asked to run again."""
    raw = _read_redo_file(hub).get("rules")
    if not isinstance(raw, dict):
        return {}
    out: dict[str, float] = {}
    for key, value in raw.items():
        name = str(key or "").strip()
        if not _ID_RE.match(name):
            continue
        try:
            stamp = float(value)
        except (TypeError, ValueError):
            continue
        if stamp > 0:
            out[name] = stamp
    return out


def redo_generation(hub: Path) -> int:
    try:
        return int(_read_redo_file(hub).get("generation") or 0)
    except (TypeError, ValueError):
        return 0


def _write_redo(hub: Path, generation: int, rules: dict[str, float]) -> None:
    path = redo_path(hub)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"generation": int(generation), "rules": rules}
    write_text_atomic(path, json.dumps(payload, ensure_ascii=False, indent=2))


def request_tier_redo(hub: Path, rule_id: str) -> dict:
    """Ask the loop to run one saved tier again, overwriting CSVs after each new result."""
    rule_id = str(rule_id or "").strip()
    if not _ID_RE.match(rule_id):
        raise ValueError("没有这一档")
    if rule_id != UNLISTED:
        found = next((rule for rule in load_config(hub)["rules"] if rule["id"] == rule_id), None)
        if found is None:
            raise ValueError("没有这一档")
        if not found.get("enabled"):
            raise ValueError("这一档已停用")
        if is_skip_rule(found):
            raise ValueError("这一项设为 -1 不执行，无法安排重做")
    current = _read_redo_file(hub)
    rules = load_redo(hub)
    try:
        generation = int(current.get("generation") or 0)
    except (TypeError, ValueError):
        generation = 0
    stamp = time.time()
    rules[rule_id] = stamp
    _write_redo(hub, generation + 1, rules)
    return {
        "ok": True,
        "rule_id": rule_id,
        "requested_at": stamp,
        "message": "已安排这一档全部重做。当前这一波结束后会重新扫描，进度从 0 开始，新的 CSV 写好后覆盖原来的文件。",
    }


def settle_redo(hub: Path, seen: dict[str, float], pending: set[str]) -> None:
    """Drop redo marks whose files are already overwritten for that request.

    A newer click keeps its own timestamp, so this will not erase a request
    that arrived while the scan was running.
    """
    data = _read_redo_file(hub)
    raw = data.get("rules") if isinstance(data.get("rules"), dict) else {}
    rules: dict[str, float] = {}
    for key, value in raw.items():
        try:
            rules[str(key)] = float(value)
        except (TypeError, ValueError):
            continue
    try:
        generation = int(data.get("generation") or 0)
    except (TypeError, ValueError):
        generation = 0
    changed = False
    for rule_id, stamp in seen.items():
        if rule_id in pending:
            continue
        if rules.get(rule_id) == stamp:
            rules.pop(rule_id, None)
            changed = True
    if changed:
        _write_redo(hub, generation, rules)


def save_config(hub: Path, payload: dict) -> dict:
    cleaned = normalize(payload, strict=True, robots=robot_catalog(hub))
    cleaned["updated_at"] = datetime.now(timezone.utc).isoformat()
    path = config_path(hub)
    write_text_atomic(path, json.dumps(cleaned, ensure_ascii=False, indent=2))
    return cleaned


def _read_presets_file(hub: Path) -> list[dict]:
    path = presets_path(hub)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    raw = data.get("presets") if isinstance(data, dict) else None
    return raw if isinstance(raw, list) else []


def _write_presets_file(hub: Path, presets: list[dict]) -> None:
    path = presets_path(hub)
    payload = {"presets": presets, "updated_at": datetime.now(timezone.utc).isoformat()}
    write_text_atomic(path, json.dumps(payload, ensure_ascii=False, indent=2))


def _clean_preset(raw: object, robots: tuple[str, ...] | list[str] | None = None) -> dict | None:
    if not isinstance(raw, dict):
        return None
    preset_id = str(raw.get("id") or "").strip()
    if preset_id == _BUILTIN_PRESET_ID or not _ID_RE.match(preset_id):
        return None
    name = str(raw.get("name") or "").strip().replace("\n", " ")
    if not name or len(name) > 24:
        return None
    rules_raw = raw.get("rules")
    if not isinstance(rules_raw, list):
        return None
    rules: list[dict] = []
    for index, item in enumerate(rules_raw[:_MAX_RULES]):
        cleaned = _clean_rule(item, strict=False, index=index, robots=robots)
        if cleaned is not None:
            rules.append(cleaned)
    if not rules:
        return None
    out: dict = {"id": preset_id, "name": name, "rules": rules}
    layout = _clean_layout(raw.get("layout"), robots=robots)
    if layout is not None:
        out["layout"] = layout
    return out


def load_presets(hub: Path) -> list[dict]:
    found: list[dict] = []
    seen: set[str] = set()
    for raw in _read_presets_file(hub):
        cleaned = _clean_preset(raw, robot_catalog(hub))
        if cleaned is None or cleaned["id"] in seen or cleaned["name"] in {item["name"] for item in found}:
            continue
        seen.add(cleaned["id"])
        found.append(cleaned)
        if len(found) >= _MAX_PRESETS:
            break
    return found


def _preset_name(name: str) -> str:
    cleaned = str(name or "").strip().replace("\n", " ")
    if not cleaned:
        raise ValueError("请填写预设名称")
    if len(cleaned) > 24:
        raise ValueError("预设名称最多 24 个字")
    if cleaned in {"内置默认", "内置预设"}:
        raise ValueError("这个名称留给内置预设")
    return cleaned


def load_pins(hub: Path) -> list[dict]:
    path = pins_path(hub)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    raw = data.get("items") if isinstance(data, dict) else None
    if not isinstance(raw, list):
        return []
    items: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        batch = str(item.get("batch") or "").strip()
        if not batch or "/" in batch or "\\" in batch:
            continue
        units: list[str] = []
        for name in item.get("units") or []:
            text = str(name or "").strip()
            if text and text not in units:
                units.append(text)
        items.append({"batch": batch, "units": units})
        if len(items) >= _MAX_PINS:
            break
    return items


def pin_index(pins: list[dict], batch: str, unit: str) -> int | None:
    for index, item in enumerate(pins):
        if item.get("batch") != batch:
            continue
        names = item.get("units") or []
        if not names or unit in names:
            return index
    return None


def add_pins(hub: Path, items: list[dict]) -> list[dict]:
    incoming: list[dict] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        batch = str(item.get("batch") or "").strip()
        if not batch or "/" in batch or "\\" in batch or len(batch) > 200:
            raise ValueError("批次名无效")
        units: list[str] = []
        for name in item.get("units") or []:
            text = str(name or "").strip()
            if not text or "/" in text or "\\" in text or len(text) > 300:
                raise ValueError("数据单元名无效")
            if text not in units:
                units.append(text)
            if len(units) > 5000:
                raise ValueError("一次最多指定 5000 个数据单元")
        incoming.append({"batch": batch, "units": units})
    if not incoming:
        raise ValueError("没有可优先的数据")
    result: list[dict] = []
    covered_batches: set[str] = set()
    covered_units: set[tuple[str, str]] = set()
    for item in incoming + load_pins(hub):
        batch = item["batch"]
        if batch in covered_batches:
            continue
        names = list(item.get("units") or [])
        if not names:
            covered_batches.add(batch)
            result.append({"batch": batch, "units": []})
        else:
            remain = [name for name in names if (batch, name) not in covered_units]
            if not remain:
                continue
            for name in remain:
                covered_units.add((batch, name))
            result.append({"batch": batch, "units": remain})
        if len(result) >= _MAX_PINS:
            break
    path = pins_path(hub)
    payload = {"items": result, "updated_at": datetime.now(timezone.utc).isoformat()}
    write_text_atomic(path, json.dumps(payload, ensure_ascii=False, indent=2))
    return result


def _target_rule(items: list[dict], robots: list[str] | None = None) -> dict:
    return {
        "id": uuid.uuid4().hex[:12],
        "enabled": True,
        "robots": list(robots or ROBOTS),
        "data_mode": "targets",
        "scheme": "",
        "include_names": [],
        "exclude_names": [],
        "include_picks": [],
        "exclude_picks": [],
        "targets": items,
    }


def _target_key(item: dict) -> tuple[str, tuple[str, ...]]:
    return (str(item.get("batch") or ""), tuple(str(name) for name in (item.get("units") or [])))


def migrate_pins_into_rules(hub: Path) -> bool:
    """Turn the old pin list into editable priority tiers, highest pin first."""
    pins = load_pins(hub)
    if not pins:
        return False
    current = load_config(hub)
    existing = {
        _target_key(item)
        for rule in current["rules"]
        if rule.get("data_mode") == "targets"
        for item in rule.get("targets") or []
    }
    catalog = robot_catalog(hub)
    fresh = [_target_rule([pin], catalog) for pin in pins if _target_key(pin) not in existing]
    if fresh:
        save_config(hub, {"rules": fresh + current["rules"]})
    path = pins_path(hub)
    write_text_atomic(path, json.dumps({"items": [], "updated_at": datetime.now(timezone.utc).isoformat()}, ensure_ascii=False))
    return bool(fresh)


def _ordered_robots(hub: Path, robots: list[str] | None) -> list[str]:
    catalog = robot_catalog(hub)
    if robots is None:
        return catalog
    chosen: list[str] = []
    for item in robots:
        name = str(item or "").strip()
        if not name or name in chosen:
            continue
        if name not in catalog:
            raise ValueError(f"没有可重定向的机器人：{name}")
        chosen.append(name)
    if not chosen:
        raise ValueError("请至少选择一台机器人")
    return chosen


def promote_targets(hub: Path, items: list[dict], robots: list[str] | None = None) -> dict:
    """Insert one new top tier for the chosen batches or units.

    ``robots`` is the click order: the first checked style is retargeted first.
    """
    migrate_pins_into_rules(hub)
    targets = _clean_targets(items, strict=True)
    if not targets:
        raise ValueError("没有可优先的数据")
    current = load_config(hub)
    chosen_robots = _ordered_robots(hub, robots)
    fresh = _target_rule(targets, chosen_robots)
    if any((rule.get("rank") or 0) > 0 for rule in current["rules"]):
        # Keep positive table numbers in step with the order; preserve -1 skip rules.
        fresh["rank"] = 1
        for rule in current["rules"]:
            r_val = rule.get("rank")
            if isinstance(r_val, int) and r_val > 0:
                rule["rank"] = min(_MAX_RANK, r_val + 1)
    rules = [fresh] + current["rules"]
    if len(rules) > _MAX_RULES:
        raise ValueError(f"最多 {_MAX_RULES} 档优先级")
    layout = current.get("layout")
    if isinstance(layout, dict):
        layout = json.loads(json.dumps(layout))
        existing_rows = list(layout.get("rows") or [])
        shift = len(targets)
        for r_item in existing_rows:
            rr = r_item.get("row_rank")
            if isinstance(rr, int) and rr > 0:
                r_item["row_rank"] = min(_MAX_RANK, rr + shift)
            ov = r_item.get("overrides")
            if isinstance(ov, dict):
                for rk, rv in list(ov.items()):
                    if isinstance(rv, int) and rv > 0:
                        ov[rk] = min(_MAX_RANK, rv + 1)
        catalog = robot_catalog(hub)
        chosen_set = set(chosen_robots)
        prepended: list[dict] = []
        for idx, t_item in enumerate(targets):
            row_ov: dict[str, int] = {}
            if robots is not None:
                for rname in catalog:
                    row_ov[rname] = 1 if rname in chosen_set else SKIP_RANK
            prepended.append(
                {
                    "key": json.dumps(["targets", [], [], [[t_item["batch"], t_item["units"]]]]),
                    "kind": "targets",
                    "include": [],
                    "exclude": [],
                    "targets": [t_item],
                    "row_rank": idx + 1,
                    "overrides": row_ov,
                }
            )
        layout["rows"] = prepended + existing_rows
    payload: dict = {"rules": rules}
    if layout is not None:
        payload["layout"] = layout
    save_config(hub, payload)
    return public_config(hub)


def save_preset(hub: Path, name: str, rules: list, layout: dict | None = None) -> dict:
    """Store the given rules as a new named preset. The running priority is unchanged."""
    title = _preset_name(name)
    normalized = normalize({"rules": rules, "layout": layout}, strict=True, robots=robot_catalog(hub))
    cleaned_rules = normalized["rules"]
    presets = load_presets(hub)
    if any(item["name"] == title for item in presets):
        raise ValueError(f"已经有名为「{title}」的预设，请换一个名称")
    if len(presets) >= _MAX_PRESETS:
        raise ValueError(f"最多保存 {_MAX_PRESETS} 套预设")
    current: dict = {"id": uuid.uuid4().hex[:12], "name": title, "rules": cleaned_rules}
    if normalized.get("layout") is not None:
        current["layout"] = normalized["layout"]
    presets.append(current)
    _write_presets_file(hub, presets)
    return current


def delete_preset(hub: Path, preset_id: str) -> None:
    if preset_id == _BUILTIN_PRESET_ID:
        raise ValueError("内置预设不能删除")
    presets = [item for item in load_presets(hub) if item["id"] != preset_id]
    if len(presets) == len(load_presets(hub)):
        raise ValueError("没有这套预设")
    _write_presets_file(hub, presets)


def preset_rules(hub: Path, preset_id: str) -> list[dict]:
    return preset_payload(hub, preset_id)["rules"]


def preset_payload(hub: Path, preset_id: str) -> dict:
    if preset_id == _BUILTIN_PRESET_ID:
        return {"rules": default_rules()}
    found = next((item for item in load_presets(hub) if item["id"] == preset_id), None)
    if found is None:
        raise ValueError("没有这套预设")
    out: dict = {"rules": found["rules"]}
    if found.get("layout") is not None:
        out["layout"] = found["layout"]
    return out


def public_presets(hub: Path) -> list[dict]:
    builtin = {
        "id": _BUILTIN_PRESET_ID,
        "name": "内置预设",
        "builtin": True,
        "rules": default_rules(),
    }
    saved = [
        {
            "id": item["id"],
            "name": item["name"],
            "builtin": False,
            "rules": item["rules"],
            **({"layout": item["layout"]} if item.get("layout") is not None else {}),
        }
        for item in load_presets(hub)
    ]
    return [builtin, *saved]


def public_config(hub: Path) -> dict:
    migrate_pins_into_rules(hub)
    cfg = load_config(hub)
    redo_map = load_redo(hub)
    cfg["robots"] = robot_catalog(hub)
    cfg["defaults"] = default_rules()
    cfg["presets"] = public_presets(hub)
    cfg["pins"] = load_pins(hub)
    cfg["redo"] = sorted(redo_map)
    cfg["redo_stamps"] = redo_map
    return cfg
