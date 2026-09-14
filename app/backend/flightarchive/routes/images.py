# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Image-only resource route backed by the FlightArchive thumbnail cache.

``GET /images/{virtual_path}`` is the parallel image counterpart of RFG's
``/res/{virtual_path}``: it lazily renders and serves a small WebP thumbnail
for mapped raster resources. The requested virtual path is validated against
the current RFG mapping; original bytes are fetched only through RFG's HTTP
resource route, so arbitrary local paths can never be served. Unmapped paths
return 404; non-decodable or non-raster resources return 415.
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request, Response

from ..thumbnails import ThumbnailStore, UnsupportedImageError
from .api import ApiError

router = APIRouter()


@router.api_route("/images/{virtual_path:path}", methods=["GET", "HEAD"])
async def image(request: Request, virtual_path: str) -> Response:
    lifecycle = request.app.state.resource_lifecycle
    store: ThumbnailStore = request.app.state.thumbnail_store
    document, _ = await lifecycle.mapping()
    entry = next((item for item in document["entries"] if item["virtual_path"] == virtual_path), None)
    if entry is None:
        raise ApiError(404, "resource-not-found", "virtual path is not mapped")
    local_path = entry["local_path"]
    source_etag = await lifecycle.resource_etag(virtual_path)
    thumbnail = await asyncio.to_thread(store.lookup, virtual_path, local_path, source_etag)
    if thumbnail is None:
        # Hits bypass this limiter.  A miss holds one of the app-wide slots for
        # both the potentially large HTTP retrieval and CPU-bound rendering.
        # Check the cache again after waiting: another request may have filled
        # it while this one was queued, avoiding a redundant source fetch.
        async with request.app.state.thumbnail_job_limiter:
            document, _ = await lifecycle.mapping()
            entry = next((item for item in document["entries"] if item["virtual_path"] == virtual_path), None)
            if entry is None:
                raise ApiError(404, "resource-not-found", "virtual path is not mapped")
            local_path = entry["local_path"]
            source_etag = await lifecycle.resource_etag(virtual_path)
            thumbnail = await asyncio.to_thread(store.lookup, virtual_path, local_path, source_etag)
            if thumbnail is None:
                source, source_etag = await lifecycle.resource_bytes(virtual_path, max_bytes=store.max_source_bytes)
                try:
                    thumbnail = await asyncio.to_thread(store.get_or_create, virtual_path, local_path, source_etag, source)
                except UnsupportedImageError as problem:
                    raise ApiError(415, "image-unsupported", str(problem)) from problem
    # The id is the SHA-256 of the WebP bytes, so it is a strong validator.
    etag = f'"{thumbnail.id}"'
    headers = {"ETag": etag, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    headers["Content-Length"] = str(len(thumbnail.data))
    if request.method == "HEAD":
        return Response(status_code=200, headers=headers)
    return Response(content=thumbnail.data, media_type="image/webp", headers=headers)
