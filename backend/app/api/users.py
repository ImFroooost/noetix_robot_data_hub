from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..core.deps import require_admin
from ..core.security import hash_password
from ..database import get_db
from ..models import AuditLog, MotionClip, User, UserRole
from ..schemas import (
    PermissionItem,
    UserCreate,
    UserOut,
    UserPermissionsPut,
    UserUpdate,
)
from ..services.audit import write_audit
from ..services.permissions import permission_summary, set_user_permissions

router = APIRouter(prefix="/users", tags=["users"])


def _user_out(db: Session, user: User) -> UserOut:
    summary = permission_summary(db, user)
    return UserOut(
        id=user.id,
        username=user.username,
        role=user.role,
        is_active=user.is_active,
        created_at=user.created_at,
        is_admin=summary["is_admin"],
        capabilities=summary["capabilities"],
        permissions=[PermissionItem(**p) for p in summary["permissions"]],
    )


@router.get("", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    users = db.query(User).order_by(User.id).all()
    return [_user_out(db, u) for u in users]


@router.post("", response_model=UserOut)
def create_user(
    body: UserCreate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    if db.query(User).filter(User.username == body.username).first():
        raise HTTPException(status_code=400, detail="用户名已存在")
    user = User(
        username=body.username,
        password_hash=hash_password(body.password),
        role=body.role,
    )
    db.add(user)
    db.flush()
    if body.role != UserRole.admin and body.permissions:
        set_user_permissions(
            db,
            user,
            [p.model_dump() for p in body.permissions],
        )
    write_audit(
        db,
        user_id=admin.id,
        action="create",
        entity_type="user",
        entity_id=user.id,
        detail={"username": user.username, "role": user.role.value},
    )
    db.commit()
    db.refresh(user)
    return _user_out(db, user)


@router.patch("/{user_id}", response_model=UserOut)
def update_user(
    user_id: int,
    body: UserUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    if body.password is not None:
        user.password_hash = hash_password(body.password)
    if body.role is not None:
        user.role = body.role
    if body.is_active is not None:
        user.is_active = body.is_active
    write_audit(
        db,
        user_id=admin.id,
        action="update",
        entity_type="user",
        entity_id=user.id,
        detail=body.model_dump(exclude_unset=True),
    )
    db.commit()
    db.refresh(user)
    return _user_out(db, user)


@router.delete("/{user_id}")
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="不能删除当前登录账号")
    if user.role == UserRole.admin and user.is_active:
        other_admins = (
            db.query(User)
            .filter(
                User.id != user.id,
                User.role == UserRole.admin,
                User.is_active.is_(True),
            )
            .count()
        )
        if other_admins == 0:
            raise HTTPException(status_code=400, detail="不能删除最后一个启用的管理员")

    # Preserve clips/audit history; drop FK to the removed user.
    db.query(MotionClip).filter(MotionClip.created_by == user.id).update(
        {MotionClip.created_by: None}, synchronize_session=False
    )
    db.query(MotionClip).filter(MotionClip.updated_by == user.id).update(
        {MotionClip.updated_by: None}, synchronize_session=False
    )
    db.query(AuditLog).filter(AuditLog.user_id == user.id).update(
        {AuditLog.user_id: None}, synchronize_session=False
    )

    username = user.username
    db.delete(user)
    write_audit(
        db,
        user_id=admin.id,
        action="delete",
        entity_type="user",
        entity_id=user_id,
        detail={"username": username},
    )
    db.commit()
    return {"ok": True, "id": user_id}


@router.get("/{user_id}/permissions", response_model=list[PermissionItem])
def get_permissions(
    user_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    summary = permission_summary(db, user)
    return [PermissionItem(**p) for p in summary["permissions"]]


@router.put("/{user_id}/permissions", response_model=list[PermissionItem])
def put_permissions(
    user_id: int,
    body: UserPermissionsPut,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    if user.role == UserRole.admin:
        raise HTTPException(status_code=400, detail="管理员默认拥有全部权限，无需配置")
    set_user_permissions(db, user, [p.model_dump() for p in body.permissions])
    write_audit(
        db,
        user_id=admin.id,
        action="update_permissions",
        entity_type="user",
        entity_id=user.id,
        detail={"permissions": [p.model_dump() for p in body.permissions]},
    )
    db.commit()
    summary = permission_summary(db, user)
    return [PermissionItem(**p) for p in summary["permissions"]]
