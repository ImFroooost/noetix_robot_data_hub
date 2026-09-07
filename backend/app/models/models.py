from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base
from .enums import Capability, QualityLevel, RobotStage, UserRole


def utcnow():
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(128))
    role: Mapped[UserRole] = mapped_column(
        Enum(UserRole, native_enum=False, length=32), default=UserRole.visitor
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    clips_created = relationship("MotionClip", back_populates="creator", foreign_keys="MotionClip.created_by")
    permissions = relationship(
        "UserPermission", back_populates="user", cascade="all, delete-orphan"
    )


class Folder(Base):
    __tablename__ = "folders"
    __table_args__ = (UniqueConstraint("path", name="uq_folders_path"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("folders.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(128), default="")
    path: Mapped[str] = mapped_column(String(1024), index=True)  # e.g. /行走/户外/
    sort_order: Mapped[int] = mapped_column(Integer, default=0, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    parent = relationship("Folder", remote_side="Folder.id", back_populates="children")
    children = relationship("Folder", back_populates="parent")
    clips = relationship("MotionClip", back_populates="folder")


class UserPermission(Base):
    __tablename__ = "user_permissions"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "capability",
            "scheme",
            "path_prefix",
            name="uq_user_perm_cap_scheme_path",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    capability: Mapped[Capability] = mapped_column(
        Enum(Capability, native_enum=False, length=32), index=True
    )
    # ""=按文件夹树；否则为分类标准 key（atomic/intent/style/custom...）
    scheme: Mapped[str] = mapped_column(String(64), default="", index=True)
    path_prefix: Mapped[str] = mapped_column(String(1024), default="/")
    recursive: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    user = relationship("User", back_populates="permissions")


class TaxonomySchemeDef(Base):
    """Registry of classification standards (built-in + custom)."""

    __tablename__ = "taxonomy_schemes"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(128), default="")
    code_prefix: Mapped[str] = mapped_column(String(8), unique=True, index=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, index=True)
    builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    description: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class TaxonomyNode(Base):
    __tablename__ = "taxonomy_nodes"
    __table_args__ = (
        UniqueConstraint("scheme", "path", name="uq_taxonomy_scheme_path"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Scheme key string (e.g. atomic / intent / style / custom_xxx)
    scheme: Mapped[str] = mapped_column(String(64), index=True)
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("taxonomy_nodes.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    code: Mapped[str] = mapped_column(String(64), default="", index=True)
    name: Mapped[str] = mapped_column(String(128), default="")
    path: Mapped[str] = mapped_column(String(1024), index=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    parent = relationship("TaxonomyNode", remote_side="TaxonomyNode.id", back_populates="children")
    children = relationship("TaxonomyNode", back_populates="parent")


class ClipTaxonomyTag(Base):
    """Per-clip tag for one taxonomy scheme (at most one node per scheme)."""

    __tablename__ = "clip_taxonomy_tags"
    __table_args__ = (
        UniqueConstraint("clip_id", "scheme", name="uq_clip_taxonomy_scheme"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    clip_id: Mapped[int] = mapped_column(
        ForeignKey("motion_clips.id", ondelete="CASCADE"), index=True
    )
    scheme: Mapped[str] = mapped_column(String(64), index=True)
    node_id: Mapped[int] = mapped_column(
        ForeignKey("taxonomy_nodes.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    clip = relationship("MotionClip", back_populates="taxonomy_tag_rows")
    node = relationship("TaxonomyNode")


class MotionClip(Base):
    __tablename__ = "motion_clips"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    folder_id: Mapped[int | None] = mapped_column(
        ForeignKey("folders.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    atomic_tag_id: Mapped[int | None] = mapped_column(
        ForeignKey("taxonomy_nodes.id", ondelete="SET NULL"), nullable=True, index=True
    )
    intent_tag_id: Mapped[int | None] = mapped_column(
        ForeignKey("taxonomy_nodes.id", ondelete="SET NULL"), nullable=True, index=True
    )
    style_tag_id: Mapped[int | None] = mapped_column(
        ForeignKey("taxonomy_nodes.id", ondelete="SET NULL"), nullable=True, index=True
    )
    category: Mapped[str] = mapped_column(String(128), index=True, default="")  # legacy
    subcategory: Mapped[str] = mapped_column(String(128), index=True, default="")  # legacy
    summary: Mapped[str] = mapped_column(String(512), default="")  # 可作动作名称兜底
    description: Mapped[str] = mapped_column(Text, default="")  # 动作详细描述
    # —— 动作定义 / 版本 / 多模态（对齐数据表字段）——
    action_code: Mapped[str] = mapped_column(String(128), default="", index=True)  # 动作ID（业务）
    action_name: Mapped[str] = mapped_column(String(512), default="")  # 动作名称
    brief: Mapped[str] = mapped_column(String(1024), default="")  # 动作简释
    detail_def: Mapped[str] = mapped_column(Text, default="")  # 动作详细定义
    action_version: Mapped[str] = mapped_column(String(64), default="")  # 动作版本号
    routine_label: Mapped[str] = mapped_column(String(256), default="")  # 动作分级·套路
    duel_label: Mapped[str] = mapped_column(String(256), default="")  # 动作分级·决斗
    compute_level: Mapped[str] = mapped_column(String(64), default="")  # 算力级别
    multimodal_overall: Mapped[str] = mapped_column(Text, default="")  # 多模态·整体描述
    multimodal_segment: Mapped[str] = mapped_column(Text, default="")  # 多模态·分段描述
    multimodal_atomic: Mapped[str] = mapped_column(Text, default="")  # 多模态·原子描述
    tags: Mapped[list] = mapped_column(ARRAY(String), default=list)
    duration_sec: Mapped[float | None] = mapped_column(Float, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, index=True)
    thumbnail_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    slice_json_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    slice_json_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    slice_json_checksum: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    folder = relationship("Folder", back_populates="clips")
    atomic_tag = relationship("TaxonomyNode", foreign_keys=[atomic_tag_id])
    intent_tag = relationship("TaxonomyNode", foreign_keys=[intent_tag_id])
    style_tag = relationship("TaxonomyNode", foreign_keys=[style_tag_id])
    taxonomy_tag_rows = relationship(
        "ClipTaxonomyTag", back_populates="clip", cascade="all, delete-orphan"
    )
    creator = relationship("User", foreign_keys=[created_by], back_populates="clips_created")
    human_files = relationship(
        "HumanMotionFile", back_populates="clip", cascade="all, delete-orphan"
    )
    robot_files = relationship(
        "RobotMotionFile", back_populates="clip", cascade="all, delete-orphan"
    )
    real_videos = relationship(
        "RealVideo", back_populates="clip", cascade="all, delete-orphan"
    )
    shared_texts = relationship(
        "SharedTextFile", back_populates="clip", cascade="all, delete-orphan"
    )


class HumanMotionFile(Base):
    __tablename__ = "human_motion_files"
    __table_args__ = (
        UniqueConstraint("clip_id", "format", "label", name="uq_human_clip_format_label"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    clip_id: Mapped[int] = mapped_column(ForeignKey("motion_clips.id", ondelete="CASCADE"), index=True)
    format: Mapped[str] = mapped_column(String(32), index=True)  # bvh/smpl/csv/fbx/npz/...
    label: Mapped[str] = mapped_column(String(64), default="v1")  # version label within format
    fps: Mapped[float | None] = mapped_column(Float, nullable=True)
    frame_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    quality: Mapped[QualityLevel] = mapped_column(Enum(QualityLevel), default=QualityLevel.medium)
    # 数据评价：'' 未评价 / pass 直接通过 / needs_fix 需要修改 / discard 建议丢弃
    review: Mapped[str] = mapped_column(String(32), default="", index=True)
    file_path: Mapped[str] = mapped_column(String(1024))
    original_name: Mapped[str] = mapped_column(String(512), default="")
    checksum: Mapped[str | None] = mapped_column(String(64), nullable=True)
    preview_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    process_status: Mapped[str] = mapped_column(String(32), default="pending")  # pending/done/error
    process_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    meta: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    clip = relationship("MotionClip", back_populates="human_files")


class RealVideo(Base):
    __tablename__ = "real_videos"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    clip_id: Mapped[int] = mapped_column(
        ForeignKey("motion_clips.id", ondelete="CASCADE"), index=True
    )
    # human=真人视频；robot_motion=motion播放；robot_policy_sim=策略仿真；robot_policy_real=策略真机
    kind: Mapped[str] = mapped_column(String(32), default="human", index=True)
    quality: Mapped[QualityLevel] = mapped_column(Enum(QualityLevel), default=QualityLevel.medium)
    review: Mapped[str] = mapped_column(String(32), default="", index=True)
    file_path: Mapped[str] = mapped_column(String(1024))
    original_name: Mapped[str] = mapped_column(String(512), default="")
    checksum: Mapped[str | None] = mapped_column(String(64), nullable=True)
    duration_sec: Mapped[float | None] = mapped_column(Float, nullable=True)
    meta: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    clip = relationship("MotionClip", back_populates="real_videos")


class SharedTextFile(Base):
    """人机共享·文本描述文件（txt/json/…）。"""

    __tablename__ = "shared_text_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    clip_id: Mapped[int] = mapped_column(
        ForeignKey("motion_clips.id", ondelete="CASCADE"), index=True
    )
    format: Mapped[str] = mapped_column(String(32), index=True)  # txt/json/md/...
    label: Mapped[str] = mapped_column(String(64), default="v1")
    file_path: Mapped[str] = mapped_column(String(1024))
    original_name: Mapped[str] = mapped_column(String(512), default="")
    checksum: Mapped[str | None] = mapped_column(String(64), nullable=True)
    review: Mapped[str] = mapped_column(String(32), default="", index=True)
    meta: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    clip = relationship("MotionClip", back_populates="shared_texts")


class ModelAsset(Base):
    """3D 模型库文件：人体（fbx/bvh/smpl/blender）与机器人（urdf/xml/fbx/blender）。"""

    __tablename__ = "model_assets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    category: Mapped[str] = mapped_column(String(32), index=True)  # human / robot
    name: Mapped[str] = mapped_column(String(256), default="", index=True)
    format: Mapped[str] = mapped_column(String(32), index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    file_path: Mapped[str] = mapped_column(String(1024))
    original_name: Mapped[str] = mapped_column(String(512), default="")
    checksum: Mapped[str | None] = mapped_column(String(64), nullable=True)
    meta: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class RobotModel(Base):
    __tablename__ = "robot_models"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    urdf_path: Mapped[str] = mapped_column(String(1024))
    package_path: Mapped[str] = mapped_column(String(1024))
    joint_names: Mapped[list] = mapped_column(ARRAY(String), default=list)
    meta: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    motion_files = relationship("RobotMotionFile", back_populates="robot_model")


class RobotMotionFile(Base):
    __tablename__ = "robot_motion_files"
    __table_args__ = (
        UniqueConstraint(
            "clip_id",
            "robot_model_id",
            "stage",
            "format",
            "label",
            name="uq_robot_clip_model_stage_fmt_label",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    clip_id: Mapped[int] = mapped_column(ForeignKey("motion_clips.id", ondelete="CASCADE"), index=True)
    robot_model_id: Mapped[int] = mapped_column(
        ForeignKey("robot_models.id", ondelete="RESTRICT"), index=True
    )
    stage: Mapped[RobotStage] = mapped_column(Enum(RobotStage), index=True)
    format: Mapped[str] = mapped_column(String(32), default="csv", index=True)
    label: Mapped[str] = mapped_column(String(64), default="v1")
    fps: Mapped[float | None] = mapped_column(Float, nullable=True)
    frame_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    quality: Mapped[QualityLevel] = mapped_column(Enum(QualityLevel), default=QualityLevel.medium)
    review: Mapped[str] = mapped_column(String(32), default="", index=True)
    file_path: Mapped[str] = mapped_column(String(1024))
    original_name: Mapped[str] = mapped_column(String(512), default="")
    checksum: Mapped[str | None] = mapped_column(String(64), nullable=True)
    preview_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    process_status: Mapped[str] = mapped_column(String(32), default="pending")
    process_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    meta: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    clip = relationship("MotionClip", back_populates="robot_files")
    robot_model = relationship("RobotModel", back_populates="motion_files")


class ActionUnit(Base):
    """动作数据单元：由「动作定义」维度唯一确定。"""

    __tablename__ = "action_units"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    action_id: Mapped[str] = mapped_column(String(256), unique=True, index=True)
    # 完整动作定义维度（atomic_action/type/style/name/...）
    action_def: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    files = relationship(
        "RepoFile", back_populates="action_unit", cascade="all, delete-orphan"
    )


class RepoFile(Base):
    """仓库文件：工程标记 × 数据类型 × 重复性标记 在动作单元内唯一定位。"""

    __tablename__ = "repo_files"
    __table_args__ = (
        UniqueConstraint("action_unit_id", "dim_key", name="uq_repo_file_action_dim"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    action_unit_id: Mapped[int] = mapped_column(
        ForeignKey("action_units.id", ondelete="CASCADE"), index=True
    )
    # engineering + data_type + replica
    dimensions: Mapped[dict] = mapped_column(JSONB, default=dict)
    dim_key: Mapped[str] = mapped_column(String(1024), default="")
    modality: Mapped[str] = mapped_column(String(32), index=True)  # motion/video/language
    ontology: Mapped[str] = mapped_column(String(32), index=True)  # human/robot
    format: Mapped[str] = mapped_column(String(64), index=True)
    source_name: Mapped[str] = mapped_column(String(256), default="", index=True)
    repo_path: Mapped[str] = mapped_column(String(1024), unique=True)
    original_name: Mapped[str] = mapped_column(String(512), default="")
    checksum: Mapped[str | None] = mapped_column(String(64), nullable=True)
    fps: Mapped[float | None] = mapped_column(Float, nullable=True)
    meta: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    action_unit = relationship("ActionUnit", back_populates="files")


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    action: Mapped[str] = mapped_column(String(64), index=True)
    entity_type: Mapped[str] = mapped_column(String(64), index=True)
    entity_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    detail: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
