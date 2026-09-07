import enum


class UserRole(str, enum.Enum):
    visitor = "visitor"
    downloader = "downloader"
    annotator = "annotator"
    uploader = "uploader"
    manager = "manager"
    super_visitor = "super_visitor"
    super_downloader = "super_downloader"
    super_annotator = "super_annotator"
    super_uploader = "super_uploader"
    super_manager = "super_manager"
    # legacy
    admin = "admin"
    editor = "editor"
    viewer = "viewer"


class Capability(str, enum.Enum):
    browse = "browse"
    download = "download"
    annotate = "annotate"
    upload = "upload"
    manage_data = "manage_data"
    manage_users = "manage_users"
    edit = "edit"  # legacy alias of manage_data


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

_B = Capability.browse
_D = Capability.download
_A = Capability.annotate
_U = Capability.upload
_M = Capability.manage_data
_S = Capability.manage_users

ROLE_CAPABILITIES: dict[UserRole, frozenset[Capability]] = {
    UserRole.visitor: frozenset({_B}),
    UserRole.downloader: frozenset({_B, _D}),
    UserRole.annotator: frozenset({_B, _A}),
    UserRole.uploader: frozenset({_B, _D, _A, _U}),
    UserRole.manager: frozenset({_B, _D, _A, _U, _M}),
    UserRole.super_visitor: frozenset({_B}),
    UserRole.super_downloader: frozenset({_B, _D}),
    UserRole.super_annotator: frozenset({_B, _A}),
    UserRole.super_uploader: frozenset({_B, _D, _A, _U}),
    UserRole.super_manager: frozenset({_B, _D, _A, _U, _M, _S}),
    UserRole.admin: frozenset({_B, _D, _A, _U, _M, _S}),
    UserRole.editor: frozenset({_B, _D, _A, _U}),
    UserRole.viewer: frozenset({_B}),
}

SUPER_ROLES = frozenset(
    {
        UserRole.super_visitor,
        UserRole.super_downloader,
        UserRole.super_annotator,
        UserRole.super_uploader,
        UserRole.super_manager,
        UserRole.admin,
    }
)

ROLE_ALIASES = {
    UserRole.admin: UserRole.super_manager,
    UserRole.editor: UserRole.super_uploader,
    UserRole.viewer: UserRole.visitor,
}


def canonical_role(role: UserRole | str) -> UserRole:
    current = role if isinstance(role, UserRole) else UserRole(role)
    return ROLE_ALIASES.get(current, current)


def alias_capability(capability: Capability) -> Capability:
    return Capability.manage_data if capability == Capability.edit else capability


def role_capabilities(role: UserRole | str) -> frozenset[Capability]:
    return ROLE_CAPABILITIES[canonical_role(role)]


def is_super_role(role: UserRole | str) -> bool:
    return canonical_role(role) in SUPER_ROLES


def is_super_manager_role(role: UserRole | str) -> bool:
    return canonical_role(role) == UserRole.super_manager
