# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Content-addressed WebP thumbnail object store for FlightArchive images.

The store lives under its own cache root (``FLIGHTARCHIVE_CACHE_DIR`` or a
sibling of the data root) and keeps a single stdlib-sqlite3 database at
``thumbnails/thumbnails.sqlite3`` with two tables:

- ``thumbnail_objects``: immutable, content-addressed WebP blobs keyed by the
  SHA-256 of their own bytes, plus rendering metadata. Identical renderings
  are stored exactly once and shared by any number of virtual paths.
- ``thumbnail_bindings``: one row per ``virtual_path`` pointing at the source
   ``local_path`` it was rendered from and the thumbnail object id. Moving a
   pending path to its stable object ID only moves the binding row; the object is
  reused, never regenerated.

Bindings are invalidated lazily: a lookup whose stored ``local_path`` or RFG
source ETag no longer matches drops the binding (and the object when it became
orphaned), so external mapping and in-place source changes never serve stale
pixels. Each row also records the :func:`thumbnail_profile_id` it was rendered
under; a lookup under a different profile (changed thumbnail settings) drops
the binding the same way, so reconfigured rendering never reuses stale pixels.
Objects left without any binding are garbage-collected eagerly.
"""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import sqlite3
import threading
import time
import warnings
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from math import cos, isfinite, pi, sin
from typing import Any
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

SCHEMA_VERSION = 3
DATABASE_PATH = Path("thumbnails") / "thumbnails.sqlite3"

DEFAULT_MAX_DIMENSION = 512
DEFAULT_QUALITY = 82
# Permit typical high-resolution resource scans while keeping source retrieval
# bounded.  This is independent of the decoded-pixel guard below.  The
# runtime configuration seeds this 256 MiB value as its default.
DEFAULT_MAX_SOURCE_BYTES = 256 * 1024 * 1024
# Decompression-bomb guard: reject absurd declared dimensions before decoding.
# A 100-million-pixel image can expand to hundreds of MiB, so this remains a
# deliberately bounded safety limit even when its compressed PNG is accepted.
DEFAULT_MAX_SOURCE_PIXELS = 100_000_000


class ThumbnailError(Exception):
    """Base class for thumbnail store failures."""


class UnsupportedImageError(ThumbnailError):
    """The source bytes are not a decodable raster image or exceed limits."""


class InvalidCropError(ThumbnailError):
    """A saved crop cannot safely describe a rectangular image crop."""


@dataclass(frozen=True)
class Thumbnail:
    """A cached WebP thumbnail object plus the metadata clients need."""

    id: str
    data: bytes
    width: int
    height: int


_SCHEMA = """
CREATE TABLE IF NOT EXISTS thumbnail_objects (
    id TEXT PRIMARY KEY,
    data BLOB NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    source_sha256 TEXT NOT NULL,
    source_bytes INTEGER NOT NULL,
    profile TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS thumbnail_bindings (
    virtual_path TEXT PRIMARY KEY,
    local_path TEXT NOT NULL,
    source_etag TEXT NOT NULL DEFAULT '',
    thumbnail_id TEXT NOT NULL REFERENCES thumbnail_objects(id),
    profile TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS thumbnail_bindings_object ON thumbnail_bindings (thumbnail_id);
"""


def thumbnail_profile_id(*, max_dimension: int, quality: int, max_source_bytes: int, max_source_pixels: int) -> str:
    """Stable content ID for the render-relevant thumbnail settings.

    Bindings created under one profile are never reused under another: a
    cached thumbnail rendered with different dimensions, quality, or source
    limits is reprofiled (re-rendered) rather than served stale.  Scheduling
    settings such as job concurrency are deliberately excluded; they never
    change rendered bytes.
    """
    canonical = json.dumps(
        {
            "maxDimension": max_dimension,
            "maxSourceBytes": max_source_bytes,
            "maxSourcePixels": max_source_pixels,
            "quality": quality,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def render_webp(source: bytes, *, max_dimension: int = DEFAULT_MAX_DIMENSION, quality: int = DEFAULT_QUALITY,
                max_source_pixels: int = DEFAULT_MAX_SOURCE_PIXELS) -> tuple[bytes, int, int]:
    """Render *source* image bytes into a bounded WebP thumbnail.

    Applies EXIF orientation, preserves alpha, and rejects non-decodable,
    non-raster, zero-sized, or decompression-bomb-sized input with
    :class:`UnsupportedImageError`.
    """
    if not source:
        raise UnsupportedImageError("resource is empty")
    # DecompressionBombError is a plain Exception subclass (not OSError), so
    # it needs an explicit clause at every stage Pillow may raise it: opening
    # the header, decoding, converting, scaling, and saving.
    try:
        # JPEG decoders can DCT-downsample before expanding the full raster.
        # Suppress Pillow's header-only warning here: the configured limit is
        # enforced against the safely decoded draft below.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            image = Image.open(io.BytesIO(source))
        if image.format == "JPEG":
            image.draft("RGB", (max_dimension * 2, max_dimension * 2))
        width, height = image.size
    except Image.DecompressionBombError as problem:
        raise UnsupportedImageError("image exceeds the decoder pixel safety limit") from problem
    except (UnidentifiedImageError, OSError, ValueError) as problem:
        raise UnsupportedImageError("resource is not a decodable raster image") from problem
    if width <= 0 or height <= 0:
        raise UnsupportedImageError("image has no pixels")
    if width * height > max_source_pixels:
        raise UnsupportedImageError(f"image exceeds the {max_source_pixels} pixel safety limit")
    try:
        image.load()
    except Image.DecompressionBombError as problem:
        raise UnsupportedImageError("image exceeds the decoder pixel safety limit") from problem
    except (OSError, ValueError) as problem:
        raise UnsupportedImageError("image data could not be decoded") from problem
    try:
        image = ImageOps.exif_transpose(image)
    except Exception:
        # Malformed EXIF must not reject an otherwise decodable image.
        pass
    has_alpha = "A" in image.getbands() or (image.mode == "P" and "transparency" in image.info)
    target_mode = "RGBA" if has_alpha else "RGB"
    try:
        if image.mode != target_mode:
            image = image.convert(target_mode)
        image.thumbnail((max_dimension, max_dimension), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.save(output, "WEBP", quality=quality, method=4)
    except Image.DecompressionBombError as problem:
        raise UnsupportedImageError("image exceeds the decoder pixel safety limit") from problem
    except (OSError, ValueError) as problem:
        raise UnsupportedImageError("image data could not be rendered as a thumbnail") from problem
    return output.getvalue(), image.width, image.height


def rectangular_crop_geometry(crop: Any) -> tuple[float, float, float, float, float]:
    """Normalize the five persisted rectangular crop summary fields.

    Optional legacy ``corners`` are deliberately ignored by both rendering and
    preview cache identity.
    """
    if not isinstance(crop, dict):
        raise InvalidCropError("saved crop is missing")
    values = [crop.get(key) for key in ("centerX", "centerY", "width", "height", "rotationDegrees")]
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value) for value in values):
        raise InvalidCropError("saved rectangular crop is invalid")
    center_x, center_y, width, height, angle = (float(value) for value in values)
    if not (0 <= center_x <= 1_000_000 and 0 <= center_y <= 1_000_000
            and 0.001 <= width <= 1_000_000 and 0.001 <= height <= 1_000_000
            and -360 <= angle <= 360):
        raise InvalidCropError("saved rectangular crop is outside its allowed range")
    return center_x, center_y, width, height, angle


def preview_geometry_id(crop: Any) -> tuple[str, tuple[float, float, float, float, float]]:
    """Return a stable cache fragment for the canonical rectangular summary."""
    geometry = rectangular_crop_geometry(crop)
    canonical = json.dumps(geometry, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canonical.encode("ascii")).hexdigest(), geometry


def render_rectangular_crop_webp(source: bytes, geometry: tuple[float, float, float, float, float], *, max_dimension: int = DEFAULT_MAX_DIMENSION,
                                 quality: int = DEFAULT_QUALITY, max_source_pixels: int = DEFAULT_MAX_SOURCE_PIXELS) -> tuple[bytes, int, int]:
    """Render a bounded rotated rectangular crop from oriented source coordinates."""
    if not source:
        raise UnsupportedImageError("resource is empty")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            image = Image.open(io.BytesIO(source))
        width, height = image.size
        if width <= 0 or height <= 0 or width * height > max_source_pixels:
            raise UnsupportedImageError("image exceeds the decoder pixel safety limit")
        image.load()
        try:
            image = ImageOps.exif_transpose(image)
        except Exception:
            # Match ordinary thumbnail behavior: broken EXIF is not a reason
            # to reject otherwise usable pixels (and browser decoders ignore it).
            pass
    except Image.DecompressionBombError as problem:
        raise UnsupportedImageError("image exceeds the decoder pixel safety limit") from problem
    except (UnidentifiedImageError, OSError, ValueError) as problem:
        raise UnsupportedImageError("resource is not a decodable raster image") from problem
    width, height = image.size
    center_x, center_y, crop_width, crop_height, angle = geometry
    radians = angle * pi / 180
    rectangle_corners = tuple(
        (center_x + x * cos(radians) - y * sin(radians), center_y + x * sin(radians) + y * cos(radians))
        for x, y in ((-crop_width / 2, -crop_height / 2), (crop_width / 2, -crop_height / 2),
                     (crop_width / 2, crop_height / 2), (-crop_width / 2, crop_height / 2))
    )
    # Browser/canvas coordinates use inclusive outer source edges.
    if any(x < 0 or y < 0 or x > width or y > height for x, y in rectangle_corners):
        raise InvalidCropError("saved crop lies outside the oriented source image")
    output_width, output_height = max(1, round(crop_width)), max(1, round(crop_height))
    scale = min(1, max_dimension / max(output_width, output_height))
    output_size = (max(1, round(output_width * scale)), max(1, round(output_height * scale)))
    try:
        has_alpha = "A" in image.getbands() or (image.mode == "P" and "transparency" in image.info)
        image = image.convert("RGBA" if has_alpha else "RGB")
        # Sample the output rectangle directly from source coordinates. Rotating
        # the whole image first can clip an otherwise in-bounds rectangle near
        # a source edge when its centre is not the image centre.
        scale_x = crop_width / output_size[0]
        scale_y = crop_height / output_size[1]
        image = image.transform(
            output_size,
            Image.Transform.AFFINE,
            (
                cos(radians) * scale_x,
                -sin(radians) * scale_y,
                center_x - cos(radians) * scale_x * output_size[0] / 2 + sin(radians) * scale_y * output_size[1] / 2,
                sin(radians) * scale_x,
                cos(radians) * scale_y,
                center_y - sin(radians) * scale_x * output_size[0] / 2 - cos(radians) * scale_y * output_size[1] / 2,
            ),
            resample=Image.Resampling.BICUBIC,
        )
        output = io.BytesIO()
        image.save(output, "WEBP", quality=quality, method=4)
    except (OSError, ValueError) as problem:
        raise UnsupportedImageError("image data could not be rendered as a rectangular crop") from problem
    return output.getvalue(), image.width, image.height


class ThumbnailStore:
    """Thread-safe sqlite3 thumbnail object store under *cache_root*.

    All database work is serialized by an instance lock around a single
    WAL-mode connection, so the store can be shared between the event loop
    (via ``asyncio.to_thread``) and worker threads.
    """

    def __init__(self, cache_root: str | Path, *, max_dimension: int = DEFAULT_MAX_DIMENSION,
                 quality: int = DEFAULT_QUALITY, max_source_bytes: int = DEFAULT_MAX_SOURCE_BYTES,
                 max_source_pixels: int = DEFAULT_MAX_SOURCE_PIXELS):
        self.root = Path(cache_root).expanduser().resolve()
        self.max_dimension, self.quality = max_dimension, quality
        self.max_source_bytes, self.max_source_pixels = max_source_bytes, max_source_pixels
        self.profile = thumbnail_profile_id(
            max_dimension=max_dimension, quality=quality,
            max_source_bytes=max_source_bytes, max_source_pixels=max_source_pixels,
        )
        database = self.root / DATABASE_PATH
        database.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._path_locks: dict[str, threading.Lock] = {}
        self._db = sqlite3.connect(database, check_same_thread=False, isolation_level=None)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA foreign_keys=ON")
        with self._lock:
            # executescript manages (and implicitly commits) its own transaction.
            self._db.executescript(_SCHEMA)
            self._migrate_locked()
            self._db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")

    def _migrate_locked(self) -> None:
        """Bring older cache databases forward in place.

        Older rows lack a render profile and/or source ETag. Empty values can
        never match current values, so they are invalidated lazily rather than
        trusted.
        """
        for table in ("thumbnail_objects", "thumbnail_bindings"):
            columns = {row[1] for row in self._db.execute(f"PRAGMA table_info({table})")}
            if "profile" not in columns:
                self._db.execute(f"ALTER TABLE {table} ADD COLUMN profile TEXT NOT NULL DEFAULT ''")
        binding_columns = {row[1] for row in self._db.execute("PRAGMA table_info(thumbnail_bindings)")}
        if "source_etag" not in binding_columns:
            self._db.execute("ALTER TABLE thumbnail_bindings ADD COLUMN source_etag TEXT NOT NULL DEFAULT ''")

    def close(self) -> None:
        with self._lock:
            self._db.close()

    @contextlib.contextmanager
    def _transaction(self) -> Iterator[None]:
        """Atomic multi-statement write; the instance lock must already be held.

        The connection runs in autocommit mode so single reads stay lock-free
        at the SQLite level; write batches need an explicit BEGIN IMMEDIATE.
        """
        self._db.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self._db.execute("ROLLBACK")
            raise
        else:
            self._db.execute("COMMIT")

    def lookup(self, virtual_path: str, local_path: str, source_etag: str) -> Thumbnail | None:
        """Return the cached thumbnail while its source and profile binding still match."""
        with self._lock:
            return self._lookup_locked(virtual_path, local_path, source_etag)

    def get_or_create(self, virtual_path: str, local_path: str, source_etag: str, source: bytes) -> Thumbnail:
        """Return the cached thumbnail or render, store, and bind a new one.

        Concurrent renderers for the same virtual path are serialized; distinct
        virtual paths render in parallel. Re-rendering reuses an identical
        existing object because objects are content-addressed.
        """
        if len(source) > self.max_source_bytes:
            raise UnsupportedImageError(f"resource exceeds the {self.max_source_bytes} byte safety limit")
        with self._lock:
            hit = self._lookup_locked(virtual_path, local_path, source_etag)
            if hit is not None:
                return hit
            path_lock = self._path_locks.setdefault(virtual_path, threading.Lock())
        with path_lock:
            try:
                with self._lock:
                    hit = self._lookup_locked(virtual_path, local_path, source_etag)
                    if hit is not None:
                        return hit
                data, width, height = render_webp(
                    source, max_dimension=self.max_dimension, quality=self.quality,
                    max_source_pixels=self.max_source_pixels,
                )
                object_id = hashlib.sha256(data).hexdigest()
                source_sha256 = hashlib.sha256(source).hexdigest()
                with self._lock, self._transaction():
                    self._delete_binding_locked(virtual_path)
                    self._db.execute(
                        "INSERT OR IGNORE INTO thumbnail_objects"
                        " (id, data, width, height, source_sha256, source_bytes, profile, created_at)"
                        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (object_id, data, width, height, source_sha256, len(source), self.profile, time.time()),
                    )
                    self._db.execute(
                        "INSERT INTO thumbnail_bindings"
                        " (virtual_path, local_path, source_etag, thumbnail_id, profile, created_at)"
                        " VALUES (?, ?, ?, ?, ?, ?)",
                        (virtual_path, local_path, source_etag, object_id, self.profile, time.time()),
                    )
                return Thumbnail(id=object_id, data=data, width=width, height=height)
            finally:
                # Keep the per-path lock table bounded; the double-checked
                # lookup above makes eviction safe against late waiters.
                with self._lock:
                    if self._path_locks.get(virtual_path) is path_lock:
                        del self._path_locks[virtual_path]

    def get_or_create_rectangular_crop(self, virtual_path: str, local_path: str, source_etag: str, source: bytes,
                                       geometry: tuple[float, float, float, float, float]) -> Thumbnail:
        """Cache a rectangular crop using the same disposable object/binding store.

        ``virtual_path`` contains the flight/slot and canonical-geometry digest;
        normal binding validation still covers both RFG mapping and source ETag.
        """
        if len(source) > self.max_source_bytes:
            raise UnsupportedImageError(f"resource exceeds the {self.max_source_bytes} byte safety limit")
        with self._lock:
            hit = self._lookup_locked(virtual_path, local_path, source_etag)
            if hit is not None:
                return hit
            path_lock = self._path_locks.setdefault(virtual_path, threading.Lock())
        with path_lock:
            try:
                with self._lock:
                    hit = self._lookup_locked(virtual_path, local_path, source_etag)
                    if hit is not None:
                        return hit
                data, width, height = render_rectangular_crop_webp(
                    source, geometry, max_dimension=self.max_dimension, quality=self.quality,
                    max_source_pixels=self.max_source_pixels,
                )
                object_id = hashlib.sha256(data).hexdigest()
                with self._lock, self._transaction():
                    self._delete_binding_locked(virtual_path)
                    self._db.execute(
                        "INSERT OR IGNORE INTO thumbnail_objects"
                        " (id, data, width, height, source_sha256, source_bytes, profile, created_at)"
                        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (object_id, data, width, height, hashlib.sha256(source).hexdigest(), len(source), self.profile, time.time()),
                    )
                    self._db.execute(
                        "INSERT INTO thumbnail_bindings"
                        " (virtual_path, local_path, source_etag, thumbnail_id, profile, created_at)"
                        " VALUES (?, ?, ?, ?, ?, ?)",
                        (virtual_path, local_path, source_etag, object_id, self.profile, time.time()),
                    )
                return Thumbnail(id=object_id, data=data, width=width, height=height)
            finally:
                with self._lock:
                    if self._path_locks.get(virtual_path) is path_lock:
                        del self._path_locks[virtual_path]

    def rebind(self, from_virtual_path: str, to_virtual_path: str, source_etag: str) -> bool:
        """Move the binding at *from_virtual_path* to *to_virtual_path*.

        Any stale binding already at the target is eliminated first, so an
        inbox -> object-ID move keeps the thumbnail and a rematch (target <- inbox)
        replaces the stale target image with the candidate's
        object. ``source_etag`` is the RFG revision at the destination virtual
        path, whose value differs from the source path even when both map to
        the same file. Returns whether a binding moved.
        """
        if from_virtual_path == to_virtual_path:
            return False
        with self._lock, self._transaction():
            self._delete_binding_locked(to_virtual_path)
            moved = self._db.execute(
                "UPDATE thumbnail_bindings SET virtual_path = ?, source_etag = ? WHERE virtual_path = ?",
                (to_virtual_path, source_etag, from_virtual_path),
            ).rowcount
            return moved > 0

    def invalidate(self, virtual_path: str) -> None:
        """Drop the binding at *virtual_path* and its orphaned object, if any."""
        with self._lock, self._transaction():
            self._delete_binding_locked(virtual_path)

    def invalidate_previews(self, flight_id: str) -> None:
        """Discard all derived crops for one flight after a business mutation."""
        prefix = f"preview/{flight_id}/"
        with self._lock, self._transaction():
            paths = [row[0] for row in self._db.execute(
                "SELECT virtual_path FROM thumbnail_bindings WHERE virtual_path >= ? AND virtual_path < ?",
                (prefix, prefix + "\U0010ffff"),
            )]
            for path in paths:
                self._delete_binding_locked(path)

    def reconcile_bindings(self, current_sources: Iterable[tuple[str, str]], preview_sources: Iterable[tuple[str, str]] = ()) -> int:
        """Remove bindings whose virtual path/source pair is no longer current.

        This does not alter RFG mappings. Missing-source mappings remain for
        rematch, but their cached pixels are disposable derivative state.
        """
        current = set(current_sources)
        current.update(preview_sources)
        with self._lock, self._transaction():
            stale = [
                row[0] for row in self._db.execute(
                    "SELECT virtual_path, local_path FROM thumbnail_bindings"
                )
                if (row[0], row[1]) not in current
            ]
            for virtual_path in stale:
                self._delete_binding_locked(virtual_path)
            return len(stale)

    def _lookup_locked(self, virtual_path: str, local_path: str, source_etag: str) -> Thumbnail | None:
        """Lock-held lookup; deletes the binding when it can no longer be trusted.

        A binding whose stored source path or RFG source ETag differs from the
        current source cannot be trusted. A binding whose stored profile differs
        was rendered under other thumbnail settings. In all cases the cached
        pixels are stale, so the binding is dropped (and its object
        garbage-collected when orphaned) and the caller re-renders it.
        """
        row = self._db.execute(
            "SELECT b.local_path, b.source_etag, b.profile, o.id, o.data, o.width, o.height"
            " FROM thumbnail_bindings b JOIN thumbnail_objects o ON o.id = b.thumbnail_id"
            " WHERE b.virtual_path = ?",
            (virtual_path,),
        ).fetchone()
        if row is None:
            return None
        if row[0] != local_path or row[1] != source_etag or row[2] != self.profile:
            with self._transaction():
                self._delete_binding_locked(virtual_path)
            return None
        return Thumbnail(id=row[3], data=row[4], width=row[5], height=row[6])

    def _delete_binding_locked(self, virtual_path: str) -> None:
        """Delete a binding and garbage-collect its object when unreferenced."""
        row = self._db.execute(
            "SELECT thumbnail_id FROM thumbnail_bindings WHERE virtual_path = ?", (virtual_path,)
        ).fetchone()
        if row is None:
            return
        self._db.execute("DELETE FROM thumbnail_bindings WHERE virtual_path = ?", (virtual_path,))
        self._db.execute(
            "DELETE FROM thumbnail_objects WHERE id = ?"
            " AND NOT EXISTS (SELECT 1 FROM thumbnail_bindings WHERE thumbnail_id = ?)",
            (row[0], row[0]),
        )
