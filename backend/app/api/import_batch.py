import json
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..core.deps import get_current_user
from ..database import get_db
from ..models import Capability, Folder, HumanMotionFile, MotionClip, RobotModel, RobotMotionFile, User
from ..models.enums import QualityLevel
from ..schemas import BatchImportIn, BatchImportOut, HumanZipClipOut, HumanZipImportOut
from ..services.audit import write_audit
from ..services.human_zip import extract_and_group_zip, folder_name_from_zip_filename
from ..services.permissions import (
    ensure_capability,
    ensure_unclassified_folder,
    get_or_create_folder_by_path,
    join_folder_path,
    normalize_path,
)
from ..services.queue import enqueue_process_human, enqueue_process_robot
from ..services.storage import copy_into_storage, data_root

router = APIRouter(prefix="/import", tags=["import"])


@router.post("/batch", response_model=BatchImportOut)
def batch_import(
    body: BatchImportIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    root = data_root()
    created: list[int] = []
    warnings: list[str] = []

    for idx, item in enumerate(body.items):
        if item.folder_path:
            folder = get_or_create_folder_by_path(db, item.folder_path)
        elif item.category:
            path = (
                normalize_path(f"/{item.category}/{item.subcategory}/")
                if item.subcategory
                else normalize_path(f"/{item.category}/")
            )
            folder = get_or_create_folder_by_path(db, path)
        else:
            folder = ensure_unclassified_folder(db)
        ensure_capability(db, user, Capability.upload, folder.path)

        clip = MotionClip(
            folder_id=folder.id,
            category=item.category,
            subcategory=item.subcategory,
            summary=item.summary,
            description=item.description,
            tags=item.tags,
            duration_sec=item.duration_sec,
            created_by=user.id,
            updated_by=user.id,
        )
        db.add(clip)
        db.flush()

        for hf in item.human_files:
            src = Path(hf.path)
            if not src.is_absolute():
                src = root / "import" / hf.path
            if not src.is_file():
                warnings.append(f"item[{idx}] human {hf.format}: 文件不存在 {src}")
                continue
            try:
                if body.copy_files:
                    rel, checksum = copy_into_storage(src, "human", clip.id)
                else:
                    # store path relative to data root if possible
                    try:
                        rel = str(src.resolve().relative_to(root.resolve()))
                    except ValueError:
                        warnings.append(f"item[{idx}] human: 路径不在 DATA_ROOT 内且 copy_files=false")
                        continue
                    from ..services.storage import checksum_file

                    checksum = checksum_file(src)
            except Exception as e:
                warnings.append(f"item[{idx}] human {hf.format}: {e}")
                continue
            rec = HumanMotionFile(
                clip_id=clip.id,
                format=hf.format.lower(),
                quality=hf.quality,
                fps=hf.fps,
                frame_count=hf.frame_count,
                file_path=rel,
                original_name=src.name,
                checksum=checksum,
                process_status="pending",
            )
            db.add(rec)
            db.flush()
            try:
                enqueue_process_human(rec.id)
            except Exception:
                pass

        for rf in item.robot_files:
            model = db.query(RobotModel).filter(RobotModel.name == rf.robot_model).first()
            if not model:
                warnings.append(f"item[{idx}] robot: 未知型号 {rf.robot_model}")
                continue
            src = Path(rf.path)
            if not src.is_absolute():
                src = root / "import" / rf.path
            if not src.is_file():
                warnings.append(f"item[{idx}] robot {rf.stage}: 文件不存在 {src}")
                continue
            try:
                if body.copy_files:
                    rel, checksum = copy_into_storage(src, "robot", clip.id)
                else:
                    try:
                        rel = str(src.resolve().relative_to(root.resolve()))
                    except ValueError:
                        warnings.append(f"item[{idx}] robot: 路径不在 DATA_ROOT 内且 copy_files=false")
                        continue
                    from ..services.storage import checksum_file

                    checksum = checksum_file(src)
            except Exception as e:
                warnings.append(f"item[{idx}] robot: {e}")
                continue
            rec = RobotMotionFile(
                clip_id=clip.id,
                robot_model_id=model.id,
                stage=rf.stage,
                format=rf.format.lower(),
                quality=rf.quality,
                fps=rf.fps,
                frame_count=rf.frame_count,
                file_path=rel,
                original_name=src.name,
                checksum=checksum,
                process_status="pending",
            )
            db.add(rec)
            db.flush()
            try:
                enqueue_process_robot(rec.id)
            except Exception:
                pass

        write_audit(
            db,
            user_id=user.id,
            action="batch_import",
            entity_type="clip",
            entity_id=clip.id,
            detail={"summary": clip.summary},
        )
        created.append(clip.id)

    db.commit()
    return BatchImportOut(created_clip_ids=created, warnings=warnings)


@router.post("/human-zip", response_model=HumanZipImportOut)
async def import_human_zip(
    file: UploadFile = File(...),
    folder_id: int | None = Form(None),
    folder_name: str = Form(""),
    quality: QualityLevel = Form(QualityLevel.medium),
    summary_prefix: str = Form(""),
    description: str = Form(""),
    tags: str = Form(""),
    taxonomy_tag_ids: str = Form("{}"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Upload a ZIP of human motion files (bvh/csv/fbx/tak/…).

    Files are grouped by normalized basename (``_Skeleton`` stripped) so that
    ``walk_Skeleton.bvh`` + ``walk.csv`` + ``walk.fbx`` + ``walk.tak`` become
    one clip with four human formats.

    Destination folder defaults to the ZIP basename (e.g. ``260729.zip`` → ``/260729/``).
    ``folder_id`` is treated as the *parent* under which that folder is created/reused.
    """
    name = (file.filename or "").lower()
    if not name.endswith(".zip"):
        raise HTTPException(status_code=400, detail="请上传 .zip 文件")

    dest_name = (folder_name or "").strip() or folder_name_from_zip_filename(file.filename)
    parent = None
    parent_path = None
    if folder_id is not None:
        parent = db.get(Folder, folder_id)
        if not parent:
            raise HTTPException(status_code=404, detail="父文件夹不存在")
        parent_path = parent.path
    try:
        dest_path = join_folder_path(parent_path, dest_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    ensure_capability(db, user, Capability.upload, dest_path)
    folder = get_or_create_folder_by_path(db, dest_path)

    try:
        tax_raw = json.loads(taxonomy_tag_ids or "{}")
        if not isinstance(tax_raw, dict):
            raise ValueError("taxonomy_tag_ids 须为 JSON 对象")
        tax_ids: dict[str, int | None] = {}
        for k, v in tax_raw.items():
            if v is None or v == "":
                tax_ids[str(k)] = None
            else:
                tax_ids[str(k)] = int(v)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"taxonomy_tag_ids 无效: {e}") from e

    tag_list = [t.strip() for t in (tags or "").split(",") if t.strip()]
    prefix = (summary_prefix or "").strip()

    staging = data_root() / "import" / "zip_staging" / uuid.uuid4().hex
    staging.mkdir(parents=True, exist_ok=True)
    zip_path = staging / "upload.zip"
    work_dir = staging / "extracted"
    warnings: list[str] = []
    created: list[int] = []
    clips_out: list[HumanZipClipOut] = []
    skipped = 0

    try:
        with zip_path.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)

        try:
            groups, gw = extract_and_group_zip(zip_path, work_dir)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"无法解压 ZIP: {e}") from e
        warnings.extend(gw)

        if not groups:
            raise HTTPException(
                status_code=400,
                detail="ZIP 中未找到可识别的人体数据（支持 bvh/csv/fbx/tak/npz 等）",
            )

        # Import taxonomy helper from clips module
        from .clips import _apply_taxonomy_writes

        max_order = (
            db.query(func.coalesce(func.max(MotionClip.sort_order), -1))
            .filter(MotionClip.folder_id == folder.id)
            .scalar()
        )
        next_order = int(max_order or -1) + 1

        for group in groups:
            if not group.files:
                skipped += 1
                continue
            summary = f"{prefix}{group.display_stem}" if prefix else group.display_stem
            clip = MotionClip(
                folder_id=folder.id,
                category=folder.name if folder else "",
                subcategory="",
                summary=summary[:512],
                description=description or "",
                tags=tag_list,
                duration_sec=None,
                sort_order=next_order,
                created_by=user.id,
                updated_by=user.id,
            )
            next_order += 1
            db.add(clip)
            db.flush()
            if tax_ids:
                _apply_taxonomy_writes(db, clip, taxonomy_tag_ids=tax_ids)

            formats: list[str] = []
            for fmt, src in sorted(group.files.items()):
                try:
                    rel, checksum = copy_into_storage(src, "human", clip.id)
                except Exception as e:
                    warnings.append(f"「{summary}」{fmt}: {e}")
                    continue
                rec = HumanMotionFile(
                    clip_id=clip.id,
                    format=fmt,
                    label="v1",
                    quality=quality,
                    file_path=rel,
                    original_name=src.name,
                    checksum=checksum,
                    process_status="pending",
                )
                db.add(rec)
                db.flush()
                formats.append(fmt)
                try:
                    enqueue_process_human(rec.id)
                except Exception:
                    pass

            if not formats:
                db.delete(clip)
                skipped += 1
                continue

            write_audit(
                db,
                user_id=user.id,
                action="human_zip_import",
                entity_type="clip",
                entity_id=clip.id,
                detail={"summary": summary, "formats": formats, "zip": file.filename},
            )
            created.append(clip.id)
            clips_out.append(
                HumanZipClipOut(clip_id=clip.id, summary=summary, formats=formats)
            )

        db.commit()
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    return HumanZipImportOut(
        created_clip_ids=created,
        clips=clips_out,
        warnings=warnings,
        skipped=skipped,
        folder_id=folder.id,
        folder_path=folder.path,
        folder_name=folder.name,
    )
