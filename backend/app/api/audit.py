"""Read the per-operation audit log."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy import String, cast, or_
from sqlalchemy.orm import Session

from ..core.deps import get_current_user
from ..database import get_db
from ..models import AuditLog, Capability, User
from ..models.enums import is_super_manager_role
from ..schemas import AuditLogOut
from ..services.permissions import user_has_any_capability

router = APIRouter(prefix="/audit", tags=["audit"])


def _can_read_audit(db: Session, user: User) -> bool:
    if is_super_manager_role(user.role):
        return True
    return user_has_any_capability(db, user, Capability.manage_users)


@router.get("", response_model=list[AuditLogOut])
def list_audit_logs(
    q: str = "",
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not _can_read_audit(db, user):
        from fastapi import HTTPException

        raise HTTPException(status_code=403, detail="只有管理者可以查看操作记录")
    query = db.query(AuditLog, User.username).outerjoin(User, User.id == AuditLog.user_id)
    text = q.strip()
    if text:
        like = f"%{text}%"
        query = query.filter(
            or_(
                User.username.ilike(like),
                AuditLog.action.ilike(like),
                AuditLog.entity_type.ilike(like),
                cast(AuditLog.detail, String).ilike(like),
            )
        )
    rows = query.order_by(AuditLog.id.desc()).offset(offset).limit(limit).all()
    return [
        AuditLogOut(
            id=log.id,
            user_id=log.user_id,
            username=username,
            action=log.action,
            entity_type=log.entity_type,
            entity_id=log.entity_id,
            detail=log.detail or {},
            created_at=log.created_at,
        )
        for log, username in rows
    ]
