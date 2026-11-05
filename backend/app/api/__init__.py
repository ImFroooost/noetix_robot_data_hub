from fastapi import APIRouter

from . import (
    audit,
    auth,
    folders,
    model_assets,
    presence,
    repo,
    robot_models,
    storage_repository,
    taxonomies,
    users,
)

api_router = APIRouter(prefix="/api")
api_router.include_router(auth.router)
api_router.include_router(users.router)
api_router.include_router(presence.router)
api_router.include_router(folders.router)
api_router.include_router(taxonomies.router)
api_router.include_router(robot_models.router)
api_router.include_router(model_assets.router)
api_router.include_router(storage_repository.router)
api_router.include_router(repo.router)
api_router.include_router(audit.router)
