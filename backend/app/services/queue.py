from redis import Redis
from rq import Queue

from ..config import settings

_redis = None
_queue = None


def get_queue() -> Queue:
    global _redis, _queue
    if _queue is None:
        _redis = Redis.from_url(settings.redis_url)
        _queue = Queue("robot_data_hub", connection=_redis)
    return _queue
