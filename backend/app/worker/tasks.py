from pathlib import Path

from ..config import settings
from ..database import SessionLocal
from ..models import HumanMotionFile, MotionClip, RobotModel, RobotMotionFile
from ..services.storage import data_root
from .parsers import (
    extract_urdf_actuated_joints,
    parse_human_file,
    parse_robot_file,
    render_thumbnail,
    write_preview_json,
)


def _check_duration(clip: MotionClip, duration: float | None) -> str | None:
    if duration is None:
        return None
    if clip.duration_sec is None:
        clip.duration_sec = duration
        return None
    tol = settings.duration_tolerance_sec
    if abs(clip.duration_sec - duration) > tol:
        return (
            f"时长不一致: 文件 {duration:.3f}s vs clip {clip.duration_sec:.3f}s "
            f"(容差 {tol}s)"
        )
    return None


def process_human_file(file_id: int):
    db = SessionLocal()
    try:
        hf = db.get(HumanMotionFile, file_id)
        if not hf:
            return
        clip = db.get(MotionClip, hf.clip_id)
        root = data_root()
        path = root / hf.file_path
        try:
            result = parse_human_file(path, hf.format, fps_hint=hf.fps)
            if hf.fps is None and result.get("fps") is not None:
                hf.fps = result["fps"]
            if hf.frame_count is None and result.get("frame_count") is not None:
                hf.frame_count = result["frame_count"]
            hf.meta = {**(hf.meta or {}), **(result.get("meta") or {})}

            preview_rel = f"previews/human_{hf.id}.json"
            write_preview_json(root / preview_rel, result.get("preview") or {})
            hf.preview_path = preview_rel

            # Thumbnail from BVH root path or CSV first two joints
            thumb_rel = f"thumbnails/clip_{hf.clip_id}.png"
            preview = result.get("preview") or {}
            positions = preview.get("positions") or []
            if not positions and preview.get("frames"):
                frames = preview["frames"]
                positions = [[f[0], f[1] if len(f) > 1 else 0] for f in frames[:200]]
            if positions:
                render_thumbnail(positions, root / thumb_rel)
                if clip:
                    clip.thumbnail_path = thumb_rel

            warn = _check_duration(clip, result.get("duration_sec")) if clip else None
            hf.process_status = "done"
            hf.process_message = warn
            db.commit()
        except Exception as e:
            hf.process_status = "error"
            hf.process_message = str(e)
            db.commit()
    finally:
        db.close()


def process_robot_file(file_id: int):
    db = SessionLocal()
    try:
        rf = db.get(RobotMotionFile, file_id)
        if not rf:
            return
        clip = db.get(MotionClip, rf.clip_id)
        model = db.get(RobotModel, rf.robot_model_id) if rf.robot_model_id else None
        root = data_root()
        path = Path(root / rf.file_path)
        try:
            joint_names: list[str] = list((model.joint_names if model else None) or [])
            if not joint_names and model and model.urdf_path:
                urdf_path = root / model.urdf_path
                if urdf_path.exists():
                    joint_names = extract_urdf_actuated_joints(urdf_path)
                    # cache onto model for later uploads
                    if joint_names and not (model.joint_names or []):
                        model.joint_names = joint_names

            # Always re-parse fps/frames from file for robot csv (headerless)
            result = parse_robot_file(
                path, rf.format, fps_hint=rf.fps, joint_names=joint_names or None
            )
            if result.get("fps") is not None:
                rf.fps = result["fps"]
            if result.get("frame_count") is not None:
                rf.frame_count = result["frame_count"]
            rf.meta = {**(rf.meta or {}), **(result.get("meta") or {})}

            preview_rel = f"previews/robot_{rf.id}.json"
            write_preview_json(root / preview_rel, result.get("preview") or {})
            rf.preview_path = preview_rel

            warn = _check_duration(clip, result.get("duration_sec")) if clip else None
            align_note = (result.get("meta") or {}).get("align_note")
            if align_note and not warn:
                rf.process_message = align_note
            else:
                rf.process_message = warn
            rf.process_status = "done"
            db.commit()
        except Exception as e:
            rf.process_status = "error"
            rf.process_message = str(e)
            db.commit()
    finally:
        db.close()
