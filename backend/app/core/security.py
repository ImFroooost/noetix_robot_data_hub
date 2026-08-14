from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from ..config import settings
from ..models.enums import UserRole


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


def create_access_token(user_id: int, username: str, role: UserRole) -> str:
    expire = datetime.now(timezone.utc) + timedelta(hours=settings.token_expire_hours)
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role.value,
        "exp": expire,
    }
    return jwt.encode(payload, settings.secret_key, algorithm="HS256")


def decode_access_token(token: str) -> dict:
    return jwt.decode(token, settings.secret_key, algorithms=["HS256"])
