# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Ephemeral, process-local background tasks for slow resource work."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

CONTENT_FINGERPRINT_ALGORITHMS = ("crc32", "md5", "sha256")
PERCEPTUAL_FINGERPRINT_ALGORITHMS = ("ahash", "dhash", "phash")
_MAX_RETAINED_TASKS = 50


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


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
    created_at: str = field(default_factory=_timestamp)
    state: str = "queued"
    started_at: str | None = None
    finished_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        completed = sum(item.state in {"succeeded", "failed"} for item in self.items)
        succeeded = sum(item.state == "succeeded" for item in self.items)
        failed = sum(item.state == "failed" for item in self.items)
        return {
            "id": self.id,
            "kind": "fingerprints",
            "state": self.state,
            "createdAt": self.created_at,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "total": len(self.items),
            "completed": completed,
            "succeeded": succeeded,
            "failed": failed,
            "items": [item.to_dict() for item in self.items],
        }


class BackgroundTaskRegistry:
    """Runs and exposes process-local fingerprint work for the task page."""

    def __init__(self) -> None:
        self._tasks: list[BackgroundTask] = []
        self._next_id = 1
        self._worker_lock = asyncio.Lock()

    def enqueue_fingerprints(self, lifecycle: Any, algorithms_by_path: dict[str, tuple[str, ...]]) -> None:
        items = [TaskItem(path, algorithm) for path, algorithms in algorithms_by_path.items() for algorithm in algorithms]
        if not items:
            return
        task = BackgroundTask(
            id=f"fp-{self._next_id}",
            items=items,
        )
        self._next_id += 1
        self._tasks.insert(0, task)
        del self._tasks[_MAX_RETAINED_TASKS:]
        asyncio.create_task(self._run_fingerprints(task, lifecycle))

    def snapshot(self) -> list[dict[str, Any]]:
        return [task.to_dict() for task in self._tasks]

    async def _run_fingerprints(self, task: BackgroundTask, lifecycle: Any) -> None:
        # RFG exposes bounded hash capacity. One worker preserves a truthful
        # queue and avoids turning simultaneous form submissions into 429s.
        async with self._worker_lock:
            task.state, task.started_at = "running", _timestamp()
            for item in task.items:
                item.state = "running"
                try:
                    response = await lifecycle.fingerprints(
                        {"virtualPaths": [item.virtual_path], "algorithms": [item.algorithm]}
                    )
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
            task.finished_at = _timestamp()
            task.state = "failed" if any(item.state == "failed" for item in task.items) else "succeeded"
