# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""FlightArchive FastAPI API and its small RFG lifecycle adapter."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import sqlite3
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictStr, field_validator

from .. import APP_NAME, __version__
from ..domain.models import (
    FlightRecord,
    ValidationError,
    validate_resource_relation_payload,
    validate_electronic_boarding_pass,
    validate_optional_hex_color,
    validate_paper_boarding_pass_layouts,
)
from ..domain.store import ConflictError, NotFoundError
from ..workspace.state import Workspace
from ..thumbnails import InvalidCropError, ThumbnailStore, UnsupportedImageError, preview_geometry_id

router = APIRouter(prefix="/api")
logger = logging.getLogger(__name__)


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any = None):
        self.status, self.code, self.message, self.details = status, code, message, details


def error(code: str, message: str, details: Any = None) -> dict[str, Any]:
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
    if details is not None: body["error"]["details"] = details
    return body


def ws(request: Request) -> Workspace:
    return request.app.state.flightarchive_workspace


async def body(request: Request) -> dict[str, Any]:
    try: value = await request.json()
    except Exception as exc: raise ApiError(400, "bad-request", "request body must be a JSON object") from exc
    if not isinstance(value, dict): raise ApiError(400, "bad-request", "request body must be a JSON object")
    return value


class BatchCatalogDeleteRequest(BaseModel):
    """Validated payload for the catalog multi-delete endpoint."""

    model_config = ConfigDict(extra="forbid")

    keys: list[StrictStr] = Field(min_length=1)
    force: StrictBool = False

    @field_validator("keys")
    @classmethod
    def normalize_and_deduplicate_keys(cls, keys: list[str]) -> list[str]:
        normalized: list[str] = []
        for key in keys:
            value = key.strip().upper()
            if not value:
                raise ValueError("keys must not contain empty values")
            if value not in normalized:
                normalized.append(value)
        if not normalized:
            raise ValueError("keys must contain at least one value")
        return normalized


class BatchCatalogDeleteResponse(BaseModel):
    deleted: list[str]


class ResourceLifecycleService:
    """Uses only RFG's documented HTTP API; no RFG state is accessed."""
    def __init__(self, app: FastAPI):
        self.app, self.lock = app, asyncio.Lock()
        # Always acquire this before ``lock`` and the workspace lock.  It spans
        # a business resource mutation from mapping validation to persistence.
        self.business_lock = asyncio.Lock()
        # Best-effort, process-local retries only. Successful business writes
        # never depend on this set surviving a restart.
        self.deferred_releases: set[str] = set()

    @staticmethod
    def _mapping_headers(etag: str | None) -> dict[str, str]:
        if not etag:
            raise ApiError(503, "rfg-unavailable", "RFG mapping has no revision token")
        return {"If-Match": etag}

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        transport = httpx.ASGITransport(app=self.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://rfg.internal") as client:
            return await client.request(method, path, **kwargs)

    async def catalog(self) -> list[dict[str, Any]]:
        response = await self._request("GET", "/api/v1/meta/local")
        if response.status_code != 200: raise ApiError(503, "rfg-unavailable", "RFG catalog is unavailable")
        return response.json().get("local_files", [])

    async def mapping(self) -> tuple[dict[str, Any], str | None]:
        response = await self._request("GET", "/api/v1/meta/map")
        if response.status_code != 200: raise ApiError(503, "rfg-unavailable", "RFG mapping is unavailable")
        return response.json(), response.headers.get("etag")

    async def synchronize(self) -> dict[str, int]:
        """Refresh RFG's catalog, expire stale temporary mappings, and inbox new sources."""
        await self.retry_deferred_releases()
        catalog = await self.catalog()
        local_paths = [item["local_path"] for item in catalog if isinstance(item.get("local_path"), str)]
        async with self.business_lock, self.lock:
            document, etag = await self.mapping()
            catalog_set = set(local_paths)
            # Inbox and ignore are both transient, non-business mappings. When
            # their exact source path disappears (including a move), forget
            # them; classified object mappings deliberately remain rematch
            # targets.
            expired_temporary = [item for item in document["entries"] if isinstance(item.get("virtual_path"), str) and item["virtual_path"].startswith(("inbox/", "ignore/")) and item.get("local_path") not in catalog_set]
            if expired_temporary:
                document["entries"] = [item for item in document["entries"] if item not in expired_temporary]
            mapped_local = {item["local_path"] for item in document["entries"]}
            mapped_virtual = {item["virtual_path"] for item in document["entries"]}
            additions = []
            for local_path in local_paths:
                if local_path in mapped_local:
                    continue
                virtual_path = f"inbox/{local_path}"
                if virtual_path in mapped_virtual:
                    raise ApiError(409, "resource-conflict", "inbox virtual path is already mapped")
                additions.append({"virtual_path": virtual_path, "local_path": local_path})
                mapped_virtual.add(virtual_path)
            if additions:
                document["entries"].extend(additions)
            if additions or expired_temporary:
                response = await self._request("PUT", "/api/v1/meta/map", json=document, headers=self._mapping_headers(etag))
                if response.status_code == 412:
                    raise ApiError(409, "resource-conflict", "RFG mapping changed; retry")
                if response.status_code != 200:
                    raise ApiError(503, "rfg-unavailable", "could not persist RFG mapping")
            # Keep missing object mappings for RFG rematch, but never retain a
            # thumbnail binding after its mapping/source pair stopped current.
            try:
                catalog_paths = set(local_paths)
                current_sources = {
                    (entry["virtual_path"], entry["local_path"])
                    for entry in document["entries"]
                    if isinstance(entry.get("virtual_path"), str)
                    and isinstance(entry.get("local_path"), str)
                    and entry["local_path"] in catalog_paths
                }
                preview_sources = _current_preview_sources(self.app.state.flightarchive_workspace, document, catalog_paths)
                await asyncio.to_thread(self.app.state.thumbnail_store.reconcile_bindings, current_sources, preview_sources)
            except (OSError, sqlite3.Error):
                logger.warning("could not reconcile thumbnail bindings after resource synchronization", exc_info=True)
            return {"cataloged": len(local_paths), "added": len(additions), "removedTemporary": len(expired_temporary)}

    async def ignore(self, data: dict[str, Any]) -> dict[str, Any]:
        """Rename one present inbox entry to its non-business ignore mapping."""
        if set(data) != {"ifMatch", "virtualPath"} or not isinstance(data.get("virtualPath"), str):
            raise ApiError(422, "validation", "request must contain ifMatch and virtualPath")
        requested_etag, virtual_path = data["ifMatch"], data["virtualPath"]
        if requested_etag is not None and not isinstance(requested_etag, str):
            raise ApiError(422, "validation", "ifMatch must be a string or null")
        async with self.business_lock, self.lock:
            document, etag = await self.mapping()
            if requested_etag != etag:
                raise ApiError(409, "resource-conflict", "RFG mapping changed; retry")
            entry = next((item for item in document["entries"] if item.get("virtual_path") == virtual_path), None)
            catalog_paths = {item.get("local_path") for item in await self.catalog()}
            if entry is None:
                raise ApiError(404, "resource-not-found", "resource is not mapped")
            if not virtual_path.startswith("inbox/") or entry.get("local_path") not in catalog_paths:
                raise ApiError(422, "resource-not-eligible", "only present inbox resources can be ignored")
            target = f"ignore/{quote(entry['local_path'], safe='/')}"
            if any(item is not entry and item.get("virtual_path") == target for item in document["entries"]):
                raise ApiError(409, "resource-conflict", "ignore virtual path is already mapped")
            entry["virtual_path"] = target
            response = await self._request("PUT", "/api/v1/meta/map", json=document, headers=self._mapping_headers(etag))
            if response.status_code == 412:
                raise ApiError(409, "resource-conflict", "RFG mapping changed; retry")
            if response.status_code != 200:
                raise ApiError(503, "rfg-unavailable", "could not persist RFG mapping")
            mapping, new_etag = await self.mapping()
            return {"ignoredVirtualPath": target, "mapping": mapping, "localFiles": await self.catalog(), "etag": new_etag}

    async def assert_mapped(self, paths: list[str]) -> None:
        document, _ = await self.mapping()
        available = {entry["virtual_path"] for entry in document["entries"]}
        missing = sorted(set(paths) - available)
        if missing: raise ApiError(422, "resource-not-mapped", "resource paths must be mapped by RFG", missing)
        if any(path.startswith("ignore/") for path in paths):
            raise ApiError(422, "resource-not-eligible", "ignored resources cannot be attached to business data")

    async def release_unreferenced(self, candidates: list[str]) -> list[str]:
        """Return present, unowned mutation candidates to their inbox paths.

        Missing-source mappings deliberately remain object mappings for rematch.
        Only mutation candidates are considered, so unrelated stale objects are
        never swept up by ordinary business writes.
        """
        pending = {path for path in candidates if isinstance(path, str) and not path.startswith(("inbox/", "ignore/"))}
        if not pending:
            return []
        async with self.lock:
            for attempt in range(2):
                document, etag = await self.mapping()
                catalog = _catalog_by_local_path(await self.catalog())
                entries = document.get("entries", [])
                by_virtual = {entry.get("virtual_path"): entry for entry in entries if isinstance(entry.get("virtual_path"), str)}
                releasable = [
                    by_virtual[path] for path in pending
                    if path in by_virtual and by_virtual[path].get("local_path") in catalog
                ]
                if not releasable:
                    return []
                # Hold business data through the map write: another flight or
                # airline mutation must not acquire a reference in the gap.
                async with self.app.state.flightarchive_workspace.lock:
                    references = persistent_business_resource_paths(self.app.state.flightarchive_workspace)
                    releasable = [entry for entry in releasable if entry["virtual_path"] not in references]
                    if not releasable:
                        return []
                    released, renamed = self._release_entries(document, releasable, conflict_is_error=False)
                    if not released:
                        return []
                    response = await self._request(
                        "PUT", "/api/v1/meta/map", json=document,
                        headers=self._mapping_headers(etag),
                    )
                if response.status_code == 412 and attempt == 0:
                    continue
                if response.status_code == 412:
                    raise ApiError(409, "resource-conflict", "RFG mapping changed during cleanup")
                if response.status_code != 200:
                    raise ApiError(503, "rfg-unavailable", "could not persist RFG mapping release")
                await self._reconcile_release_thumbnails(released, renamed, document, catalog)
                return sorted(released)
        return []

    def defer_release(self, candidates: list[str]) -> None:
        self.deferred_releases.update(path for path in candidates if isinstance(path, str) and not path.startswith("inbox/"))

    async def retry_deferred_releases(self) -> None:
        """Retry only release work which a completed business mutation deferred."""
        async with self.business_lock:
            candidates = set(self.deferred_releases)
            if not candidates:
                return
            try:
                await self.release_unreferenced(list(candidates))
                document, _ = await self.mapping()
                catalog = _catalog_by_local_path(await self.catalog())
                references = persistent_business_resource_paths(self.app.state.flightarchive_workspace)
                current = {entry.get("virtual_path"): entry for entry in document.get("entries", [])}
                # A missing source, a surviving reference, and an already-inbox
                # or absent mapping are definitive outcomes, not retry work.
                self.deferred_releases.difference_update(
                    path for path in candidates
                    if path in references or path not in current or path.startswith("inbox/")
                    or current[path].get("local_path") not in catalog
                )
            except Exception:
                logger.warning("could not retry deferred resource releases", exc_info=True)

    @staticmethod
    def _release_entries(document: dict[str, Any], entries: list[dict[str, Any]], *, conflict_is_error: bool) -> tuple[list[str], list[tuple[str, str]]]:
        """Change object entries to inbox entries without ever touching sources."""
        all_entries = document["entries"]
        released: list[str] = []
        renamed: list[tuple[str, str]] = []
        for entry in entries:
            old_path, local_path = entry["virtual_path"], entry["local_path"]
            inbox_path = f"inbox/{local_path}"
            collision = next((item for item in all_entries if item is not entry and item.get("virtual_path") == inbox_path), None)
            if collision is not None and collision.get("local_path") != local_path:
                if conflict_is_error:
                    raise ApiError(409, "resource-conflict", "inbox virtual path is already mapped to another source")
                continue
            released.append(old_path)
            if collision is not None:
                all_entries.remove(entry)
                continue
            entry["virtual_path"] = inbox_path
            for algorithm in _FINGERPRINT_ALGORITHMS:
                entry.pop(algorithm, None)
            renamed.append((old_path, inbox_path))
        return released, renamed

    async def _reconcile_release_thumbnails(self, released: list[str], renamed: list[tuple[str, str]], document: dict[str, Any], catalog: dict[str, dict[str, Any]]) -> None:
        """Move reusable generic bindings and discard all no-longer-current derivatives."""
        try:
            source_etags: dict[str, str] = {}
            for _, inbox_path in renamed:
                source_etags[inbox_path] = await self.resource_etag(inbox_path)
            store = self.app.state.thumbnail_store
            def reconcile() -> None:
                renamed_from = {old for old, _ in renamed}
                for old_path, inbox_path in renamed:
                    store.rebind(old_path, inbox_path, source_etags[inbox_path])
                # A same-source inbox collision is retained, so preserve its
                # binding and only dispose of the dropped object's binding.
                for old_path in set(released) - renamed_from:
                    store.invalidate(old_path)
                current_sources = {
                    (entry["virtual_path"], entry["local_path"])
                    for entry in document["entries"]
                    if isinstance(entry.get("virtual_path"), str)
                    and isinstance(entry.get("local_path"), str)
                    and entry["local_path"] in catalog
                }
                store.reconcile_bindings(
                    current_sources,
                    _current_preview_sources(self.app.state.flightarchive_workspace, document, set(catalog)),
                )
            await asyncio.to_thread(reconcile)
        except (ApiError, OSError, sqlite3.Error):
            logger.warning("could not reconcile thumbnail bindings after resource release", exc_info=True)

    async def release(self, data: dict[str, Any]) -> dict[str, Any]:
        """Explicitly return selected unowned, current object mappings to inbox."""
        paths, requested_etag = _release_request(data)
        async with self.business_lock, self.lock:
            catalog = _catalog_by_local_path(await self.catalog())
            document, etag = await self.mapping()
            if requested_etag is not None and requested_etag != etag:
                raise ApiError(409, "resource-conflict", "RFG mapping changed; retry")
            entries = {entry.get("virtual_path"): entry for entry in document.get("entries", [])}
            async with self.app.state.flightarchive_workspace.lock:
                references = persistent_business_resource_paths(self.app.state.flightarchive_workspace)
                selected: list[dict[str, Any]] = []
                for path in paths:
                    entry = entries.get(path)
                    if entry is None:
                        raise ApiError(404, "resource-not-found", "resource is not mapped")
                    if path.startswith("inbox/") or entry.get("local_path") not in catalog:
                        raise ApiError(422, "resource-not-eligible", "resource must be a current non-inbox mapping")
                    if path in references:
                        raise ApiError(409, "resource-conflict", "resource is still referenced by business data")
                    selected.append(entry)
                released, renamed = self._release_entries(document, selected, conflict_is_error=True)
                response = await self._request("PUT", "/api/v1/meta/map", json=document, headers=self._mapping_headers(etag))
                if response.status_code == 412:
                    raise ApiError(409, "resource-conflict", "RFG mapping changed; retry")
                if response.status_code != 200:
                    raise ApiError(503, "rfg-unavailable", "could not persist RFG mapping release")
            await self._reconcile_release_thumbnails(released, renamed, document, catalog)
            mapping, new_etag = await self.mapping()
            return {"released": sorted(released), "mapping": mapping, "localFiles": list(catalog.values()), "etag": new_etag}

    async def resource_bytes(self, virtual_path: str, *, max_bytes: int) -> tuple[bytes, str]:
        """Read the original bytes of a mapped virtual path via RFG's /res/ route.

        The gateway is the only resource delivery layer; this service never
        touches source files directly. The body is capped at *max_bytes*.
        """
        quoted = self._quoted_virtual_path(virtual_path)
        transport = httpx.ASGITransport(app=self.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://rfg.internal") as client:
            for attempt in range(2):
                async with client.stream("GET", f"/res/{quoted}") as response:
                    if response.status_code == 503 and attempt == 0:
                        await self.catalog()
                        continue
                    if response.status_code == 404:
                        raise ApiError(404, "resource-not-found", "virtual resource is unavailable")
                    if response.status_code != 200:
                        raise ApiError(503, "rfg-unavailable", "virtual resource could not be read")
                    source_etag = response.headers.get("etag")
                    if source_etag is None:
                        raise ApiError(503, "rfg-unavailable", "virtual resource has no source revision")
                    chunks, total = [], 0
                    async for chunk in response.aiter_bytes(64 * 1024):
                        total += len(chunk)
                        if total > max_bytes:
                            raise ApiError(415, "image-too-large", "image exceeds the thumbnail source size limit")
                        chunks.append(chunk)
                    return b"".join(chunks), source_etag
        raise AssertionError("unreachable")

    @staticmethod
    def _quoted_virtual_path(virtual_path: str) -> str:
        return "/".join(quote(segment, safe="") for segment in virtual_path.split("/"))

    async def resource_etag(self, virtual_path: str) -> str:
        """Return the current RFG source revision, refreshing only stale scans."""
        quoted = self._quoted_virtual_path(virtual_path)
        for attempt in range(2):
            response = await self._request("HEAD", f"/res/{quoted}")
            if response.status_code == 503 and attempt == 0:
                await self.catalog()
                continue
            if response.status_code == 404:
                raise ApiError(404, "resource-not-found", "virtual resource is unavailable")
            if response.status_code != 200:
                raise ApiError(503, "rfg-unavailable", "virtual resource could not be read")
            etag = response.headers.get("etag")
            if etag is None:
                raise ApiError(503, "rfg-unavailable", "virtual resource has no source revision")
            return etag
        raise AssertionError("unreachable")

    async def invalidate_flight_previews(self, flight_id: str) -> None:
        """Best-effort invalidation for disposable flight-specific derivatives."""
        try:
            await asyncio.to_thread(self.app.state.thumbnail_store.invalidate_previews, flight_id)
        except (OSError, sqlite3.Error):
            logger.warning("could not remove boarding-pass preview cache", exc_info=True)

    async def _materialize(self, inbox_path: str, owners: list[ResourceOwner]) -> str:
        """Move one validated inbox resource to its stable named object path."""
        async with self.lock:
            document, etag = await self.mapping()
            entry = next((item for item in document["entries"] if item["virtual_path"] == inbox_path), None)
            if entry is None: raise ApiError(404, "resource-not-found", "inbox resource is not mapped")
            target = generate_resource_name(owners, _extension_of(entry["local_path"]))
            taken = {item["virtual_path"] for item in document["entries"] if item is not entry}
            if target in taken:
                # Same owner, different source (e.g. a replaced image) reuses the
                # human-readable prefix; a short source hash keeps the path unique.
                target = _disambiguate_resource_name(target, entry["local_path"])
                if target in taken:
                    raise ApiError(409, "resource-conflict", "object path is already mapped")
            entry["virtual_path"] = target
            response = await self._request("PUT", "/api/v1/meta/map", json=document, headers=self._mapping_headers(etag))
            if response.status_code == 412: raise ApiError(409, "resource-conflict", "RFG mapping changed; retry")
            if response.status_code != 200: raise ApiError(503, "rfg-unavailable", "could not persist RFG mapping")
            # The source did not change, so an existing inbox thumbnail object
            # moves to the stable object ID without being regenerated.
            try:
                source_etag = await self.resource_etag(target)
                await asyncio.to_thread(self.app.state.thumbnail_store.rebind, inbox_path, target, source_etag)
            except (ApiError, OSError, sqlite3.Error):
                logger.warning("could not rebind thumbnail after resource materialization", exc_info=True)
            return target

    async def materialize_flight_resources(self, data: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
        """Materialize pending flight resources after the complete form is valid.

        Resource selection is intentionally side-effect free: the browser keeps
        ``inbox/`` paths in its draft form, and this is the only point where a
        successful flight submission turns them into stable named RFG object
        paths.
        """
        resolved = dict(data)
        created: list[str] = []
        materialized: dict[str, str] = {}
        for field, (role, index) in _FLIGHT_ROLE_INDEX_BY_FIELD.items():
            path = resolved.get(field)
            if isinstance(path, str) and path.startswith("inbox/"):
                if path not in materialized:
                    try:
                        materialized[path] = await self._materialize(path, [_flight_owner(resolved, role, index)])
                    except Exception:
                        await _best_effort_release(self, created, "failed flight resource materialization")
                        raise
                resolved[field] = materialized[path]
                created.append(resolved[field])
        attachments = resolved.get("attachmentResourcePaths")
        if isinstance(attachments, list):
            materialized_attachments = []
            for index, path in enumerate(attachments):
                if path.startswith("inbox/"):
                    if path not in materialized:
                        try:
                            materialized[path] = await self._materialize(path, [_flight_owner(resolved, "c", index)])
                        except Exception:
                            await _best_effort_release(self, created, "failed flight resource materialization")
                            raise
                    path = materialized[path]
                    created.append(path)
                materialized_attachments.append(path)
            resolved["attachmentResourcePaths"] = materialized_attachments
        return resolved, list(dict.fromkeys(created))

    async def materialize_catalog_resources(self, kind: str, data: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
        """Materialize pending airline logos only after their catalog form is valid."""
        if kind != "airlines":
            return data, []
        resolved = dict(data)
        created: list[str] = []
        materialized: dict[str, str] = {}
        for field, role in _AIRLINE_ROLE_BY_FIELD.items():
            path = resolved.get(field)
            if isinstance(path, str) and path.startswith("inbox/"):
                if path not in materialized:
                    try:
                        materialized[path] = await self._materialize(path, [_airline_owner(resolved, role)])
                    except Exception:
                        await _best_effort_release(self, created, "failed catalog resource materialization")
                        raise
                resolved[field] = materialized[path]
                created.append(resolved[field])
        return resolved, list(dict.fromkeys(created))

    async def image_virtual_paths(self, paths: list[str]) -> list[str]:
        """Filter newly materialized paths to source files that are images."""
        document, _ = await self.mapping()
        local_by_virtual = {entry["virtual_path"]: entry["local_path"] for entry in document["entries"]}
        return [
            path for path in paths
            if isinstance(local_by_virtual.get(path), str) and local_by_virtual[path].lower().endswith(_IMAGE_SUFFIXES)
        ]

    async def fingerprint_work(self, paths: list[str]) -> dict[str, tuple[str, ...]]:
        """Choose feasible automatic hashes from mapped source file types."""
        document, _ = await self.mapping()
        local_by_virtual = {entry["virtual_path"]: entry["local_path"] for entry in document["entries"]}
        return {
            path: _CONTENT_FINGERPRINT_ALGORITHMS + (_PERCEPTUAL_FINGERPRINT_ALGORITHMS if _supports_perceptual_hash(local_by_virtual.get(path, "")) else ())
            for path in paths
            if isinstance(local_by_virtual.get(path), str) and local_by_virtual[path].lower().endswith(_IMAGE_SUFFIXES)
        }

    async def rematch(self, data: dict[str, Any]) -> dict[str, Any]:
        if set(data) - {"ifMatch", "matches"} or "matches" not in data:
            raise ApiError(422, "validation", "request must contain only ifMatch and matches")
        if "ifMatch" in data and data["ifMatch"] is not None and not isinstance(data["ifMatch"], str):
            raise ApiError(422, "validation", "ifMatch must be a string or null")
        matches = data["matches"]
        if not isinstance(matches, list) or not matches:
            raise ApiError(422, "validation", "matches must be a nonempty list")
        pairs: list[tuple[str, str]] = []
        for item in matches:
            if not isinstance(item, dict) or set(item) != {"targetVirtualPath", "candidateInboxVirtualPath"}:
                raise ApiError(422, "validation", "each match must contain targetVirtualPath and candidateInboxVirtualPath")
            target, candidate = item["targetVirtualPath"], item["candidateInboxVirtualPath"]
            if not isinstance(target, str) or not isinstance(candidate, str):
                raise ApiError(422, "validation", "match paths must be strings")
            pairs.append((target, candidate))
        targets, candidates = [pair[0] for pair in pairs], [pair[1] for pair in pairs]
        if len(targets) != len(set(targets)):
            raise ApiError(422, "validation", "target virtual paths must be unique")
        if len(candidates) != len(set(candidates)):
            raise ApiError(422, "validation", "candidate inbox virtual paths must be unique")

        catalog = await self.catalog()
        catalog_by_path = {item["local_path"]: item for item in catalog if isinstance(item.get("local_path"), str)}
        async with self.business_lock, self.lock:
            document, etag = await self.mapping()
            if isinstance(data.get("ifMatch"), str) and data["ifMatch"] != etag:
                raise ApiError(409, "resource-conflict", "RFG mapping changed; retry")
            entries = {entry["virtual_path"]: entry for entry in document["entries"]}
            for target_path, candidate_path in pairs:
                target, candidate = entries.get(target_path), entries.get(candidate_path)
                if target is None or candidate is None:
                    raise ApiError(404, "resource-not-found", "resource is not mapped")
                if target_path.startswith("inbox/") or target["local_path"] in catalog_by_path:
                    raise ApiError(422, "validation", "target must be a missing non-inbox resource")
                if not candidate_path.startswith("inbox/") or candidate["local_path"] not in catalog_by_path:
                    raise ApiError(422, "validation", "candidate must be a cataloged inbox resource")
            consumed = set(candidates)
            for target_path, candidate_path in pairs:
                target, candidate = entries[target_path], entries[candidate_path]
                target.clear()
                target.update({"virtual_path": target_path, "local_path": candidate["local_path"]})
                metadata = catalog_by_path[candidate["local_path"]]
                if isinstance(metadata.get("size_bytes"), int) and not isinstance(metadata["size_bytes"], bool):
                    target["size_bytes"] = metadata["size_bytes"]
            document["entries"] = [entry for entry in document["entries"] if entry["virtual_path"] not in consumed]
            response = await self._request("PUT", "/api/v1/meta/map", json=document, headers=self._mapping_headers(etag))
            if response.status_code == 412: raise ApiError(409, "resource-conflict", "RFG mapping changed; retry")
            if response.status_code != 200: raise ApiError(503, "rfg-unavailable", "could not persist RFG mapping")
            # Each rematch eliminates the stale target thumbnail and, when the
            # candidate inbox resource already has one, rebinds that object to
            # the target so the replacement needs no regeneration.
            store = self.app.state.thumbnail_store
            source_etags = {}
            for target_path, _ in pairs:
                try:
                    source_etags[target_path] = await self.resource_etag(target_path)
                except ApiError:
                    logger.warning("could not revalidate thumbnail after resource rematch", exc_info=True)
            def move_thumbnails() -> None:
                for target_path, candidate_path in pairs:
                    source_etag = source_etags.get(target_path)
                    if source_etag is None:
                        continue
                    try:
                        store.rebind(candidate_path, target_path, source_etag)
                    except (OSError, sqlite3.Error):
                        logger.warning("could not rebind thumbnail after resource rematch", exc_info=True)
            await asyncio.to_thread(move_thumbnails)
            mapping, new_etag = await self.mapping()
            return {"applied": len(pairs), "mapping": mapping, "localFiles": await self.catalog(), "etag": new_etag}

    async def batch_rematch(self, data: dict[str, Any]) -> dict[str, Any]:
        """Match selected pending files to missing objects without trusting browser hashes.

        Only a one-to-one result is applied.  Hashes for pending files are used
        transiently: inbox entries are deliberately not fingerprint metadata.
        """
        if set(data) != {"ifMatch", "candidateInboxVirtualPaths", "algorithms"}:
            raise ApiError(422, "validation", "request must contain ifMatch, candidateInboxVirtualPaths, and algorithms")
        candidates, algorithms, requested_etag = data["candidateInboxVirtualPaths"], data["algorithms"], data["ifMatch"]
        if (requested_etag is not None and not isinstance(requested_etag, str)) or not isinstance(candidates, list) or not candidates:
            raise ApiError(422, "validation", "invalid batch rematch request")
        allowed = _FINGERPRINT_ALGORITHMS | {"filename", "sizeBytes"}
        if (not all(isinstance(p, str) and _safe_resource_path(p) for p in candidates) or len(candidates) != len(set(candidates))
                or not isinstance(algorithms, list) or not algorithms or not all(isinstance(a, str) and a in allowed for a in algorithms) or len(algorithms) != len(set(algorithms))):
            raise ApiError(422, "validation", "invalid batch rematch candidates or algorithms")
        catalog = _catalog_by_local_path(await self.catalog())
        document, etag = await self.mapping()
        if requested_etag != etag:
            raise ApiError(409, "resource-conflict", "RFG mapping changed; retry")
        entries = {entry["virtual_path"]: entry for entry in document["entries"]}
        selected = []
        for path in candidates:
            entry = entries.get(path)
            if entry is None or not path.startswith("inbox/") or entry.get("local_path") not in catalog:
                raise ApiError(422, "validation", "candidates must be present inbox resources")
            selected.append(entry)
        targets = [entry for entry in document["entries"] if not entry["virtual_path"].startswith("inbox/") and entry.get("local_path") not in catalog]

        async def values(entry: dict[str, Any], pending: bool) -> dict[str, str] | None:
            result: dict[str, str] = {}
            for algorithm in algorithms:
                if algorithm == "filename":
                    result[algorithm] = entry["local_path"].rsplit("/", 1)[-1].lower()
                elif algorithm == "sizeBytes":
                    size = (catalog.get(entry["local_path"]) or entry).get("size_bytes")
                    if not isinstance(size, int) or isinstance(size, bool): return None
                    result[algorithm] = str(size)
                elif pending:
                    if algorithm in _PERCEPTUAL_FINGERPRINT_ALGORITHMS and not _supports_perceptual_hash(entry["local_path"]):
                        return None
                    hashed = await self._hash(entry["local_path"], algorithm)
                    if hashed.get("status") != "succeeded" or not isinstance(hashed.get("value"), str): return None
                    result[algorithm] = hashed["value"]
                else:
                    value = entry.get(algorithm)
                    if not isinstance(value, str) or not value: return None
                    result[algorithm] = value
            return result

        candidate_values = {entry["virtual_path"]: await values(entry, True) for entry in selected}
        target_values = {entry["virtual_path"]: await values(entry, False) for entry in targets}
        proposed: list[tuple[str, str]] = []
        ambiguous: list[str] = []
        for target in targets:
            expected = target_values[target["virtual_path"]]
            options = [path for path, actual in candidate_values.items() if actual is not None and actual == expected]
            if len(options) == 1:
                proposed.append((target["virtual_path"], options[0]))
            elif options:
                ambiguous.append(target["virtual_path"])
        candidate_counts = {candidate: sum(candidate == used for _, used in proposed) for candidate in candidate_values}
        matches = [(target, candidate) for target, candidate in proposed if candidate_counts[candidate] == 1]
        response = await self.rematch({"ifMatch": etag, "matches": [{"targetVirtualPath": target, "candidateInboxVirtualPath": candidate} for target, candidate in matches]}) if matches else {"mapping": document, "etag": etag, "localFiles": await self.catalog()}
        return {**response, "applied": len(matches), "ambiguous": sorted(set(ambiguous + [target for target, candidate in proposed if candidate_counts[candidate] > 1])), "unmatched": sorted(target["virtual_path"] for target in targets if target["virtual_path"] not in {target for target, _ in matches})}

    async def fingerprints(self, data: dict[str, Any]) -> dict[str, Any]:
        """Compute server-authorized hashes for persisted business resources.

        RFG hashes are intentionally never requested for inbox/candidate assets.
        Keeping this policy here, next to the only RFG HTTP adapter, prevents a
        browser-provided local path or hash from becoming authoritative.
        """
        paths, algorithms, requested_etag = _fingerprint_request(data)

        # Validate the entire request before calling RFG's hash API.  In
        # particular, a mixed request must not accidentally hash an inbox item
        # before discovering another invalid requested path.
        catalog = await self.catalog()
        catalog_by_path = _catalog_by_local_path(catalog)
        document, etag = await self.mapping()
        if requested_etag is not None and requested_etag != etag:
            raise ApiError(409, "resource-conflict", "RFG mapping changed; retry")
        self._assert_fingerprint_eligible(paths, document, catalog_by_path)
        for virtual_path in paths:
            entry = next(item for item in document["entries"] if item["virtual_path"] == virtual_path)
            if any(algorithm in _PERCEPTUAL_FINGERPRINT_ALGORITHMS for algorithm in algorithms) and not _supports_perceptual_hash(entry["local_path"]):
                raise ApiError(422, "resource-not-eligible", "perceptual hashes require a supported raster image")

        results: list[dict[str, Any]] = []
        # RFG documents bounded hash capacity.  Keep requests serial rather
        # than consuming that capacity with a client-controlled fan-out.
        for virtual_path in paths:
            entry = next(item for item in document["entries"] if item["virtual_path"] == virtual_path)
            for algorithm in algorithms:
                result = await self._hash(entry["local_path"], algorithm)
                results.append({
                    "virtualPath": virtual_path,
                    "algorithm": algorithm,
                    "status": result.get("status", "failed"),
                    "code": result.get("code", "hash_failed"),
                    "value": result.get("value"),
                    "profile": result.get("profile"),
                    "persisted": False,
                })

        async with self.lock:
            # A whole-document PUT needs a fresh document.  Re-read both RFG
            # views and the persisted flight records immediately before write;
            # ETag mismatch means no result is partially persisted.
            fresh_catalog = await self.catalog()
            fresh_catalog_by_path = _catalog_by_local_path(fresh_catalog)
            fresh_document, fresh_etag = await self.mapping()
            if requested_etag is not None and requested_etag != fresh_etag:
                raise ApiError(409, "resource-conflict", "RFG mapping changed; retry")
            # Hold the business-data lock through the PUT, so a business record
            # cannot lose its reference between this final check and persistence.
            async with self.app.state.flightarchive_workspace.lock:
                self._assert_fingerprint_eligible(paths, fresh_document, fresh_catalog_by_path)
                entries = {item["virtual_path"]: item for item in fresh_document["entries"]}
                changed = False
                for result in results:
                    if result["status"] != "succeeded" or not isinstance(result["value"], str) or not result["value"]:
                        continue
                    entry = entries[result["virtualPath"]]
                    if entry.get(result["algorithm"]) != result["value"]:
                        entry[result["algorithm"]] = result["value"]
                        changed = True
                    # This is catalog metadata, not client input.  It is stored on
                    # precisely the same, already-authorized mapping entry.
                    size = fresh_catalog_by_path[entry["local_path"]].get("size_bytes")
                    if isinstance(size, int) and not isinstance(size, bool) and entry.get("size_bytes") != size:
                        entry["size_bytes"] = size
                        changed = True
                    result["persisted"] = True
                if changed:
                    response = await self._request("PUT", "/api/v1/meta/map", json=fresh_document, headers=self._mapping_headers(fresh_etag))
                    if response.status_code == 412:
                        raise ApiError(409, "resource-conflict", "RFG mapping changed; retry")
                    if response.status_code != 200:
                        raise ApiError(503, "rfg-unavailable", "could not persist RFG mapping")
            mapping, final_etag = await self.mapping()
            return {"mapping": mapping, "etag": final_etag, "results": results}

    async def _hash(self, local_path: str, algorithm: str) -> dict[str, Any]:
        response = await self._request("POST", "/api/v1/hashes", json={"local_path": local_path, "algorithm": algorithm})
        if response.status_code == 200:
            value = response.json()
            if isinstance(value, dict):
                return value
        # Capacity failures are terminal for this API call, but are not a
        # reason to write a fabricated/null hash into the mapping.
        if response.status_code == 429:
            return {"status": "failed", "code": "capacity_exceeded", "value": None, "profile": None}
        if response.status_code == 404:
            return {"status": "failed", "code": "source_stale", "value": None, "profile": None}
        return {"status": "failed", "code": "rfg_unavailable", "value": None, "profile": None}

    def _assert_fingerprint_eligible(self, paths: list[str], document: dict[str, Any], catalog_by_path: dict[str, dict[str, Any]]) -> None:
        entries = {entry.get("virtual_path"): entry for entry in document.get("entries", [])}
        business_paths = _business_resource_paths(self.app.state.flightarchive_workspace)
        for path in paths:
            entry = entries.get(path)
            if entry is None:
                raise ApiError(404, "resource-not-found", "resource is not mapped")
            if path.startswith("inbox/"):
                raise ApiError(422, "resource-not-eligible", "inbox resources cannot be fingerprinted")
            if path not in business_paths:
                raise ApiError(422, "resource-not-eligible", "resource must be referenced by business data")
            if entry.get("local_path") not in catalog_by_path:
                raise ApiError(422, "resource-not-eligible", "resource is not in the current RFG catalog")


_IMAGE_SUFFIXES = (".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp")
_CONTENT_FINGERPRINT_ALGORITHMS = ("crc32", "md5", "sha256")
_PERCEPTUAL_FINGERPRINT_ALGORITHMS = ("ahash", "dhash", "phash")
_RASTER_IMAGE_SUFFIXES = (".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp")


def _supports_perceptual_hash(local_path: str) -> bool:
    return local_path.lower().endswith(_RASTER_IMAGE_SUFFIXES)


def _extension_of(local_path: str) -> str:
    """Return the lowercased extension (without dot) of a local source path."""
    basename = local_path.rsplit("/", 1)[-1]
    _, dot, extension = basename.rpartition(".")
    return extension.lower() if dot and extension else ""


@dataclass(frozen=True)
class ResourceOwner:
    """One persisted business reference used to derive a resource name.

    Flight owners carry a ``YYYYMMDD`` departure date, a lowercased airline
    code, a zero-padded flight number, a single-letter role (``a`` paper,
    ``b`` electronic, ``c`` attachment) and a disambiguating index.  Airline
    logo owners carry only the lowercased airline code and the logo role word.
    """

    date: str = ""
    code: str = ""
    flight_number: str = ""
    role: str = ""
    index: int = 0

    def name_part(self) -> str:
        """Human-readable fragment contributed by this single owner."""
        if self.flight_number:
            return f"{self.date}{self.code}{self.flight_number}{self.role}{self.index}"
        return f"{self.code}-{self.role}"


def generate_resource_name(owners: list[ResourceOwner], extension: str) -> str:
    """Generate a human-readable resource name from its owners.

    A single owner names the resource directly; shared resources merge every
    owner's fragment ordered by date, code, then role.  Only newly materialized
    inbox resources pass through here, so existing object paths are never
    renamed.
    """
    if not owners:
        raise ValueError("At least one owner is required")
    sorted_owners = sorted(owners, key=lambda owner: (owner.date, owner.code, owner.role))
    base = "+".join(owner.name_part() for owner in sorted_owners)
    return f"{base}.{extension}" if extension else base


def _disambiguate_resource_name(target: str, local_path: str) -> str:
    """Append a short source-derived suffix when two sources share an owner."""
    digest = hashlib.sha256(local_path.encode("utf-8")).hexdigest()[:10]
    if "." in target:
        base, extension = target.rsplit(".", 1)
        return f"{base}-{digest}.{extension}"
    return f"{target}-{digest}"


def _flight_owner(record: dict[str, Any], role: str, index: int) -> ResourceOwner:
    """Derive a flight resource owner from an already-validated flight payload."""
    return ResourceOwner(
        date=str(record.get("departureDate") or "").replace("-", ""),
        code=str(record.get("airlineCode") or "").strip().lower(),
        flight_number=str(record.get("flightNumber") or "").strip().zfill(4),
        role=role,
        index=index,
    )


def _airline_owner(record: dict[str, Any], role: str) -> ResourceOwner:
    """Derive an airline-logo owner from an already-validated catalog payload."""
    return ResourceOwner(code=str(record.get("code") or "").strip().lower(), role=role)


_FLIGHT_RESOURCE_FIELDS = (
    "paperBoardingPassFrontResourcePath",
    "paperBoardingPassBackResourcePath",
    "electronicBoardingPassResourcePath",
)
_PAPER_BOARDING_PASS_LAYOUT_FIELDS = {
    "paperBoardingPassFront": "paperBoardingPassFrontResourcePath",
    "paperBoardingPassBack": "paperBoardingPassBackResourcePath",
}
_AIRLINE_LOGO_RESOURCE_FIELDS = (
    "horizontalLogoResourcePath",
    "horizontalDarkLogoResourcePath",
    "symbolLogoResourcePath",
)
_FLIGHT_ROLE_INDEX_BY_FIELD = {
    "paperBoardingPassFrontResourcePath": ("a", 0),
    "paperBoardingPassBackResourcePath": ("a", 1),
    "electronicBoardingPassResourcePath": ("b", 0),
}
_AIRLINE_ROLE_BY_FIELD = {
    "horizontalLogoResourcePath": "horizontal",
    "horizontalDarkLogoResourcePath": "horizontal-dark",
    "symbolLogoResourcePath": "symbol",
}


def _preview_virtual_path(flight_id: str, slot: str, crop: Any) -> tuple[str, tuple[float, float, float, float, float]]:
    geometry_id, geometry = preview_geometry_id(crop)
    return f"preview/{flight_id}/{slot}/{geometry_id}", geometry


def _paper_layout_for_slot(record: dict[str, Any], slot: str) -> dict[str, Any] | None:
    """Return a paper layout for the given slot."""
    if slot not in _PAPER_BOARDING_PASS_LAYOUT_FIELDS:
        return None
    layouts = record.get("paperBoardingPassLayouts")
    if isinstance(layouts, dict) and isinstance(layouts.get(slot), dict):
        return layouts[slot]
    return None


def _current_preview_sources(workspace: Workspace, mapping: dict[str, Any], catalog_paths: set[str]) -> set[tuple[str, str]]:
    """Bindings still justified by persisted layouts and cataloged source files."""
    local_by_virtual = {
        entry.get("virtual_path"): entry.get("local_path") for entry in mapping.get("entries", [])
        if isinstance(entry.get("virtual_path"), str) and isinstance(entry.get("local_path"), str)
    }
    sources: set[tuple[str, str]] = set()
    for flight in workspace.domain.list_flights():
        record = flight.to_dict()
        for slot in _PAPER_BOARDING_PASS_LAYOUT_FIELDS:
            layout, path = _paper_layout_for_slot(record, slot), record.get(_PAPER_BOARDING_PASS_LAYOUT_FIELDS[slot])
            if not isinstance(layout, dict) or not isinstance(path, str) or local_by_virtual.get(path) not in catalog_paths:
                continue
            try:
                virtual_path, _ = _preview_virtual_path(record["id"], slot, layout.get("crop"))
            except InvalidCropError:
                continue
            sources.add((virtual_path, local_by_virtual[path]))
    return sources


def resource_paths(data: dict[str, Any]) -> list[str]:
    """Extract resource paths from one flight or airline payload."""
    keys = _FLIGHT_RESOURCE_FIELDS + _AIRLINE_LOGO_RESOURCE_FIELDS
    attachments = data.get("attachmentResourcePaths", [])
    return [data[key] for key in keys if isinstance(data.get(key), str)] + [x for x in attachments if isinstance(x, str)]


def persistent_business_resource_paths(workspace: Workspace) -> set[str]:
    """Return every persisted business-owned resource path exactly once.

    Flights own all boarding-pass slots and attachments; airline catalog entries
    own all logo slots. A set is necessary because paths may be shared.
    """
    paths: set[str] = set()
    for flight in workspace.domain.list_flights():
        record = flight.to_dict()
        paths.update(record[field] for field in _FLIGHT_RESOURCE_FIELDS if isinstance(record.get(field), str))
        paths.update(path for path in record.get("attachmentResourcePaths", []) if isinstance(path, str))
    for airline in workspace.domain.list_catalog("airlines"):
        record = airline.to_dict()
        paths.update(record[field] for field in _AIRLINE_LOGO_RESOURCE_FIELDS if isinstance(record.get(field), str))
    return paths


async def _best_effort_release(lifecycle: ResourceLifecycleService, candidates: list[str], context: str) -> None:
    """Cleanup must never turn an already-persisted business mutation into a failure."""
    try:
        await lifecycle.release_unreferenced(candidates)
    except Exception:
        lifecycle.defer_release(candidates)
        logger.warning("could not release unreferenced resource mappings after %s", context, exc_info=True)


_FINGERPRINT_ALGORITHMS = frozenset({"crc32", "md5", "sha256", "ahash", "dhash", "phash"})
_MAX_FINGERPRINT_PATHS = 32
_MAX_FINGERPRINT_ALGORITHMS = 6


def _fingerprint_request(data: dict[str, Any]) -> tuple[list[str], list[str], str | None]:
    """Validate the intentionally small public fingerprint request schema."""
    if set(data) - {"ifMatch", "virtualPaths", "algorithms"} or "virtualPaths" not in data or "algorithms" not in data:
        raise ApiError(422, "validation", "request must contain only ifMatch, virtualPaths, and algorithms")
    if "ifMatch" in data and data["ifMatch"] is not None and not isinstance(data["ifMatch"], str):
        raise ApiError(422, "validation", "ifMatch must be a string or null")
    paths, algorithms = data["virtualPaths"], data["algorithms"]
    if not isinstance(paths, list) or not 1 <= len(paths) <= _MAX_FINGERPRINT_PATHS:
        raise ApiError(422, "validation", f"virtualPaths must contain 1..{_MAX_FINGERPRINT_PATHS} paths")
    if not all(isinstance(path, str) and 0 < len(path) <= 512 for path in paths) or len(paths) != len(set(paths)):
        raise ApiError(422, "validation", "virtualPaths must be unique nonempty strings")
    if not isinstance(algorithms, list) or not 1 <= len(algorithms) <= _MAX_FINGERPRINT_ALGORITHMS:
        raise ApiError(422, "validation", f"algorithms must contain 1..{_MAX_FINGERPRINT_ALGORITHMS} values")
    if not all(isinstance(algorithm, str) and algorithm in _FINGERPRINT_ALGORITHMS for algorithm in algorithms) or len(algorithms) != len(set(algorithms)):
        raise ApiError(422, "validation", "algorithms must be unique supported hash algorithms")
    return paths, algorithms, data.get("ifMatch")


def _release_request(data: dict[str, Any]) -> tuple[list[str], str | None]:
    if set(data) != {"ifMatch", "virtualPaths"}:
        raise ApiError(422, "validation", "request must contain only ifMatch and virtualPaths")
    requested_etag = data["ifMatch"]
    paths = data["virtualPaths"]
    if requested_etag is not None and not isinstance(requested_etag, str):
        raise ApiError(422, "validation", "ifMatch must be a string or null")
    if not isinstance(paths, list) or not paths:
        raise ApiError(422, "validation", "virtualPaths must be a nonempty list")
    if (not all(isinstance(path, str) and _safe_resource_path(path) for path in paths)
            or len(paths) != len(set(paths))):
        raise ApiError(422, "validation", "virtualPaths must be unique nonempty safe paths")
    return paths, requested_etag


def _safe_resource_path(value: str) -> bool:
    return len(value) <= 512 and "\\" not in value and "\x00" not in value and not value.startswith("/") and all(part not in {"", ".", ".."} for part in value.split("/"))


def _catalog_by_local_path(catalog: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {item["local_path"]: item for item in catalog if isinstance(item.get("local_path"), str)}


def _business_resource_paths(workspace: Workspace) -> set[str]:
    """Fingerprintable resources are persisted, non-pending business references."""
    return {path for path in persistent_business_resource_paths(workspace) if not path.startswith("inbox/")}


def _validate_flight_submission(data: dict[str, Any]) -> None:
    """Validate a complete flight payload before it changes RFG mappings."""
    issues = validate_resource_relation_payload(data, _FLIGHT_RESOURCE_FIELDS, "attachmentResourcePaths")
    for legacy_field in ("boardingPassPrimaryColor", "boardingPassContrastColor"):
        if legacy_field in data:
            issues.append(f"flight.{legacy_field} is no longer supported; use boardingPassColor")
    issues.extend(validate_paper_boarding_pass_layouts(data.get("paperBoardingPassLayouts", {}), data))
    issues.extend(validate_electronic_boarding_pass(data.get("electronicBoardingPass"), data))
    # Layouts were checked against the uncoerced payload above.  Do not repeat
    # those same issues after model coercion.
    issues.extend(FlightRecord.from_dict(data).validate(include_boarding_pass_layouts=False))
    if issues:
        raise ValidationError(issues)


def _merged_flight_submission(workspace: Workspace, flight_id: str, changes: dict[str, Any]) -> dict[str, Any]:
    """Apply an update payload in memory so it can be validated before materialization."""
    existing = workspace.domain.get_flight(flight_id).to_dict()
    merged = dict(existing)
    for key, value in changes.items():
        if key in merged and key not in ("id", "createdAt"):
            merged[key] = value
    # A crop/layout belongs to the exact selected RFG virtual resource; a
    # changed resource path invalidates the saved presentation.
    paper_layouts = merged.get("paperBoardingPassLayouts")
    if isinstance(paper_layouts, dict):
        paper_layouts = dict(paper_layouts)
        merged["paperBoardingPassLayouts"] = paper_layouts
        for slot, field in (
            ("paperBoardingPassFront", "paperBoardingPassFrontResourcePath"),
            ("paperBoardingPassBack", "paperBoardingPassBackResourcePath"),
        ):
            if existing[field] != merged.get(field):
                paper_layouts.pop(slot, None)
    if existing.get("electronicBoardingPassResourcePath") != merged.get("electronicBoardingPassResourcePath"):
        merged["electronicBoardingPass"] = None
    return merged


def _validate_catalog_submission(workspace: Workspace, kind: str, data: dict[str, Any]) -> None:
    """Validate a complete catalog payload before it changes RFG mappings."""
    if kind == "aircraft-types" and set(data) - {"icao", "iata", "manufacturer", "displayName"}:
        raise ValidationError(["aircraft type contains unsupported fields"])
    if kind == "airlines":
        issues = validate_resource_relation_payload(
            data,
            _AIRLINE_LOGO_RESOURCE_FIELDS,
        )
        if issues:
            raise ValidationError(issues)
    entry = workspace.domain.catalog_model(kind).from_dict(data)
    issues = entry.validate()
    if kind == "airlines":
        colors = data.get("brandColors")
        if "primaryBrandColor" in data or "contrastBrandColor" in data:
            issues.append("airline brand colors must use brandColors")
        elif colors is not None and (not isinstance(colors, dict) or set(colors) != {"primary", "contrast"}):
            issues.append("airline.brandColors must contain exactly primary and contrast")
        elif isinstance(colors, dict):
            issues.extend(validate_optional_hex_color(colors["primary"], "airline.brandColors.primary"))
            issues.extend(validate_optional_hex_color(colors["contrast"], "airline.brandColors.contrast"))
    if issues:
        raise ValidationError(issues)


@router.get("/health")
async def health(): return {"ok": True, "app": APP_NAME, "version": __version__}

@router.get("/workspace/status")
async def status(request: Request): return {"status": ws(request).status(), "app": APP_NAME, "version": __version__}

@router.get("/tasks")
async def tasks(request: Request): return {"tasks": request.app.state.background_tasks.snapshot()}

@router.post("/workspace/reset")
async def reset(request: Request):
    workspace, lifecycle = ws(request), request.app.state.resource_lifecycle
    async with lifecycle.business_lock:
        flights = workspace.domain.list_flights()
        flight_ids = [flight.to_dict()["id"] for flight in flights]
        previous_paths = [path for flight in flights for path in resource_paths(flight.to_dict())]
        previous_paths.extend(
            path for airline in workspace.domain.list_catalog("airlines")
            for path in resource_paths(airline.to_dict())
        )
        async with workspace.lock: workspace.transaction(workspace.reset)
        for flight_id in flight_ids:
            await lifecycle.invalidate_flight_previews(flight_id)
        await _best_effort_release(lifecycle, previous_paths, "workspace reset")
    return {"reset": True, "status": workspace.status()}

@router.get("/flights")
async def flights(request: Request, q: str = "", airline: str = "", dateFrom: str = "", dateTo: str = ""):
    records = ws(request).domain.list_flights(query=q, airline=airline.upper(), date_from=dateFrom, date_to=dateTo)
    return {"flights": [r.to_dict() for r in records]}

@router.post("/flights", status_code=201)
async def create_flight(request: Request):
    data, workspace = await body(request), ws(request)
    _validate_flight_submission(data)
    lifecycle = request.app.state.resource_lifecycle
    async with lifecycle.business_lock:
        resolved, created_paths = await lifecycle.materialize_flight_resources(data)
        try:
            await lifecycle.assert_mapped(resource_paths(resolved))
            async with workspace.lock: record = workspace.transaction(lambda: workspace.domain.create_flight(resolved))
        except Exception:
            await _best_effort_release(lifecycle, created_paths, "failed flight creation")
            raise
        await _best_effort_release(lifecycle, created_paths, "flight creation")
    request.app.state.background_tasks.enqueue_fingerprints(lifecycle, await lifecycle.fingerprint_work(created_paths))
    return {"flight": record.to_dict()}

@router.get("/flights/{flight_id}")
async def get_flight(flight_id: str, request: Request): return {"flight": ws(request).domain.get_flight(flight_id).to_dict()}


@router.get("/flights/{flight_id}/boarding-passes/{slot}/preview")
async def boarding_pass_preview(flight_id: str, slot: str, request: Request) -> Response:
    """Serve a rotated rectangular crop for a prepared paper boarding-pass slot."""
    if slot not in _PAPER_BOARDING_PASS_LAYOUT_FIELDS:
        raise ApiError(404, "boarding-pass-slot-not-found", "boarding-pass slot is not recognized")
    record = ws(request).domain.get_flight(flight_id).to_dict()
    layout = _paper_layout_for_slot(record, slot)
    path = record.get(_PAPER_BOARDING_PASS_LAYOUT_FIELDS[slot])
    if not isinstance(layout, dict) or not isinstance(path, str):
        raise ApiError(422, "boarding-pass-preview-unavailable", "boarding-pass slot has no saved crop")
    try:
        cache_path, geometry = _preview_virtual_path(flight_id, slot, layout.get("crop"))
    except InvalidCropError as problem:
        raise ApiError(422, "boarding-pass-preview-unavailable", str(problem)) from problem
    lifecycle = request.app.state.resource_lifecycle
    store: ThumbnailStore = request.app.state.thumbnail_store
    document, _ = await lifecycle.mapping()
    entry = next((item for item in document["entries"] if item.get("virtual_path") == path), None)
    if entry is None:
        raise ApiError(404, "resource-not-found", "boarding-pass resource is not mapped")
    local_path = entry.get("local_path")
    if not isinstance(local_path, str):
        raise ApiError(404, "resource-not-found", "boarding-pass resource is unavailable")
    source_etag = await lifecycle.resource_etag(path)
    preview = await asyncio.to_thread(store.lookup, cache_path, local_path, source_etag)
    if preview is None:
        async with request.app.state.thumbnail_job_limiter:
            # Recheck mapping and cache after capacity wait, as the normal image
            # route does, so concurrent frame mounts do not duplicate work.
            document, _ = await lifecycle.mapping()
            entry = next((item for item in document["entries"] if item.get("virtual_path") == path), None)
            if entry is None or not isinstance(entry.get("local_path"), str):
                raise ApiError(404, "resource-not-found", "boarding-pass resource is unavailable")
            local_path = entry["local_path"]
            source_etag = await lifecycle.resource_etag(path)
            preview = await asyncio.to_thread(store.lookup, cache_path, local_path, source_etag)
            if preview is None:
                source, source_etag = await lifecycle.resource_bytes(path, max_bytes=store.max_source_bytes)
                try:
                    preview = await asyncio.to_thread(store.get_or_create_rectangular_crop, cache_path, local_path, source_etag, source, geometry)
                except (InvalidCropError, UnsupportedImageError) as problem:
                    raise ApiError(422, "boarding-pass-preview-unavailable", str(problem)) from problem
    etag = f'"{preview.id}"'
    headers = {"ETag": etag, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Content-Length": str(len(preview.data))}
    if_none_match = request.headers.get("if-none-match", "")
    if if_none_match.strip() == "*" or etag.strip('"') in [v.strip().strip('"') for v in if_none_match.split(",")]:
        return Response(status_code=304, headers=headers)
    return Response(content=preview.data, media_type="image/webp", headers=headers)

@router.put("/flights/{flight_id}")
async def update_flight(flight_id: str, request: Request):
    data, workspace = await body(request), ws(request)
    legacy_colors = {key for key in ("boardingPassPrimaryColor", "boardingPassContrastColor") if key in data}
    if legacy_colors:
        raise ValidationError([f"flight.{key} is no longer supported; use boardingPassColor" for key in sorted(legacy_colors)])
    lifecycle = request.app.state.resource_lifecycle
    async with lifecycle.business_lock:
        # The existing record determines both the validated update and cleanup
        # candidates.  Read it only after joining the resource/business
        # critical section so a concurrent update cannot make either stale.
        previous_paths = resource_paths(workspace.domain.get_flight(flight_id).to_dict())
        merged = _merged_flight_submission(workspace, flight_id, data)
        _validate_flight_submission(merged)
        resolved, created_paths = await lifecycle.materialize_flight_resources(merged)
        try:
            await lifecycle.assert_mapped(resource_paths(resolved))
            async with workspace.lock: record = workspace.transaction(lambda: workspace.domain.update_flight(flight_id, resolved))
        except Exception:
            await _best_effort_release(lifecycle, created_paths, "failed flight update")
            raise
        await lifecycle.invalidate_flight_previews(flight_id)
        await _best_effort_release(lifecycle, previous_paths + created_paths, "flight update")
    request.app.state.background_tasks.enqueue_fingerprints(lifecycle, await lifecycle.fingerprint_work(created_paths))
    return {"flight": record.to_dict()}

@router.delete("/flights/{flight_id}")
async def delete_flight(flight_id: str, request: Request):
    workspace = ws(request)
    lifecycle = request.app.state.resource_lifecycle
    async with lifecycle.business_lock:
        previous_paths = resource_paths(workspace.domain.get_flight(flight_id).to_dict())
        async with workspace.lock: workspace.transaction(lambda: workspace.domain.delete_flight(flight_id))
        await lifecycle.invalidate_flight_previews(flight_id)
        await _best_effort_release(lifecycle, previous_paths, "flight deletion")
    return {"deleted": flight_id}

@router.get("/catalogs")
async def catalogs(request: Request):
    domain = ws(request).domain
    return {"airlines": [x.to_dict() for x in domain.list_catalog("airlines")], "airports": [x.to_dict() for x in domain.list_catalog("airports")], "aircraftTypes": [x.to_dict() for x in domain.list_catalog("aircraft-types")]}

@router.post("/catalogs/{kind}", status_code=201)
async def create_catalog(kind: str, request: Request):
    data, workspace = await body(request), ws(request)
    _validate_catalog_submission(workspace, kind, data)
    lifecycle = request.app.state.resource_lifecycle
    async with lifecycle.business_lock:
        existing = workspace.domain.catalog_table(kind).get(
            workspace.domain.catalog_key(kind, data)
        )
        previous_paths = resource_paths(existing.to_dict()) if existing else []
        resolved, created_paths = await lifecycle.materialize_catalog_resources(kind, data)
        try:
            await lifecycle.assert_mapped(resource_paths(resolved))
            async with workspace.lock: entry = workspace.transaction(lambda: workspace.domain.upsert_catalog_entry(kind, resolved))
        except Exception:
            await _best_effort_release(lifecycle, created_paths, "failed catalog creation")
            raise
        await _best_effort_release(lifecycle, previous_paths + created_paths, "catalog creation")
    request.app.state.background_tasks.enqueue_fingerprints(lifecycle, await lifecycle.fingerprint_work(created_paths))
    return {"entry": entry.to_dict()}

@router.put("/catalogs/{kind}/{key}")
async def update_catalog(kind: str, key: str, request: Request):
    data, workspace = await body(request), ws(request)
    lifecycle = request.app.state.resource_lifecycle
    async with lifecycle.business_lock:
        # Keep the snapshot used for merge and resource release serialized with
        # the eventual business write.  Otherwise another catalog mutation can
        # replace an asset before this request releases its old path.
        existing = workspace.domain.catalog_table(kind).get(key.upper())
        previous_paths = resource_paths(existing.to_dict()) if existing else []
        merged = existing.to_dict() if existing else {}
        merged.update(data)
        merged["code" if kind in ("airlines", "airports") else "icao"] = key
        _validate_catalog_submission(workspace, kind, merged)
        resolved, created_paths = await lifecycle.materialize_catalog_resources(kind, merged)
        try:
            await lifecycle.assert_mapped(resource_paths(resolved))
            async with workspace.lock: entry = workspace.transaction(lambda: workspace.domain.upsert_catalog_entry(kind, resolved))
        except Exception:
            await _best_effort_release(lifecycle, created_paths, "failed catalog update")
            raise
        await _best_effort_release(lifecycle, previous_paths + created_paths, "catalog update")
    request.app.state.background_tasks.enqueue_fingerprints(lifecycle, await lifecycle.fingerprint_work(created_paths))
    return {"entry": entry.to_dict()}

@router.delete("/catalogs/{kind}", response_model=BatchCatalogDeleteResponse)
async def delete_catalog_batch(kind: str, payload: BatchCatalogDeleteRequest, request: Request):
    """Delete unique catalog keys together, rejecting unknown keys with 404.

    This intentionally follows the single-delete endpoint: an unknown key is
    not ignored.  All requested keys are preflighted before the transaction,
    so a not-found or reference conflict leaves the catalog unchanged.
    """
    workspace, lifecycle = ws(request), request.app.state.resource_lifecycle
    async with lifecycle.business_lock:
        async with workspace.lock:
            table = workspace.domain.catalog_table(kind)  # preserves unknown-kind 404 behavior
            for key in payload.keys:
                if key not in table:
                    raise NotFoundError(f"{kind} entry {key!r} not found")
            previous_paths = [resource_path for key in payload.keys for resource_path in resource_paths(table[key].to_dict())]
            deleted = workspace.transaction(
                lambda: workspace.domain.delete_catalog_entries(kind, payload.keys, force=payload.force)
            )
        await _best_effort_release(lifecycle, previous_paths, "catalog batch deletion")
    return BatchCatalogDeleteResponse(deleted=deleted)

@router.delete("/catalogs/{kind}/{key}")
async def delete_catalog(kind: str, key: str, request: Request, force: bool = False):
    workspace, lifecycle = ws(request), request.app.state.resource_lifecycle
    async with lifecycle.business_lock:
        existing = workspace.domain.catalog_table(kind).get(key.strip().upper())
        previous_paths = resource_paths(existing.to_dict()) if existing else []
        async with workspace.lock: workspace.transaction(lambda: workspace.domain.delete_catalog_entry(kind, key, force=force))
        await _best_effort_release(lifecycle, previous_paths, "catalog deletion")
    return {"deleted": key}

@router.get("/resources/catalog")
async def resource_catalog(request: Request): return {"localFiles": await request.app.state.resource_lifecycle.catalog()}
@router.post("/resources/sync")
async def synchronize_resources(request: Request): return await request.app.state.resource_lifecycle.synchronize()
@router.post("/resources/ignore")
async def ignore_resource(request: Request): return await request.app.state.resource_lifecycle.ignore(await body(request))
@router.post("/resources/rematches")
async def rematches(request: Request):
    lifecycle = request.app.state.resource_lifecycle
    data = await body(request)
    response = await lifecycle.rematch(data)
    rematched_paths = [
        match["targetVirtualPath"] for match in data.get("matches", [])
        if isinstance(match, dict) and isinstance(match.get("targetVirtualPath"), str)
        and match["targetVirtualPath"] in _business_resource_paths(ws(request))
    ]
    request.app.state.background_tasks.enqueue_fingerprints(
        lifecycle, await lifecycle.fingerprint_work(rematched_paths)
    )
    return response
@router.post("/resources/batch-rematches")
async def batch_rematches(request: Request):
    lifecycle = request.app.state.resource_lifecycle
    response = await lifecycle.batch_rematch(await body(request))
    applied = [entry["virtual_path"] for entry in response["mapping"]["entries"]
               if isinstance(entry.get("virtual_path"), str) and entry["virtual_path"] in _business_resource_paths(ws(request))]
    request.app.state.background_tasks.enqueue_fingerprints(lifecycle, await lifecycle.fingerprint_work(applied))
    return response
@router.post("/resources/release")
async def release_resources(request: Request): return await request.app.state.resource_lifecycle.release(await body(request))
@router.post("/resources/fingerprints")
async def fingerprints(request: Request): return await request.app.state.resource_lifecycle.fingerprints(await body(request))
