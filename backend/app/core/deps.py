from fastapi import Depends, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWTError
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Capability, MotionClip, User, UserRole
from ..services.permissions import ensure_capability, ensure_clip_capability, folder_path_of_clip
from .security import decode_access_token

bearer = HTTPBearer(auto_error=False)


def _user_from_token(db: Session, token: str) -> User:
    try:
        payload = decode_access_token(token)
        user_id = int(payload["sub"])
    except (PyJWTError, KeyError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="无效令牌")
    user = db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不可用")
    return user


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


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != UserRole.admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要管理员权限")
    return user


def require_roles(*roles: UserRole):
    """Legacy helper; prefer capability checks."""

    def checker(user: User = Depends(get_current_user)) -> User:
        if user.role == UserRole.admin or user.role in roles:
            return user
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="权限不足")

    return checker


# Kept for robot model management: admin or anyone with edit somewhere
def require_editor(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> User:
    from ..services.permissions import is_admin, user_has_capability

    if is_admin(user):
        return user
    if user_has_capability(db, user, Capability.edit, "/") or user_has_capability(
        db, user, Capability.upload, "/"
    ):
        return user
    # any edit/upload on any path
    from ..models import UserPermission

    has = (
        db.query(UserPermission)
        .filter(
            UserPermission.user_id == user.id,
            UserPermission.capability.in_([Capability.edit, Capability.upload]),
        )
        .first()
    )
    if has:
        return user
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要编辑或上传权限")


def get_clip_or_404(clip_id: int, db: Session) -> MotionClip:
    clip = db.get(MotionClip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="条目不存在")
    return clip


def check_clip_perm(db: Session, user: User, clip: MotionClip, capability: Capability) -> str:
    return ensure_clip_capability(db, user, capability, clip)


def check_path_perm(db: Session, user: User, capability: Capability, folder_path: str) -> None:
    ensure_capability(db, user, capability, folder_path)
