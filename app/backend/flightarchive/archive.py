# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Small, domain-neutral storage for FlightArchive's named JSON documents."""
from __future__ import annotations

import json
import logging
import math
import os
import stat
import tempfile
from pathlib import Path
from typing import Any

ARCHIVE_DOCUMENT_IDS = (
    "manifest.json",
    "flights.json",
    "airlines.json",
    "airports.json",
    "aircraft-types.json",
    "settings.json",
)
MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
logger = logging.getLogger(__name__)


class ArchiveError(Exception):
    """A named document could not be safely read or changed."""


def parse_finite_json(raw: bytes) -> Any:
    """Decode strict UTF-8 JSON, rejecting every non-finite numeric value."""
    def reject_constant(value: str) -> None:
        raise ValueError(f"non-finite JSON number: {value}")

    def parse_float(value: str) -> float:
        number = float(value)
        if not math.isfinite(number):
            raise ValueError(f"non-finite JSON number: {value}")
        return number

    return json.loads(raw.decode("utf-8"), parse_constant=reject_constant, parse_float=parse_float)


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class ArchiveStore:
    """Current-file-only JSON document store for one registered application."""

    app_id = "flightarchive"

    def __init__(self, data_root: str | Path) -> None:
        self.data_root = Path(data_root)
        self.root = self.data_root / "flightarchive" / "v2"

    def _check_root(self, *, required: bool) -> bool:
        try:
            root_info = os.lstat(self.data_root)
        except FileNotFoundError:
            if required:
                raise FileNotFoundError(self.root)
            return False
        if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
            raise ArchiveError("archive path must contain only real directories")
        current = self.data_root
        for component in ("flightarchive", "v2"):
            current = current / component
            try:
                info = os.lstat(current)
            except FileNotFoundError:
                if required:
                    raise FileNotFoundError(self.root)
                return False
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise ArchiveError("archive path must contain only real directories")
        return True

    @staticmethod
    def _document_id(document_id: str) -> str:
        if document_id not in ARCHIVE_DOCUMENT_IDS:
            raise KeyError(document_id)
        return document_id

    def _path(self, document_id: str) -> Path:
        return self.root / self._document_id(document_id)

    @staticmethod
    def _regular_file(path: Path) -> os.stat_result:
        info = os.lstat(path)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise ArchiveError("archive document must be a regular non-symlink file")
        return info

    def list_documents(self) -> list[str]:
        if not self._check_root(required=False):
            return []
        result: list[str] = []
        for document_id in ARCHIVE_DOCUMENT_IDS:
            path = self.root / document_id
            if not os.path.lexists(path):
                continue
            self._regular_file(path)
            result.append(document_id)
        return result

    def read(self, document_id: str) -> Any:
        self._check_root(required=True)
        path = self._path(document_id)
        info = self._regular_file(path)
        if info.st_size > MAX_DOCUMENT_BYTES:
            raise ArchiveError("archive document exceeds the size limit")
        with path.open("rb") as stream:
            raw = stream.read(MAX_DOCUMENT_BYTES + 1)
        if len(raw) > MAX_DOCUMENT_BYTES:
            raise ArchiveError("archive document exceeds the size limit")
        try:
            return parse_finite_json(raw)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise ArchiveError("archive document is not valid finite UTF-8 JSON") from exc

    def write(self, document_id: str, raw: bytes) -> None:
        self._check_root(required=True)
        path = self._path(document_id)
        if os.path.lexists(path):
            self._regular_file(path)
        if len(raw) > MAX_DOCUMENT_BYTES:
            raise ArchiveError("archive document exceeds the size limit")
        try:
            parse_finite_json(raw)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise ValueError("request body must be valid finite UTF-8 JSON") from exc
        descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=self.root)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            _fsync_directory(self.root)
        except Exception:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise

    def delete(self, document_id: str) -> None:
        self._check_root(required=True)
        path = self._path(document_id)
        self._regular_file(path)
        os.unlink(path)
        _fsync_directory(self.root)

    def state(self) -> str:
        try:
            if not self._check_root(required=False):
                return "missing"
            for document_id in ARCHIVE_DOCUMENT_IDS:
                self.read(document_id)
            return "ready"
        except (ArchiveError, FileNotFoundError, OSError, KeyError):
            return "migration-failed"
