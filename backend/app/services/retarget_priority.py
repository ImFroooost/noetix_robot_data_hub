"""Ordered retarget priority. Each rule picks robots and a data scope.

Rules are stored in hub_repo/index/auto_retarget_priority.json. The first
matching enabled rule wins. A taxonomy rule matches a unit tagged with an
included node (or a child of it) and not tagged with an excluded node.
A rest rule matches that robot's jobs which earlier rules did not take.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROBOTS = ("noetix_e2v2_1015", "unitree_g1", "noetix_e2")
DATA_MODES = ("taxonomy", "rest")
UNLISTED = "unlisted"
_SCHEME_RE = re.compile(r"^[A-Za-z0-9_]{1,64}$")
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
_MAX_RULES = 24
_MAX_NAMES = 40


def config_path(hub: Path) -> Path:
    return Path(hub) / "index" / "auto_retarget_priority.json"


def presets_path(hub: Path) -> Path:
    return Path(hub) / "index" / "auto_retarget_priority_presets.json"


def pins_path(hub: Path) -> Path:
    return Path(hub) / "index" / "auto_retarget_pins.json"


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


def describe_rule(rule: dict, earlier_robots: set[str] | None = None) -> str:
    robots = " → ".join(rule.get("robots") or []) or "未选机器人"
    if rule.get("data_mode") == "rest":
        covered = set(rule.get("robots") or [])
        if earlier_robots is not None and covered and covered.isdisjoint(earlier_robots):
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
    if len(schemes) > 1:
        text += f" · {'、'.join(schemes)}"
    elif schemes and schemes[0] != "custom_6":
        text += f" · {schemes[0]}"
    elif not schemes:
        scheme = str(rule.get("scheme") or "")
        if scheme and scheme != "custom_6":
            text += f" · {scheme}"
    return text


def job_queue(
    style: str,
    tag_ids: set[int],
    compiled: list[tuple],
) -> str:
    """First matching rule id, or UNLISTED when no rule covers this job.

    A taxonomy rule with several schemes matches only when every scheme hits.
    """
    tags = set(tag_ids)
    for item in compiled:
        rule = item[0]
        include_ids = item[1] if len(item) > 1 else set()
        exclude_ids = item[2] if len(item) > 2 else set()
        scopes = item[4] if len(item) > 4 else None
        if style not in (rule.get("robots") or []):
            continue
        if rule.get("data_mode") == "rest":
            return str(rule["id"])
        if exclude_ids and tags & exclude_ids:
            continue
        groups = scopes if scopes else ([include_ids] if include_ids else [])
        if groups and all(group and tags & group for group in groups):
            return str(rule["id"])
    return UNLISTED


def _clean_picks(value: object, scheme: str, names: list[str]) -> list[dict]:
    picks: list[dict] = []
    seen: set[tuple[str, str]] = set()

    def add(item_scheme: str, name: str) -> None:
        title = name.strip().replace("\n", " ")
        key = (item_scheme, title)
        if not title or not _SCHEME_RE.match(item_scheme) or key in seen:
            return
        if len(title) > 80 or len(picks) >= _MAX_NAMES:
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


def _clean_rule(raw: object, *, strict: bool, index: int) -> dict | None:
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
    robots: list[str] = []
    for item in robots_raw:
        name = str(item or "").strip()
        if name not in ROBOTS:
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
            raise ValueError("数据范围只能是指定分类或其余数据")
        mode = "rest"
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
    include_picks = _clean_picks(raw.get("include_picks"), scheme, legacy_include)
    exclude_picks = _clean_picks(raw.get("exclude_picks"), scheme, legacy_exclude)
    if mode == "taxonomy" and not include_picks:
        if strict:
            raise ValueError("指定分类时至少选一个分类")
        return None
    if mode == "rest":
        include_picks = []
        exclude_picks = []
    if include_picks:
        scheme = include_picks[0]["scheme"]
    return {
        "id": rule_id,
        "enabled": bool(raw.get("enabled", True)),
        "robots": robots,
        "data_mode": mode,
        "scheme": scheme,
        "include_names": [item["name"] for item in include_picks],
        "exclude_names": [item["name"] for item in exclude_picks],
        "include_picks": include_picks,
        "exclude_picks": exclude_picks,
    }


def _reject_shadowed(rules: list[dict]) -> None:
    """A rest rule consumes that robot, so a later taxonomy rule would never run."""
    seen_rest: set[str] = set()
    seen_ids: set[str] = set()
    for rule in rules:
        rule_id = rule["id"]
        if rule_id in seen_ids:
            raise ValueError("规则编号重复")
        seen_ids.add(rule_id)
        if not rule["enabled"]:
            continue
        robots = set(rule["robots"])
        if rule["data_mode"] == "rest":
            overlap = robots & seen_rest
            if overlap:
                name = "、".join(sorted(overlap))
                raise ValueError(f"{name} 的其余数据重复了，后面那条不会排到任务")
            seen_rest |= robots
            continue
        overlap = robots & seen_rest
        if overlap:
            name = "、".join(sorted(overlap))
            raise ValueError(f"{name} 的其余数据已经排在更前面，后面的分类规则不会生效。把分类规则移到其余数据之前。")


def normalize(data: object, *, strict: bool) -> dict:
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
        cleaned = _clean_rule(raw, strict=strict, index=index)
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
    if isinstance(data, dict):
        updated = str(data.get("updated_at") or "")
    return {"version": 1, "rules": rules, "updated_at": updated or None}


def load_config(hub: Path) -> dict:
    path = config_path(hub)
    if not path.is_file():
        return normalize({"rules": default_rules()}, strict=False)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return normalize({"rules": default_rules()}, strict=False)
    return normalize(data, strict=False)


def save_config(hub: Path, payload: dict) -> dict:
    cleaned = normalize(payload, strict=True)
    cleaned["updated_at"] = datetime.now(timezone.utc).isoformat()
    path = config_path(hub)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cleaned, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)
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
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"presets": presets, "updated_at": datetime.now(timezone.utc).isoformat()}
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _clean_preset(raw: object) -> dict | None:
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
        cleaned = _clean_rule(item, strict=False, index=index)
        if cleaned is not None:
            rules.append(cleaned)
    if not rules:
        return None
    return {"id": preset_id, "name": name, "rules": rules}


def load_presets(hub: Path) -> list[dict]:
    found: list[dict] = []
    seen: set[str] = set()
    for raw in _read_presets_file(hub):
        cleaned = _clean_preset(raw)
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
        raise ValueError("请填写规则名称")
    if len(cleaned) > 24:
        raise ValueError("规则名称最多 24 个字")
    if cleaned == "内置默认":
        raise ValueError("这个名称留给内置默认规则")
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
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"items": result, "updated_at": datetime.now(timezone.utc).isoformat()}
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)
    return result


def save_preset(hub: Path, name: str, rules: list) -> dict:
    title = _preset_name(name)
    cleaned_rules = normalize({"rules": rules}, strict=True)["rules"]
    presets = load_presets(hub)
    current = next((item for item in presets if item["name"] == title), None)
    if current is None:
        if len(presets) >= _MAX_PRESETS:
            raise ValueError(f"最多保存 {_MAX_PRESETS} 套默认规则")
        current = {"id": uuid.uuid4().hex[:12], "name": title, "rules": cleaned_rules}
        presets.append(current)
    else:
        current["rules"] = cleaned_rules
    _write_presets_file(hub, presets)
    return current


def delete_preset(hub: Path, preset_id: str) -> None:
    if preset_id == _BUILTIN_PRESET_ID:
        raise ValueError("内置默认规则不能删除")
    presets = [item for item in load_presets(hub) if item["id"] != preset_id]
    if len(presets) == len(load_presets(hub)):
        raise ValueError("没有这套默认规则")
    _write_presets_file(hub, presets)


def preset_rules(hub: Path, preset_id: str) -> list[dict]:
    if preset_id == _BUILTIN_PRESET_ID:
        return default_rules()
    found = next((item for item in load_presets(hub) if item["id"] == preset_id), None)
    if found is None:
        raise ValueError("没有这套默认规则")
    return found["rules"]


def public_presets(hub: Path) -> list[dict]:
    builtin = {
        "id": _BUILTIN_PRESET_ID,
        "name": "内置默认",
        "builtin": True,
        "rules": default_rules(),
    }
    saved = [
        {"id": item["id"], "name": item["name"], "builtin": False, "rules": item["rules"]}
        for item in load_presets(hub)
    ]
    return [builtin, *saved]


def public_config(hub: Path) -> dict:
    cfg = load_config(hub)
    cfg["robots"] = list(ROBOTS)
    cfg["defaults"] = default_rules()
    cfg["presets"] = public_presets(hub)
    cfg["pins"] = load_pins(hub)
    return cfg
