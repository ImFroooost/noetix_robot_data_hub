from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..core.deps import get_current_user
from ..core.security import create_access_token, verify_password
from ..database import get_db
from ..models import User
from ..schemas import LoginIn, PermissionItem, TokenOut, UserOut
from ..services.permissions import is_admin, permission_summary

router = APIRouter(prefix="/auth", tags=["auth"])


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
    )


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == body.username).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    if not user.is_active:
        raise HTTPException(status_code=401, detail="账号已禁用")
    token = create_access_token(user.id, user.username, user.role)
    summary = permission_summary(db, user)
    return TokenOut(
        access_token=token,
        role=user.role,
        username=user.username,
        is_admin=summary["is_admin"],
        capabilities=summary["capabilities"],
        permissions=[PermissionItem(**p) for p in summary["permissions"]],
    )


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _user_out(db, user)
