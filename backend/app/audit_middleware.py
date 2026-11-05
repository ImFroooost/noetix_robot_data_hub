"""Record one audit row for each user operation that did not record its own."""

from __future__ import annotations

import logging
from urllib.parse import parse_qsl

from jwt import PyJWTError

from .core.security import decode_access_token
from .database import SessionLocal
from .models import AuditLog
from .services.audit import begin_request_audit, end_request_audit, request_audit_actions

logger = logging.getLogger("audit")

# Page loads and heartbeats. They repeat on their own and are not an operation.
_QUIET_PREFIXES = (
    "/api/presence",
    "/api/auth/me",
    "/api/auth/impersonation-targets",
    "/api/storage/overview",
    "/api/storage/rescan/status",
    "/api/storage/schema",
    "/api/repo/retarget/status",
    "/api/repo/retarget/storage-tree",
    "/api/repo/catalog",
    "/api/repo/meta",
    "/api/repo/browse-tree",
    "/api/repo/dimensions",
    "/api/repo/units",
    "/api/repo/files",
    "/api/repo/packs",
    "/api/users",
    "/api/taxonomies",
    "/api/folders",
    "/api/robot-models",
    "/api/model-assets",
    "/api/storage/models",
    "/api/audit",
    "/docs",
    "/openapi.json",
    "/redoc",
)


def _headers(scope: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in scope.get("headers") or []:
        out[key.decode("latin1").lower()] = value.decode("latin1")
    return out


def _user_ids(headers: dict[str, str], query: dict[str, str]) -> tuple[int | None, int | None]:
    raw = ""
    auth = headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        raw = auth.split(" ", 1)[1].strip()
    elif query.get("token"):
        raw = query["token"]
    if not raw:
        return None, None
    try:
        payload = decode_access_token(raw)
        user_id = int(payload["sub"])
        actor = payload.get("impersonator_id")
        return user_id, int(actor) if actor is not None else None
    except (PyJWTError, KeyError, ValueError, TypeError):
        return None, None


def _should_record(method: str, path: str, headers: dict[str, str]) -> bool:
    if method == "OPTIONS" or not path.startswith("/api/"):
        return False
    if headers.get("range"):
        return False
    if any(path == prefix or path.startswith(prefix + "/") for prefix in _QUIET_PREFIXES):
        if method == "GET":
            return "/download" in path
        return False
    if method != "GET":
        return True
    return (
        "/download" in path
        or path.startswith("/api/storage/file")
        or path.startswith("/api/storage/smpl-")
    )


def _action(method: str, path: str, query: dict[str, str]) -> str:
    if method == "GET":
        if "/download" in path or query.get("download") in {"1", "true", "True"}:
            return "download"
        return "view"
    return {"POST": "create", "PUT": "update", "PATCH": "update", "DELETE": "delete"}.get(
        method, method.lower()
    )


class AuditMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        token = begin_request_audit()
        status_code = 500

        async def send_wrapper(message):
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = int(message["status"])
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            try:
                self._record(scope, status_code)
            except Exception:
                logger.exception("操作记录写入失败")
            finally:
                end_request_audit(token)

    def _record(self, scope: dict, status_code: int) -> None:
        if request_audit_actions():
            return
        method = str(scope.get("method") or "GET").upper()
        path = str(scope.get("path") or "")
        headers = _headers(scope)
        if not _should_record(method, path, headers):
            return
        query = {
            key: value
            for key, value in parse_qsl(scope.get("query_string", b"").decode("latin1"))
            if key not in {"token", "password", "old_password", "new_password"}
        }
        user_id, actor_id = _user_ids(headers, query)
        if user_id is None and path != "/api/auth/login":
            return
        detail = {
            "method": method,
            "path": path,
            "status": status_code,
        }
        if query:
            detail["query"] = query
        if actor_id is not None:
            detail["impersonator_id"] = actor_id
        client = scope.get("client")
        if client:
            detail["ip"] = client[0]
        db = SessionLocal()
        try:
            db.add(
                AuditLog(
                    user_id=user_id,
                    action=_action(method, path, query),
                    entity_type="request",
                    detail=detail,
                )
            )
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()
