# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""User-editable versioned runtime configuration (restart-only).

The file lives at ``<RFG_DATA_DIR>/flightarchive/v1/preview-config.json``, next
to — but strictly separate from — BusinessData.  When absent it is seeded
atomically with the documented defaults; an existing file is validated
strictly and any violation aborts startup with :class:`ConfigError`.  The
file is never rewritten or silently ignored: there is no fallback.

Strictness contract for schemaVersion 1:

- exact keys at every level; unknown or missing keys are rejected;
- every scalar must be a JSON integer — booleans, floats, strings, and
  nulls are rejected (``bool`` is an ``int`` subclass, so it is excluded
  explicitly);
- the file must be a regular, non-symlink file of at most 64 KiB;
- every value must lie within its documented inclusive bound.

The configuration is applied exactly once at application startup; edits
require a restart.  Nothing in this module reads or writes BusinessData.
"""
from __future__ import annotations

import json
import os
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

CONFIG_SCHEMA_VERSION = 1
CONFIG_FILENAME = "preview-config.json"
CONFIG_MAX_BYTES = 64 * 1024

MAX_SOURCE_BYTES_BOUNDS = (1024 * 1024, 1024 * 1024 * 1024)
MAX_SOURCE_PIXELS_BOUNDS = (1_000_000, 500_000_000)
MAX_DIMENSION_BOUNDS = (1, 2048)
QUALITY_BOUNDS = (0, 100)
JOB_CONCURRENCY_BOUNDS = (1, 2)
PILLOW_IMAGE_MAX_PIXELS_BOUNDS = (1_000_000, 500_000_000)


class ConfigError(Exception):
    """The runtime configuration is invalid; startup must abort."""


@dataclass(frozen=True)
class ThumbnailConfig:
    """Render and scheduling limits for the thumbnail pipeline."""

    max_source_bytes: int
    max_source_pixels: int
    max_dimension: int
    quality: int
    job_concurrency: int


@dataclass(frozen=True)
class RfgConfig:
    """The one supported host-level RFG image safety limit."""

    pillow_image_max_pixels: int


@dataclass(frozen=True)
class RuntimeConfig:
    """The validated, restart-only runtime configuration."""

    schema_version: int
    thumbnails: ThumbnailConfig
    rfg: RfgConfig


def default_config_document() -> dict[str, Any]:
    """The exact seeded schemaVersion-1 document."""
    return {
        "schemaVersion": 1,
        "thumbnails": {
            "maxSourceBytes": 268435456,
            "maxSourcePixels": 100000000,
            "maxDimension": 512,
            "quality": 82,
            "jobConcurrency": 2,
        },
        "rfg": {"pillowImageMaxPixels": 100000000},
    }


def config_path(data_root: str | Path) -> Path:
    return Path(data_root) / "flightarchive" / "v1" / CONFIG_FILENAME


def _require_object(value: Any, name: str, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfigError(f"runtime config {name} must be a JSON object")
    unknown = sorted(set(value) - keys)
    if unknown:
        raise ConfigError(f"runtime config {name} has unknown keys: {', '.join(unknown)}")
    missing = sorted(keys - set(value))
    if missing:
        raise ConfigError(f"runtime config {name} is missing keys: {', '.join(missing)}")
    return value


def _require_int(value: Any, name: str, bounds: tuple[int, int]) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(f"runtime config {name} must be an integer, not {type(value).__name__}")
    low, high = bounds
    if not low <= value <= high:
        raise ConfigError(f"runtime config {name} must be within {low}..{high}")
    return value


def parse_runtime_config(raw: Any) -> RuntimeConfig:
    """Validate the sole supported runtime config schema, version 1."""
    document = _require_object(raw, "document", {"schemaVersion", "thumbnails", "rfg"})
    version = document["schemaVersion"]
    if isinstance(version, bool) or not isinstance(version, int) or version != CONFIG_SCHEMA_VERSION:
        raise ConfigError(
            f"runtime config schemaVersion must be exactly {CONFIG_SCHEMA_VERSION};"
            " old and future formats are not supported"
        )
    thumbnails = _require_object(
        document["thumbnails"], "thumbnails",
        {"maxSourceBytes", "maxSourcePixels", "maxDimension", "quality", "jobConcurrency"},
    )
    rfg = _require_object(document["rfg"], "rfg", {"pillowImageMaxPixels"})
    return RuntimeConfig(
        schema_version=CONFIG_SCHEMA_VERSION,
        thumbnails=ThumbnailConfig(
            max_source_bytes=_require_int(thumbnails["maxSourceBytes"], "thumbnails.maxSourceBytes", MAX_SOURCE_BYTES_BOUNDS),
            max_source_pixels=_require_int(thumbnails["maxSourcePixels"], "thumbnails.maxSourcePixels", MAX_SOURCE_PIXELS_BOUNDS),
            max_dimension=_require_int(thumbnails["maxDimension"], "thumbnails.maxDimension", MAX_DIMENSION_BOUNDS),
            quality=_require_int(thumbnails["quality"], "thumbnails.quality", QUALITY_BOUNDS),
            job_concurrency=_require_int(thumbnails["jobConcurrency"], "thumbnails.jobConcurrency", JOB_CONCURRENCY_BOUNDS),
        ),
        rfg=RfgConfig(
            pillow_image_max_pixels=_require_int(
                rfg["pillowImageMaxPixels"], "rfg.pillowImageMaxPixels", PILLOW_IMAGE_MAX_PIXELS_BOUNDS
            ),
        ),
    )


def _read_config_bytes(path: Path) -> bytes:
    """Read a regular, non-symlink config file of at most 64 KiB."""
    try:
        info = os.lstat(path)
    except OSError as exc:
        raise ConfigError(f"runtime config could not be inspected: {path}") from exc
    if stat.S_ISLNK(info.st_mode):
        raise ConfigError(f"runtime config must not be a symlink: {path}")
    if not stat.S_ISREG(info.st_mode):
        raise ConfigError(f"runtime config must be a regular file: {path}")
    try:
        with path.open("rb") as handle:
            raw = handle.read(CONFIG_MAX_BYTES + 1)
    except OSError as exc:
        raise ConfigError(f"runtime config could not be read: {path}") from exc
    if len(raw) > CONFIG_MAX_BYTES:
        raise ConfigError(f"runtime config exceeds the {CONFIG_MAX_BYTES} byte limit")
    return raw


def _write_config_atomic(path: Path, document: dict[str, Any]) -> None:
    payload = (json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except OSError:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def load_runtime_config(data_root: str | Path) -> RuntimeConfig:
    """Load the runtime config, seeding the defaults atomically when absent.

    Any existing but invalid file aborts startup with :class:`ConfigError`;
    the offending file is preserved untouched.
    """
    path = config_path(data_root)
    if not path.exists():
        _write_config_atomic(path, default_config_document())
    try:
        raw = json.loads(_read_config_bytes(path).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ConfigError("runtime config is not valid UTF-8 JSON") from exc
    return parse_runtime_config(raw)
