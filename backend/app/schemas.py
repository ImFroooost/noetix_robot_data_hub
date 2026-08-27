from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .models.enums import Capability, QualityLevel, RobotStage, UserRole


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# -------- Auth / Users --------
class PermissionItem(BaseModel):
    capability: Capability
    # ""=文件夹树；否则为分类标准 key，path_prefix 为该分类树下的节点路径
    scheme: str = ""
    path_prefix: str = "/"
    recursive: bool = True


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: UserRole
    username: str
    is_admin: bool = False
    capabilities: dict[str, list[str]] = Field(default_factory=dict)
    permissions: list[PermissionItem] = Field(default_factory=list)


class LoginIn(BaseModel):
    username: str
    password: str


class UserCreate(BaseModel):
    username: str = Field(min_length=2, max_length=64)
    password: str = Field(min_length=4, max_length=128)
    role: UserRole = UserRole.viewer
    permissions: list[PermissionItem] = Field(default_factory=list)


class UserUpdate(BaseModel):
    password: str | None = None
    role: UserRole | None = None
    is_active: bool | None = None


class UserOut(ORMModel):
    id: int
    username: str
    role: UserRole
    is_active: bool
    created_at: datetime
    is_admin: bool = False
    capabilities: dict[str, list[str]] = Field(default_factory=dict)
    permissions: list[PermissionItem] = Field(default_factory=list)


class UserPermissionsPut(BaseModel):
    permissions: list[PermissionItem]


# -------- Folders --------
class FolderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    parent_id: int | None = None


class FolderUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    parent_id: int | None = None
    sort_order: int | None = None


class FolderReorderIn(BaseModel):
    """同级文件夹排序：parent_id=null 表示根级。"""
    parent_id: int | None = None
    ordered_ids: list[int]


class FolderOut(ORMModel):
    id: int
    parent_id: int | None
    name: str
    path: str
    sort_order: int = 0
    created_at: datetime
    clip_count: int = 0
    child_count: int = 0


# -------- Taxonomies --------
class TaxonomySchemeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    key: str | None = Field(default=None, max_length=64)
    code_prefix: str | None = Field(default=None, max_length=8)
    description: str = ""
    sort_order: int | None = None


class TaxonomySchemeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    description: str | None = None
    sort_order: int | None = None
    code_prefix: str | None = Field(default=None, max_length=8)


class TaxonomySchemeReorder(BaseModel):
    ordered_keys: list[str] = Field(min_length=1)


class TaxonomySchemeOut(ORMModel):
    key: str
    name: str
    code_prefix: str
    sort_order: int = 0
    builtin: bool = False
    description: str = ""
    created_at: datetime | None = None
    node_count: int = 0


class TaxonomyNodeCreate(BaseModel):
    scheme: str
    parent_id: int | None = None
    name: str = Field(min_length=1, max_length=128)
    code: str = ""
    description: str = ""
    sort_order: int | None = None


class TaxonomyNodeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    code: str | None = None
    description: str | None = None
    parent_id: int | None = None
    sort_order: int | None = None


class TaxonomyNodeReorder(BaseModel):
    """同级节点排序：parent_id=null 表示根级。默认按新顺序重编号码。"""
    parent_id: int | None = None
    ordered_ids: list[int]
    renumber_codes: bool = True


class TaxonomyNodeOut(ORMModel):
    id: int
    scheme: str
    parent_id: int | None
    code: str
    name: str
    path: str
    sort_order: int = 0
    description: str = ""
    clip_count: int = 0
    child_count: int = 0


class TaxonomyTagBrief(ORMModel):
    id: int
    scheme: str
    code: str = ""
    name: str
    path: str


# -------- Clips --------
class ClipCreate(BaseModel):
    folder_id: int | None = None
    atomic_tag_id: int | None = None
    intent_tag_id: int | None = None
    style_tag_id: int | None = None
    # scheme_key -> node_id (null clears). Keyword tags remain in `tags`.
    taxonomy_tag_ids: dict[str, int | None] = Field(default_factory=dict)
    category: str = ""
    subcategory: str = ""
    summary: str = ""
    description: str = ""
    action_code: str = ""
    action_name: str = ""
    brief: str = ""
    detail_def: str = ""
    action_version: str = ""
    routine_label: str = ""
    duel_label: str = ""
    compute_level: str = ""
    multimodal_overall: str = ""
    multimodal_segment: str = ""
    multimodal_atomic: str = ""
    tags: list[str] = Field(default_factory=list)
    duration_sec: float | None = None


class ClipUpdate(BaseModel):
    folder_id: int | None = None
    atomic_tag_id: int | None = None
    intent_tag_id: int | None = None
    style_tag_id: int | None = None
    taxonomy_tag_ids: dict[str, int | None] | None = None
    category: str | None = None
    subcategory: str | None = None
    summary: str | None = None
    description: str | None = None
    action_code: str | None = None
    action_name: str | None = None
    brief: str | None = None
    detail_def: str | None = None
    action_version: str | None = None
    routine_label: str | None = None
    duel_label: str | None = None
    compute_level: str | None = None
    multimodal_overall: str | None = None
    multimodal_segment: str | None = None
    multimodal_atomic: str | None = None
    tags: list[str] | None = None
    duration_sec: float | None = None
    sort_order: int | None = None


class ClipReorderIn(BaseModel):
    folder_id: int
    ordered_ids: list[int]


class ClipBatchIn(BaseModel):
    """批量移动或删除动作条目。"""

    action: str  # move | delete
    clip_ids: list[int]
    folder_id: int | None = None  # move 时必填


# 数据评价：'' 未评价 / pass 直接通过 / needs_fix 需要修改 / discard 建议丢弃
REVIEW_VALUES = {"", "pass", "needs_fix", "discard"}


class HumanFileOut(ORMModel):
    id: int
    clip_id: int
    format: str
    label: str = "v1"
    fps: float | None
    frame_count: int | None
    quality: QualityLevel
    review: str = ""
    original_name: str
    checksum: str | None
    preview_path: str | None
    process_status: str
    process_message: str | None
    meta: dict[str, Any]
    created_at: datetime
    can_download: bool = False


class RobotFileOut(ORMModel):
    id: int
    clip_id: int
    robot_model_id: int
    stage: RobotStage
    format: str
    label: str = "v1"
    fps: float | None
    frame_count: int | None
    quality: QualityLevel
    review: str = ""
    original_name: str
    checksum: str | None
    preview_path: str | None
    process_status: str
    process_message: str | None
    meta: dict[str, Any]
    created_at: datetime
    robot_model_name: str | None = None
    can_download: bool = False


# 视频类型：human 真人视频 | robot_motion motion播放 | robot_policy_sim 策略仿真 | robot_policy_real 策略真机
VIDEO_KINDS = {"human", "robot_motion", "robot_policy_sim", "robot_policy_real"}


class RealVideoOut(ORMModel):
    id: int
    clip_id: int
    kind: str = "human"
    quality: QualityLevel
    review: str = ""
    original_name: str
    checksum: str | None
    duration_sec: float | None
    meta: dict[str, Any]
    created_at: datetime
    can_download: bool = False


class RealVideoUpdate(BaseModel):
    kind: str | None = None
    quality: QualityLevel | None = None
    review: str | None = None
    original_name: str | None = Field(default=None, max_length=512)
    duration_sec: float | None = None


class SharedTextOut(ORMModel):
    id: int
    clip_id: int
    format: str
    label: str = "v1"
    review: str = ""
    original_name: str
    checksum: str | None
    meta: dict[str, Any]
    created_at: datetime
    can_download: bool = False


class SharedTextUpdate(BaseModel):
    review: str | None = None
    label: str | None = Field(default=None, max_length=64)
    original_name: str | None = Field(default=None, max_length=512)


class SliceInfoOut(BaseModel):
    has_file: bool = False
    original_name: str | None = None
    checksum: str | None = None
    can_download: bool = False


class ClipOut(ORMModel):
    id: int
    folder_id: int | None = None
    folder_path: str = "/未分类/"
    atomic_tag_id: int | None = None
    intent_tag_id: int | None = None
    style_tag_id: int | None = None
    atomic_tag: TaxonomyTagBrief | None = None
    intent_tag: TaxonomyTagBrief | None = None
    style_tag: TaxonomyTagBrief | None = None
    taxonomy_tags: dict[str, TaxonomyTagBrief] = Field(default_factory=dict)
    category: str
    subcategory: str
    summary: str
    description: str
    action_code: str = ""
    action_name: str = ""
    brief: str = ""
    detail_def: str = ""
    action_version: str = ""
    routine_label: str = ""
    duel_label: str = ""
    compute_level: str = ""
    multimodal_overall: str = ""
    multimodal_segment: str = ""
    multimodal_atomic: str = ""
    tags: list[str]
    duration_sec: float | None
    sort_order: int = 0
    thumbnail_path: str | None
    created_by: int | None
    updated_by: int | None
    created_at: datetime
    updated_at: datetime
    human_files: list[HumanFileOut] = Field(default_factory=list)
    robot_files: list[RobotFileOut] = Field(default_factory=list)
    real_videos: list[RealVideoOut] = Field(default_factory=list)
    shared_texts: list[SharedTextOut] = Field(default_factory=list)
    slice_info: SliceInfoOut = Field(default_factory=SliceInfoOut)
    can_download: bool = False
    can_edit: bool = False
    can_annotate: bool = False
    can_upload: bool = False


class ClipListItem(ORMModel):
    id: int
    folder_id: int | None = None
    folder_path: str = "/未分类/"
    atomic_tag_id: int | None = None
    intent_tag_id: int | None = None
    style_tag_id: int | None = None
    atomic_tag: TaxonomyTagBrief | None = None
    intent_tag: TaxonomyTagBrief | None = None
    style_tag: TaxonomyTagBrief | None = None
    taxonomy_tags: dict[str, TaxonomyTagBrief] = Field(default_factory=dict)
    category: str
    subcategory: str
    summary: str
    description: str
    action_code: str = ""
    action_name: str = ""
    action_version: str = ""
    tags: list[str]
    duration_sec: float | None
    sort_order: int = 0
    thumbnail_path: str | None
    created_at: datetime
    human_formats: list[str] = Field(default_factory=list)
    robot_stages: list[str] = Field(default_factory=list)
    robot_models: list[str] = Field(default_factory=list)
    shared_formats: list[str] = Field(default_factory=list)
    video_kinds: list[str] = Field(default_factory=list)
    has_slice: bool = False
    has_video: bool = False


class SearchResult(BaseModel):
    total: int
    page: int
    page_size: int
    items: list[ClipListItem]


class HumanFileUpdate(BaseModel):
    quality: QualityLevel | None = None
    review: str | None = None
    fps: float | None = None
    frame_count: int | None = None
    label: str | None = Field(default=None, max_length=64)
    original_name: str | None = Field(default=None, max_length=512)


class RobotFileUpdate(BaseModel):
    quality: QualityLevel | None = None
    review: str | None = None
    fps: float | None = None
    frame_count: int | None = None
    stage: RobotStage | None = None
    label: str | None = Field(default=None, max_length=64)
    original_name: str | None = Field(default=None, max_length=512)


# -------- Robot models --------
class RobotModelCreate(BaseModel):
    name: str
    description: str = ""
    joint_names: list[str] = Field(default_factory=list)


class RobotModelUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    joint_names: list[str] | None = None


class RobotModelOut(ORMModel):
    id: int
    name: str
    description: str
    urdf_path: str
    package_path: str
    joint_names: list[str]
    meta: dict[str, Any]
    created_at: datetime


# -------- 3D model assets --------
MODEL_ASSET_CATEGORIES = {"human", "robot"}
HUMAN_MODEL_FORMATS = {"fbx", "bvh", "smpl", "blend", "blender"}
ROBOT_MODEL_FORMATS = {"urdf", "xml", "fbx", "blend", "blender"}


class ModelAssetOut(ORMModel):
    id: int
    category: str
    name: str
    format: str
    description: str
    original_name: str
    checksum: str | None
    meta: dict[str, Any]
    created_at: datetime


class ModelAssetUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=256)
    description: str | None = None
    original_name: str | None = Field(default=None, max_length=512)


# -------- Batch import --------
class BatchHumanFile(BaseModel):
    format: str
    path: str
    quality: QualityLevel = QualityLevel.medium
    fps: float | None = None
    frame_count: int | None = None


class BatchRobotFile(BaseModel):
    robot_model: str
    stage: RobotStage
    path: str
    format: str = "csv"
    quality: QualityLevel = QualityLevel.medium
    fps: float | None = None
    frame_count: int | None = None


class BatchClipItem(BaseModel):
    folder_path: str | None = None
    category: str = ""
    subcategory: str = ""
    summary: str = ""
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    duration_sec: float | None = None
    human_files: list[BatchHumanFile] = Field(default_factory=list)
    robot_files: list[BatchRobotFile] = Field(default_factory=list)


class BatchImportIn(BaseModel):
    """相对路径相对于服务器 DATA_ROOT/import staging 或绝对路径（容器内）。"""
    items: list[BatchClipItem]
    copy_files: bool = True


class BatchImportOut(BaseModel):
    created_clip_ids: list[int]
    warnings: list[str]


class HumanZipClipOut(BaseModel):
    clip_id: int
    summary: str
    formats: list[str]


class HumanZipImportOut(BaseModel):
    created_clip_ids: list[int]
    clips: list[HumanZipClipOut]
    warnings: list[str]
    skipped: int = 0
    folder_id: int | None = None
    folder_path: str = ""
    folder_name: str = ""


class FolderEnsureIn(BaseModel):
    """按名称确保文件夹存在（已存在则复用）。"""
    name: str = Field(min_length=1, max_length=128)
    parent_id: int | None = None


class AuditLogOut(ORMModel):
    id: int
    user_id: int | None
    action: str
    entity_type: str
    entity_id: int | None
    detail: dict[str, Any]
    created_at: datetime
