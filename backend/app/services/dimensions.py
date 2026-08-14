"""Extensible dimension schema for hub_repo data units and files.

动作定义 → 唯一确定一个动作数据单元（ActionUnit）
工程标记 × 数据类型 × 重复性标记 → 单元内唯一定位一个文件（RepoFile）
schema 存于 hub_repo/index/dimensions.json，可随时扩展字段。
"""

from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_DIMENSION_SCHEMA: dict[str, Any] = {
    "version": 1,
    "updated_at": None,
    "groups": [
        {
            "key": "action_def",
            "name": "动作定义",
            "role": "action_unit",
            "description": "唯一确定一个动作数据单元",
            "fields": [
                {"key": "atomic_action", "name": "原子动作", "type": "string"},
                {"key": "type", "name": "类型", "type": "string"},
                {"key": "style", "name": "风格", "type": "string"},
                {"key": "action_name", "name": "动作名称", "type": "string"},
                {"key": "action_flow", "name": "动作流程", "type": "string"},
                {"key": "action_label", "name": "动作标号", "type": "string"},
                {"key": "detail_def", "name": "动作详细定义", "type": "text"},
                {"key": "detail_desc", "name": "动作详细描述", "type": "text"},
                {
                    "key": "action_id",
                    "name": "动作id",
                    "type": "string",
                    "unique_key": True,
                    "required": True,
                },
            ],
        },
        {
            "key": "engineering",
            "name": "工程标记",
            "role": "file_tag",
            "fields": [
                {"key": "project", "name": "所属项目", "type": "string"},
                {"key": "acquire_method", "name": "获取方式", "type": "string"},
                {"key": "acquire_location", "name": "获取地点", "type": "string"},
                {"key": "acquire_device", "name": "获取设备", "type": "string"},
            ],
        },
        {
            "key": "data_type",
            "name": "数据类型",
            "role": "file_tag",
            "fields": [
                {
                    "key": "ontology",
                    "name": "本体类型",
                    "type": "enum",
                    "enum": ["human", "robot"],
                    "required": True,
                },
                {
                    "key": "modality",
                    "name": "数据模态",
                    "type": "enum",
                    "enum": ["motion", "video", "language"],
                    "required": True,
                },
                {"key": "format", "name": "数据格式", "type": "string", "required": True},
                {"key": "fps", "name": "帧率", "type": "number"},
            ],
        },
        {
            "key": "replica",
            "name": "重复性标记",
            "role": "file_tag",
            "fields": [
                {"key": "copy_no", "name": "动作副本号", "type": "string", "default": "1"},
            ],
        },
        {
            "key": "file",
            "name": "文件",
            "role": "file",
            "fields": [
                {"key": "body", "name": "文件体", "type": "file"},
            ],
        },
    ],
}

MODALITIES = ("motion", "video", "language")
ONTOLOGIES = ("human", "robot")


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def schema_path(hub_root: Path) -> Path:
    return hub_root / "index" / "dimensions.json"


def load_dimension_schema(hub_root: Path) -> dict[str, Any]:
    path = schema_path(hub_root)
    if path.is_file():
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("groups"):
            return data
    schema = deepcopy(DEFAULT_DIMENSION_SCHEMA)
    schema["updated_at"] = _utcnow_iso()
    save_dimension_schema(hub_root, schema)
    return schema


def save_dimension_schema(hub_root: Path, schema: dict[str, Any]) -> dict[str, Any]:
    path = schema_path(hub_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    out = deepcopy(schema)
    out["updated_at"] = _utcnow_iso()
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    return out


def merge_dimension_schema(
    hub_root: Path,
    *,
    group_key: str | None = None,
    field: dict[str, Any] | None = None,
    new_group: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Extend schema: add a field to a group, or add a whole group."""
    schema = load_dimension_schema(hub_root)
    groups: list[dict[str, Any]] = schema.setdefault("groups", [])
    if new_group:
        key = new_group.get("key")
        if not key:
            raise ValueError("new_group.key 必填")
        if any(g.get("key") == key for g in groups):
            raise ValueError(f"维度组已存在: {key}")
        groups.append(new_group)
    if field and group_key:
        target = next((g for g in groups if g.get("key") == group_key), None)
        if not target:
            raise ValueError(f"维度组不存在: {group_key}")
        fkey = field.get("key")
        if not fkey:
            raise ValueError("field.key 必填")
        fields = target.setdefault("fields", [])
        if any(f.get("key") == fkey for f in fields):
            raise ValueError(f"字段已存在: {group_key}.{fkey}")
        fields.append(field)
    schema["version"] = int(schema.get("version") or 1) + 1
    return save_dimension_schema(hub_root, schema)


def group_map(schema: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {g["key"]: g for g in schema.get("groups", []) if g.get("key")}


def action_id_from_dims(action_def: dict[str, Any]) -> str:
    aid = str(action_def.get("action_id") or "").strip()
    if aid:
        return aid
    # fallback: name + label
    name = str(action_def.get("action_name") or "").strip()
    label = str(action_def.get("action_label") or "").strip()
    if name or label:
        return f"{name}:{label}".strip(":")
    raise ValueError("动作定义缺少动作id（或动作名称/标号）")


def normalize_file_dimensions(
    dims: dict[str, Any],
    *,
    modality: str,
    ontology: str,
    fmt: str,
) -> dict[str, Any]:
    out = deepcopy(dims) if dims else {}
    eng = dict(out.get("engineering") or {})
    dtype = dict(out.get("data_type") or {})
    replica = dict(out.get("replica") or {})
    dtype["modality"] = (modality or dtype.get("modality") or "").strip().lower()
    dtype["ontology"] = (ontology or dtype.get("ontology") or "").strip().lower()
    dtype["format"] = (fmt or dtype.get("format") or "").strip().lower().lstrip(".")
    if dtype["modality"] not in MODALITIES:
        raise ValueError(f"数据模态无效: {dtype['modality']}，应为 {MODALITIES}")
    if dtype["ontology"] not in ONTOLOGIES:
        raise ValueError(f"本体类型无效: {dtype['ontology']}，应为 {ONTOLOGIES}")
    if not dtype["format"]:
        raise ValueError("数据格式不能为空")
    if not replica.get("copy_no"):
        replica["copy_no"] = "1"
    out["engineering"] = eng
    out["data_type"] = dtype
    out["replica"] = replica
    return out


def file_dimension_key(file_dims: dict[str, Any]) -> str:
    """Stable key for uniqueness within an action unit."""
    eng = file_dims.get("engineering") or {}
    dtype = file_dims.get("data_type") or {}
    replica = file_dims.get("replica") or {}
    parts = [
        eng.get("project", ""),
        eng.get("acquire_method", ""),
        eng.get("acquire_location", ""),
        eng.get("acquire_device", ""),
        dtype.get("ontology", ""),
        dtype.get("modality", ""),
        dtype.get("format", ""),
        str(dtype.get("fps") or ""),
        str(replica.get("copy_no") or "1"),
    ]
    return "|".join(str(p) for p in parts)
