"""3D 模型库：人体（fbx/bvh/smpl/blender）与机器人（urdf/xml/fbx/blender）模型文件。"""

from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..core.deps import get_current_user, require_editor, require_manage_data
from ..database import get_db
from ..models import ModelAsset, User
from ..schemas import (
    HUMAN_MODEL_FORMATS,
    MODEL_ASSET_CATEGORIES,
    ROBOT_MODEL_FORMATS,
    ModelAssetOut,
    ModelAssetUpdate,
)
from ..services.audit import write_audit
from ..services.storage import absolute_path, save_upload_stream

router = APIRouter(prefix="/model-assets", tags=["model-assets"])


@router.get("", response_model=list[ModelAssetOut])
def list_assets(
    category: str | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    q = db.query(ModelAsset)
    if category:
        q = q.filter(ModelAsset.category == category)
    return q.order_by(ModelAsset.category, ModelAsset.name, ModelAsset.id).all()


@router.post("", response_model=ModelAssetOut)
async def upload_asset(
    category: str = Form(...),
    name: str = Form(""),
    format: str = Form(""),
    description: str = Form(""),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_editor),
):
    cat = (category or "").strip().lower()
    if cat not in MODEL_ASSET_CATEGORIES:
        raise HTTPException(status_code=400, detail="category 须为 human 或 robot")
    fmt = (format or "").strip().lower().lstrip(".")
    if not fmt:
        fmt = (Path(file.filename or "").suffix.lstrip(".") or "bin").lower()
    allowed = HUMAN_MODEL_FORMATS if cat == "human" else ROBOT_MODEL_FORMATS
    if fmt not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"{'人体' if cat == 'human' else '机器人'}模型格式须为 {'/'.join(sorted(allowed))}",
        )
    display = (name or "").strip() or Path(file.filename or "").stem or f"{cat}_model"
    # 目录按类别聚合（save_upload_stream 需要一个整型分组 id，用 0 表示模型库）
    rel, checksum = save_upload_stream(
        f"model_assets/{cat}", 0, file.filename or f"model.{fmt}", file.file
    )
    asset = ModelAsset(
        category=cat,
        name=display,
        format=fmt,
        description=description or "",
        file_path=rel,
        original_name=file.filename or "",
        checksum=checksum,
        created_by=user.id,
    )
    db.add(asset)
    db.flush()
    write_audit(
        db,
        user_id=user.id,
        action="upload",
        entity_type="model_asset",
        entity_id=asset.id,
        detail={"category": cat, "format": fmt, "name": display},
    )
    db.commit()
    db.refresh(asset)
    return asset


@router.patch("/{asset_id}", response_model=ModelAssetOut)
def update_asset(
    asset_id: int,
    body: ModelAssetUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_manage_data),
):
    asset = db.get(ModelAsset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="模型不存在")
    data = body.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(status_code=400, detail="无更新字段")
    for k, v in data.items():
        setattr(asset, k, v)
    write_audit(
        db,
        user_id=user.id,
        action="update",
        entity_type="model_asset",
        entity_id=asset_id,
        detail=data,
    )
    db.commit()
    db.refresh(asset)
    return asset


@router.get("/{asset_id}/download")
def download_asset(
    asset_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    asset = db.get(ModelAsset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="模型不存在")
    path = absolute_path(asset.file_path)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="磁盘文件缺失")
    name = asset.original_name or f"{asset.name}.{asset.format}"
    return FileResponse(path, filename=name, media_type="application/octet-stream")


@router.delete("/{asset_id}")
def delete_asset(
    asset_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_manage_data),
):
    asset = db.get(ModelAsset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="模型不存在")
    try:
        p = absolute_path(asset.file_path)
        if p.is_file():
            p.unlink()
    except Exception:
        pass
    db.delete(asset)
    write_audit(
        db,
        user_id=user.id,
        action="delete",
        entity_type="model_asset",
        entity_id=asset_id,
        detail={"name": asset.name},
    )
    db.commit()
    return {"ok": True}
