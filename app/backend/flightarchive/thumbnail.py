# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Bounded, domain-neutral raster scaling through RFG's public HTTP API."""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import math
import os
import re
import stat
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
from PIL import Image, ImageOps, UnidentifiedImageError


LOGGER = logging.getLogger(__name__)

ALLOWED_SCALES = (1.0, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625)
DEFAULT_SCALE = 0.125
MAX_SOURCE_BYTES = 256 * 1024 * 1024
MAX_SOURCE_PIXELS = 160_000_000
MAX_SOURCE_DIMENSION = 65_535
MAX_HEADER_BYTES = 256 * 1024
MAX_OUTPUT_PIXELS = 4_000_000
MAX_OUTPUT_DIMENSION = 4096
MAX_OUTPUT_BYTES = 4 * 1024 * 1024
MAX_CACHE_BYTES = 256 * 1024 * 1024
RENDER_PROFILE = "pillow-webp-q80-v1"
SUPPORTED_FORMATS = frozenset({"JPEG", "PNG", "WEBP", "BMP", "GIF", "AVIF"})
_OWN_FILE = re.compile(r"^thumb-([0-9a-f]{64})\.(webp|json)$")


class ThumbnailError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status, self.code, self.message = status, code, message
        super().__init__(message)


class _SourceChanged(Exception):
    pass


@dataclass(frozen=True)
class SourceIdentity:
    etag: str
    size: int


@dataclass(frozen=True)
class ImageGeometry:
    source_width: int
    source_height: int
    thumbnail_width: int
    thumbnail_height: int
    format: str


@dataclass(frozen=True)
class ThumbnailResult:
    body: bytes | None
    headers: dict[str, str]
    cached: bool


def parse_scale(raw: str | None) -> tuple[float, str]:
    text = str(DEFAULT_SCALE) if raw is None else raw
    try:
        value = float(text)
    except (TypeError, ValueError) as exc:
        raise ThumbnailError(400, "invalid-thumbnail-scale", "scale must be a permitted dyadic value") from exc
    if not math.isfinite(value) or value not in ALLOWED_SCALES:
        raise ThumbnailError(400, "invalid-thumbnail-scale", "scale must be a permitted dyadic value")
    canonical = "1" if value == 1 else str(value)
    return value, canonical


def validate_virtual_path(path: str) -> None:
    if not path or path.startswith("/") or "\\" in path or "\x00" in path:
        raise ThumbnailError(400, "unsafe-virtual-path", "virtual path is unsafe")
    parts = path.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ThumbnailError(400, "unsafe-virtual-path", "virtual path is unsafe")


def _resource_url(path: str) -> str:
    return "/res/" + "/".join(quote(part, safe="") for part in path.split("/"))


def _regular_file(path: Path) -> os.stat_result | None:
    try:
        result = path.stat(follow_symlinks=False)
    except (FileNotFoundError, OSError):
        return None
    return result if stat.S_ISREG(result.st_mode) else None


def _png_prefix_orientation(prefix: bytes) -> int:
    """EXIF orientation from a PNG eXIf chunk, read from bounded bytes only.

    Pillow stops parsing a PNG at the first IDAT chunk, so an eXIf chunk placed
    after IDAT never reaches ``image.info``. Walking the chunk lengths is
    metadata-only work and never decodes pixels; a chunk that extends past the
    bounded prefix is simply unavailable and yields the neutral orientation.
    """
    if prefix[:8] != b"\x89PNG\r\n\x1a\n":
        return 1
    cursor = 8
    limit = len(prefix)
    while cursor + 8 <= limit:
        length = int.from_bytes(prefix[cursor:cursor + 4], "big")
        chunk_type = prefix[cursor + 4:cursor + 8]
        data_start = cursor + 8
        data_end = data_start + length
        if data_end + 4 > limit:
            return 1
        if chunk_type == b"eXIf":
            exif = Image.Exif()
            try:
                exif.load(prefix[data_start:data_end])
            except (OSError, ValueError, SyntaxError):
                return 1
            orientation = exif.get(274, 1)
            return orientation if orientation in (1, 2, 3, 4, 5, 6, 7, 8) else 1
        if chunk_type == b"IEND":
            return 1
        cursor = data_end + 4
    return 1


class ThumbnailCache:
    def __init__(self, root: Path):
        self.root = root

    def _safe_root(self, *, create: bool) -> bool:
        path = self.root.absolute()
        existing: list[Path] = []
        cursor = path
        while True:
            existing.append(cursor)
            if cursor.parent == cursor:
                break
            cursor = cursor.parent
        for component in reversed(existing):
            try:
                info = component.stat(follow_symlinks=False)
            except FileNotFoundError:
                break
            except OSError:
                return False
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                return False
        if create:
            try:
                path.mkdir(parents=True, exist_ok=True)
            except OSError:
                return False
        try:
            info = path.stat(follow_symlinks=False)
        except OSError:
            return False
        return stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)

    def paths(self, key: str) -> tuple[Path, Path]:
        return self.root / f"thumb-{key}.webp", self.root / f"thumb-{key}.json"

    def read(self, key: str) -> tuple[bytes, dict[str, Any]] | None:
        if not self._safe_root(create=False):
            return None
        blob_path, meta_path = self.paths(key)
        blob_stat, meta_stat = _regular_file(blob_path), _regular_file(meta_path)
        if blob_stat is None or meta_stat is None or blob_stat.st_size > MAX_OUTPUT_BYTES or meta_stat.st_size > 16 * 1024:
            return None
        try:
            metadata = json.loads(meta_path.read_text(encoding="utf-8"))
            blob = blob_path.read_bytes()
            if not isinstance(metadata, dict) or metadata.get("key") != key:
                return None
            if len(blob) != metadata.get("encodedBytes") or hashlib.sha256(blob).hexdigest() != metadata.get("blobSha256"):
                return None
            now = None
            os.utime(blob_path, now, follow_symlinks=False)
            os.utime(meta_path, now, follow_symlinks=False)
            return blob, metadata
        except (OSError, UnicodeError, ValueError, TypeError, json.JSONDecodeError):
            return None

    def write(self, key: str, blob: bytes, metadata: dict[str, Any]) -> None:
        if not self._safe_root(create=True):
            LOGGER.warning("thumbnail cache is unavailable: %s", self.root)
            return
        blob_path, meta_path = self.paths(key)
        # Never replace a special file or symlink planted at a cache leaf.
        for path in (blob_path, meta_path):
            try:
                info = path.stat(follow_symlinks=False)
            except FileNotFoundError:
                continue
            except OSError:
                LOGGER.warning("thumbnail cache leaf cannot be inspected: %s", path)
                return
            if not stat.S_ISREG(info.st_mode):
                LOGGER.warning("thumbnail cache leaf is not a regular file: %s", path)
                return
        token = f"{os.getpid()}-{uuid.uuid4().hex}"
        temporary_blob = self.root / f".thumb-{key}-{token}.webp.tmp"
        temporary_meta = self.root / f".thumb-{key}-{token}.json.tmp"
        document = {**metadata, "key": key, "encodedBytes": len(blob), "blobSha256": hashlib.sha256(blob).hexdigest()}
        try:
            with temporary_blob.open("xb") as stream:
                stream.write(blob)
                stream.flush()
                os.fsync(stream.fileno())
            with temporary_meta.open("x", encoding="utf-8") as stream:
                json.dump(document, stream, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_blob, blob_path)
            os.replace(temporary_meta, meta_path)
            self._evict()
        except OSError as exc:
            LOGGER.warning("thumbnail cache write failed: %s", exc)
        finally:
            for path in (temporary_blob, temporary_meta):
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
                except OSError:
                    pass

    def _evict(self) -> None:
        if not self._safe_root(create=False):
            return
        groups: dict[str, dict[str, tuple[Path, os.stat_result]]] = {}
        try:
            children = list(self.root.iterdir())
        except OSError:
            return
        for path in children:
            match = _OWN_FILE.fullmatch(path.name)
            info = _regular_file(path) if match else None
            if match is not None and info is not None:
                groups.setdefault(match.group(1), {})[match.group(2)] = (path, info)

        # Owned regular files without their mate can never be cache hits. Clean
        # them opportunistically, while leaving unrelated and special files alone.
        for files in groups.values():
            if set(files) == {"webp", "json"}:
                continue
            for path, _info in files.values():
                try:
                    if _regular_file(path) is not None:
                        path.unlink()
                except OSError:
                    pass

        pairs = [files for files in groups.values() if set(files) == {"webp", "json"}]
        total = sum(info.st_size for files in pairs for _path, info in files.values())
        ordered = sorted(
            pairs,
            key=lambda files: (max(info.st_mtime_ns for _path, info in files.values()), files["webp"][0].name),
        )
        for files in ordered:
            if total <= MAX_CACHE_BYTES:
                break
            for path, info in files.values():
                try:
                    if _regular_file(path) is not None:
                        path.unlink()
                        total -= info.st_size
                except OSError:
                    pass


class ThumbnailService:
    def __init__(self, rfg_app, cache_dir: Path):
        self._client = httpx.AsyncClient(transport=httpx.ASGITransport(app=rfg_app), base_url="http://rfg.internal")
        self._cache = ThumbnailCache(cache_dir)
        self._heavy_jobs = asyncio.Semaphore(1)

    async def close(self) -> None:
        await self._client.aclose()

    @staticmethod
    def _key(virtual_path: str, source: SourceIdentity, scale_text: str) -> str:
        payload = json.dumps(
            [virtual_path, source.etag, source.size, scale_text, RENDER_PROFILE],
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(payload).hexdigest()

    async def _is_mapped(self, virtual_path: str) -> bool | None:
        try:
            response = await self._client.get("/api/v1/meta/map")
            if response.status_code != 200:
                return None
            document = response.json()
            entries = document.get("entries", []) if isinstance(document, dict) else []
            return any(isinstance(item, dict) and item.get("virtual_path") == virtual_path for item in entries)
        except (httpx.HTTPError, ValueError, TypeError):
            return None

    async def _head_source(self, virtual_path: str) -> SourceIdentity:
        url = _resource_url(virtual_path)
        try:
            response = await self._client.head(url)
            if response.status_code != 200:
                refresh = await self._client.get("/api/v1/meta/local")
                if refresh.status_code != 200:
                    raise ThumbnailError(503, "resource-catalog-unavailable", "resource catalog could not be refreshed")
                response = await self._client.head(url)
        except httpx.HTTPError as exc:
            raise ThumbnailError(503, "resource-unavailable", "source resource is unavailable") from exc
        if response.status_code == 404:
            mapped = await self._is_mapped(virtual_path)
            if mapped is None:
                raise ThumbnailError(503, "resource-mapping-unavailable", "resource mapping could not be inspected")
            if mapped:
                raise ThumbnailError(503, "resource-source-missing", "mapped source resource is unavailable")
            raise ThumbnailError(404, "resource-not-mapped", "resource is not mapped")
        if response.status_code != 200:
            raise ThumbnailError(503, "resource-unavailable", "source resource is unavailable")
        etag = response.headers.get("etag")
        if not etag or etag.startswith("W/"):
            raise ThumbnailError(503, "resource-version-unavailable", "source resource has no strong ETag")
        try:
            size = int(response.headers["content-length"])
        except (KeyError, ValueError) as exc:
            raise ThumbnailError(503, "resource-size-unavailable", "source resource size is unavailable") from exc
        if size < 0:
            raise ThumbnailError(503, "resource-size-unavailable", "source resource size is unavailable")
        if size > MAX_SOURCE_BYTES:
            raise ThumbnailError(413, "thumbnail-source-too-large", "source resource exceeds the thumbnail size limit")
        return SourceIdentity(etag, size)

    async def _inspect(self, virtual_path: str, source: SourceIdentity, scale: float) -> ImageGeometry:
        end = min(source.size, MAX_HEADER_BYTES) - 1
        if end < 0:
            raise ThumbnailError(415, "unsupported-thumbnail-source", "source is not a supported raster image")
        try:
            async with self._client.stream(
                "GET", _resource_url(virtual_path), headers={"Range": f"bytes=0-{end}"},
            ) as response:
                if response.headers.get("etag") != source.etag:
                    raise _SourceChanged
                permitted_statuses = {206, 200} if source.size <= MAX_HEADER_BYTES else {206}
                if response.status_code not in permitted_statuses:
                    raise ThumbnailError(503, "resource-range-unavailable", "source header range is unavailable")
                chunks: list[bytes] = []
                total = 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > MAX_HEADER_BYTES:
                        raise ThumbnailError(503, "resource-range-unavailable", "source header range exceeded its bound")
                    chunks.append(chunk)
        except ThumbnailError:
            raise
        except _SourceChanged:
            raise
        except httpx.HTTPError as exc:
            raise ThumbnailError(503, "resource-unavailable", "source resource is unavailable") from exc
        return await asyncio.to_thread(self._inspect_prefix, b"".join(chunks), scale)

    @staticmethod
    def _inspect_prefix(prefix: bytes, scale: float) -> ImageGeometry:
        try:
            with Image.open(io.BytesIO(prefix)) as image:
                image_format = (image.format or "").upper()
                if image_format not in SUPPORTED_FORMATS:
                    raise ThumbnailError(415, "unsupported-thumbnail-source", "source is not a supported raster image")
                width, height = image.size
                # JPEG parses EXIF while opening its marker segments and PNG
                # exposes a header eXIf chunk in ``info``.  Anything else must
                # not make Pillow load every pixel hunting for absent metadata;
                # for PNG an eXIf chunk placed after IDAT is recovered directly
                # from the bounded prefix without decoding it.
                if image_format == "JPEG" or "exif" in image.info:
                    orientation = image.getexif().get(274, 1)
                elif image_format == "PNG":
                    orientation = _png_prefix_orientation(prefix)
                else:
                    orientation = 1
        except ThumbnailError:
            raise
        except Image.DecompressionBombError as exc:
            raise ThumbnailError(413, "thumbnail-source-dimensions-too-large", "source dimensions exceed the thumbnail limit") from exc
        except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
            raise ThumbnailError(415, "unsupported-thumbnail-source", "source is not a readable supported raster image") from exc
        if width <= 0 or height <= 0 or max(width, height) > MAX_SOURCE_DIMENSION or width * height > MAX_SOURCE_PIXELS:
            raise ThumbnailError(413, "thumbnail-source-dimensions-too-large", "source dimensions exceed the thumbnail limit")
        if orientation in (5, 6, 7, 8):
            width, height = height, width
        target_width = max(1, int(width * scale))
        target_height = max(1, int(height * scale))
        if max(target_width, target_height) > MAX_OUTPUT_DIMENSION or target_width * target_height > MAX_OUTPUT_PIXELS:
            raise ThumbnailError(413, "thumbnail-output-too-large", "requested thumbnail dimensions exceed the output limit")
        return ImageGeometry(width, height, target_width, target_height, image_format)

    @staticmethod
    def _headers(source: SourceIdentity, geometry: ImageGeometry, scale_text: str, derivative_etag: str) -> dict[str, str]:
        return {
            "Cache-Control": "no-cache",
            "ETag": derivative_etag,
            "X-Source-Width": str(geometry.source_width),
            "X-Source-Height": str(geometry.source_height),
            "X-Source-Bytes": str(source.size),
            "X-Source-ETag": source.etag,
            "X-Thumbnail-Width": str(geometry.thumbnail_width),
            "X-Thumbnail-Height": str(geometry.thumbnail_height),
            "X-Thumbnail-Scale": scale_text,
        }

    @staticmethod
    def _metadata_geometry(metadata: dict[str, Any], scale: float, scale_text: str) -> ImageGeometry | None:
        names = ("sourceWidth", "sourceHeight", "thumbnailWidth", "thumbnailHeight")
        if any(isinstance(metadata.get(name), bool) or not isinstance(metadata.get(name), int) for name in names):
            return None
        image_format = metadata.get("format")
        if not isinstance(image_format, str):
            return None
        geometry = ImageGeometry(
            metadata["sourceWidth"], metadata["sourceHeight"],
            metadata["thumbnailWidth"], metadata["thumbnailHeight"], image_format,
        )
        if (geometry.format not in SUPPORTED_FORMATS
                or metadata.get("scale") != scale_text
                or metadata.get("renderProfile") != RENDER_PROFILE
                or geometry.source_width <= 0 or geometry.source_height <= 0
                or max(geometry.source_width, geometry.source_height) > MAX_SOURCE_DIMENSION
                or geometry.source_width * geometry.source_height > MAX_SOURCE_PIXELS
                or geometry.thumbnail_width != max(1, int(geometry.source_width * scale))
                or geometry.thumbnail_height != max(1, int(geometry.source_height * scale))
                or max(geometry.thumbnail_width, geometry.thumbnail_height) > MAX_OUTPUT_DIMENSION
                or geometry.thumbnail_width * geometry.thumbnail_height > MAX_OUTPUT_PIXELS):
            return None
        return geometry

    def _cached(self, key: str, source: SourceIdentity, scale: float, scale_text: str) -> tuple[bytes, ImageGeometry] | None:
        cached = self._cache.read(key)
        if cached is None:
            return None
        blob, metadata = cached
        source_bytes = metadata.get("sourceBytes")
        if (metadata.get("sourceEtag") != source.etag
                or isinstance(source_bytes, bool) or not isinstance(source_bytes, int)
                or source_bytes != source.size):
            return None
        geometry = self._metadata_geometry(metadata, scale, scale_text)
        if geometry is None:
            return None
        try:
            with Image.open(io.BytesIO(blob)) as image:
                if (image.format or "").upper() != "WEBP" or image.size != (
                    geometry.thumbnail_width, geometry.thumbnail_height,
                ):
                    return None
        except (Image.DecompressionBombError, UnidentifiedImageError, OSError, ValueError, SyntaxError):
            return None
        return blob, geometry

    async def _validated_cached(
        self, key: str, virtual_path: str, source: SourceIdentity, scale: float, scale_text: str,
    ) -> tuple[bytes, ImageGeometry] | None:
        cached = await asyncio.to_thread(self._cached, key, source, scale, scale_text)
        if cached is None:
            return None
        blob, geometry = cached
        inspected = await self._inspect(virtual_path, source, scale)
        return (blob, geometry) if inspected == geometry else None

    async def head(self, virtual_path: str, scale: float, scale_text: str) -> ThumbnailResult:
        for attempt in range(2):
            source = await self._head_source(virtual_path)
            key = self._key(virtual_path, source, scale_text)
            derivative_etag = f'"thumb-{key}"'
            try:
                cached = await self._validated_cached(key, virtual_path, source, scale, scale_text)
                if cached:
                    blob, geometry = cached
                    return ThumbnailResult(None, {**self._headers(source, geometry, scale_text, derivative_etag), "Content-Length": str(len(blob))}, True)
                geometry = await self._inspect(virtual_path, source, scale)
            except _SourceChanged:
                if attempt:
                    raise ThumbnailError(503, "resource-changing", "source resource changed during thumbnail inspection")
                continue
            return ThumbnailResult(None, self._headers(source, geometry, scale_text, derivative_etag), False)
        raise AssertionError("unreachable")

    async def get(self, virtual_path: str, scale: float, scale_text: str) -> ThumbnailResult:
        for attempt in range(2):
            try:
                return await self._get_once(virtual_path, scale, scale_text)
            except _SourceChanged:
                if attempt:
                    raise ThumbnailError(503, "resource-changing", "source resource changed during thumbnail generation")
        raise AssertionError("unreachable")

    async def _get_once(self, virtual_path: str, scale: float, scale_text: str) -> ThumbnailResult:
        source = await self._head_source(virtual_path)
        key = self._key(virtual_path, source, scale_text)
        derivative_etag = f'"thumb-{key}"'
        cached = await self._validated_cached(key, virtual_path, source, scale, scale_text)
        if cached:
            blob, geometry = cached
            return ThumbnailResult(blob, self._headers(source, geometry, scale_text, derivative_etag), True)
        async with self._heavy_jobs:
            current = await self._head_source(virtual_path)
            if current != source:
                raise _SourceChanged
            cached = await self._validated_cached(key, virtual_path, source, scale, scale_text)
            if cached:
                blob, geometry = cached
                return ThumbnailResult(blob, self._headers(source, geometry, scale_text, derivative_etag), True)
            geometry = await self._inspect(virtual_path, source, scale)
            payload = await self._source_get(virtual_path, source)
            blob = await asyncio.to_thread(self._render, payload, geometry)
            metadata = {
                "sourceEtag": source.etag, "sourceBytes": source.size,
                "sourceWidth": geometry.source_width, "sourceHeight": geometry.source_height,
                "thumbnailWidth": geometry.thumbnail_width, "thumbnailHeight": geometry.thumbnail_height,
                "format": geometry.format, "scale": scale_text, "renderProfile": RENDER_PROFILE,
            }
            await asyncio.to_thread(self._cache.write, key, blob, metadata)
            return ThumbnailResult(blob, self._headers(source, geometry, scale_text, derivative_etag), False)

    async def _source_get(self, virtual_path: str, source: SourceIdentity) -> bytes:
        try:
            async with self._client.stream("GET", _resource_url(virtual_path)) as response:
                if response.status_code != 200:
                    # A catalog/source race commonly appears as a transient
                    # non-200 here. Re-establish identity through HEAD before
                    # deciding whether another bounded attempt is possible.
                    raise _SourceChanged
                if response.headers.get("etag") != source.etag:
                    raise _SourceChanged
                declared = response.headers.get("content-length")
                if declared is not None:
                    try:
                        if int(declared) != source.size:
                            raise _SourceChanged
                    except ValueError as exc:
                        raise ThumbnailError(503, "resource-size-unavailable", "source resource size is invalid") from exc
                chunks: list[bytes] = []
                total = 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > MAX_SOURCE_BYTES or total > source.size:
                        raise _SourceChanged
                    chunks.append(chunk)
        except ThumbnailError:
            raise
        except _SourceChanged:
            raise
        except httpx.HTTPError as exc:
            raise ThumbnailError(503, "resource-unavailable", "source resource is unavailable") from exc
        if total != source.size:
            raise _SourceChanged
        return b"".join(chunks)

    @staticmethod
    def _render(payload: bytes, geometry: ImageGeometry) -> bytes:
        try:
            with Image.open(io.BytesIO(payload)) as source:
                if (source.format or "").upper() != geometry.format or geometry.format not in SUPPORTED_FORMATS:
                    raise ThumbnailError(415, "unsupported-thumbnail-source", "source image format changed")
                source.seek(0)
                if geometry.format == "JPEG":
                    orientation = source.getexif().get(274, 1)
                    decoder_target = (geometry.thumbnail_height, geometry.thumbnail_width) if orientation in (5, 6, 7, 8) else (
                        geometry.thumbnail_width, geometry.thumbnail_height,
                    )
                    source.draft("RGB", decoder_target)
                source.load()
                image = ImageOps.exif_transpose(source)
                if geometry.format != "JPEG" and image.size != (geometry.source_width, geometry.source_height):
                    # The EXIF orientation normalized the full decode differently
                    # than the bounded prefix could inspect, because the eXIf
                    # chunk lies beyond the header range. Reject explicitly
                    # instead of emitting pixels that contradict the headers.
                    raise ThumbnailError(
                        415, "unsupported-header-orientation",
                        "source EXIF orientation lies outside the bounded header range",
                    )
                if image.size != (geometry.thumbnail_width, geometry.thumbnail_height):
                    image = image.resize((geometry.thumbnail_width, geometry.thumbnail_height), Image.Resampling.LANCZOS)
                bands = image.getbands()
                image = image.convert("RGBA" if "A" in bands or "transparency" in image.info else "RGB")
                output = io.BytesIO()
                image.save(output, "WEBP", quality=80, method=4)
                encoded = output.getvalue()
        except ThumbnailError:
            raise
        except Image.DecompressionBombError as exc:
            raise ThumbnailError(413, "thumbnail-source-dimensions-too-large", "source dimensions exceed the thumbnail limit") from exc
        except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
            raise ThumbnailError(415, "unsupported-thumbnail-source", "source is not a readable supported raster image") from exc
        if len(encoded) > MAX_OUTPUT_BYTES:
            raise ThumbnailError(413, "thumbnail-output-too-large", "encoded thumbnail exceeds the output limit")
        return encoded
