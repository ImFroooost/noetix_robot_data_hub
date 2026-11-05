from contextvars import ContextVar

from sqlalchemy.orm import Session

from ..models import AuditLog

# Rows written during the current request. The HTTP middleware uses this so a
# request that already recorded its own rows is not recorded a second time.
_request_rows: ContextVar[list[str] | None] = ContextVar("audit_request_rows", default=None)


def begin_request_audit() -> object:
    return _request_rows.set([])


def request_audit_actions() -> list[str]:
    return list(_request_rows.get() or [])


def skip_request_audit() -> None:
    """This request was checked and changed nothing, so it needs no log row."""
    bucket = _request_rows.get()
    if bucket is not None:
        bucket.append("")


def end_request_audit(token: object) -> None:
    _request_rows.reset(token)  # type: ignore[arg-type]


def write_audit(
    db: Session,
    *,
    user_id: int | None,
    action: str,
    entity_type: str,
    entity_id: int | None = None,
    detail: dict | None = None,
):
    bucket = _request_rows.get()
    if bucket is not None:
        bucket.append(action)
    log = AuditLog(
        user_id=user_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        detail=detail or {},
    )
    db.add(log)
