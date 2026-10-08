# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

from __future__ import annotations

import io
import json
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

import flightarchive.activity as activity_module
import flightarchive.legacy_tasks as legacy_tasks_module
import flightarchive.routes.api as api_module
from flightarchive.activity import ActivityLog, report_activity
from flightarchive.archive import ARCHIVE_DOCUMENT_IDS, ArchiveError, ArchiveStore, parse_finite_json
from flightarchive.legacy_tasks import LegacyTaskReader
from flightarchive.server import create_app


def _client(tmp_path):
    resources, data = tmp_path / "resources", tmp_path / "runtime"
    resources.mkdir()
    data.mkdir()
    return TestClient(create_app(resource_root=resources, data_root=data)), data


def _make_v2(data):
    root = data / "flightarchive" / "v2"
    root.mkdir(parents=True)
    return root


def test_named_documents_are_opaque_allowlisted_json(tmp_path):
    client, data = _client(tmp_path)
    root = _make_v2(data)
    (root / "manifest.json").write_text("null", encoding="utf-8")
    (root / "flights.json").write_text("42", encoding="utf-8")
    with client:
        assert client.get("/api/archive/flightarchive").json() == {
            "appId": "flightarchive",
            "documents": ["manifest.json", "flights.json"],
        }
        listed = client.get("/api/archive/flightarchive/documents")
        assert listed.json() == {"documents": ["manifest.json", "flights.json"]}
        assert listed.headers["cache-control"] == "no-store"
        scalar = client.get("/api/archive/flightarchive/documents/flights.json")
        assert scalar.json() == 42
        assert scalar.headers["cache-control"] == "no-store"

        assert client.put(
            "/api/archive/flightarchive/documents/settings.json", content=b'"opaque"',
            headers={"content-type": "application/json"},
        ).status_code == 204
        assert json.loads((root / "settings.json").read_text(encoding="utf-8")) == "opaque"
        assert client.delete("/api/archive/flightarchive/documents/settings.json").status_code == 204
        assert not (root / "settings.json").exists()

    assert set(ARCHIVE_DOCUMENT_IDS) == {
        "manifest.json", "flights.json", "airlines.json", "airports.json",
        "aircraft-types.json", "settings.json",
    }


def test_named_documents_reject_bad_names_invalid_json_nan_size_and_symlinks(tmp_path):
    client, data = _client(tmp_path)
    root = _make_v2(data)
    outside = tmp_path / "outside.json"
    outside.write_text("{}", encoding="utf-8")
    (root / "manifest.json").symlink_to(outside)
    with client:
        assert client.get("/api/archive/other").status_code == 404
        assert client.get("/api/archive/flightarchive/documents/nope.json").status_code == 404
        assert client.get("/api/archive/flightarchive/documents/manifest.json").status_code == 422
        assert client.put("/api/archive/flightarchive/documents/flights.json", content=b"NaN").status_code == 400
        assert client.put("/api/archive/flightarchive/documents/flights.json", content=b"\xff").status_code == 400
        assert client.put(
            "/api/archive/flightarchive/documents/flights.json",
            content=b'"' + b"x" * (16 * 1024 * 1024) + b'"',
        ).status_code == 413
        assert client.put("/api/archive/flightarchive/documents/manifest.json", json={}).status_code == 422
    assert outside.read_text(encoding="utf-8") == "{}"


def test_parse_finite_json_rejects_exponent_overflow_and_accepts_finite_extremes():
    assert parse_finite_json(b"1e308") == 1e308
    assert parse_finite_json(b"-1e308") == -1e308
    assert parse_finite_json(b"1e-999") == 0.0
    huge = parse_finite_json(b"1" + b"0" * 400)
    assert isinstance(huge, int) and huge > 0
    for raw in (b"NaN", b"Infinity", b"-Infinity", b"1e999", b"-1e999", b"[1e999]"):
        with pytest.raises(ValueError):
            parse_finite_json(raw)


def test_archive_store_rejects_exponent_overflow_on_write_and_read(tmp_path):
    data = tmp_path / "runtime"
    (data / "flightarchive" / "v2").mkdir(parents=True)
    store = ArchiveStore(data)
    with pytest.raises(ValueError):
        store.write("flights.json", b"1e999")
    (data / "flightarchive" / "v2" / "flights.json").write_bytes(b"1e999")
    with pytest.raises(ArchiveError):
        store.read("flights.json")


def test_archive_store_rejects_symlinked_data_root_without_touching_target(tmp_path):
    target = tmp_path / "target"
    (target / "flightarchive" / "v2").mkdir(parents=True)
    marker = target / "keep"
    marker.write_text("safe")
    link = tmp_path / "runtime"
    link.symlink_to(target, target_is_directory=True)
    store = ArchiveStore(link)
    assert store.state() == "migration-failed"
    with pytest.raises(ArchiveError):
        store.list_documents()
    assert marker.read_text() == "safe"


def test_archive_store_does_not_initialize_missing_v2(tmp_path):
    data = tmp_path / "runtime"
    data.mkdir()
    store = ArchiveStore(data)
    assert store.state() == "missing"
    assert store.list_documents() == []
    assert not (data / "flightarchive" / "v2").exists()


def test_archive_store_missing_data_root_preserves_missing_behavior(tmp_path):
    store = ArchiveStore(tmp_path / "absent")
    assert store.state() == "missing"
    assert store.list_documents() == []
    with pytest.raises(FileNotFoundError):
        store.read("flights.json")


def test_activity_append_page_revision_and_helper(tmp_path):
    now = datetime(2026, 9, 24, 12, 34, 56, 123456, tzinfo=timezone.utc)
    log = ActivityLog(tmp_path, clock=lambda: now)
    first = log.report("archive", "write", "info", "succeeded", "saved", {"count": 1})
    second = report_activity(
        "archive", "delete", "warning", "succeeded", "deleted", None,
        data_root=tmp_path, clock=lambda: now,
    )
    assert first["id"] != second["id"]
    page = log.history()
    assert page == {
        "days": [{"date": "2026-09-24", "activities": [first, second]}],
        "nextCursor": None,
        "hasMore": False,
        "revision": second["id"],
    }
    assert ActivityLog(tmp_path).revision() == second["id"]


def test_activity_api_accepts_only_submission_fields_and_ignores_partial_tail(tmp_path):
    client, data = _client(tmp_path)
    payload = {
        "source": "ui", "kind": "notice", "severity": "info",
        "state": "succeeded", "code": "ok", "details": {"value": 1},
    }
    with client:
        created = client.post("/api/activity", json=payload)
        assert created.status_code == 201
        record = created.json()
        assert set(record) == {*payload, "id", "createdAt"}
        assert client.post("/api/activity", json={**payload, "id": "caller-id"}).status_code == 400
        nan_payload = json.dumps({**payload, "details": None}).replace("null", "NaN")
        assert client.post("/api/activity", content=nan_payload, headers={"content-type": "application/json"}).status_code == 400

        path = next((data / "flightarchive" / "log" / "activity").glob("*.jsonl"))
        with path.open("ab") as stream:
            stream.write(b'{"incomplete":')
        before = path.read_bytes()
        page = client.get("/api/activity")
        assert page.status_code == 200
        assert page.json()["days"][0]["activities"] == [record]
        assert path.read_bytes() == before


def _activity_log_files(data):
    return list((data / "flightarchive" / "log" / "activity").glob("*.jsonl"))


def test_activity_api_rejects_oversized_content_length_before_report(tmp_path):
    client, data = _client(tmp_path)
    limit = api_module.MAX_ACTIVITY_REQUEST_BYTES
    payload = {
        "source": "ui", "kind": "notice", "severity": "info",
        "state": "succeeded", "code": "ok", "details": "x" * limit,
    }
    with client:
        response = client.post(
            "/api/activity", content=json.dumps(payload).encode(),
            headers={"content-type": "application/json"},
        )
        assert response.status_code == 413
        assert response.json()["error"]["code"] == "request-too-large"
        assert _activity_log_files(data) == []


def test_activity_api_rejects_streamed_oversized_body_before_report(tmp_path):
    client, data = _client(tmp_path)
    limit = api_module.MAX_ACTIVITY_REQUEST_BYTES
    chunk = b"x" * 8192

    def body():
        remaining = limit + 1
        while remaining > 0:
            piece = chunk[:remaining]
            remaining -= len(piece)
            yield piece

    with client:
        response = client.post(
            "/api/activity", content=body(),
            headers={"content-type": "application/json"},
        )
        assert response.status_code == 413
        assert response.json()["error"]["code"] == "request-too-large"
        assert not (data / "flightarchive" / "log" / "activity").exists()


def test_activity_rejects_symlink_day_without_touching_target(tmp_path):
    log = ActivityLog(tmp_path, clock=lambda: datetime(2026, 9, 24, tzinfo=timezone.utc))
    directory = tmp_path / "flightarchive" / "log" / "activity"
    directory.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.write_bytes(b"safe")
    (directory / "2026-09-24.jsonl").symlink_to(outside)
    with pytest.raises(OSError):
        log.report("x", "x", "info", "succeeded", "x", None)
    assert outside.read_bytes() == b"safe"


def test_activity_rejects_symlinked_data_root_without_touching_target(tmp_path):
    target = tmp_path / "target"
    target.mkdir()
    marker = target / "keep"
    marker.write_text("safe")
    link = tmp_path / "runtime"
    link.symlink_to(target, target_is_directory=True)
    log = ActivityLog(link, clock=lambda: datetime(2026, 9, 24, tzinfo=timezone.utc))
    with pytest.raises(OSError):
        log.report("x", "x", "info", "succeeded", "x", None)
    with pytest.raises(OSError):
        log.history()
    assert marker.read_text() == "safe"
    assert not (target / "flightarchive").exists()


def test_activity_missing_data_root_preserves_missing_behavior(tmp_path):
    log = ActivityLog(tmp_path / "absent", clock=lambda: datetime(2026, 9, 24, tzinfo=timezone.utc))
    assert log.history() == {"days": [], "nextCursor": None, "hasMore": False, "revision": None}
    with pytest.raises(FileNotFoundError):
        log.report("x", "x", "info", "succeeded", "x", None)


class _RecordingStream(io.BytesIO):
    def __init__(self, data: bytes) -> None:
        super().__init__(data)
        self.unbounded_read = False

    def readline(self, size: int = -1) -> bytes:  # type: ignore[override]
        if size is None or size < 0:
            self.unbounded_read = True
        return super().readline(size)


def test_bounded_lines_skip_oversized_without_unbounded_reads():
    limit = 16
    data = b"short line\n" + b"x" * 200 + b"\n" + b"tail line"
    stream = _RecordingStream(data)
    lines = list(activity_module._bounded_lines(stream, limit))
    assert not stream.unbounded_read
    assert lines == [b"short line\n", b"tail line"]


def test_activity_reads_bounded_lines_and_skips_nonfinite(tmp_path):
    now = datetime(2026, 9, 24, 12, 0, 0, tzinfo=timezone.utc)
    log = ActivityLog(tmp_path, clock=lambda: now)
    record = log.report("archive", "write", "info", "succeeded", "saved", {"count": 1})
    path = next((tmp_path / "flightarchive" / "log" / "activity").glob("*.jsonl"))
    oversized = b'{"pad":"' + b"a" * (activity_module._MAX_LINE_BYTES + 10) + b'"}\n'
    overflow = (
        b'{"id":"a","createdAt":"x","source":"s","kind":"k","severity":"info",'
        b'"state":"succeeded","code":"c","details":1e999}\n'
    )
    nan = (
        b'{"id":"b","createdAt":"x","source":"s","kind":"k","severity":"info",'
        b'"state":"succeeded","code":"c","details":NaN}\n'
    )
    path.write_bytes(path.read_bytes() + oversized + overflow + nan + b'{"partial":')
    before = path.read_bytes()
    page = log.history()
    assert page["days"][0]["activities"] == [record]
    assert log.revision() == record["id"]
    assert path.read_bytes() == before


def test_legacy_reader_is_pure_and_preserves_active_projection(tmp_path):
    missing = tmp_path / "missing"
    reader = LegacyTaskReader(missing)
    assert reader.history() == {"days": [], "nextCursor": None, "hasMore": False}
    assert not missing.exists()

    data = tmp_path / "runtime"
    directory = data / "flightarchive" / "log" / "task"
    directory.mkdir(parents=True)
    day = "2026-09-24"
    base = {
        "schemaVersion": 1, "taskId": "task-one", "kind": "fingerprints",
        "recordType": "status", "seq": 1, "occurredAt": f"{day}T12:00:00+00:00",
        "logDay": day, "state": "running", "createdAt": f"{day}T12:00:00+00:00",
        "startedAt": None, "finishedAt": None,
        "progress": {"total": 1, "completed": 0, "succeeded": 0, "failed": 0},
        "items": [{"virtualPath": "a", "algorithm": "sha256", "state": "running", "code": None, "message": None}],
    }
    path = directory / f"{day}.jsonl"
    path.write_bytes(json.dumps(base).encode() + b"\nnot-json\n{\"partial\":")
    before, stamp = path.read_bytes(), path.stat().st_mtime_ns
    page = LegacyTaskReader(data).history()
    assert page["days"][0]["tasks"][0]["state"] == "running"
    assert path.read_bytes() == before and path.stat().st_mtime_ns == stamp
    assert LegacyTaskReader(data).history() == page


def test_legacy_reader_rejects_symlinks_without_mutation(tmp_path):
    data = tmp_path / "runtime"
    directory = data / "flightarchive" / "log" / "task"
    directory.mkdir(parents=True)
    target = tmp_path / "target.jsonl"
    target.write_text("{}\n", encoding="utf-8")
    link = directory / "2026-09-24.jsonl"
    link.symlink_to(target)
    before, stamp = target.read_bytes(), target.stat().st_mtime_ns
    with pytest.raises(OSError):
        LegacyTaskReader(data).history()
    assert target.read_bytes() == before and target.stat().st_mtime_ns == stamp


def test_legacy_reader_skips_oversized_and_nonfinite_lines_without_repair(tmp_path):
    data = tmp_path / "runtime"
    directory = data / "flightarchive" / "log" / "task"
    directory.mkdir(parents=True)
    day = "2026-09-24"
    base = {
        "schemaVersion": 1, "taskId": "task-one", "kind": "fingerprints",
        "recordType": "status", "seq": 1, "occurredAt": f"{day}T12:00:00+00:00",
        "logDay": day, "state": "running", "createdAt": f"{day}T12:00:00+00:00",
        "startedAt": None, "finishedAt": None,
        "progress": {"total": 1, "completed": 0, "succeeded": 0, "failed": 0},
        "items": [{"virtualPath": "a", "algorithm": "sha256", "state": "running", "code": None, "message": None}],
    }
    day_bytes = day.encode()
    oversized = b'{"logDay":"' + day_bytes + b'","pad":"' + b"a" * (legacy_tasks_module._MAX_LINE_BYTES + 10) + b'"}\n'
    overflow = (
        b'{"taskId":"inf","logDay":"' + day_bytes + b'","seq":1,"createdAt":"x",'
        b'"items":[],"progress":{"total":1e999}}\n'
    )
    nan = (
        b'{"taskId":"nan","logDay":"' + day_bytes + b'","seq":1,"createdAt":"x",'
        b'"items":[],"progress":{"total":NaN}}\n'
    )
    path = directory / f"{day}.jsonl"
    path.write_bytes(json.dumps(base).encode() + b"\n" + oversized + overflow + nan + b'{"partial":')
    before, stamp = path.read_bytes(), path.stat().st_mtime_ns
    page = LegacyTaskReader(data).history()
    assert [task["id"] for task in page["days"][0]["tasks"]] == ["task-one"]
    assert path.read_bytes() == before and path.stat().st_mtime_ns == stamp


def _legacy_task_bytes(day: str) -> bytes:
    return (
        b'{"taskId":"legacy-one","logDay":"' + day.encode() + b'","seq":1,"createdAt":"x",'
        b'"items":[],"progress":{"total":1}}\n'
    )


@pytest.mark.parametrize("ancestor", ["flightarchive", "log", "task"])
def test_legacy_reader_rejects_symlinked_ancestors_without_touching_target(tmp_path, ancestor):
    day = "2026-09-24"
    target = tmp_path / "target"
    target_directory = target / "flightarchive" / "log" / "task"
    target_directory.mkdir(parents=True)
    target_file = target_directory / f"{day}.jsonl"
    target_file.write_bytes(_legacy_task_bytes(day))

    data = tmp_path / "runtime"
    if ancestor == "flightarchive":
        data.mkdir()
        (data / "flightarchive").symlink_to(target / "flightarchive")
    elif ancestor == "log":
        (data / "flightarchive").mkdir(parents=True)
        (data / "flightarchive" / "log").symlink_to(target / "flightarchive" / "log")
    else:
        (data / "flightarchive" / "log").mkdir(parents=True)
        (data / "flightarchive" / "log" / "task").symlink_to(target_directory)

    before, stamp = target_file.read_bytes(), target_file.stat().st_mtime_ns
    with pytest.raises(OSError):
        LegacyTaskReader(data).history()
    assert target_file.read_bytes() == before and target_file.stat().st_mtime_ns == stamp


def test_legacy_reader_rejects_symlinked_data_root_without_touching_target(tmp_path):
    day = "2026-09-24"
    target = tmp_path / "target"
    target_directory = target / "flightarchive" / "log" / "task"
    target_directory.mkdir(parents=True)
    target_file = target_directory / f"{day}.jsonl"
    target_file.write_bytes(_legacy_task_bytes(day))
    link = tmp_path / "runtime"
    link.symlink_to(target, target_is_directory=True)

    before, stamp = target_file.read_bytes(), target_file.stat().st_mtime_ns
    with pytest.raises(OSError):
        LegacyTaskReader(link).history()
    assert target_file.read_bytes() == before and target_file.stat().st_mtime_ns == stamp


@pytest.mark.parametrize("ancestor", ["flightarchive", "log"])
def test_legacy_task_api_rejects_symlinked_ancestors_without_reading_target(tmp_path, ancestor):
    resources, data = tmp_path / "resources", tmp_path / "runtime"
    resources.mkdir()
    data.mkdir()
    day = "2026-09-24"
    outside = tmp_path / "outside"
    target_directory = outside / "flightarchive" / "log" / "task"
    target_directory.mkdir(parents=True)
    target_file = target_directory / f"{day}.jsonl"
    target_file.write_bytes(_legacy_task_bytes(day))
    if ancestor == "flightarchive":
        (data / "flightarchive").symlink_to(outside / "flightarchive")
    else:
        (data / "flightarchive").mkdir()
        (data / "flightarchive" / "log").symlink_to(outside / "flightarchive" / "log")

    before, stamp = target_file.read_bytes(), target_file.stat().st_mtime_ns
    client = TestClient(create_app(resource_root=resources, data_root=data))
    with client:
        response = client.get("/api/tasks")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid-legacy-task-log"
    assert target_file.read_bytes() == before and target_file.stat().st_mtime_ns == stamp


def test_status_adds_archive_state_and_activity_revision(tmp_path):
    client, data = _client(tmp_path)
    with client:
        initial = client.get("/api/status").json()["status"]
        assert initial["archiveState"] == "missing"
        assert initial["activityRevision"] is None
        root = _make_v2(data)
        for name in ARCHIVE_DOCUMENT_IDS:
            (root / name).write_text("null", encoding="utf-8")
        assert client.get("/api/status").json()["status"]["archiveState"] == "ready"
        (root / "manifest.json").write_text("NaN", encoding="utf-8")
        assert client.get("/api/status").json()["status"]["archiveState"] == "migration-failed"
