from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import api_router
from .config import settings
from .core.security import hash_password
from .database import SessionLocal, init_db
from .models import User, UserRole
from .services.hub_repo import ensure_hub_skeleton
from .services.storage import data_root


def ensure_admin():
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.username == settings.admin_username).first()
        if not user:
            user = User(
                username=settings.admin_username,
                password_hash=hash_password(settings.admin_password),
                role=UserRole.admin,
            )
            db.add(user)
            db.commit()
    finally:
        db.close()


@asynccontextmanager
async def lifespan(_: FastAPI):
    data_root()
    try:
        ensure_hub_skeleton()
    except Exception:
        pass
    init_db()
    ensure_admin()
    yield


app = FastAPI(
    title="Noetix Robot Data Hub API",
    description="机器人数据管理中心接口",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)


@app.get("/health")
def health():
    return {"status": "ok"}
