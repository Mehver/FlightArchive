# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Pure, read-only projection of legacy fingerprint task JSONL files."""
from __future__ import annotations

import json
import math
import os
import re
import stat
from pathlib import Path
from typing import Any

_DAY_FILE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.jsonl$")
_MAX_LINE_BYTES = 1024 * 1024
_DRAIN_CHUNK_BYTES = 64 * 1024


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON number: {value}")


def _parse_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"non-finite JSON number: {value}")
    return number


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


_LEGACY_TASK_PATH = ("flightarchive", "log", "task")


class LegacyTaskReader:
    def __init__(self, data_root: str | Path) -> None:
        self.data_root = Path(data_root)
        self.directory = self.data_root.joinpath(*_LEGACY_TASK_PATH)

    def _readable_directory(self) -> bool:
        """True only when the fixed legacy path exists below real, non-symlink directories."""
        try:
            root_info = os.lstat(self.data_root)
        except FileNotFoundError:
            return False
        if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
            raise OSError("legacy task path must contain only real directories")
        current = self.data_root
        for component in _LEGACY_TASK_PATH:
            current = current / component
            try:
                info = os.lstat(current)
            except FileNotFoundError:
                return False
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise OSError("legacy task path must contain only real directories")
        return True

    def _days(self) -> list[str]:
        if not self._readable_directory():
            return []
        days: list[str] = []
        for path in self.directory.iterdir():
            match = _DAY_FILE.fullmatch(path.name)
            if not match:
                continue
            file_info = os.lstat(path)
            if stat.S_ISLNK(file_info.st_mode) or not stat.S_ISREG(file_info.st_mode):
                raise OSError("legacy task day must be a regular non-symlink file")
            days.append(match.group(1))
        return sorted(days, reverse=True)

    @staticmethod
    def _task_record(record: dict[str, Any]) -> dict[str, Any]:
        progress = record.get("progress") if isinstance(record.get("progress"), dict) else {}
        return {
            "id": record.get("taskId"),
            "kind": record.get("kind", "fingerprints"),
            "state": record.get("state"),
            "createdAt": record.get("createdAt"),
            "startedAt": record.get("startedAt"),
            "finishedAt": record.get("finishedAt"),
            "total": progress.get("total", 0),
            "completed": progress.get("completed", 0),
            "succeeded": progress.get("succeeded", 0),
            "failed": progress.get("failed", 0),
            "items": record.get("items") if isinstance(record.get("items"), list) else [],
        }

    def _read_day(self, day: str) -> list[dict[str, Any]]:
        latest: dict[str, dict[str, Any]] = {}
        path = self.directory / f"{day}.jsonl"
        info = os.lstat(path)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise OSError("legacy task day must be a regular non-symlink file")
        with path.open("rb") as stream:
            for line in _bounded_lines(stream, _MAX_LINE_BYTES):
                try:
                    record = json.loads(
                        line.decode("utf-8"), parse_constant=_reject_constant, parse_float=_parse_float,
                    )
                except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
                    continue
                if not isinstance(record, dict) or record.get("logDay") != day:
                    continue
                task_id = record.get("taskId")
                items = record.get("items")
                if not isinstance(task_id, str) or not isinstance(record.get("createdAt"), str):
                    continue
                if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
                    continue
                try:
                    int(record.get("seq"))
                except (TypeError, ValueError):
                    continue
                latest[task_id] = record
        tasks = [self._task_record(record) for record in latest.values()]
        tasks.sort(key=lambda task: (task["createdAt"], task["id"]), reverse=True)
        return tasks

    def history(self, *, before: str | None = None, limit_days: int = 3) -> dict[str, Any]:
        days = self._days()
        eligible = [day for day in days if before is None or day < before]
        selected = eligible[:limit_days]
        has_more = len(eligible) > len(selected)
        return {
            "days": [{"date": day, "tasks": self._read_day(day)} for day in selected],
            "nextCursor": selected[-1] if has_more and selected else None,
            "hasMore": has_more,
        }
