# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Generic append-only activity records, usable without a FastAPI application."""
from __future__ import annotations

import json
import math
import os
import re
import secrets
import stat
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

_DAY_FILE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.jsonl$")
_MAX_STRING = 512
_MAX_DETAILS_BYTES = 64 * 1024
_MAX_RECORD_BYTES = 128 * 1024
_MAX_LINE_BYTES = _MAX_RECORD_BYTES
_DRAIN_CHUNK_BYTES = 64 * 1024


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds")


def _finite_json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON number: {value}")


def _parse_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"non-finite JSON number: {value}")
    return number


def _decode_line(line: bytes) -> Any:
    return json.loads(line.decode("utf-8"), parse_constant=_reject_constant, parse_float=_parse_float)


def _bounded_lines(stream: Any, limit: int) -> Any:
    """Yield lines of at most ``limit`` bytes, draining longer ones without buffering them."""
    while True:
        line = stream.readline(limit + 1)
        if not line:
            return
        if len(line) > limit:
            while line and not line.endswith(b"\n"):
                line = stream.readline(_DRAIN_CHUNK_BYTES)
            continue
        yield line


def _is_json_value(value: Any) -> bool:
    if value is None or isinstance(value, (str, bool, int)):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, list):
        return all(_is_json_value(item) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and _is_json_value(item) for key, item in value.items())
    return False


def _validate_submission(source: Any, kind: Any, severity: Any, state: Any, code: Any, details: Any) -> None:
    for name, value in (("source", source), ("kind", kind), ("severity", severity), ("state", state), ("code", code)):
        if not isinstance(value, str) or not value or len(value) > _MAX_STRING:
            raise ValueError(f"{name} must be a non-empty string of at most {_MAX_STRING} characters")
    if not _is_json_value(details):
        raise ValueError("details must be finite JSON")
    encoded = _finite_json_bytes(details)
    if len(encoded) > _MAX_DETAILS_BYTES:
        raise ValueError("details exceeds the size limit")


def _valid_record(value: Any) -> bool:
    if not isinstance(value, dict) or set(value) != {
        "id", "createdAt", "source", "kind", "severity", "state", "code", "details",
    }:
        return False
    if not isinstance(value["id"], str) or not value["id"] or not isinstance(value["createdAt"], str):
        return False
    try:
        _validate_submission(
            value["source"], value["kind"], value["severity"], value["state"], value["code"], value["details"],
        )
    except ValueError:
        return False
    return True


class ActivityLog:
    def __init__(self, data_root: str | Path, *, clock: Callable[[], datetime] = _now) -> None:
        self.data_root = Path(data_root)
        self.directory = self.data_root / "flightarchive" / "log" / "activity"
        self.clock = clock

    def _ensure_directory(self) -> None:
        root_info = os.lstat(self.data_root)
        if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
            raise OSError("activity path must contain only real directories")
        current = self.data_root
        for component in ("flightarchive", "log", "activity"):
            current = current / component
            try:
                info = os.lstat(current)
            except FileNotFoundError:
                current.mkdir()
                info = os.lstat(current)
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise OSError("activity path must contain only real directories")

    def _readable_directory(self) -> bool:
        try:
            root_info = os.lstat(self.data_root)
        except FileNotFoundError:
            return False
        if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
            raise OSError("activity path must contain only real directories")
        current = self.data_root
        for component in ("flightarchive", "log", "activity"):
            current = current / component
            try:
                info = os.lstat(current)
            except FileNotFoundError:
                return False
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise OSError("activity path must contain only real directories")
        return True

    @staticmethod
    def _check_day_file(path: Path) -> None:
        info = os.lstat(path)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise OSError("activity day must be a regular non-symlink file")

    def report(self, source: str, kind: str, severity: str, state: str, code: str, details: Any) -> dict[str, Any]:
        _validate_submission(source, kind, severity, state, code, details)
        created = self.clock().astimezone(timezone.utc)
        record = {
            "id": f"activity-{created.strftime('%Y%m%dT%H%M%S%fZ')}-{secrets.token_hex(4)}",
            "createdAt": _timestamp(created),
            "source": source,
            "kind": kind,
            "severity": severity,
            "state": state,
            "code": code,
            "details": details,
        }
        line = _finite_json_bytes(record) + b"\n"
        if len(line) > _MAX_RECORD_BYTES:
            raise ValueError("activity record exceeds the size limit")
        self._ensure_directory()
        path = self.directory / f"{created.date().isoformat()}.jsonl"
        if os.path.lexists(path):
            self._check_day_file(path)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            if os.write(descriptor, line) != len(line):
                raise OSError("short append while writing activity log")
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        return record

    def _days(self) -> list[str]:
        if not self._readable_directory():
            return []
        days: list[str] = []
        for path in self.directory.iterdir():
            match = _DAY_FILE.fullmatch(path.name)
            if not match:
                continue
            self._check_day_file(path)
            days.append(match.group(1))
        return sorted(days, reverse=True)

    def _read_day(self, day: str) -> list[dict[str, Any]]:
        path = self.directory / f"{day}.jsonl"
        self._check_day_file(path)
        records: list[dict[str, Any]] = []
        with path.open("rb") as stream:
            for line in _bounded_lines(stream, _MAX_LINE_BYTES):
                try:
                    value = _decode_line(line)
                except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
                    continue
                if _valid_record(value):
                    records.append(value)
        return records

    def revision(self) -> str | None:
        for day in self._days():
            latest: str | None = None
            path = self.directory / f"{day}.jsonl"
            self._check_day_file(path)
            with path.open("rb") as stream:
                for line in _bounded_lines(stream, _MAX_LINE_BYTES):
                    try:
                        value = _decode_line(line)
                    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
                        continue
                    if _valid_record(value):
                        latest = value["id"]
            if latest is not None:
                return latest
        return None

    def history(self, *, before: str | None = None, limit_days: int = 3) -> dict[str, Any]:
        days = self._days()
        eligible = [day for day in days if before is None or day < before]
        selected = eligible[:limit_days]
        grouped = [{"date": day, "activities": self._read_day(day)} for day in selected]
        has_more = len(eligible) > len(selected)
        return {
            "days": grouped,
            "nextCursor": selected[-1] if has_more and selected else None,
            "hasMore": has_more,
            "revision": self.revision(),
        }


def report_activity(
    source: str, kind: str, severity: str, state: str, code: str, details: Any,
    *, data_root: str | Path, clock: Callable[[], datetime] = _now,
) -> dict[str, Any]:
    """Append one activity using an explicitly supplied data directory."""
    return ActivityLog(data_root, clock=clock).report(source, kind, severity, state, code, details)
