# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""FastAPI host that composes FlightArchive with the public RFG factory.

Import-order contract: ``rfg.hashes`` snapshots Pillow's process-global
``Image.MAX_IMAGE_PIXELS`` at import time.  This module therefore must not
import ``rfg.api`` at module level; ``create_app`` resolves the data root,
loads the runtime configuration, applies ``rfg.pillowImageMaxPixels`` to
Pillow, and only then imports the RFG factory.
"""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from starlette.exceptions import HTTPException as StarletteHTTPException

from .business_data import BusinessDataError, BusinessDataPersistence
from .config import load_runtime_config
from .routes.api import ApiError, ResourceLifecycleService, error, router
from .routes.images import router as images_router
from .domain.models import ValidationError
from .domain.store import ConflictError, NotFoundError
from .thumbnails import ThumbnailStore
from .tasks import BackgroundTaskRegistry
from .workspace.state import Workspace


class SpaStaticFiles(StaticFiles):
    """Serve real static files, then the SPA entrypoint for client routes."""
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


def _directory(value: str | Path | None, env: str, default: str, *, create: bool) -> Path:
    path = Path(value or os.getenv(env, default)).expanduser()
    if create: path.mkdir(parents=True, exist_ok=True)
    if not path.is_dir(): raise RuntimeError(f"{env} must name {'a creatable' if create else 'an existing'} directory: {path}")
    return path.resolve()


def _cache_directory(value: str | Path | None, data: Path) -> Path:
    """Thumbnail cache root: explicit value, FLIGHTARCHIVE_CACHE_DIR, or a sibling of the data root."""
    configured = value or os.getenv("FLIGHTARCHIVE_CACHE_DIR")
    path = Path(configured).expanduser() if configured else data.parent / "cache"
    path.mkdir(parents=True, exist_ok=True)
    if not path.is_dir(): raise RuntimeError(f"FLIGHTARCHIVE_CACHE_DIR must name a creatable directory: {path}")
    return path.resolve()


def default_static_dir() -> Path | None:
    """Find the built SPA in either the source tree or the container image."""
    module = Path(__file__).resolve()
    candidates = (module.parents[2] / "frontend" / "build", module.parents[1] / "frontend")
    return next((candidate for candidate in candidates if candidate.is_dir()), None)


def create_app(*, resource_root: str | Path | None = None, data_root: str | Path | None = None, static_dir: str | Path | None = None, workspace: Workspace | None = None, cache_dir: str | Path | None = None) -> FastAPI:
    root = _directory(resource_root, "RFG_RESOURCE_PATH", "/resource", create=False)
    data = _directory(data_root, "RFG_DATA_DIR", "/data", create=True)
    # Restart-only runtime config: seeded when absent, invalid files abort
    # startup here, before any RFG or business state is touched.
    config = load_runtime_config(data)
    # Apply the one supported host-level RFG image safety limit BEFORE the
    # RFG factory is imported: rfg.hashes captures Image.MAX_IMAGE_PIXELS at
    # import time, so a later assignment would never reach its snapshot.
    Image.MAX_IMAGE_PIXELS = config.rfg.pillow_image_max_pixels
    from rfg.api import create_app as create_rfg_app
    cache = _cache_directory(cache_dir, data)
    # RFG 1.0.0 only exposes a complete application factory.  Keep that app
    # isolated as a child: the FlightArchive host owns the public application,
    # including its state, exception handlers, and route precedence.
    rfg_app = create_rfg_app(root, data)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # Mounted applications do not have a lifecycle guarantee.  RFG builds
        # its initial catalog in its lifespan, so compose it explicitly.
        async with rfg_app.router.lifespan_context(rfg_app):
            yield

    app = FastAPI(lifespan=lifespan)
    current = workspace or Workspace(seed=False)
    loaded = current.configure_business_persistence(BusinessDataPersistence(data))
    if not loaded:
        if current.business_persistence and current.business_persistence.last_error:
            raise RuntimeError(f"invalid FlightArchive business data: {current.business_persistence.last_error}")
        current.domain.seed_defaults()
        current.persist_business_data()
    app.state.runtime_config = config
    app.state.flightarchive_workspace = current
    app.state.thumbnail_store = ThumbnailStore(
        cache,
        max_dimension=config.thumbnails.max_dimension,
        quality=config.thumbnails.quality,
        max_source_bytes=config.thumbnails.max_source_bytes,
        max_source_pixels=config.thumbnails.max_source_pixels,
    )
    # Cache misses fetch and decode potentially large source images.  This is
    # app-local (rather than module-global) so independently-created apps and
    # TestClient instances do not share capacity.
    app.state.thumbnail_job_limiter = asyncio.Semaphore(config.thumbnails.job_concurrency)
    app.state.resource_lifecycle = ResourceLifecycleService(app)
    app.state.background_tasks = BackgroundTaskRegistry()
    app.include_router(router)
    app.include_router(images_router)

    @app.exception_handler(ApiError)
    async def api_error(_request: Request, exc: ApiError): return JSONResponse(error(exc.code, exc.message, exc.details), exc.status)
    @app.exception_handler(ValidationError)
    async def validation(_request: Request, exc: ValidationError): return JSONResponse(error("validation", "validation failed", exc.issues), 422)
    @app.exception_handler(NotFoundError)
    async def missing(_request: Request, exc: NotFoundError): return JSONResponse(error("not-found", str(exc)), 404)
    @app.exception_handler(ConflictError)
    async def conflict(_request: Request, exc: ConflictError): return JSONResponse(error("conflict", str(exc)), 409)
    @app.exception_handler(BusinessDataError)
    async def persistence(_request: Request, exc: BusinessDataError): return JSONResponse(error("business-data-persistence", str(exc)), 500)
    @app.exception_handler(RequestValidationError)
    async def bad_request(_request: Request, _exc: RequestValidationError): return JSONResponse(error("bad-request", "invalid request"), 400)

    # This is deliberately a child route.  It is ordered after RFG's explicit
    # routes and before the SPA mount, so an unknown API request is JSON 404
    # rather than the SPA entrypoint.
    @rfg_app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
    async def unknown_api(path: str): return JSONResponse(error("not-found", f"unknown API path /api/{path}"), 404)

    configured_static = static_dir or os.getenv("FLIGHTARCHIVE_STATIC_DIR")
    frontend = Path(configured_static).expanduser() if configured_static else default_static_dir()
    if frontend and frontend.is_dir():
        # The child-level order is RFG routes, unknown /api, then SPA fallback.
        rfg_app.mount("/", SpaStaticFiles(directory=frontend, html=True), name="flightarchive-spa")
    # The child is the host's final fallback.  FlightArchive routes above always
    # win, while RFG retains its external /api/v1/* and /res/* URL contract.
    app.mount("/", rfg_app, name="rfg")
    return app
