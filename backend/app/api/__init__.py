from fastapi import APIRouter

from . import auth, clips, files, folders, import_batch, repo, robot_models, taxonomies, users

api_router = APIRouter(prefix="/api")
api_router.include_router(auth.router)
api_router.include_router(users.router)
api_router.include_router(folders.router)
api_router.include_router(taxonomies.router)
api_router.include_router(clips.router)
api_router.include_router(files.router)
api_router.include_router(robot_models.router)
api_router.include_router(import_batch.router)
api_router.include_router(repo.router)
