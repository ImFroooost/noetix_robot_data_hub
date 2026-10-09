"""短时在线状态。存在 Redis 里，不写数据库。"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from redis import Redis

from ..config import settings

ONLINE_SECONDS = 50
KEEP_SECONDS = 14 * 24 * 3600
_redis: Redis | None = None


def _client() -> Redis:
    global _redis
    if _redis is None:
        _redis = Redis.from_url(settings.redis_url, decode_responses=True)
    return _redis


def _key(user_id: int) -> str:
    return f"hub:presence:{user_id}"


def touch(user_id: int, *, page: str, detail: str, idle: bool) -> None:
    payload = {
        "page": page.strip()[:40],
        "detail": detail.strip()[:240],
        "idle": bool(idle),
        "seen_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        _client().set(_key(user_id), json.dumps(payload, ensure_ascii=False), ex=KEEP_SECONDS)
    except Exception:
        return


def read_many(user_ids: list[int]) -> dict[int, dict]:
    if not user_ids:
        return {}
    try:
        raws = _client().mget([_key(user_id) for user_id in user_ids])
    except Exception:
        return {}
    now = datetime.now(timezone.utc)
    found: dict[int, dict] = {}
    for user_id, raw in zip(user_ids, raws):
        if not raw:
            continue
        try:
            data = json.loads(raw)
            seen = datetime.fromisoformat(str(data.get("seen_at") or ""))
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        if seen.tzinfo is None:
            seen = seen.replace(tzinfo=timezone.utc)
        fresh = (now - seen).total_seconds() <= ONLINE_SECONDS
        idle = bool(data.get("idle"))
        found[user_id] = {
            "online": fresh and not idle,
            "away": fresh and idle,
            "page": str(data.get("page") or ""),
            "detail": str(data.get("detail") or ""),
            "seen_at": seen.isoformat(),
        }
    return found
