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


def enqueue_process_human(file_id: int):
    from ..worker.tasks import process_human_file

    get_queue().enqueue(process_human_file, file_id, job_timeout=600)


def enqueue_process_robot(file_id: int):
    from ..worker.tasks import process_robot_file

    get_queue().enqueue(process_robot_file, file_id, job_timeout=600)
