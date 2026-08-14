from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from ..core.deps import get_current_user, require_editor
from ..database import get_db
from ..models import RobotModel, User
from ..schemas import RobotModelOut, RobotModelUpdate
from ..services.audit import write_audit
from ..services.storage import data_root, extract_zip_to_robot_model, import_robot_model_from_dir

router = APIRouter(prefix="/robot-models", tags=["robot-models"])


def _resolve_host_path(path: str) -> Path:
    """Map host absolute paths into container mounts (/host/...)."""
    p = Path(path).expanduser()
    candidates = [p]
    if str(p).startswith("/home/"):
        candidates.append(Path("/host") / str(p).lstrip("/"))
    if not str(p).startswith("/host/"):
        candidates.append(Path("/host") / str(p).lstrip("/"))
    for c in candidates:
        if c.is_dir():
            return c.resolve()
    raise ValueError(
        f"服务器上找不到目录：{path}。"
        "请确认路径在本机存在，且 docker-compose 已挂载 /home/noetix（或改用 zip 上传）。"
    )


@router.get("", response_model=list[RobotModelOut])
def list_models(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return db.query(RobotModel).order_by(RobotModel.name).all()


@router.post("/from-path", response_model=RobotModelOut)
def create_model_from_path(
    name: str = Form(...),
    path: str = Form(..., description="服务器本机上的机器人资源目录绝对路径"),
    description: str = Form(""),
    joint_names: str = Form(""),
    db: Session = Depends(get_db),
    user: User = Depends(require_editor),
):
    name = (name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="请填写型号名称")
    if db.query(RobotModel).filter(RobotModel.name == name).first():
        raise HTTPException(status_code=400, detail="型号名已存在")
    try:
        src = _resolve_host_path(path.strip())
        package_rel, urdf_rel, _ = import_robot_model_from_dir(name, src)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    joints = [j.strip() for j in joint_names.split(",") if j.strip()] if joint_names else []
    model = RobotModel(
        name=name,
        description=description,
        urdf_path=urdf_rel,
        package_path=package_rel,
        joint_names=joints,
    )
    db.add(model)
    db.flush()
    write_audit(
        db,
        user_id=user.id,
        action="create_from_path",
        entity_type="robot_model",
        entity_id=model.id,
        detail={"name": name, "path": path},
    )
    db.commit()
    db.refresh(model)
    return model


@router.post("", response_model=RobotModelOut)
async def create_model(
    name: str = Form(...),
    description: str = Form(""),
    joint_names: str = Form("", description="逗号分隔关节名，可选"),
    package: UploadFile = File(..., description="含 URDF + mesh 的 zip 包"),
    db: Session = Depends(get_db),
    user: User = Depends(require_editor),
):
    import uuid

    name = (name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="请填写型号名称")
    if db.query(RobotModel).filter(RobotModel.name == name).first():
        raise HTTPException(status_code=400, detail="型号名已存在")

    filename = package.filename or "package.zip"
    if not filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="请上传 .zip 压缩包（内含 URDF 与 mesh）")

    tmp: Path | None = None
    try:
        tmp_dir = data_root() / "tmp"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        tmp = tmp_dir / f"{uuid.uuid4().hex}.zip"
        with tmp.open("wb") as out:
            while True:
                chunk = await package.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
        if tmp.stat().st_size == 0:
            raise HTTPException(status_code=400, detail="上传文件为空，请重新选择 zip")
        package_rel, urdf_rel, _ = extract_zip_to_robot_model(name, tmp)
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"解析压缩包失败：{e}")
    finally:
        if tmp is not None:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass

    joints = [j.strip() for j in joint_names.split(",") if j.strip()] if joint_names else []
    model = RobotModel(
        name=name,
        description=description,
        urdf_path=urdf_rel,
        package_path=package_rel,
        joint_names=joints,
    )
    db.add(model)
    db.flush()
    write_audit(
        db,
        user_id=user.id,
        action="create",
        entity_type="robot_model",
        entity_id=model.id,
        detail={"name": name},
    )
    db.commit()
    db.refresh(model)
    return model


@router.patch("/{model_id}", response_model=RobotModelOut)
def update_model(
    model_id: int,
    body: RobotModelUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_editor),
):
    model = db.get(RobotModel, model_id)
    if not model:
        raise HTTPException(status_code=404, detail="型号不存在")
    data = body.model_dump(exclude_unset=True)
    if "name" in data and data["name"] != model.name:
        if db.query(RobotModel).filter(RobotModel.name == data["name"]).first():
            raise HTTPException(status_code=400, detail="型号名已存在")
    for k, v in data.items():
        setattr(model, k, v)
    write_audit(
        db,
        user_id=user.id,
        action="update",
        entity_type="robot_model",
        entity_id=model.id,
        detail=data,
    )
    db.commit()
    db.refresh(model)
    return model


@router.get("/{model_id}", response_model=RobotModelOut)
def get_model(
    model_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    model = db.get(RobotModel, model_id)
    if not model:
        raise HTTPException(status_code=404, detail="型号不存在")
    return model
