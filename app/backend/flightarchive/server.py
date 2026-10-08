# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Small FastAPI host around the public RFG child application."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from .activity import ActivityLog
from .archive import ArchiveStore
from .legacy_tasks import LegacyTaskReader
from .paths import resolve_runtime_paths
from .routes.api import ApiError, error, router
from .thumbnail import ThumbnailService


class SpaStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        try:
            response = await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code != 404:
                raise
            return await super().get_response("index.html", scope)
        if response.status_code == 404:
            return await super().get_response("index.html", scope)
        return response


def default_static_dir() -> Path | None:
    module = Path(__file__).resolve()
    candidates = (module.parents[2] / "frontend" / "build", module.parents[1] / "frontend")
    return next((candidate for candidate in candidates if candidate.is_dir()), None)


def create_app(
    *, resource_root: str | Path | None = None, data_root: str | Path | None = None,
    static_dir: str | Path | None = None, cache_dir: str | Path | None = None,
) -> FastAPI:
    resource, data = resolve_runtime_paths(resource_root=resource_root, data_root=data_root)
    from rfg.api import create_app as create_rfg_app
    rfg_app = create_rfg_app(resource, data)
    configured_cache = cache_dir or os.getenv("FLIGHTARCHIVE_CACHE_DIR")
    cache = Path(configured_cache).expanduser() if configured_cache else data.parent / "cache"
    thumbnail_service = ThumbnailService(rfg_app, cache)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        async with rfg_app.router.lifespan_context(rfg_app):
            try:
                yield
            finally:
                await thumbnail_service.close()

    app = FastAPI(lifespan=lifespan)
    app.state.archive_store = ArchiveStore(data)
    app.state.activity_log = ActivityLog(data)
    app.state.legacy_task_reader = LegacyTaskReader(data)
    app.state.thumbnail_service = thumbnail_service
    app.include_router(router)

    @app.exception_handler(ApiError)
    async def api_error(_request: Request, exc: ApiError):
        return JSONResponse(error(exc.code, exc.message, exc.details), exc.status)

    @app.exception_handler(RequestValidationError)
    async def bad_request(_request: Request, _exc: RequestValidationError):
        return JSONResponse(error("bad-request", "invalid request"), 400)

    @rfg_app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
    async def unknown_api(path: str):
        return JSONResponse(error("not-found", f"unknown API path /api/{path}"), 404)

    configured_static = static_dir or os.getenv("FLIGHTARCHIVE_STATIC_DIR")
    frontend = Path(configured_static).expanduser() if configured_static else default_static_dir()
    if frontend and frontend.is_dir():
        rfg_app.mount("/", SpaStaticFiles(directory=frontend, html=True), name="flightarchive-spa")
    app.mount("/", rfg_app, name="rfg")
    return app
