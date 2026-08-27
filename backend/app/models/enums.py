import enum


class UserRole(str, enum.Enum):
    admin = "admin"
    editor = "editor"  # legacy; migrated to path permissions
    viewer = "viewer"  # legacy; migrated to browse-only permissions


class Capability(str, enum.Enum):
    browse = "browse"
    download = "download"
    edit = "edit"
    annotate = "annotate"
    upload = "upload"


class QualityLevel(str, enum.Enum):
    high = "high"  # 好
    medium = "medium"  # 中
    low = "low"  # 差


class RobotStage(str, enum.Enum):
    retarget = "retarget"  # 重定向
    polish = "polish"  # 精修
    refine = "refine"  # refine
    real = "real"  # 真机


class TaxonomyScheme(str, enum.Enum):
    """Built-in scheme keys (stored as plain strings on nodes/tags)."""

    atomic = "atomic"  # 原子or组合
    intent = "intent"  # 动作意图
    style = "style"  # 动作风格


BUILTIN_TAXONOMY_SCHEMES: tuple[tuple[str, str, str, int], ...] = (
    # key, name, code_prefix, sort_order
    ("atomic", "原子or组合", "A", 0),
    ("intent", "动作意图", "B", 1),
    ("style", "动作风格", "C", 2),
)

# 旧显示名 → 新显示名（启动时自动改名）
LEGACY_SCHEME_NAMES: dict[str, str] = {
    "原子动作": "原子or组合",
    "意图功能": "动作意图",
    "风格化模式": "动作风格",
    "录制地点": "获取地点",
}
