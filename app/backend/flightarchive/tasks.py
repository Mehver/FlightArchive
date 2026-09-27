# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Process-local fingerprint scheduling with append-only JSONL history."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

_MAX_RETAINED_TASKS = 50
_DAY_FILE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.jsonl$")
_TERMINAL_STATES = {"succeeded", "failed"}
logger = logging.getLogger(__name__)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds")


@dataclass
class TaskItem:
    virtual_path: str
    algorithm: str
    state: str = "queued"
    code: str | None = None
    message: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "virtualPath": self.virtual_path,
            "algorithm": self.algorithm,
            "state": self.state,
            "code": self.code,
            "message": self.message,
        }


@dataclass
class BackgroundTask:
    id: str
    items: list[TaskItem]
    created_at: str
    log_day: str
    state: str = "queued"
    started_at: str | None = None
    finished_at: str | None = None
    seq: int = 0

    def progress(self) -> dict[str, int]:
        return {
            "total": len(self.items),
            "completed": sum(item.state in _TERMINAL_STATES for item in self.items),
            "succeeded": sum(item.state == "succeeded" for item in self.items),
            "failed": sum(item.state == "failed" for item in self.items),
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": "fingerprints",
            "state": self.state,
            "createdAt": self.created_at,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            **self.progress(),
            "items": [item.to_dict() for item in self.items],
        }


class BackgroundTaskRegistry:
    """Single-process FIFO scheduler backed by non-replayable JSONL history."""

    def __init__(self, log_directory: str | Path, *, clock: Callable[[], datetime] = _utc_now) -> None:
        self._log_directory = Path(log_directory)
        self._log_directory.mkdir(parents=True, exist_ok=True)
        self._clock = clock
        self._tasks: list[BackgroundTask] = []
        self._pending: deque[tuple[BackgroundTask, Any, asyncio.Task[None]]] = deque()
        self._queued_logs: dict[str, asyncio.Task[None]] = {}
        self._active_ids: set[str] = set()
        self._worker: asyncio.Task[None] | None = None
        # All reads, repairs, and appends in this process are serialized. Files
        # for separate creation days remain physically independent.
        self._log_lock = asyncio.Lock()

    def enqueue_fingerprints(self, lifecycle: Any, algorithms_by_path: dict[str, tuple[str, ...]]) -> dict[str, Any] | None:
        items = [TaskItem(path, algorithm) for path, algorithms in algorithms_by_path.items() for algorithm in algorithms]
        if not items:
            return None
        created = self._clock().astimezone(timezone.utc)
        task = BackgroundTask(
            id=f"task-{created.strftime('%Y%m%dT%H%M%S%fZ')}-{secrets.token_hex(4)}",
            items=items,
            created_at=_timestamp(created),
            log_day=created.date().isoformat(),
        )
        self._tasks.append(task)
        self._active_ids.add(task.id)
        self._trim_terminal_history()
        try:
            queued_log = asyncio.create_task(self._append(task, "status"))
            self._queued_logs[task.id] = queued_log
            self._pending.append((task, lifecycle, queued_log))
            if self._worker is None or self._worker.done():
                self._worker = asyncio.create_task(self._run_worker())
        except Exception as error:
            self._active_ids.discard(task.id)
            self._fail_task(task, error)
            logger.exception("could not start fingerprint queue worker")
            return None
        return task.to_dict()

    async def history(self, *, before: str | None = None, limit_days: int = 3) -> dict[str, Any]:
        """Read log-day pages and atomically repair abandoned active records."""
        # Enqueue is synchronous for post-commit callers, but its non-blocking
        # disk write is scheduled immediately. A read waits for those initial
        # facts so every returned task can come from JSONL rather than memory.
        queued_logs = list(self._queued_logs.items())
        if queued_logs:
            results = await asyncio.gather(*(queued_log for _, queued_log in queued_logs), return_exceptions=True)
            for (task_id, queued_log), result in zip(queued_logs, results):
                if isinstance(result, BaseException):
                    if self._queued_logs.get(task_id) is queued_log:
                        self._queued_logs.pop(task_id, None)
                    logger.warning("initial queued task log failed for %s: %s", task_id, result)
        async with self._log_lock:
            days = await asyncio.to_thread(self._existing_days)
            eligible = [day for day in days if before is None or day < before]
            selected = eligible[:limit_days]
            active_ids = set(self._active_ids)
            grouped: list[dict[str, Any]] = []
            for day in selected:
                records = await asyncio.to_thread(self._read_day, day)
                records = await self._repair_interrupted(day, records, active_ids)
                latest: dict[str, dict[str, Any]] = {}
                for record in records:
                    task_id = record.get("taskId")
                    if isinstance(task_id, str):
                        latest[task_id] = record
                tasks = [self._task_record(record) for record in latest.values()]
                tasks.sort(
                    key=lambda task: (
                        task["createdAt"] if isinstance(task["createdAt"], str) else "",
                        task["id"] if isinstance(task["id"], str) else "",
                    ),
                    reverse=True,
                )
                grouped.append({"date": day, "tasks": tasks})
            has_more = len(eligible) > len(selected)
            return {
                "days": grouped,
                "nextCursor": selected[-1] if has_more and selected else None,
                "hasMore": has_more,
            }

    async def shutdown(self) -> None:
        """Stop work without replay; its last queued/running status is repaired on a later read."""
        if self._worker is not None:
            self._worker.cancel()
            try:
                await self._worker
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception("fingerprint queue worker failed during shutdown")
            self._worker = None
        if self._queued_logs:
            await asyncio.gather(*self._queued_logs.values(), return_exceptions=True)
            self._queued_logs.clear()
        self._active_ids.clear()

    async def _run_worker(self) -> None:
        while self._pending:
            task, lifecycle, queued_log = self._pending.popleft()
            try:
                await asyncio.shield(queued_log)
                self._queued_logs.pop(task.id, None)
                task.state = "running"
                task.started_at = _timestamp(self._clock())
                for item in task.items:
                    item.state = "running"
                await self._append(task, "status")
                for item in task.items:
                    try:
                        job = await lifecycle.capture_automatic_fingerprint(item.virtual_path, (item.algorithm,))
                        response = await lifecycle.automatic_fingerprints(job)
                        result = response["results"][0]
                        if result.get("status") == "succeeded" and result.get("persisted"):
                            item.state = "succeeded"
                        else:
                            item.state = "failed"
                            item.code = str(result.get("code") or "hash_failed")
                            item.message = item.code
                    except Exception as error:
                        item.state = "failed"
                        item.code = str(getattr(error, "code", "task_error"))
                        item.message = str(getattr(error, "message", error))
                    await self._append(task, "status")
                task.finished_at = _timestamp(self._clock())
                task.state = "failed" if any(item.state == "failed" for item in task.items) else "succeeded"
                await self._append(task, "status")
                await self._append(task, "result")
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.exception("fingerprint task %s failed in queue worker", task.id)
                try:
                    self._fail_task(task, error)
                except Exception:
                    logger.exception("could not update failed fingerprint task %s in memory", task.id)
                for record_type in ("status", "result"):
                    try:
                        await self._append(task, record_type)
                    except Exception:
                        logger.exception("could not append %s record for failed fingerprint task %s", record_type, task.id)
            finally:
                self._active_ids.discard(task.id)
                self._queued_logs.pop(task.id, None)
                self._trim_terminal_history()

    async def _append(self, task: BackgroundTask, record_type: str) -> None:
        async with self._log_lock:
            task.seq += 1
            record = self._record(
                task_id=task.id,
                record_type=record_type,
                seq=task.seq,
                occurred_at=_timestamp(self._clock()),
                log_day=task.log_day,
                state=task.state,
                created_at=task.created_at,
                started_at=task.started_at,
                finished_at=task.finished_at,
                progress=task.progress(),
                items=[item.to_dict() for item in task.items],
            )
            await asyncio.to_thread(self._append_sync, task.log_day, record)

    async def _repair_interrupted(
        self, day: str, records: list[dict[str, Any]], active_ids: set[str],
    ) -> list[dict[str, Any]]:
        latest_status: dict[str, dict[str, Any]] = {}
        max_seq: dict[str, int] = {}
        result_ids: set[str] = set()
        valid_records: list[dict[str, Any]] = []
        for record in records:
            task_id = record.get("taskId")
            if not isinstance(task_id, str):
                logger.warning("skipping malformed task record in %s: invalid taskId", day)
                continue
            try:
                seq = int(record.get("seq"))
            except (TypeError, ValueError):
                logger.warning("skipping malformed task record %s in %s: invalid seq", task_id, day)
                continue
            if not isinstance(record.get("createdAt"), str):
                logger.warning("skipping malformed task record %s in %s: invalid createdAt", task_id, day)
                continue
            items = record.get("items")
            if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
                logger.warning("skipping malformed task record %s in %s: invalid items", task_id, day)
                continue
            valid_records.append(record)
            max_seq[task_id] = max(max_seq.get(task_id, 0), seq)
            if record.get("recordType") == "status":
                latest_status[task_id] = record
            elif record.get("recordType") == "result":
                result_ids.add(task_id)
        for task_id, status in latest_status.items():
            state = status.get("state")
            if state in _TERMINAL_STATES:
                if task_id in result_ids:
                    continue
                result = self._record(
                    task_id=task_id, record_type="result", seq=max_seq[task_id] + 1,
                    occurred_at=_timestamp(self._clock()), log_day=day, state=state,
                    created_at=status["createdAt"], started_at=status.get("startedAt"),
                    finished_at=status.get("finishedAt"),
                    progress=self._safe_progress(status), items=status["items"],
                )
                await asyncio.to_thread(self._append_sync, day, result)
                valid_records.append(result)
                result_ids.add(task_id)
                max_seq[task_id] += 1
                continue
            if state not in {"queued", "running"} or task_id in active_ids:
                continue
            occurred = _timestamp(self._clock())
            items = []
            for original in status["items"]:
                item = dict(original)
                if item.get("state") not in _TERMINAL_STATES:
                    item.update(state="failed", code="task_interrupted", message="Task was interrupted before completion")
                items.append(item)
            progress = {
                "total": len(items),
                "completed": sum(item.get("state") in _TERMINAL_STATES for item in items),
                "succeeded": sum(item.get("state") == "succeeded" for item in items),
                "failed": sum(item.get("state") == "failed" for item in items),
            }
            common = dict(
                task_id=task_id, occurred_at=occurred, log_day=day, state="failed",
                created_at=status.get("createdAt"), started_at=status.get("startedAt"),
                finished_at=occurred, progress=progress, items=items,
            )
            failed = self._record(record_type="status", seq=max_seq[task_id] + 1, **common)
            result = self._record(record_type="result", seq=max_seq[task_id] + 2, **common)
            await asyncio.to_thread(self._append_sync, day, failed)
            await asyncio.to_thread(self._append_sync, day, result)
            valid_records.extend((failed, result))
        return valid_records

    @staticmethod
    def _safe_progress(record: dict[str, Any]) -> dict[str, int]:
        progress = record.get("progress")
        if not isinstance(progress, dict):
            items = record.get("items", [])
            return {
                "total": len(items),
                "completed": sum(item.get("state") in _TERMINAL_STATES for item in items),
                "succeeded": sum(item.get("state") == "succeeded" for item in items),
                "failed": sum(item.get("state") == "failed" for item in items),
            }
        return {
            key: value if isinstance(value, int) else 0
            for key, value in ((key, progress.get(key)) for key in ("total", "completed", "succeeded", "failed"))
        }

    @staticmethod
    def _record(*, task_id: str, record_type: str, seq: int, occurred_at: str, log_day: str,
                state: str, created_at: str, started_at: str | None, finished_at: str | None,
                progress: dict[str, int], items: list[dict[str, Any]]) -> dict[str, Any]:
        record: dict[str, Any] = {
            "schemaVersion": 1,
            "taskId": task_id,
            "kind": "fingerprints",
            "recordType": record_type,
            "seq": seq,
            "occurredAt": occurred_at,
            "logDay": log_day,
            "state": state,
            "createdAt": created_at,
            "startedAt": started_at,
            "finishedAt": finished_at,
            "progress": progress,
            "items": items,
        }
        if record_type == "result":
            record.update(outcome=state, summary=dict(progress))
        return record

    def _append_sync(self, day: str, record: dict[str, Any]) -> None:
        path = self._log_directory / f"{day}.jsonl"
        prefix = b""
        try:
            with path.open("rb") as existing:
                existing.seek(-1, os.SEEK_END)
                if existing.read(1) != b"\n":
                    prefix = b"\n"
        except (FileNotFoundError, OSError):
            pass
        line = prefix + json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            if os.write(descriptor, line) != len(line):
                raise OSError("short append while writing task log")
        finally:
            os.close(descriptor)

    def _existing_days(self) -> list[str]:
        days = [match.group(1) for path in self._log_directory.iterdir() if (match := _DAY_FILE.fullmatch(path.name))]
        return sorted(days, reverse=True)

    def _read_day(self, day: str) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        with (self._log_directory / f"{day}.jsonl").open("rb") as stream:
            for line in stream:
                try:
                    record = json.loads(line.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
                if isinstance(record, dict) and record.get("logDay") == day:
                    records.append(record)
        return records

    @staticmethod
    def _task_record(record: dict[str, Any]) -> dict[str, Any]:
        progress = record.get("progress", {})
        if not isinstance(progress, dict):
            progress = {}
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

    def _trim_terminal_history(self) -> None:
        terminal = [task for task in self._tasks if task.state in _TERMINAL_STATES]
        for task in terminal[:-_MAX_RETAINED_TASKS]:
            self._tasks.remove(task)

    def _fail_task(self, task: BackgroundTask, error: Exception) -> None:
        task.state = "failed"
        task.started_at = task.finished_at = _timestamp(self._clock())
        for item in task.items:
            item.state = "failed"
            item.code = str(getattr(error, "code", "task_error"))
            item.message = str(getattr(error, "message", error))
