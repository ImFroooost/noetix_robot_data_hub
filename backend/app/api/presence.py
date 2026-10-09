from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..core.deps import get_current_user, impersonator_id_of, require_admin
from ..database import get_db
from ..models import User
from ..services.presence import read_many, touch

router = APIRouter(prefix="/presence", tags=["presence"])


class PresenceIn(BaseModel):
    page: str = Field(default="", max_length=40)
    detail: str = Field(default="", max_length=240)
    idle: bool = False


class PresenceOut(BaseModel):
    user_id: int
    online: bool = False
    away: bool = False
    page: str = ""
    detail: str = ""
    seen_at: str | None = None


@router.post("")
def report_presence(
    body: PresenceIn,
    user: User = Depends(get_current_user),
):
    page = body.page.strip()
    detail = body.detail.strip()
    actor_id = impersonator_id_of(user)
    target_id = user.id
    if actor_id is not None:
        target_id = actor_id
        viewed = f"以「{user.username}」的视角"
        detail = f"{viewed} · {detail}" if detail else viewed
    touch(target_id, page=page, detail=detail, idle=body.idle)
    return {"ok": True}


@router.get("", response_model=list[PresenceOut])
def list_presence(
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    users = db.query(User.id).order_by(User.id).all()
    ids = [row[0] for row in users]
    found = read_many(ids)
    rows: list[PresenceOut] = []
    for user_id in ids:
        item = found.get(user_id) or {}
        rows.append(
            PresenceOut(
                user_id=user_id,
                online=bool(item.get("online")),
                away=bool(item.get("away")),
                page=str(item.get("page") or ""),
                detail=str(item.get("detail") or ""),
                seen_at=item.get("seen_at"),
            )
        )
    return rows
