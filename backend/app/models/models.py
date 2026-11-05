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
from .enums import Capability, UserRole


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
