from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.requests import Request as StarletteRequest

# Raise Starlette's multipart parser limits (default 1000 files/fields)
_original_form = StarletteRequest.form


def _patched_form(self, *, max_files: int | float = 100000, max_fields: int | float = 100000, max_part_size: int = 100 * 1024 * 1024):
    return _original_form(self, max_files=max_files, max_fields=max_fields, max_part_size=max_part_size)


StarletteRequest.form = _patched_form

import logging
logger = logging.getLogger("upload_debug")
logging.basicConfig(level=logging.WARNING)



from .api import api_router
from .config import settings
from .core.security import hash_password
from .database import SessionLocal, init_db
from .models import User, UserRole
from .services.disk_repository import schedule_catalog_rebuild
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
                role=UserRole.super_manager,
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
    try:
        schedule_catalog_rebuild()
    except Exception:
        pass
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


@app.middleware("http")
async def log_body_parse_errors(request, call_next):
    response = await call_next(request)
    if response.status_code == 400 and "upload" in str(request.url.path):
        logger.warning("Upload 400 error on %s", request.url.path)
    return response


app.include_router(api_router)

from fastapi import HTTPException
from fastapi.responses import JSONResponse


@app.exception_handler(HTTPException)
async def log_parse_errors(request, exc: HTTPException):
    if exc.status_code == 400 and "parsing" in str(exc.detail):
        cause = exc.__cause__
        logger.error("Body parse error on %s: %s: %s", request.url.path, type(cause).__name__ if cause else "unknown", cause)
        return JSONResponse(
            status_code=400,
            content={"detail": f"Body parse error: {cause}" if cause else exc.detail},
        )
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.get("/health")
def health():
    return {"status": "ok"}
