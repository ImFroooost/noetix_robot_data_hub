from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..core.deps import get_acting_super_manager, get_current_user, impersonator_id_of
from ..core.security import create_access_token, verify_password
from ..database import get_db
from ..models import User
from ..models.enums import is_super_manager_role
from ..schemas import ImpersonatorOut, LoginIn, PermissionItem, TokenOut, UserOut
from ..services.audit import write_audit
from ..services.permissions import permission_summary

router = APIRouter(prefix="/auth", tags=["auth"])


def _impersonator_out(db: Session, user: User) -> ImpersonatorOut | None:
    actor_id = impersonator_id_of(user)
    if actor_id is None:
        return None
    actor = db.get(User, actor_id)
    if not actor:
        return None
    return ImpersonatorOut(id=actor.id, username=actor.username)


def _user_out(db, user: User) -> UserOut:
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
        impersonated_by=_impersonator_out(db, user),
    )


def _token_out(db: Session, user: User, token: str, actor: User | None = None) -> TokenOut:
    summary = permission_summary(db, user)
    return TokenOut(
        access_token=token,
        role=user.role,
        username=user.username,
        is_admin=summary["is_admin"],
        capabilities=summary["capabilities"],
        permissions=[PermissionItem(**p) for p in summary["permissions"]],
        impersonated_by=(
            ImpersonatorOut(id=actor.id, username=actor.username) if actor else None
        ),
    )


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == body.username).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    if not user.is_active:
        raise HTTPException(status_code=401, detail="账号已禁用")
    token = create_access_token(user.id, user.username, user.role)
    return _token_out(db, user, token)


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _user_out(db, user)


@router.post("/impersonate/{user_id}", response_model=TokenOut)
def impersonate(
    user_id: int,
    db: Session = Depends(get_db),
    admin: User = Depends(get_acting_super_manager),
    current: User = Depends(get_current_user),
):
    if user_id == admin.id:
        token = create_access_token(admin.id, admin.username, admin.role)
        write_audit(
            db,
            user_id=admin.id,
            action="stop_impersonate",
            entity_type="user",
            entity_id=current.id,
            detail={"target": current.username},
        )
        db.commit()
        return _token_out(db, admin, token)
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")
    token = create_access_token(
        target.id,
        target.username,
        target.role,
        impersonator_id=admin.id,
    )
    write_audit(
        db,
        user_id=admin.id,
        action="impersonate",
        entity_type="user",
        entity_id=target.id,
        detail={"target": target.username, "role": target.role.value},
    )
    db.commit()
    return _token_out(db, target, token, actor=admin)


@router.get("/impersonation-targets", response_model=list[UserOut])
def impersonation_targets(
    db: Session = Depends(get_db),
    _: User = Depends(get_acting_super_manager),
):
    users = db.query(User).order_by(User.id).all()
    return [_user_out(db, u) for u in users]


@router.post("/stop-impersonate", response_model=TokenOut)
def stop_impersonate(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    actor_id = impersonator_id_of(user)
    if actor_id is None:
        raise HTTPException(status_code=400, detail="当前不是视角切换状态")
    actor = db.get(User, actor_id)
    if not actor or not actor.is_active or not is_super_manager_role(actor.role):
        raise HTTPException(status_code=403, detail="无法恢复超级管理者会话")
    token = create_access_token(actor.id, actor.username, actor.role)
    write_audit(
        db,
        user_id=actor.id,
        action="stop_impersonate",
        entity_type="user",
        entity_id=user.id,
        detail={"target": user.username},
    )
    db.commit()
    return _token_out(db, actor, token)
