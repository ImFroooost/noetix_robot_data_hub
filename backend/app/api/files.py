import json

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session, joinedload

from ..core.deps import get_current_user, get_current_user_bearer_or_query
from ..database import get_db
from ..models import (
    Capability,
    HumanMotionFile,
    MotionClip,
    RealVideo,
    RobotModel,
    RobotMotionFile,
    User,
)
from ..models.enums import QualityLevel, RobotStage
from ..schemas import HumanFileOut, RealVideoOut, RobotFileOut, SliceInfoOut
from ..services.audit import write_audit
from ..services.permissions import ensure_clip_capability, folder_path_of_clip, user_has_capability
from ..services.queue import enqueue_process_human, enqueue_process_robot
from ..services.storage import absolute_path, data_root, save_upload_stream

router = APIRouter(tags=["files"])


def _next_version_label(db: Session, model, **filters) -> str:
    """Allocate v1/v2/… among existing labels for the filter set."""
    rows = db.query(model.label).filter_by(**filters).all()
    used = {((r[0] or "").strip() or "v1") for r in rows}
    n = 1
    while f"v{n}" in used:
        n += 1
    return f"v{n}"


@router.post("/clips/{clip_id}/human-files", response_model=HumanFileOut)
async def upload_human_file(
    clip_id: int,
    format: str = Form(...),
    quality: QualityLevel = Form(QualityLevel.medium),
    fps: float | None = Form(None),
    frame_count: int | None = Form(None),
    label: str = Form(""),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    clip = db.get(MotionClip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="条目不存在")
    ensure_clip_capability(db, user, Capability.upload, clip)
    fmt = format.lower().strip()
    ver = (label or "").strip()
    if not ver:
        ver = _next_version_label(db, HumanMotionFile, clip_id=clip_id, format=fmt)
    clash = (
        db.query(HumanMotionFile)
        .filter(
            HumanMotionFile.clip_id == clip_id,
            HumanMotionFile.format == fmt,
            HumanMotionFile.label == ver,
        )
        .first()
    )
    if clash:
        raise HTTPException(
            status_code=400, detail=f"该条目已有 {fmt}/{ver}，请换版本标签或删除旧文件"
        )

    rel, checksum = save_upload_stream("human", clip_id, file.filename or "data.bin", file.file)
    hf = HumanMotionFile(
        clip_id=clip_id,
        format=fmt,
        label=ver,
        quality=quality,
        fps=fps,
        frame_count=frame_count,
        file_path=rel,
        original_name=file.filename or "",
        checksum=checksum,
        process_status="pending",
    )
    db.add(hf)
    clip.updated_by = user.id
    db.flush()
    write_audit(
        db,
        user_id=user.id,
        action="upload",
        entity_type="human_file",
        entity_id=hf.id,
        detail={"format": fmt, "clip_id": clip_id, "name": file.filename},
    )
    db.commit()
    db.refresh(hf)
    try:
        enqueue_process_human(hf.id)
    except Exception:
        pass
    out = HumanFileOut.model_validate(hf)
    out.can_download = user_has_capability(
        db, user, Capability.download, folder_path_of_clip(db, clip)
    )
    return out


@router.post("/clips/{clip_id}/robot-files", response_model=RobotFileOut)
async def upload_robot_file(
    clip_id: int,
    robot_model_id: int = Form(...),
    stage: RobotStage = Form(...),
    format: str = Form("csv"),
    quality: QualityLevel = Form(QualityLevel.medium),
    fps: float | None = Form(None),
    frame_count: int | None = Form(None),
    label: str = Form(""),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    clip = db.get(MotionClip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="条目不存在")
    ensure_clip_capability(db, user, Capability.upload, clip)
    model = db.get(RobotModel, robot_model_id)
    if not model:
        raise HTTPException(status_code=404, detail="机器人型号不存在")
    fmt = format.lower().strip()
    if fmt not in ("csv", "pkl", "npz", "json", "bin", "txt"):
        # allow common formats; do not hard-block unknown
        pass
    ver = (label or "").strip()
    if not ver:
        ver = _next_version_label(
            db,
            RobotMotionFile,
            clip_id=clip_id,
            robot_model_id=robot_model_id,
            stage=stage,
            format=fmt,
        )
    existing = (
        db.query(RobotMotionFile)
        .filter(
            RobotMotionFile.clip_id == clip_id,
            RobotMotionFile.robot_model_id == robot_model_id,
            RobotMotionFile.stage == stage,
            RobotMotionFile.format == fmt,
            RobotMotionFile.label == ver,
        )
        .first()
    )
    if existing:
        raise HTTPException(status_code=400, detail=f"该阶段/格式版本 {ver} 已存在")

    rel, checksum = save_upload_stream("robot", clip_id, file.filename or "data.csv", file.file)
    rf = RobotMotionFile(
        clip_id=clip_id,
        label=ver,
        robot_model_id=robot_model_id,
        stage=stage,
        format=fmt,
        quality=quality,
        fps=fps,
        frame_count=frame_count,
        file_path=rel,
        original_name=file.filename or "",
        checksum=checksum,
        process_status="pending",
    )
    db.add(rf)
    clip.updated_by = user.id
    db.flush()
    write_audit(
        db,
        user_id=user.id,
        action="upload",
        entity_type="robot_file",
        entity_id=rf.id,
        detail={
            "stage": stage.value,
            "clip_id": clip_id,
            "robot_model_id": robot_model_id,
            "name": file.filename,
        },
    )
    db.commit()
    rf = (
        db.query(RobotMotionFile)
        .options(joinedload(RobotMotionFile.robot_model))
        .filter(RobotMotionFile.id == rf.id)
        .first()
    )
    try:
        enqueue_process_robot(rf.id)
    except Exception:
        pass
    out = RobotFileOut.model_validate(rf)
    out.robot_model_name = model.name
    out.can_download = user_has_capability(
        db, user, Capability.download, folder_path_of_clip(db, clip)
    )
    return out


@router.post("/clips/{clip_id}/slice-json", response_model=SliceInfoOut)
async def upload_slice_json(
    clip_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    clip = db.get(MotionClip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="条目不存在")
    ensure_clip_capability(db, user, Capability.upload, clip)
    raw = await file.read()
    try:
        json.loads(raw.decode("utf-8"))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"无效的 JSON 文件：{e}") from e

    # write via stream helper using BytesIO
    from io import BytesIO

    rel, checksum = save_upload_stream(
        "slice", clip_id, file.filename or "slice.json", BytesIO(raw)
    )
    clip.slice_json_path = rel
    clip.slice_json_name = file.filename or "slice.json"
    clip.slice_json_checksum = checksum
    clip.updated_by = user.id
    write_audit(
        db,
        user_id=user.id,
        action="upload",
        entity_type="slice_json",
        entity_id=clip_id,
        detail={"name": clip.slice_json_name},
    )
    db.commit()
    path = folder_path_of_clip(db, clip)
    return SliceInfoOut(
        has_file=True,
        original_name=clip.slice_json_name,
        checksum=checksum,
        can_download=user_has_capability(db, user, Capability.download, path),
    )


@router.get("/clips/{clip_id}/slice-json")
def download_slice_json(
    clip_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    clip = db.get(MotionClip, clip_id)
    if not clip or not clip.slice_json_path:
        raise HTTPException(status_code=404, detail="切片文件不存在")
    ensure_clip_capability(db, user, Capability.download, clip)
    path = absolute_path(clip.slice_json_path)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="磁盘文件缺失")
    return FileResponse(
        path,
        filename=clip.slice_json_name or "slice.json",
        media_type="application/json",
    )


@router.delete("/clips/{clip_id}/slice-json")
def delete_slice_json(
    clip_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    clip = db.get(MotionClip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="条目不存在")
    ensure_clip_capability(db, user, Capability.edit, clip)
    clip.slice_json_path = None
    clip.slice_json_name = None
    clip.slice_json_checksum = None
    clip.updated_by = user.id
    db.commit()
    return {"ok": True}


@router.post("/clips/{clip_id}/real-videos", response_model=RealVideoOut)
async def upload_real_video(
    clip_id: int,
    quality: QualityLevel = Form(QualityLevel.medium),
    kind: str = Form("human"),
    duration_sec: float | None = Form(None),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    clip = db.get(MotionClip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="条目不存在")
    ensure_clip_capability(db, user, Capability.upload, clip)
    video_kind = (kind or "human").strip().lower()
    if video_kind not in {"human", "robot_motion"}:
        raise HTTPException(status_code=400, detail="kind 须为 human 或 robot_motion")
    rel, checksum = save_upload_stream(
        "video", clip_id, file.filename or "video.mp4", file.file
    )
    rv = RealVideo(
        clip_id=clip_id,
        kind=video_kind,
        quality=quality,
        file_path=rel,
        original_name=file.filename or "",
        checksum=checksum,
        duration_sec=duration_sec,
    )
    db.add(rv)
    clip.updated_by = user.id
    db.flush()
    write_audit(
        db,
        user_id=user.id,
        action="upload",
        entity_type="real_video",
        entity_id=rv.id,
        detail={"clip_id": clip_id, "name": file.filename},
    )
    db.commit()
    db.refresh(rv)
    out = RealVideoOut.model_validate(rv)
    out.can_download = user_has_capability(
        db, user, Capability.download, folder_path_of_clip(db, clip)
    )
    return out


@router.get("/files/{kind}/{file_id}")
def download_file(
    kind: str,
    file_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if kind == "human":
        rec = db.get(HumanMotionFile, file_id)
        if not rec:
            raise HTTPException(status_code=404, detail="文件不存在")
        clip = db.get(MotionClip, rec.clip_id)
        ensure_clip_capability(db, user, Capability.download, clip)
        path = absolute_path(rec.file_path)
        name = rec.original_name or path.name
    elif kind == "robot":
        rec = db.get(RobotMotionFile, file_id)
        if not rec:
            raise HTTPException(status_code=404, detail="文件不存在")
        clip = db.get(MotionClip, rec.clip_id)
        ensure_clip_capability(db, user, Capability.download, clip)
        path = absolute_path(rec.file_path)
        name = rec.original_name or path.name
    elif kind == "video":
        rec = db.get(RealVideo, file_id)
        if not rec:
            raise HTTPException(status_code=404, detail="文件不存在")
        clip = db.get(MotionClip, rec.clip_id)
        ensure_clip_capability(db, user, Capability.download, clip)
        path = absolute_path(rec.file_path)
        name = rec.original_name or path.name
    else:
        raise HTTPException(status_code=400, detail="kind 必须为 human、robot 或 video")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="磁盘文件缺失")
    return FileResponse(path, filename=name, media_type="application/octet-stream")


@router.get("/previews/{kind}/{file_id}")
def get_preview(
    kind: str,
    file_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if kind == "human":
        rec = db.get(HumanMotionFile, file_id)
        clip_id = rec.clip_id if rec else None
    elif kind == "robot":
        rec = db.get(RobotMotionFile, file_id)
        clip_id = rec.clip_id if rec else None
    else:
        raise HTTPException(status_code=400, detail="kind 无效")
    if not rec or not rec.preview_path:
        raise HTTPException(status_code=404, detail="预览尚未生成")
    clip = db.get(MotionClip, clip_id)
    ensure_clip_capability(db, user, Capability.browse, clip)
    path = absolute_path(rec.preview_path)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="预览文件缺失")
    return FileResponse(path, media_type="application/json")


@router.get("/thumbnails/{clip_id}")
def get_thumbnail(
    clip_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user_bearer_or_query),
):
    clip = db.get(MotionClip, clip_id)
    if not clip or not clip.thumbnail_path:
        raise HTTPException(status_code=404, detail="无缩略图")
    ensure_clip_capability(db, user, Capability.browse, clip)
    path = absolute_path(clip.thumbnail_path)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="缩略图缺失")
    return FileResponse(path, media_type="image/png")


@router.post("/files/{kind}/{file_id}/reprocess")
def reprocess_file(
    kind: str,
    file_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if kind == "human":
        rec = db.get(HumanMotionFile, file_id)
        if not rec:
            raise HTTPException(status_code=404, detail="文件不存在")
        clip = db.get(MotionClip, rec.clip_id)
        ensure_clip_capability(db, user, Capability.edit, clip)
        rec.process_status = "pending"
        rec.process_message = None
        db.commit()
        enqueue_process_human(file_id)
    elif kind == "robot":
        rec = db.get(RobotMotionFile, file_id)
        if not rec:
            raise HTTPException(status_code=404, detail="文件不存在")
        clip = db.get(MotionClip, rec.clip_id)
        ensure_clip_capability(db, user, Capability.edit, clip)
        rec.process_status = "pending"
        rec.process_message = None
        db.commit()
        enqueue_process_robot(file_id)
    else:
        raise HTTPException(status_code=400, detail="kind 无效")
    write_audit(
        db,
        user_id=user.id,
        action="reprocess",
        entity_type=f"{kind}_file",
        entity_id=file_id,
    )
    db.commit()
    return {"ok": True}


@router.delete("/files/{kind}/{file_id}")
def delete_file(
    kind: str,
    file_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if kind == "human":
        rec = db.get(HumanMotionFile, file_id)
    elif kind == "robot":
        rec = db.get(RobotMotionFile, file_id)
    elif kind == "video":
        rec = db.get(RealVideo, file_id)
    else:
        raise HTTPException(status_code=400, detail="kind 无效")
    if not rec:
        raise HTTPException(status_code=404, detail="文件不存在")
    clip = db.get(MotionClip, rec.clip_id)
    ensure_clip_capability(db, user, Capability.edit, clip)
    db.delete(rec)
    write_audit(
        db,
        user_id=user.id,
        action="delete",
        entity_type=f"{kind}_file",
        entity_id=file_id,
    )
    db.commit()
    return {"ok": True}


@router.get("/media/{path:path}")
def get_media(path: str):
    """Serve robot model assets (urdf/meshes). Open on LAN so URDFLoader can fetch meshes."""
    root = data_root()
    allowed_prefix = ("robot_models/", "previews/", "thumbnails/")
    if not path.startswith(allowed_prefix):
        raise HTTPException(status_code=403, detail="路径不允许匿名访问")
    full = (root / path).resolve()
    if not str(full).startswith(str(root.resolve())):
        raise HTTPException(status_code=400, detail="非法路径")
    if not full.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(full)
