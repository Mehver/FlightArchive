# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Contracts for the process-local fingerprint queue and durable task log."""
from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import datetime, timezone

from fastapi.testclient import TestClient
from flightarchive.server import create_app
from flightarchive.tasks import BackgroundTaskRegistry


class _Lifecycle:
    def __init__(self, gate: asyncio.Event | None = None):
        self.gate, self.calls = gate, []

    async def capture_automatic_fingerprint(self, path, algorithms):
        if self.gate is not None:
            await self.gate.wait()
        self.calls.append(path)
        return {"path": path, "algorithms": algorithms}

    async def automatic_fingerprints(self, job):
        return {"results": [{"status": "succeeded", "persisted": True}]}


def _lines(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_task_id_is_timestamp_based_and_unique(tmp_path):
    async def exercise():
        now = datetime(2026, 9, 24, 12, 34, 56, 123456, tzinfo=timezone.utc)
        queue = BackgroundTaskRegistry(tmp_path, clock=lambda: now)
        first = queue.enqueue_fingerprints(_Lifecycle(), {"a.png": ("sha256",)})
        second = queue.enqueue_fingerprints(_Lifecycle(), {"b.png": ("sha256",)})
        await queue._worker
        assert first["id"] != second["id"]
        for task in (first, second):
            assert re.fullmatch(r"task-\d{8}T\d{12}Z-[0-9a-f]{8}", task["id"])
            assert task["id"].startswith("task-20260924T123456123456Z-")

    asyncio.run(exercise())


def test_log_contains_ordered_full_status_snapshots_and_result(tmp_path):
    async def exercise():
        now = datetime(2026, 9, 24, 23, 59, 59, tzinfo=timezone.utc)
        queue = BackgroundTaskRegistry(tmp_path, clock=lambda: now)
        task = queue.enqueue_fingerprints(_Lifecycle(), {"a.png": ("md5", "sha256")})
        await queue._worker

        records = _lines(tmp_path / "2026-09-24.jsonl")
        assert [record["recordType"] for record in records] == ["status"] * 5 + ["result"]
        assert [record["state"] for record in records] == ["queued", "running", "running", "running", "succeeded", "succeeded"]
        assert [record["seq"] for record in records] == list(range(1, 7))
        assert records[-1]["outcome"] == "succeeded"
        assert records[-1]["summary"] == {"total": 2, "completed": 2, "succeeded": 2, "failed": 0}
        for record in records:
            assert record["schemaVersion"] == 1
            assert record["taskId"] == task["id"]
            assert record["kind"] == "fingerprints"
            assert record["logDay"] == "2026-09-24"
            assert set(record["progress"]) == {"total", "completed", "succeeded", "failed"}
            assert len(record["items"]) == 2

    asyncio.run(exercise())


def test_live_registry_task_is_not_repaired_and_queue_remains_fifo(tmp_path):
    async def exercise():
        gate = asyncio.Event()
        lifecycle = _Lifecycle(gate)
        queue = BackgroundTaskRegistry(tmp_path)
        first = queue.enqueue_fingerprints(lifecycle, {"first.png": ("sha256",)})
        second = queue.enqueue_fingerprints(lifecycle, {"second.png": ("sha256",)})
        await asyncio.sleep(0.02)
        page = await queue.history()
        live = next(task for task in page["days"][0]["tasks"] if task["id"] == first["id"])
        assert live["state"] == "running"
        assert not any(row["recordType"] == "result" for row in _lines(next(tmp_path.glob("*.jsonl"))))
        gate.set()
        await queue._worker
        assert lifecycle.calls == ["first.png", "second.png"]

    asyncio.run(exercise())


def test_cross_midnight_updates_stay_in_creation_day(tmp_path):
    async def exercise():
        calls = 0
        def clock():
            nonlocal calls
            calls += 1
            return datetime(2026, 9, 24, 23, 59, 59, tzinfo=timezone.utc) if calls == 1 else datetime(2026, 9, 25, 0, 0, calls, tzinfo=timezone.utc)
        queue = BackgroundTaskRegistry(tmp_path, clock=clock)
        queue.enqueue_fingerprints(_Lifecycle(), {"a.png": ("sha256",)})
        await queue._worker
        assert (tmp_path / "2026-09-24.jsonl").exists()
        assert not (tmp_path / "2026-09-25.jsonl").exists()
        assert all(row["logDay"] == "2026-09-24" for row in _lines(tmp_path / "2026-09-24.jsonl"))

    asyncio.run(exercise())


def test_history_pages_over_existing_days_and_ignores_partial_line(tmp_path):
    async def exercise():
        for day in ("2026-09-20", "2026-09-22", "2026-09-23", "2026-09-24"):
            record = {
                "schemaVersion": 1, "taskId": f"task-{day}", "kind": "fingerprints",
                "recordType": "status", "seq": 1, "occurredAt": f"{day}T12:00:00+00:00",
                "logDay": day, "state": "succeeded", "createdAt": f"{day}T12:00:00+00:00",
                "startedAt": f"{day}T12:00:00+00:00", "finishedAt": f"{day}T12:00:00+00:00",
                "progress": {"total": 1, "completed": 1, "succeeded": 1, "failed": 0},
                "items": [{"virtualPath": "a", "algorithm": "md5", "state": "succeeded", "code": None, "message": None}],
            }
            (tmp_path / f"{day}.jsonl").write_text(json.dumps(record) + "\n", encoding="utf-8")
        with (tmp_path / "2026-09-24.jsonl").open("a", encoding="utf-8") as stream:
            stream.write('{"taskId":"partial"')

        queue = BackgroundTaskRegistry(tmp_path)
        page = await queue.history()
        assert [day["date"] for day in page["days"]] == ["2026-09-24", "2026-09-23", "2026-09-22"]
        assert page["hasMore"] is True and page["nextCursor"] == "2026-09-22"
        assert page["days"][0]["tasks"][0]["id"] == "task-2026-09-24"
        older = await queue.history(before="2026-09-22", limit_days=3)
        assert [day["date"] for day in older["days"]] == ["2026-09-20"]
        assert older["hasMore"] is False and older["nextCursor"] is None

    asyncio.run(exercise())


def test_read_repairs_orphaned_running_and_queued_once(tmp_path):
    async def exercise():
        for index, state in enumerate(("running", "queued"), 1):
            task_id = f"task-orphan-{index}"
            record = {
                "schemaVersion": 1, "taskId": task_id, "kind": "fingerprints", "recordType": "status",
                "seq": 1, "occurredAt": "2026-09-24T12:00:00+00:00", "logDay": "2026-09-24",
                "state": state, "createdAt": "2026-09-24T12:00:00+00:00", "startedAt": None,
                "finishedAt": None, "progress": {"total": 1, "completed": 0, "succeeded": 0, "failed": 0},
                "items": [{"virtualPath": "a", "algorithm": "md5", "state": state, "code": None, "message": None}],
            }
            with (tmp_path / "2026-09-24.jsonl").open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(record) + "\n")

        queue = BackgroundTaskRegistry(tmp_path)
        first = await queue.history()
        assert {task["state"] for task in first["days"][0]["tasks"]} == {"failed"}
        records_after_first = _lines(tmp_path / "2026-09-24.jsonl")
        for task_id in ("task-orphan-1", "task-orphan-2"):
            task_records = [row for row in records_after_first if row["taskId"] == task_id]
            assert [row["recordType"] for row in task_records] == ["status", "status", "result"]
            repaired_status, result = task_records[-2:]
            assert repaired_status["state"] == "failed"
            assert repaired_status["finishedAt"] is not None
            assert repaired_status["progress"] == {"total": 1, "completed": 1, "succeeded": 0, "failed": 1}
            assert repaired_status["items"][0]["code"] == "task_interrupted"
            assert result["outcome"] == "failed"
            assert result["summary"] == {"total": 1, "completed": 1, "succeeded": 0, "failed": 1}
        await queue.history()
        assert len(_lines(tmp_path / "2026-09-24.jsonl")) == len(records_after_first)

    asyncio.run(exercise())


def test_queued_log_failure_keeps_api_available_fails_task_and_worker_continues(tmp_path, monkeypatch):
    resource_root, data_root = tmp_path / "resources", tmp_path / "data"
    resource_root.mkdir()
    data_root.mkdir()
    application = create_app(resource_root=resource_root, data_root=data_root)
    queue = application.state.background_tasks
    lifecycle = _Lifecycle()
    original_append_sync = queue._append_sync
    append_calls = 0

    def fail_first_append(day, record):
        nonlocal append_calls
        append_calls += 1
        if append_calls == 1:
            raise OSError("injected queued-log failure")
        original_append_sync(day, record)

    monkeypatch.setattr(queue, "_append_sync", fail_first_append)
    with TestClient(application) as client:
        def enqueue_both():
            return (
                queue.enqueue_fingerprints(lifecycle, {"first.png": ("sha256",)}),
                queue.enqueue_fingerprints(lifecycle, {"second.png": ("sha256",)}),
            )

        first, second = client.portal.call(enqueue_both)
        assert first is not None and second is not None
        deadline = time.monotonic() + 2
        tasks = {}
        while time.monotonic() < deadline:
            response = client.get("/api/tasks")
            assert response.status_code == 200
            tasks = {
                task["id"]: task
                for day in response.json()["days"]
                for task in day["tasks"]
            }
            if tasks.get(first["id"], {}).get("state") == "failed" and tasks.get(second["id"], {}).get("state") == "succeeded":
                break
            time.sleep(0.01)

        assert tasks[first["id"]]["state"] == "failed"
        assert tasks[second["id"]]["state"] == "succeeded"
        records = _lines(next((data_root / "flightarchive" / "log" / "task").glob("*.jsonl")))
        assert any(row["taskId"] == first["id"] and row["recordType"] == "result" for row in records)
        assert lifecycle.calls == ["second.png"]
        assert queue._active_ids == set()
        assert queue._queued_logs == {}


def test_history_skips_malformed_seq_items_and_created_at(tmp_path):
    async def exercise():
        day = "2026-09-24"
        base = {
            "schemaVersion": 1, "kind": "fingerprints", "recordType": "status",
            "occurredAt": f"{day}T12:00:00+00:00", "logDay": day, "state": "succeeded",
            "createdAt": f"{day}T12:00:00+00:00", "startedAt": None, "finishedAt": None,
            "progress": {"total": 0, "completed": 0, "succeeded": 0, "failed": 0}, "items": [],
        }
        malformed = [
            {**base, "taskId": "bad-seq", "seq": None},
            {**base, "taskId": "bad-items", "seq": 1, "items": {"not": "a list"}},
            {**base, "taskId": "bad-created", "seq": 1, "createdAt": None},
        ]
        valid = {**base, "taskId": "valid", "seq": 1}
        (tmp_path / f"{day}.jsonl").write_text(
            "".join(json.dumps(record) + "\n" for record in [*malformed, valid]), encoding="utf-8"
        )

        page = await BackgroundTaskRegistry(tmp_path).history()
        assert [task["id"] for task in page["days"][0]["tasks"]] == ["valid"]

    asyncio.run(exercise())


def test_history_repairs_terminal_status_missing_result_once(tmp_path):
    async def exercise():
        day = "2026-09-24"
        status = {
            "schemaVersion": 1, "taskId": "task-terminal", "kind": "fingerprints",
            "recordType": "status", "seq": 7, "occurredAt": f"{day}T12:00:00+00:00",
            "logDay": day, "state": "succeeded", "createdAt": f"{day}T12:00:00+00:00",
            "startedAt": f"{day}T12:00:00+00:00", "finishedAt": f"{day}T12:01:00+00:00",
            "progress": {"total": 1, "completed": 1, "succeeded": 1, "failed": 0},
            "items": [{"virtualPath": "a", "algorithm": "md5", "state": "succeeded", "code": None, "message": None}],
        }
        path = tmp_path / f"{day}.jsonl"
        path.write_text(json.dumps(status) + "\n", encoding="utf-8")
        queue = BackgroundTaskRegistry(tmp_path)

        first = await queue.history()
        assert first["days"][0]["tasks"][0]["state"] == "succeeded"
        after_first = _lines(path)
        assert [record["recordType"] for record in after_first] == ["status", "result"]
        assert after_first[-1]["seq"] == 8
        assert after_first[-1]["outcome"] == "succeeded"

        await queue.history()
        assert _lines(path) == after_first

    asyncio.run(exercise())
