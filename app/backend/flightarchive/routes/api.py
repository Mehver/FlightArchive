# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Domain-neutral FlightArchive HTTP routes."""
from __future__ import annotations

import json
import os
from datetime import date
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, Response

from ..archive import ArchiveError, MAX_DOCUMENT_BYTES, parse_finite_json
from ..thumbnail import ThumbnailError, parse_scale, validate_virtual_path

router = APIRouter(prefix="/api")

MAX_ACTIVITY_REQUEST_BYTES = 128 * 1024


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any = None):
        self.status, self.code, self.message, self.details = status, code, message, details


def error(code: str, message: str, details: Any = None) -> dict[str, Any]:
    result: dict[str, Any] = {"error": {"code": code, "message": message}}
    if details is not None:
        result["error"]["details"] = details
    return result


async def _object_body(request: Request, maximum: int = MAX_DOCUMENT_BYTES) -> dict[str, Any]:
    raw = await _bounded_request_bytes(request, maximum)
    try:
        value = parse_finite_json(raw)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise ApiError(400, "bad-request", "request body must be a JSON object") from exc
    if not isinstance(value, dict):
        raise ApiError(400, "bad-request", "request body must be a JSON object")
    return value


@router.get("/healthz")
async def healthz():
    return {"ok": True}


def _thumbnail_error(exc: ThumbnailError) -> ApiError:
    return ApiError(exc.status, exc.code, exc.message)


@router.api_route("/thumbnails/{virtual_path:path}", methods=["GET", "HEAD"])
async def thumbnail(virtual_path: str, request: Request):
    try:
        validate_virtual_path(virtual_path)
        query = request.query_params.multi_items()
        if any(key != "scale" for key, _value in query) or sum(key == "scale" for key, _value in query) > 1:
            raise ThumbnailError(400, "invalid-thumbnail-query", "only one scale parameter is permitted")
        scale, scale_text = parse_scale(request.query_params.get("scale"))
        service = request.app.state.thumbnail_service
        result = await (service.head(virtual_path, scale, scale_text) if request.method == "HEAD" else service.get(virtual_path, scale, scale_text))
    except ThumbnailError as exc:
        raise _thumbnail_error(exc) from exc
    response = Response(
        content=result.body or b"",
        media_type="image/webp",
        headers=result.headers,
    )
    if request.method == "HEAD" and not result.cached:
        del response.headers["content-length"]
    return response


@router.get("/status")
async def status(request: Request):
    store = request.app.state.archive_store
    try:
        revision = request.app.state.activity_log.revision()
    except OSError:
        revision = None
    return {"status": {
        "persistence": {
            "mode": "named-json-documents",
            "writable": store.data_root.is_dir() and os.access(store.data_root, os.W_OK),
            "persistenceError": None,
        },
        "archiveState": store.state(),
        "activityRevision": revision,
    }}


def _archive_store(request: Request, app_id: str):
    store = request.app.state.archive_store
    if app_id != store.app_id:
        raise ApiError(404, "archive-not-found", "archive application is not registered")
    return store


def _documents(store) -> list[str]:
    try:
        return store.list_documents()
    except ArchiveError as exc:
        raise ApiError(422, "invalid-archive", str(exc)) from exc
    except OSError as exc:
        raise ApiError(500, "archive-io", "archive could not be inspected") from exc


@router.get("/archive/{app_id}")
async def archive_root(app_id: str, request: Request):
    store = _archive_store(request, app_id)
    return JSONResponse({"appId": store.app_id, "documents": _documents(store)}, headers={"Cache-Control": "no-store"})


@router.get("/archive/{app_id}/documents")
async def archive_documents(app_id: str, request: Request):
    return JSONResponse({"documents": _documents(_archive_store(request, app_id))}, headers={"Cache-Control": "no-store"})


@router.get("/archive/{app_id}/documents/{document_id}")
async def get_archive_document(app_id: str, document_id: str, request: Request):
    store = _archive_store(request, app_id)
    try:
        value = store.read(document_id)
    except (KeyError, FileNotFoundError):
        raise ApiError(404, "document-not-found", "archive document was not found")
    except ArchiveError as exc:
        raise ApiError(422, "invalid-archive-document", str(exc)) from exc
    except OSError as exc:
        raise ApiError(500, "archive-io", "archive document could not be read") from exc
    return JSONResponse(value, headers={"Cache-Control": "no-store"})


async def _bounded_request_bytes(request: Request, maximum: int = MAX_DOCUMENT_BYTES) -> bytes:
    length = request.headers.get("content-length")
    if length is not None:
        try:
            if int(length) > maximum:
                raise ApiError(413, "request-too-large", "request body exceeds the size limit")
        except ValueError:
            raise ApiError(400, "bad-request", "invalid content length")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > maximum:
            raise ApiError(413, "request-too-large", "request body exceeds the size limit")
        chunks.append(chunk)
    return b"".join(chunks)


@router.put("/archive/{app_id}/documents/{document_id}", status_code=204)
async def put_archive_document(app_id: str, document_id: str, request: Request):
    store = _archive_store(request, app_id)
    try:
        store._document_id(document_id)
    except KeyError:
        raise ApiError(404, "document-not-found", "archive document name is not registered")
    try:
        store.write(document_id, await _bounded_request_bytes(request))
    except KeyError:
        raise ApiError(404, "document-not-found", "archive document name is not registered")
    except FileNotFoundError:
        raise ApiError(404, "archive-not-found", "archive has not been initialized")
    except ValueError as exc:
        raise ApiError(400, "bad-request", str(exc)) from exc
    except ArchiveError as exc:
        raise ApiError(422, "invalid-archive-document", str(exc)) from exc
    except OSError as exc:
        raise ApiError(500, "archive-io", "archive document could not be written") from exc
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


@router.delete("/archive/{app_id}/documents/{document_id}", status_code=204)
async def delete_archive_document(app_id: str, document_id: str, request: Request):
    store = _archive_store(request, app_id)
    try:
        store.delete(document_id)
    except (KeyError, FileNotFoundError):
        raise ApiError(404, "document-not-found", "archive document was not found")
    except ArchiveError as exc:
        raise ApiError(422, "invalid-archive-document", str(exc)) from exc
    except OSError as exc:
        raise ApiError(500, "archive-io", "archive document could not be deleted") from exc
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


@router.get("/activity")
async def activity_history(request: Request, before: date | None = None, limit_days: int = Query(3, alias="limitDays", ge=1, le=30)):
    try:
        result = request.app.state.activity_log.history(before=before.isoformat() if before else None, limit_days=limit_days)
    except OSError as exc:
        raise ApiError(422, "invalid-activity-log", str(exc)) from exc
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@router.post("/activity", status_code=201)
async def create_activity(request: Request):
    data = await _object_body(request, MAX_ACTIVITY_REQUEST_BYTES)
    if set(data) != {"source", "kind", "severity", "state", "code", "details"}:
        raise ApiError(400, "bad-request", "activity must contain exactly source, kind, severity, state, code, and details")
    try:
        record = request.app.state.activity_log.report(
            data["source"], data["kind"], data["severity"], data["state"], data["code"], data["details"],
        )
    except ValueError as exc:
        raise ApiError(400, "bad-request", str(exc)) from exc
    except OSError as exc:
        raise ApiError(500, "activity-write-failed", "activity could not be persisted") from exc
    return JSONResponse(record, status_code=201, headers={"Cache-Control": "no-store"})


@router.get("/tasks")
async def tasks(request: Request, before: date | None = None, limit_days: int = Query(3, alias="limitDays", ge=1, le=30)):
    try:
        result = request.app.state.legacy_task_reader.history(before=before.isoformat() if before else None, limit_days=limit_days)
    except OSError as exc:
        raise ApiError(422, "invalid-legacy-task-log", str(exc)) from exc
    return JSONResponse(result, headers={"Cache-Control": "no-store"})
