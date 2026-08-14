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

    atomic = "atomic"  # 原子动作
    intent = "intent"  # 意图/功能
    style = "style"  # 风格化模式


BUILTIN_TAXONOMY_SCHEMES: tuple[tuple[str, str, str, int], ...] = (
    # key, name, code_prefix, sort_order
    ("atomic", "原子动作", "A", 0),
    ("intent", "意图功能", "B", 1),
    ("style", "风格化模式", "C", 2),
)
