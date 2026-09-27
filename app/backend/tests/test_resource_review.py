from __future__ import annotations

import json

from fastapi.testclient import TestClient

from flightarchive.server import create_app


def _app(tmp_path, files: dict[str, bytes] | None = None):
    root, data = tmp_path / "resources", tmp_path / "data"
    root.mkdir()
    data.mkdir()
    for path, content in (files or {}).items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    return create_app(resource_root=root, data_root=data), root, data


def _put_mapping(client: TestClient, entries: list[dict[str, object]]) -> None:
    current = client.get("/api/v1/meta/map")
    document = current.json()
    document["entries"] = entries
    response = client.put(
        "/api/v1/meta/map",
        json=document,
        headers={"If-Match": current.headers["etag"]},
    )
    assert response.status_code == 200


def _rows(snapshot: dict[str, object]) -> dict[str | None, dict[str, object]]:
    return {row["virtualPath"]: row for row in snapshot["rows"]}


def test_review_is_an_authoritative_read_only_join_with_uses_and_capabilities(tmp_path, monkeypatch):
    application, root, data = _app(
        tmp_path,
        {
            "front.png": b"front",
            "free.png": b"free",
            "candidate.png": b"candidate",
            "ignored.png": b"ignored",
            "local-only.bin": b"local-only",
        },
    )
    with TestClient(application) as client:
        _put_mapping(client, [
            {"virtual_path": "objects/front.png", "local_path": "front.png", "sha256": "abc", "md5": "def", "size_bytes": 999},
            {"virtual_path": "objects/free.png", "local_path": "free.png"},
            {"virtual_path": "objects/missing.png", "local_path": "gone.png", "sha256": "stale", "size_bytes": 17},
            {"virtual_path": "inbox/candidate.png", "local_path": "candidate.png"},
            {"virtual_path": "ignore/ignored.png", "local_path": "ignored.png"},
            {"virtual_path": "ignore/ignored-gone.png", "local_path": "ignored-gone.png"},
        ])
        flight = client.post("/api/flights", json={
            "flightNumber": "1", "airlineCode": "CA", "departureAirport": "PEK",
            "arrivalAirport": "SHA", "departureDate": "2026-01-01",
            "paperBoardingPassFrontResourcePath": "objects/front.png",
            "attachmentResourcePaths": ["objects/front.png", "objects/missing.png"],
        })
        assert flight.status_code == 201
        flight_id = flight.json()["flight"]["id"]
        airline = client.put("/api/catalogs/airlines/CA", json={
            "horizontalLogoResourcePath": "objects/front.png",
        })
        assert airline.status_code == 200

        lifecycle = application.state.resource_lifecycle
        original_request = lifecycle._request
        writes: list[str] = []

        async def observe(method, path, **kwargs):
            if method == "PUT":
                writes.append(path)
            return await original_request(method, path, **kwargs)

        monkeypatch.setattr(lifecycle, "_request", observe)
        mapping_before = json.loads(json.dumps(client.get("/api/v1/meta/map").json()))
        business_before = (data / "flightarchive" / "v1" / "business-data.json").read_bytes()
        response = client.get("/api/resources/review")
        assert response.status_code == 200
        snapshot = response.json()
        assert snapshot["revision"] == client.get("/api/v1/meta/map").headers["etag"]
        rows = _rows(snapshot)

        front = rows["objects/front.png"]
        assert front == {
            "virtualPath": "objects/front.png", "localPath": "front.png", "state": "mapped",
            "present": True, "sizeBytes": 5, "fingerprints": ["md5", "sha256"],
            "uses": [
                {"kind": "flight", "id": flight_id, "airlineCode": "CA", "flightNumber": "1", "departureDate": "2026-01-01", "role": "paperBoardingPassFront"},
                {"kind": "flight", "id": flight_id, "airlineCode": "CA", "flightNumber": "1", "departureDate": "2026-01-01", "role": "attachment"},
                {"kind": "airline", "code": "CA", "role": "horizontal"},
            ],
            "capabilities": {"ignore": False, "unignore": False, "release": False, "fingerprint": True, "rematchTarget": False, "rematchCandidate": False},
        }
        assert rows["objects/free.png"]["capabilities"] == {
            "ignore": False, "unignore": False, "release": True, "fingerprint": False,
            "rematchTarget": False, "rematchCandidate": False,
        }
        assert rows["objects/missing.png"]["state"] == "missing"
        assert rows["objects/missing.png"]["present"] is False
        assert rows["objects/missing.png"]["sizeBytes"] == 17
        assert rows["objects/missing.png"]["capabilities"] == {
            "ignore": False, "unignore": False, "release": False, "fingerprint": False,
            "rematchTarget": True, "rematchCandidate": False,
        }
        assert rows["inbox/candidate.png"]["state"] == "pending"
        assert rows["inbox/candidate.png"]["capabilities"] == {
            "ignore": True, "unignore": False, "release": False, "fingerprint": False,
            "rematchTarget": False, "rematchCandidate": True,
        }
        assert rows["ignore/ignored.png"]["state"] == "ignored"
        assert rows["ignore/ignored.png"]["capabilities"] == {
            "ignore": False, "unignore": True, "release": False, "fingerprint": False,
            "rematchTarget": False, "rematchCandidate": False,
        }
        assert rows["ignore/ignored-gone.png"]["state"] == "ignored"
        assert rows["ignore/ignored-gone.png"]["present"] is False
        assert rows["ignore/ignored-gone.png"]["capabilities"]["unignore"] is False
        local_only = rows[None]
        assert local_only["localPath"] == "local-only.bin"
        assert local_only["state"] == "local_only" and local_only["present"] is True
        assert not any(local_only["capabilities"].values())

        assert writes == []
        assert client.get("/api/v1/meta/map").json() == mapping_before
        assert (data / "flightarchive" / "v1" / "business-data.json").read_bytes() == business_before


def test_review_handles_empty_data_and_reconcile_returns_the_same_snapshot_shape(tmp_path):
    application, root, _ = _app(tmp_path)
    with TestClient(application) as client:
        empty = client.get("/api/resources/review")
        assert empty.status_code == 200
        assert empty.json()["rows"] == []
        assert isinstance(empty.json()["revision"], str)

        (root / "new.bin").write_bytes(b"new")
        reconciled = client.post("/api/resources/reconcile")
        assert reconciled.status_code == 200
        assert set(reconciled.json()) == {"revision", "rows"}
        assert reconciled.json() == client.get("/api/resources/review").json()
        assert reconciled.json()["rows"][0]["state"] == "pending"
        assert client.post("/api/resources/sync").status_code == 404


def test_reconcile_removes_stale_temporary_entries_but_keeps_missing_objects(tmp_path):
    application, root, _ = _app(tmp_path, {"pending.png": b"pending", "ignored.png": b"ignored"})
    with TestClient(application) as client:
        reconciled = client.post("/api/resources/reconcile").json()
        pending = next(row for row in reconciled["rows"] if row["localPath"] == "pending.png")
        ignored_source = next(row for row in reconciled["rows"] if row["localPath"] == "ignored.png")
        ignored = client.post("/api/resources/ignore", json={
            "ifMatch": reconciled["revision"], "virtualPaths": [ignored_source["virtualPath"]],
        })
        assert ignored.status_code == 200
        meta = client.get("/api/v1/meta/map")
        document = meta.json()
        next(entry for entry in document["entries"] if entry["virtual_path"] == pending["virtualPath"])["virtual_path"] = "objects/missing.png"
        assert client.put("/api/v1/meta/map", json=document, headers={"If-Match": meta.headers["etag"]}).status_code == 200
        (root / "pending.png").unlink()
        (root / "ignored.png").unlink()

        snapshot = client.post("/api/resources/reconcile").json()
        assert [(row["virtualPath"], row["state"], row["present"]) for row in snapshot["rows"]] == [
            ("objects/missing.png", "missing", False),
        ]
