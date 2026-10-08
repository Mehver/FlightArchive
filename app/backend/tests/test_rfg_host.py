# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from flightarchive.archive import ARCHIVE_DOCUMENT_IDS
from flightarchive.server import create_app


def _app(tmp_path, *, static=False):
    resources, runtime = tmp_path / "resources", tmp_path / "runtime"
    resources.mkdir()
    runtime.mkdir()
    (resources / "ticket.txt").write_bytes(b"ticket")
    frontend = None
    if static:
        frontend = tmp_path / "frontend"
        frontend.mkdir()
        (frontend / "index.html").write_text("<html>FlightArchive</html>", encoding="utf-8")
        (frontend / "asset.txt").write_text("asset", encoding="utf-8")
    return create_app(resource_root=resources, data_root=runtime, static_dir=frontend, cache_dir=tmp_path / "cache"), runtime


def test_final_http_boundary_and_domain_neutral_status(tmp_path):
    application, runtime = _app(tmp_path)
    archive = runtime / "flightarchive" / "v2"
    archive.mkdir(parents=True)
    for name in ARCHIVE_DOCUMENT_IDS:
        (archive / name).write_text("null", encoding="utf-8")

    retired = (
        "/api/flights", "/api/catalogs", "/api/workspace/reset", "/api/resources/review",
        "/api/images/anything.png", "/api/flights/id/boarding-passes/front/preview",
    )
    with TestClient(application) as client:
        assert client.get("/api/healthz").json() == {"ok": True}
        status = client.get("/api/status").json()
        assert status == {"status": {
            "persistence": {"mode": "named-json-documents", "writable": True, "persistenceError": None},
            "archiveState": "ready", "activityRevision": None,
        }}
        assert "counts" not in json.dumps(status) and "schemaVersion" not in json.dumps(status)
        for path in retired:
            assert client.get(path).status_code == 404, path

    assert set(application.state._state) == {"archive_store", "activity_log", "legacy_task_reader", "thumbnail_service"}


def test_rfg_child_lifespan_public_http_and_spa_order(tmp_path):
    application, _ = _app(tmp_path, static=True)
    with TestClient(application) as client:
        catalog = client.get("/api/v1/meta/local")
        assert catalog.status_code == 200
        assert [item["local_path"] for item in catalog.json()["local_files"]] == ["ticket.txt"]

        mapping = {"entries": [{"virtual_path": "documents/ticket.txt", "local_path": "ticket.txt"}]}
        stored = client.put("/api/v1/meta/map", json=mapping)
        assert stored.status_code == 200
        assert client.get("/api/v1/meta/map").json() == mapping
        hashed = client.post("/api/v1/hashes", json={"local_path": "ticket.txt", "algorithm": "sha256"})
        assert hashed.status_code == 200
        assert hashed.json()["status"] == "succeeded"
        assert client.get("/res/documents/ticket.txt").content == b"ticket"

        unknown = client.post("/api/not-a-flightarchive-route")
        assert unknown.status_code == 404
        assert unknown.json()["error"]["code"] == "not-found"
        assert client.get("/asset.txt").text == "asset"
        assert client.get("/client/route").text == "<html>FlightArchive</html>"


def test_runtime_never_reads_or_writes_legacy_v1(tmp_path):
    application, runtime = _app(tmp_path)
    legacy = runtime / "flightarchive" / "v1" / "business-data.json"
    legacy.parent.mkdir(parents=True)
    legacy.write_bytes(b"sentinel-not-json")
    before = (legacy.read_bytes(), legacy.stat().st_mtime_ns)
    with TestClient(application) as client:
        assert client.get("/api/status").status_code == 200
        assert client.get("/api/archive/flightarchive").status_code == 200
    assert (legacy.read_bytes(), legacy.stat().st_mtime_ns) == before


def test_tasks_is_the_only_read_only_legacy_task_http_surface(tmp_path):
    application, runtime = _app(tmp_path)
    log = runtime / "flightarchive" / "log" / "task"
    log.mkdir(parents=True)
    record = {
        "taskId": "legacy-one", "kind": "fingerprints", "seq": 1,
        "logDay": "2026-09-24", "createdAt": "2026-09-24T12:00:00+00:00",
        "state": "succeeded", "items": [], "progress": {},
    }
    path = log / "2026-09-24.jsonl"
    path.write_text(json.dumps(record) + "\n", encoding="utf-8")
    before = (path.read_bytes(), path.stat().st_mtime_ns)
    with TestClient(application) as client:
        assert client.get("/api/tasks").json()["days"][0]["tasks"][0]["id"] == "legacy-one"
        assert client.get("/api/activity/legacy-tasks").status_code == 404
        assert client.post("/api/tasks", json={}).status_code == 404
    assert (path.read_bytes(), path.stat().st_mtime_ns) == before
