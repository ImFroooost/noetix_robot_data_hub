from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings

engine = create_engine(settings.database_url, pool_pre_ping=True, pool_size=10)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _column_exists(conn, table: str, column: str) -> bool:
    row = conn.execute(
        text(
            """
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = :t AND column_name = :c
            """
        ),
        {"t": table, "c": column},
    ).first()
    return row is not None


def _constraint_exists(conn, table: str, name: str) -> bool:
    row = conn.execute(
        text(
            """
            SELECT 1 FROM information_schema.table_constraints
            WHERE table_schema = 'public' AND table_name = :t AND constraint_name = :n
            """
        ),
        {"t": table, "n": name},
    ).first()
    return row is not None


def _exec_optional(conn, stmt: str) -> None:
    """Run DDL that may fail without aborting the outer transaction (PG savepoint)."""
    sp = conn.begin_nested()
    try:
        conn.execute(text(stmt))
        sp.commit()
    except Exception:
        sp.rollback()


def _migrate_schema(conn):
    """Add new columns/tables-compatible alters for existing deployments."""
    alters = [
        (
            "motion_clips",
            "folder_id",
            "ALTER TABLE motion_clips ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE RESTRICT",
        ),
        (
            "motion_clips",
            "slice_json_path",
            "ALTER TABLE motion_clips ADD COLUMN slice_json_path VARCHAR(1024)",
        ),
        (
            "motion_clips",
            "slice_json_name",
            "ALTER TABLE motion_clips ADD COLUMN slice_json_name VARCHAR(512)",
        ),
        (
            "motion_clips",
            "slice_json_checksum",
            "ALTER TABLE motion_clips ADD COLUMN slice_json_checksum VARCHAR(64)",
        ),
        (
            "folders",
            "sort_order",
            "ALTER TABLE folders ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "motion_clips",
            "sort_order",
            "ALTER TABLE motion_clips ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "motion_clips",
            "atomic_tag_id",
            "ALTER TABLE motion_clips ADD COLUMN atomic_tag_id INTEGER REFERENCES taxonomy_nodes(id) ON DELETE SET NULL",
        ),
        (
            "motion_clips",
            "intent_tag_id",
            "ALTER TABLE motion_clips ADD COLUMN intent_tag_id INTEGER REFERENCES taxonomy_nodes(id) ON DELETE SET NULL",
        ),
        (
            "motion_clips",
            "style_tag_id",
            "ALTER TABLE motion_clips ADD COLUMN style_tag_id INTEGER REFERENCES taxonomy_nodes(id) ON DELETE SET NULL",
        ),
        ("motion_clips", "action_code", "ALTER TABLE motion_clips ADD COLUMN action_code VARCHAR(128) NOT NULL DEFAULT ''"),
        ("motion_clips", "action_name", "ALTER TABLE motion_clips ADD COLUMN action_name VARCHAR(512) NOT NULL DEFAULT ''"),
        ("motion_clips", "brief", "ALTER TABLE motion_clips ADD COLUMN brief VARCHAR(1024) NOT NULL DEFAULT ''"),
        ("motion_clips", "detail_def", "ALTER TABLE motion_clips ADD COLUMN detail_def TEXT NOT NULL DEFAULT ''"),
        ("motion_clips", "action_version", "ALTER TABLE motion_clips ADD COLUMN action_version VARCHAR(64) NOT NULL DEFAULT ''"),
        ("motion_clips", "routine_label", "ALTER TABLE motion_clips ADD COLUMN routine_label VARCHAR(256) NOT NULL DEFAULT ''"),
        ("motion_clips", "duel_label", "ALTER TABLE motion_clips ADD COLUMN duel_label VARCHAR(256) NOT NULL DEFAULT ''"),
        ("motion_clips", "compute_level", "ALTER TABLE motion_clips ADD COLUMN compute_level VARCHAR(64) NOT NULL DEFAULT ''"),
        ("motion_clips", "multimodal_overall", "ALTER TABLE motion_clips ADD COLUMN multimodal_overall TEXT NOT NULL DEFAULT ''"),
        ("motion_clips", "multimodal_segment", "ALTER TABLE motion_clips ADD COLUMN multimodal_segment TEXT NOT NULL DEFAULT ''"),
        ("motion_clips", "multimodal_atomic", "ALTER TABLE motion_clips ADD COLUMN multimodal_atomic TEXT NOT NULL DEFAULT ''"),
        ("real_videos", "kind", "ALTER TABLE real_videos ADD COLUMN kind VARCHAR(32) NOT NULL DEFAULT 'human'"),
    ]
    # folders / user_permissions / real_videos / taxonomy_nodes created by create_all
    for table, col, stmt in alters:
        # folders must exist first for FK
        if table == "motion_clips" and col == "folder_id":
            exists = conn.execute(
                text("SELECT to_regclass('public.folders')")
            ).scalar()
            if not exists:
                continue
        if table == "motion_clips" and col.endswith("_tag_id"):
            exists = conn.execute(
                text("SELECT to_regclass('public.taxonomy_nodes')")
            ).scalar()
            if not exists:
                continue
        if not _column_exists(conn, table, col):
            conn.execute(text(stmt))
    if _column_exists(conn, "motion_clips", "folder_id"):
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_motion_clips_folder_id ON motion_clips (folder_id)"
            )
        )
    for col in ("atomic_tag_id", "intent_tag_id", "style_tag_id", "action_code"):
        if _column_exists(conn, "motion_clips", col):
            conn.execute(
                text(f"CREATE INDEX IF NOT EXISTS ix_motion_clips_{col} ON motion_clips ({col})")
            )
    if _column_exists(conn, "real_videos", "kind"):
        conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_real_videos_kind ON real_videos (kind)")
        )

    # taxonomy_nodes.scheme: enum -> varchar for custom schemes
    if _column_exists(conn, "taxonomy_nodes", "scheme"):
        row = conn.execute(
            text(
                """
                SELECT data_type, udt_name
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'taxonomy_nodes' AND column_name = 'scheme'
                """
            )
        ).first()
        if row and row[0] == "USER-DEFINED":
            conn.execute(
                text(
                    "ALTER TABLE taxonomy_nodes "
                    "ALTER COLUMN scheme TYPE VARCHAR(64) USING scheme::text"
                )
            )
            # Drop leftover enum type if unused
            for typ in ("taxonomyscheme", "taxonomy_scheme"):
                _exec_optional(conn, f"DROP TYPE IF EXISTS {typ}")

    # Multi-version human/robot files: add label + replace unique constraints
    if _column_exists(conn, "human_motion_files", "format") and not _column_exists(
        conn, "human_motion_files", "label"
    ):
        conn.execute(
            text(
                "ALTER TABLE human_motion_files "
                "ADD COLUMN label VARCHAR(64) NOT NULL DEFAULT 'v1'"
            )
        )
    if _column_exists(conn, "robot_motion_files", "format") and not _column_exists(
        conn, "robot_motion_files", "label"
    ):
        conn.execute(
            text(
                "ALTER TABLE robot_motion_files "
                "ADD COLUMN label VARCHAR(64) NOT NULL DEFAULT 'v1'"
            )
        )
    # Drop old uniques if present; add label-aware uniques
    for old in ("uq_human_clip_format",):
        _exec_optional(conn, f"ALTER TABLE human_motion_files DROP CONSTRAINT IF EXISTS {old}")
    for old in ("uq_robot_clip_model_stage_fmt",):
        _exec_optional(conn, f"ALTER TABLE robot_motion_files DROP CONSTRAINT IF EXISTS {old}")
    if not _constraint_exists(conn, "human_motion_files", "uq_human_clip_format_label"):
        _exec_optional(
            conn,
            "ALTER TABLE human_motion_files "
            "ADD CONSTRAINT uq_human_clip_format_label UNIQUE (clip_id, format, label)",
        )
    if not _constraint_exists(
        conn, "robot_motion_files", "uq_robot_clip_model_stage_fmt_label"
    ):
        _exec_optional(
            conn,
            "ALTER TABLE robot_motion_files "
            "ADD CONSTRAINT uq_robot_clip_model_stage_fmt_label "
            "UNIQUE (clip_id, robot_model_id, stage, format, label)",
        )


def _migrate_data(db):
    from .models import Capability, Folder, MotionClip, User, UserPermission, UserRole
    from .services.permissions import (
        ALL_CAPABILITIES,
        ensure_trash_folder,
        ensure_unclassified_folder,
        get_or_create_folder_by_path,
        normalize_path,
        set_user_permissions,
    )
    from .services.taxonomy_schemes import (
        backfill_clip_taxonomy_tags,
        ensure_builtin_schemes,
    )

    unclassified = ensure_unclassified_folder(db)
    ensure_trash_folder(db)

    # Initialize folder sort_order per sibling group if all zeros
    from collections import defaultdict

    by_parent: dict = defaultdict(list)
    for f in db.query(Folder).order_by(Folder.name.asc(), Folder.id.asc()).all():
        by_parent[f.parent_id].append(f)
    for siblings in by_parent.values():
        if all((getattr(s, "sort_order", 0) or 0) == 0 for s in siblings):
            for idx, s in enumerate(siblings):
                s.sort_order = idx

    # Assign folders from legacy category/subcategory
    clips = db.query(MotionClip).filter(MotionClip.folder_id.is_(None)).all()
    for clip in clips:
        cat = (clip.category or "").strip()
        sub = (clip.subcategory or "").strip()
        if cat and sub:
            path = normalize_path(f"/{cat}/{sub}/")
        elif cat:
            path = normalize_path(f"/{cat}/")
        else:
            clip.folder_id = unclassified.id
            continue
        try:
            folder = get_or_create_folder_by_path(db, path)
            clip.folder_id = folder.id
        except Exception:
            clip.folder_id = unclassified.id

    # Migrate legacy roles to path permissions once (users with zero perms)
    users = db.query(User).all()
    for user in users:
        count = (
            db.query(UserPermission).filter(UserPermission.user_id == user.id).count()
        )
        if count > 0 or user.role == UserRole.admin:
            continue
        if user.role == UserRole.editor:
            set_user_permissions(
                db,
                user,
                [
                    {"capability": c, "path_prefix": "/", "recursive": True}
                    for c in ALL_CAPABILITIES
                ],
            )
        else:
            # viewer and others: browse only on /
            set_user_permissions(
                db,
                user,
                [{"capability": Capability.browse, "path_prefix": "/", "recursive": True}],
            )

    # Seed / rebuild taxonomy trees + heuristic map from legacy folders
    from .services.taxonomy_seed import apply_folder_heuristic_to_clips, ensure_taxonomies

    ensure_builtin_schemes(db)
    ensure_taxonomies(db)
    apply_folder_heuristic_to_clips(db)
    backfill_clip_taxonomy_tags(db)
    db.commit()


def init_db():
    """Create tables and enable pg_trgm for fuzzy search."""
    from . import models  # noqa: F401

    with engine.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
    Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        _migrate_schema(conn)
        for stmt in [
            "CREATE INDEX IF NOT EXISTS ix_clips_category_trgm ON motion_clips USING gin (category gin_trgm_ops)",
            "CREATE INDEX IF NOT EXISTS ix_clips_subcategory_trgm ON motion_clips USING gin (subcategory gin_trgm_ops)",
            "CREATE INDEX IF NOT EXISTS ix_clips_summary_trgm ON motion_clips USING gin (summary gin_trgm_ops)",
            "CREATE INDEX IF NOT EXISTS ix_clips_description_trgm ON motion_clips USING gin (description gin_trgm_ops)",
            "CREATE INDEX IF NOT EXISTS ix_clips_tags_gin ON motion_clips USING gin (tags)",
            "CREATE INDEX IF NOT EXISTS ix_folders_path ON folders (path)",
        ]:
            try:
                conn.execute(text(stmt))
            except Exception:
                pass

    db = SessionLocal()
    try:
        _migrate_data(db)
    finally:
        db.close()
