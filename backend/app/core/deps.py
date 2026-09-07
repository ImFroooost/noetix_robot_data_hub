from fastapi import Depends, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWTError
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Capability, MotionClip, User, UserRole
from ..models.enums import is_super_manager_role
from ..services.permissions import (
    ensure_capability,
    ensure_clip_capability,
    folder_path_of_clip,
    is_admin,
    user_has_any_capability,
)
from .security import decode_access_token

bearer = HTTPBearer(auto_error=False)


def _user_from_token(db: Session, token: str) -> User:
    try:
        payload = decode_access_token(token)
        user_id = int(payload["sub"])
        impersonator_id = payload.get("impersonator_id")
        if impersonator_id is not None:
            impersonator_id = int(impersonator_id)
    except (PyJWTError, KeyError, ValueError, TypeError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="无效令牌")
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不可用")
    if not user.is_active and impersonator_id is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不可用")
    user.impersonated_by_id = impersonator_id
    return user


def impersonator_id_of(user: User) -> int | None:
    raw = getattr(user, "impersonated_by_id", None)
    return int(raw) if raw is not None else None


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User:
    if creds is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="未登录")
    return _user_from_token(db, creds.credentials)


def get_current_user_bearer_or_query(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    token: str | None = Query(None, description="供 <img> 等无法带 Authorization 头的场景"),
    db: Session = Depends(get_db),
) -> User:
    """Bearer 优先；否则接受 ?token=（缩略图/媒体嵌入用）。"""
    raw = creds.credentials if creds is not None else token
    if not raw:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="未登录")
    return _user_from_token(db, raw)


def get_acting_super_manager(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> User:
    """当前超级管理者，或视角令牌背后的超级管理者。"""
    actor_id = impersonator_id_of(user)
    actor = user if actor_id is None else db.get(User, actor_id)
    if (
        not actor
        or not actor.is_active
        or not is_super_manager_role(actor.role)
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要超级管理者权限")
    return actor


def require_admin(user: User = Depends(get_current_user)) -> User:
    if not is_super_manager_role(user.role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要超级管理者权限")
    return user


def require_roles(*roles: UserRole):
    """Legacy helper; prefer capability checks."""

    def checker(user: User = Depends(get_current_user)) -> User:
        if is_super_manager_role(user.role) or user.role in roles:
            return user
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="权限不足")

    return checker


def require_editor(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> User:
    if is_admin(user) or user_has_any_capability(db, user, Capability.upload):
        return user
    if user_has_any_capability(db, user, Capability.manage_data):
        return user
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要上传或管理数据权限")


def require_manage_data(
    user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> User:
    if user_has_any_capability(db, user, Capability.manage_data):
        return user
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要管理数据权限")


def get_clip_or_404(clip_id: int, db: Session) -> MotionClip:
    clip = db.get(MotionClip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="条目不存在")
    return clip


def check_clip_perm(db: Session, user: User, clip: MotionClip, capability: Capability) -> str:
    return ensure_clip_capability(db, user, capability, clip)


def check_path_perm(db: Session, user: User, capability: Capability, folder_path: str) -> None:
    ensure_capability(db, user, capability, folder_path)
