# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

from __future__ import annotations

import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient
from flightarchive.business_data import BusinessDataError, make_business_data, parse_business_data, write_business_data_atomic
from flightarchive.domain.models import Airline
from flightarchive.domain.seed import DEFAULT_AIRCRAFT_TYPES, DEFAULT_AIRLINES, DEFAULT_AIRPORTS
from flightarchive.server import create_app


def app(tmp_path):
    root, data = tmp_path / "resources", tmp_path / "data"
    root.mkdir(); data.mkdir()
    (root / "ticket.png").write_bytes(b"ticket")
    return create_app(resource_root=root, data_root=data), data


def _tasks(client):
    return [task for day in client.get("/api/tasks").json()["days"] for task in day["tasks"]]


def _await_task(client: TestClient, task_id: str, expected_state: str = "succeeded", timeout: float = 2):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = next((task for task in _tasks(client) if task["id"] == task_id), None)
        if last is not None and last["state"] in {"succeeded", "failed"}:
            assert last["state"] == expected_state, last
            return last
        time.sleep(0.01)
    raise AssertionError(f"task {task_id} did not succeed before timeout; last={last!r}")


def test_retired_flight_status_is_rejected_from_business_data():
    """BusinessData no longer silently accepts the retired status field."""
    legacy = {
        "id": "legacy-flight",
        "flightNumber": "1",
        "airlineCode": "CA",
        "departureAirport": "PEK",
        "arrivalAirport": "SHA",
        "departureDate": "2026-01-01",
        "status": "cancelled",
    }

    with pytest.raises(BusinessDataError, match="status"):
        parse_business_data({
            "schemaVersion": 1,
            "airlines": [], "airports": [], "aircraftTypes": [],
            "flights": [legacy], "settings": {},
        })


def test_host_owns_business_routes_and_rfg_is_the_final_fallback(tmp_path):
    """The mounted RFG app serves only its explicit API/resource surface."""
    root, data, static = tmp_path / "resources", tmp_path / "data", tmp_path / "frontend"
    root.mkdir(); data.mkdir(); static.mkdir()
    (root / "ticket.png").write_bytes(b"ticket")
    (static / "index.html").write_text("<html>FlightArchive</html>", encoding="utf-8")
    (static / "asset.txt").write_text("asset", encoding="utf-8")
    application = create_app(resource_root=root, data_root=data, static_dir=static)
    payload = {
        "flightNumber": "1",
        "airlineCode": "CA",
        "departureAirport": "PEK",
        "arrivalAirport": "SHA",
        "departureDate": "2026-01-01",
    }
    with TestClient(application) as client:
        created = client.post("/api/flights", json=payload)
        assert created.status_code == 201
        assert created.json()["flight"]["flightNumber"] == "1"
        assert client.post("/api/resources/reconcile").status_code == 200
        assert client.get("/api/v1/meta/map").status_code == 200
        unknown = client.post("/api/not-a-flightarchive-route")
        assert unknown.status_code == 404
        assert unknown.json() == {"error": {"code": "not-found", "message": "unknown API path /api/not-a-flightarchive-route"}}
        assert client.get("/asset.txt").text == "asset"
        assert client.get("/client/route").text == "<html>FlightArchive</html>"


def test_task_history_http_cursor_uses_existing_log_days(tmp_path):
    application, data = app(tmp_path)
    log_dir = data / "flightarchive" / "log" / "task"
    for day in ("2026-09-20", "2026-09-22", "2026-09-23", "2026-09-24"):
        record = {
            "schemaVersion": 1, "taskId": f"task-{day}", "kind": "fingerprints",
            "recordType": "status", "seq": 1, "occurredAt": f"{day}T12:00:00+00:00",
            "logDay": day, "state": "succeeded", "createdAt": f"{day}T12:00:00+00:00",
            "startedAt": f"{day}T12:00:00+00:00", "finishedAt": f"{day}T12:00:00+00:00",
            "progress": {"total": 0, "completed": 0, "succeeded": 0, "failed": 0}, "items": [],
        }
        (log_dir / f"{day}.jsonl").write_text(json.dumps(record) + "\n", encoding="utf-8")
    with (log_dir / "2026-09-24.jsonl").open("a", encoding="utf-8") as stream:
        stream.write('{"taskId":"incomplete"')
    with TestClient(application) as client:
        recent_response = client.get("/api/tasks")
        assert recent_response.status_code == 200
        recent = recent_response.json()
        assert [entry["date"] for entry in recent["days"]] == ["2026-09-24", "2026-09-23", "2026-09-22"]
        assert [[task["id"] for task in entry["tasks"]] for entry in recent["days"]] == [
            ["task-2026-09-24"], ["task-2026-09-23"], ["task-2026-09-22"],
        ]
        assert recent["nextCursor"] == "2026-09-22" and recent["hasMore"] is True
        older_response = client.get("/api/tasks", params={"before": "2026-09-22", "limitDays": 2})
        assert older_response.status_code == 200
        older = older_response.json()
        assert [entry["date"] for entry in older["days"]] == ["2026-09-20"]
        assert older["nextCursor"] is None and older["hasMore"] is False
        assert client.get("/api/tasks", params={"limitDays": 31}).status_code == 400


def test_workspace_routes_and_v1_persistence_contract(tmp_path):
    application, data = app(tmp_path)
    with TestClient(application) as client:
        status = client.get("/api/status")
        assert status.status_code == 200
        assert set(status.json()) == {"status"}
        assert "version" not in status.json() and "version" not in status.json()["status"]
        assert status.json()["status"]["counts"] == {
            "flights": 0,
            "airlines": len(DEFAULT_AIRLINES),
            "airports": len(DEFAULT_AIRPORTS),
            "aircraftTypes": len(DEFAULT_AIRCRAFT_TYPES),
        }
        assert set(status.json()["status"]["persistence"]) == {
            "mode", "schemaVersion", "writable", "loaded", "persistenceError",
        }
        health = client.get("/api/healthz")
        assert health.status_code == 200
        assert health.json() == {"ok": True}
        for retired in ("/api/health", "/api/workspace/status", "/api/version"):
            response = client.get(retired)
            assert response.status_code == 404
            assert response.json()["error"]["code"] == "not-found"
        created = client.post("/api/flights", json={"flightNumber": "1", "airlineCode": "CA", "departureAirport": "PEK", "arrivalAirport": "SHA", "departureDate": "2026-01-01"})
        assert created.status_code == 201
    persisted = json.loads((data / "flightarchive" / "v1" / "business-data.json").read_text(encoding="utf-8"))
    assert persisted["schemaVersion"] == 1 and "assetTags" not in persisted and len(persisted["flights"]) == 1
    assert "status" not in persisted["flights"][0]
    reloaded = create_app(resource_root=tmp_path / "resources", data_root=data)
    with TestClient(reloaded) as client: assert len(client.get("/api/flights").json()["flights"]) == 1


def test_fresh_workspace_persists_default_seed_catalogs_before_any_mutation(tmp_path):
    """An empty data directory seeds and persists the default catalogs on startup."""
    root, data = tmp_path / "resources", tmp_path / "data"
    root.mkdir(); data.mkdir()
    create_app(resource_root=root, data_root=data)
    persisted = json.loads((data / "flightarchive" / "v1" / "business-data.json").read_text(encoding="utf-8"))
    assert persisted["schemaVersion"] == 1
    assert len(persisted["airlines"]) == len(DEFAULT_AIRLINES)
    assert len(persisted["airports"]) == len(DEFAULT_AIRPORTS)
    assert len(persisted["aircraftTypes"]) == len(DEFAULT_AIRCRAFT_TYPES)
    assert persisted["flights"] == []
    assert (data / "flightarchive" / "v1" / "preview-config.json").is_file()


def test_default_aircraft_seed_includes_the_requested_fairchild_types(tmp_path):
    aircraft = {entry["icao"]: entry for entry in DEFAULT_AIRCRAFT_TYPES}
    assert aircraft["J328"] == {
        "icao": "J328", "iata": "FRJ", "manufacturer": "Fairchild (仙童) US", "displayName": "Dornier 328 JET",
    }
    assert aircraft["SW4"] == {
        "icao": "SW4", "iata": "SW4", "manufacturer": "Fairchild (仙童) US", "displayName": "Swearingen Metro 23",
    }


def test_fresh_workspace_uses_curated_legacy_airline_catalog_data(tmp_path):
    application, _ = app(tmp_path)
    with TestClient(application) as client:
        airlines = {airline["code"]: airline for airline in client.get("/api/catalogs").json()["airlines"]}

    # Legacy catalog values override the earlier generic defaults, while
    # existing product catalog entries not present in that catalog remain.
    assert {"AC", "AF", "CA", "CI", "CX", "CZ", "DL", "EY", "GK", "HU", "HX", "KE", "KG", "KL", "KN", "LH", "MU", "PR", "SQ", "UA", "UO", "YP", "ZH"} <= airlines.keys()
    assert airlines["MU"]["brandColors"] == {"primary": "#D70819", "contrast": "#0B3393"}
    assert airlines["CI"]["nameEn"] == "China Airlines"
    assert airlines["BA"]["nameEn"] == "British Airways"
    assert airlines["KG"] == {
        "code": "KG",
        "icao": "LYM",
        "nameZh": "青柠航空",
        "nameEn": "Key Lime / DAC",
        "alliance": None,
        "horizontalLogoResourcePath": None,
        "horizontalDarkLogoResourcePath": None,
        "symbolLogoResourcePath": None,
        "brandColors": {"primary": "#00BE49", "contrast": "#001146"},
    }
    for field in ("horizontalLogoResourcePath", "horizontalDarkLogoResourcePath", "symbolLogoResourcePath"):
        assert airlines["CI"][field] is None


def test_airline_brand_colors_are_nested_ordered_and_have_defaults(tmp_path):
    airline = Airline.from_dict({"code": "ZZ", "nameEn": "Zulu Air"})
    assert airline.to_dict()["brandColors"] == {"primary": None, "contrast": None}
    path = tmp_path / "business-data.json"
    write_business_data_atomic(path, make_business_data({"airlines": [airline.to_dict()]}))
    text = path.read_text(encoding="utf-8")
    assert text.index('"brandColors"') < text.index('"primary"') < text.index('"contrast"')
    with pytest.raises(BusinessDataError, match="primaryBrandColor"):
        parse_business_data({
            "schemaVersion": 1, "airlines": [{"code": "ZZ", "primaryBrandColor": "#FFFFFF"}],
            "airports": [], "aircraftTypes": [], "flights": [], "settings": {},
        })


def test_airline_brand_colors_api_uses_the_nested_contract(tmp_path):
    application, _ = app(tmp_path)
    with TestClient(application) as client:
        created = client.put("/api/catalogs/airlines/ZZ", json={
            "nameEn": "Zulu Air",
            "brandColors": {"primary": "#010203", "contrast": None},
        })
        assert created.status_code == 200
        assert created.json()["entry"]["brandColors"] == {"primary": "#010203", "contrast": None}
        legacy = client.put("/api/catalogs/airlines/ZY", json={
            "nameEn": "Legacy Air", "primaryBrandColor": "#010203",
        })
        assert legacy.status_code == 422


def test_flight_number_is_a_numeric_suffix_and_searches_as_a_full_flight_code(tmp_path):
    application, _ = app(tmp_path)
    payload = {"flightNumber": "0123", "airlineCode": "CA", "departureAirport": "PEK", "arrivalAirport": "SHA", "departureDate": "2026-01-01"}
    with TestClient(application) as client:
        created = client.post("/api/flights", json=payload)
        assert created.status_code == 201
        assert created.json()["flight"]["flightNumber"] == "0123"
        assert len(client.get("/api/flights?q=CA0123").json()["flights"]) == 1
        assert client.post("/api/flights", json={**payload, "flightNumber": "CA123"}).status_code == 422
        assert client.post("/api/flights", json={**payload, "flightNumber": "12345"}).status_code == 422


def test_flight_submission_materializes_pending_resources_only_after_form_validation(tmp_path):
    application, _ = app(tmp_path)
    with TestClient(application) as client:
        assert len(client.post("/api/resources/reconcile").json()["rows"]) == 1
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]

        # A draft may select an inbox resource before any flight fields are
        # filled. Failed submission leaves the RFG mapping untouched.
        invalid = client.post("/api/flights", json={"paperBoardingPassFrontResourcePath": inbox})
        assert invalid.status_code == 422
        assert client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"] == inbox

        saved = client.post(
            "/api/flights",
            json={
                "flightNumber": "1",
                "airlineCode": "CA",
                "departureAirport": "PEK",
                "arrivalAirport": "SHA",
                "departureDate": "2026-01-01",
                "paperBoardingPassFrontResourcePath": inbox,
            },
        )
        assert saved.status_code == 201
        path = saved.json()["flight"]["paperBoardingPassFrontResourcePath"]
        assert path == "20260101ca0001a0.png"
        assert client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"] == path


def test_flight_update_materializes_pending_resources_after_merging_the_form(tmp_path):
    application, _ = app(tmp_path)
    with TestClient(application) as client:
        created = client.post(
            "/api/flights",
            json={
                "flightNumber": "1",
                "airlineCode": "CA",
                "departureAirport": "PEK",
                "arrivalAirport": "SHA",
                "departureDate": "2026-01-01",
            },
        ).json()["flight"]
        assert len(client.post("/api/resources/reconcile").json()["rows"]) == 1
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]

        updated = client.put(
            f"/api/flights/{created['id']}", json={"paperBoardingPassFrontResourcePath": inbox}
        )
        assert updated.status_code == 200
        assert updated.json()["flight"]["paperBoardingPassFrontResourcePath"] == "20260101ca0001a0.png"


def test_airline_submission_materializes_pending_logo_only_after_form_validation(tmp_path):
    application, _ = app(tmp_path)
    with TestClient(application) as client:
        assert len(client.post("/api/resources/reconcile").json()["rows"]) == 1
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]

        invalid = client.put("/api/catalogs/airlines/ZZ", json={"horizontalLogoResourcePath": inbox})
        assert invalid.status_code == 422
        assert client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"] == inbox

        saved = client.put(
            "/api/catalogs/airlines/CA",
            json={"nameEn": "Air China", "horizontalLogoResourcePath": inbox},
        )
        assert saved.status_code == 200
        path = saved.json()["entry"]["horizontalLogoResourcePath"]
        assert path == "ca-horizontal.png"
        assert client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"] == path


def test_new_image_fingerprints_are_queued_as_a_background_task(tmp_path):
    application, _ = app(tmp_path)
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]
        created = client.post(
            "/api/flights",
            json={"flightNumber": "1", "airlineCode": "CA", "departureAirport": "PEK", "arrivalAirport": "SHA", "departureDate": "2026-01-01", "paperBoardingPassFrontResourcePath": inbox},
        )
        assert created.status_code == 201
        path = created.json()["flight"]["paperBoardingPassFrontResourcePath"]
        # The fixture is deliberately arbitrary bytes rather than a decodable
        # image: content hashes succeed and the three perceptual hashes fail.
        task = _await_task(client, _tasks(client)[0]["id"], expected_state="failed")
        assert task["total"] == 6 and task["completed"] == 6
        assert {item["virtualPath"] for item in task["items"]} == {path}
        assert {item["algorithm"] for item in task["items"] if item["state"] == "succeeded"} == {"crc32", "md5", "sha256"}
        assert {item["algorithm"] for item in task["items"] if item["state"] == "failed"} == {"ahash", "dhash", "phash"}


def test_resource_rematch_explicit_preserves_target_and_returns_compact_result(tmp_path):
    application, _ = app(tmp_path)
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        mapping = client.get("/api/v1/meta/map")
        document = mapping.json()
        document["entries"][0]["virtual_path"] = "old/missing.png"
        assert client.put("/api/v1/meta/map", json=document, headers={"If-Match": mapping.headers["etag"]}).status_code == 200
        (tmp_path / "resources" / "ticket.png").unlink()
        (tmp_path / "resources" / "replacement.png").write_bytes(b"replacement")
        client.post("/api/resources/reconcile")
        candidate = next(x["virtual_path"] for x in client.get("/api/v1/meta/map").json()["entries"] if x["virtual_path"].startswith("inbox/"))
        etag = client.get("/api/v1/meta/map").headers["etag"]
        response = client.post("/api/resources/rematch", json={"ifMatch": etag, "mode": "explicit", "matches": [{"targetVirtualPath": "old/missing.png", "candidateInboxVirtualPath": candidate}]})
        assert response.status_code == 200
        assert response.json() == {"applied": 1, "ambiguous": [], "unmatched": [], "revision": response.json()["revision"]}
        assert isinstance(response.json()["revision"], str)
        entries = client.get("/api/v1/meta/map").json()["entries"]
        assert entries == [{"virtual_path": "old/missing.png", "local_path": "replacement.png", "size_bytes": 11}]


def test_resource_rematches_reject_non_inbox_candidate(tmp_path):
    application, _ = app(tmp_path)
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        mapping = client.get("/api/v1/meta/map")
        document = mapping.json()
        document["entries"][0]["virtual_path"] = "old/missing.png"
        assert client.put("/api/v1/meta/map", json=document, headers={"If-Match": mapping.headers["etag"]}).status_code == 200
        (tmp_path / "resources" / "ticket.png").unlink()
        (tmp_path / "resources" / "replacement.png").write_bytes(b"replacement")
        client.post("/api/resources/reconcile")
        etag = client.get("/api/v1/meta/map").headers["etag"]
        response = client.post("/api/resources/rematch", json={"ifMatch": etag, "mode": "explicit", "matches": [{"targetVirtualPath": "old/missing.png", "candidateInboxVirtualPath": "old/missing.png"}]})
        assert response.status_code == 422


def test_resource_rematches_reject_invalid_duplicate_and_stale_requests(tmp_path):
    application, _ = app(tmp_path)
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]
        etag = client.get("/api/v1/meta/map").headers["etag"]
        before = client.get("/api/v1/meta/map").json()
        cases = [
            ({"ifMatch": etag, "mode": "explicit", "matches": [{"targetVirtualPath": "missing/path", "candidateInboxVirtualPath": inbox}]}, 404),
            ({"ifMatch": etag, "mode": "explicit", "matches": [{"targetVirtualPath": inbox, "candidateInboxVirtualPath": inbox}]}, 422),
            ({"ifMatch": etag, "mode": "explicit", "matches": [{"targetVirtualPath": "a", "candidateInboxVirtualPath": inbox}, {"targetVirtualPath": "a", "candidateInboxVirtualPath": "other"}]}, 422),
            ({"ifMatch": etag, "mode": "explicit", "matches": [{"targetVirtualPath": "a", "candidateInboxVirtualPath": inbox}, {"targetVirtualPath": "b", "candidateInboxVirtualPath": inbox}]}, 422),
            ({"ifMatch": etag, "mode": "explicit", "matches": [], "algorithms": ["sha256"]}, 422),
            ({"ifMatch": etag, "mode": "auto", "matches": []}, 422),
            ({"ifMatch": etag, "mode": "explicit"}, 422),
            ({"ifMatch": etag, "mode": "unknown", "matches": []}, 422),
            ({"ifMatch": '"stale"', "mode": "explicit", "matches": [{"targetVirtualPath": "missing/path", "candidateInboxVirtualPath": inbox}]}, 409),
        ]
        for payload, expected_status in cases:
            response = client.post("/api/resources/rematch", json=payload)
            assert response.status_code == expected_status, (payload, response.text)
            assert response.json()["error"]["code"] in {"validation", "resource-not-found", "resource-conflict"}
            assert client.get("/api/v1/meta/map").json() == before


def test_fingerprints_are_authoritative_for_direct_flight_resources(tmp_path):
    application, _ = app(tmp_path)
    (tmp_path / "resources" / "ticket.png").rename(tmp_path / "resources" / "ticket.bin")
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]
        # Pending resources are rejected before the RFG hash endpoint is used.
        lifecycle = application.state.resource_lifecycle
        calls: list[str] = []
        original_hash = lifecycle.compute_rfg_hash
        async def observed_hash(local_path, algorithm):
            calls.append(local_path)
            return await original_hash(local_path, algorithm)
        lifecycle.compute_rfg_hash = observed_hash
        etag = client.get("/api/v1/meta/map").headers["etag"]
        assert client.post("/api/resources/fingerprints", json={"ifMatch": etag, "virtualPaths": [inbox], "algorithms": ["sha256"]}).status_code == 422
        assert calls == []

        created = client.post("/api/flights", json={"flightNumber": "1", "airlineCode": "CA", "departureAirport": "PEK", "arrivalAirport": "SHA", "departureDate": "2026-01-01", "paperBoardingPassFrontResourcePath": inbox})
        assert created.status_code == 201
        path = created.json()["flight"]["paperBoardingPassFrontResourcePath"]
        assert _tasks(client) == []
        etag = client.get("/api/v1/meta/map").headers["etag"]
        response = client.post("/api/resources/fingerprints", json={"ifMatch": etag, "virtualPaths": [path], "algorithms": ["crc32", "sha256"]})
        assert response.status_code == 202
        task_id = response.json()["task"]["id"]
        assert response.json()["task"]["total"] == 2
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            task = next(item for item in _tasks(client) if item["id"] == task_id)
            if task["state"] in {"succeeded", "failed"}: break
            time.sleep(0.01)
        assert task["state"] == "succeeded" and all(item["state"] == "succeeded" for item in task["items"])
        entry = next(item for item in client.get("/api/v1/meta/map").json()["entries"] if item["virtual_path"] == path)
        assert entry["crc32"] and entry["sha256"]
        assert entry["size_bytes"] == len(b"ticket")
        assert client.post("/api/resources/fingerprints", json={"ifMatch": etag, "virtualPaths": [path], "algorithms": ["md5"]}).status_code == 409


def test_fingerprints_include_airline_logo_and_reject_invalid_body(tmp_path):
    application, _ = app(tmp_path)
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]
        saved = client.put("/api/catalogs/airlines/CA", json={"nameEn": "Air China", "horizontalLogoResourcePath": inbox})
        assert saved.status_code == 200
        logo = saved.json()["entry"]["horizontalLogoResourcePath"]
        etag = client.get("/api/v1/meta/map").headers["etag"]
        response = client.post("/api/resources/fingerprints", json={"ifMatch": etag, "virtualPaths": [logo], "algorithms": ["sha256"]})
        assert response.status_code == 202 and response.json()["task"]["total"] == 1
        assert client.post("/api/resources/fingerprints", json={"virtualPaths": [logo, logo], "algorithms": ["sha256"], "localPath": "ticket.png"}).status_code == 422


def test_svg_automatic_fingerprints_exclude_perceptual_hashes(tmp_path):
    application, _ = app(tmp_path)
    root = tmp_path / "resources"
    (root / "ticket.png").unlink()
    (root / "logo.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>", encoding="utf-8")
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]
        saved = client.put("/api/catalogs/airlines/CA", json={"nameEn": "Air China", "symbolLogoResourcePath": inbox})
        assert saved.status_code == 200
        logo = saved.json()["entry"]["symbolLogoResourcePath"]
        tasks = _tasks(client)
        assert {item["algorithm"] for item in tasks[0]["items"]} == {"crc32", "md5", "sha256"}
        etag = client.get("/api/v1/meta/map").headers["etag"]
        assert client.post("/api/resources/fingerprints", json={"ifMatch": etag, "virtualPaths": [logo], "algorithms": ["phash"]}).status_code == 422


def test_ignore_renames_present_inbox_without_business_mutation_and_reconcile_expires_it(tmp_path):
    application, _ = app(tmp_path)
    root = tmp_path / "resources"
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        meta = client.get("/api/v1/meta/map")
        inbox = meta.json()["entries"][0]["virtual_path"]
        ignored = client.post("/api/resources/ignore", json={"ifMatch": meta.headers["etag"], "virtualPaths": [inbox]})
        assert ignored.status_code == 200
        assert ignored.json()["ignored"] == ["ignore/ticket.png"]
        assert ignored.json()["count"] == 1
        assert isinstance(ignored.json()["revision"], str)
        assert set(ignored.json()) == {"ignored", "count", "revision"}
        assert client.get("/api/flights").json()["flights"] == []
        assert client.post("/api/resources/ignore", json={"ifMatch": '"stale"', "virtualPaths": [inbox]}).status_code == 409
        (root / "ticket.png").unlink()
        sync = client.post("/api/resources/reconcile")
        assert sync.status_code == 200 and sync.json()["rows"] == []
        assert client.get("/api/v1/meta/map").json()["entries"] == []


def test_committed_mapping_refresh_failure_reports_commit_without_rollback(tmp_path, monkeypatch):
    application, _ = app(tmp_path)
    lifecycle = application.state.resource_lifecycle
    original_request = lifecycle._request
    armed = False
    committed = False
    refresh_attempts = 0

    async def fail_reads_after_put(method, path, **kwargs):
        nonlocal committed, refresh_attempts
        if committed and method == "GET" and path == "/api/v1/meta/map":
            refresh_attempts += 1
            return httpx.Response(503)
        response = await original_request(method, path, **kwargs)
        if armed and method == "PUT" and path == "/api/v1/meta/map" and response.status_code == 200:
            committed = True
        return response

    monkeypatch.setattr(lifecycle, "_request", fail_reads_after_put)
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        meta = client.get("/api/v1/meta/map")
        inbox = meta.json()["entries"][0]["virtual_path"]
        armed = True
        response = client.post("/api/resources/ignore", json={"ifMatch": meta.headers["etag"], "virtualPaths": [inbox]})
        assert response.status_code == 503
        assert response.json()["error"] == {
            "code": "resource-committed-refresh-failed",
            "message": "resource operation was committed, but the latest state could not be read; refresh to confirm",
            "details": {"committed": True, "ignored": ["ignore/ticket.png"], "count": 1},
        }
        assert refresh_attempts == 2

        # Restore reads and verify the successful PUT was not rolled back.
        monkeypatch.setattr(lifecycle, "_request", original_request)
        persisted = client.get("/api/v1/meta/map")
        assert persisted.status_code == 200
        assert persisted.json()["entries"][0]["virtual_path"] == "ignore/ticket.png"


@pytest.mark.parametrize("if_match", [None, '"stale"'])
def test_reviewed_mapping_writes_strictly_reject_null_and_stale_etags(tmp_path, if_match):
    application, _ = app(tmp_path)
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]
        requests = [
            ("/api/resources/ignore", {"ifMatch": if_match, "virtualPaths": [inbox]}),
            ("/api/resources/unignore", {"ifMatch": if_match, "virtualPaths": [inbox]}),
            ("/api/resources/release", {"ifMatch": if_match, "virtualPaths": [inbox]}),
            ("/api/resources/rematch", {"ifMatch": if_match, "mode": "explicit", "matches": [{"targetVirtualPath": "missing.png", "candidateInboxVirtualPath": inbox}]}),
            ("/api/resources/rematch", {"ifMatch": if_match, "mode": "auto", "candidateInboxVirtualPaths": [inbox], "algorithms": ["filename"]}),
            ("/api/resources/fingerprints", {"ifMatch": if_match, "virtualPaths": [inbox], "algorithms": ["sha256"]}),
        ]
        for path, payload in requests:
            response = client.post(path, json=payload)
            assert response.status_code == 409, (path, response.text)
            assert response.json()["error"]["code"] == "resource-conflict"


def test_batch_unignore_is_atomic_and_restores_current_ignored_sources(tmp_path):
    application, _ = app(tmp_path)
    root = tmp_path / "resources"
    (root / "second.png").write_bytes(b"second")
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        meta = client.get("/api/v1/meta/map")
        ignored = []
        for entry in meta.json()["entries"]:
            ignored.extend(client.post("/api/resources/ignore", json={"ifMatch": client.get("/api/v1/meta/map").headers["etag"], "virtualPaths": [entry["virtual_path"]]}).json()["ignored"])
        before = client.get("/api/v1/meta/map").json()

        # A missing selection invalidates the whole batch, including valid paths.
        rejected = client.post("/api/resources/unignore", json={"ifMatch": client.get("/api/v1/meta/map").headers["etag"], "virtualPaths": [ignored[0], "ignore/missing.png"]})
        assert rejected.status_code == 404
        assert client.get("/api/v1/meta/map").json() == before
        assert client.post("/api/resources/unignore", json={"ifMatch": '"stale"', "virtualPaths": ignored}).status_code == 409

        restored = client.post("/api/resources/unignore", json={"ifMatch": client.get("/api/v1/meta/map").headers["etag"], "virtualPaths": ignored})
        assert restored.status_code == 200
        assert restored.json()["restored"] == sorted(ignored)
        assert restored.json()["count"] == 2
        assert set(restored.json()) == {"restored", "count", "revision"}
        assert {entry["virtual_path"] for entry in client.get("/api/v1/meta/map").json()["entries"]} == {"inbox/ticket.png", "inbox/second.png"}
        assert (root / "ticket.png").read_bytes() == b"ticket"
        assert (root / "second.png").read_bytes() == b"second"


def test_batch_ignore_is_atomic_and_uses_one_reviewed_etag(tmp_path):
    application, _ = app(tmp_path)
    root = tmp_path / "resources"
    (root / "second.png").write_bytes(b"second")
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        meta = client.get("/api/v1/meta/map")
        paths = [entry["virtual_path"] for entry in meta.json()["entries"]]
        before = meta.json()
        rejected = client.post("/api/resources/ignore", json={"ifMatch": meta.headers["etag"], "virtualPaths": [paths[0], "inbox/missing.png"]})
        assert rejected.status_code == 404
        assert client.get("/api/v1/meta/map").json() == before
        ignored = client.post("/api/resources/ignore", json={"ifMatch": meta.headers["etag"], "virtualPaths": paths})
        assert ignored.status_code == 200 and ignored.json()["count"] == 2
        assert all(path.startswith("ignore/") for path in ignored.json()["ignored"])
        assert set(ignored.json()) == {"ignored", "count", "revision"}


def test_removed_resource_mutation_routes_are_not_available(tmp_path):
    application, _ = app(tmp_path)
    with TestClient(application) as client:
        for path in ("/api/resources/ignore-many", "/api/resources/rematches", "/api/resources/batch-rematches"):
            assert client.post(path, json={}).status_code == 404
        assert client.get("/api/resources/catalog").status_code == 404


def test_batch_unignore_rejects_absent_source_and_inbox_target_collision_without_changes(tmp_path):
    application, _ = app(tmp_path)
    root = tmp_path / "resources"
    (root / "other.png").write_bytes(b"other")
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        meta = client.get("/api/v1/meta/map")
        ticket = next(entry for entry in meta.json()["entries"] if entry["local_path"] == "ticket.png")
        ignored = client.post("/api/resources/ignore", json={"ifMatch": meta.headers["etag"], "virtualPaths": [ticket["virtual_path"]]}).json()["ignored"][0]
        (root / "ticket.png").unlink()
        before = client.get("/api/v1/meta/map").json()
        assert client.post("/api/resources/unignore", json={"ifMatch": client.get("/api/v1/meta/map").headers["etag"], "virtualPaths": [ignored]}).status_code == 422
        assert client.get("/api/v1/meta/map").json() == before

        # Reintroduce the source and make a deliberately conflicting inbox path.
        (root / "ticket.png").write_bytes(b"ticket")
        meta = client.get("/api/v1/meta/map")
        document = meta.json()
        next(entry for entry in document["entries"] if entry["local_path"] == "other.png")["virtual_path"] = "inbox/ticket.png"
        assert client.put("/api/v1/meta/map", json=document, headers={"If-Match": meta.headers["etag"]}).status_code == 200
        before = client.get("/api/v1/meta/map").json()
        assert client.post("/api/resources/unignore", json={"ifMatch": client.get("/api/v1/meta/map").headers["etag"], "virtualPaths": [ignored]}).status_code == 409
        assert client.get("/api/v1/meta/map").json() == before


def test_ignored_mappings_are_temporary_and_rejected_by_stable_object_operations(tmp_path):
    """Ignore remains usable, but cannot cross the temporary/object boundary."""
    application, _ = app(tmp_path)
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        meta = client.get("/api/v1/meta/map")
        inbox = meta.json()["entries"][0]["virtual_path"]
        ignored = client.post("/api/resources/ignore", json={"ifMatch": meta.headers["etag"], "virtualPaths": [inbox]})
        assert ignored.status_code == 200
        ignored_path = ignored.json()["ignored"][0]

        # A temporary mapping cannot become a business relation, release into
        # inbox, or acquire persisted fingerprint metadata.
        flight = {"flightNumber": "1", "airlineCode": "CA", "departureAirport": "PEK", "arrivalAirport": "SHA", "departureDate": "2026-01-01", "paperBoardingPassFrontResourcePath": ignored_path}
        assert client.post("/api/flights", json=flight).status_code == 422
        assert client.get("/api/flights").json()["flights"] == []
        assert client.post("/api/resources/release", json={"ifMatch": ignored.json()["revision"], "virtualPaths": [ignored_path]}).status_code == 422
        etag = client.get("/api/v1/meta/map").headers["etag"]
        assert client.post("/api/resources/fingerprints", json={"ifMatch": etag, "virtualPaths": [ignored_path], "algorithms": ["sha256"]}).status_code == 422


def test_rematch_rejects_ignored_target_and_candidate(tmp_path):
    application, _ = app(tmp_path)
    root = tmp_path / "resources"
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        meta = client.get("/api/v1/meta/map")
        document = meta.json()
        document["entries"][0]["virtual_path"] = "old/missing.png"
        assert client.put("/api/v1/meta/map", json=document, headers={"If-Match": meta.headers["etag"]}).status_code == 200
        (root / "ticket.png").unlink()
        (root / "replacement.png").write_bytes(b"replacement")
        client.post("/api/resources/reconcile")
        meta = client.get("/api/v1/meta/map")
        candidate = next(entry["virtual_path"] for entry in meta.json()["entries"] if entry["virtual_path"].startswith("inbox/"))
        ignored = client.post("/api/resources/ignore", json={"ifMatch": meta.headers["etag"], "virtualPaths": [candidate]}).json()["ignored"][0]
        etag = client.get("/api/v1/meta/map").headers["etag"]
        assert client.post("/api/resources/rematch", json={"ifMatch": etag, "mode": "explicit", "matches": [{"targetVirtualPath": "old/missing.png", "candidateInboxVirtualPath": ignored}]}).status_code == 422

        # The same rule applies to a temporary target, even when its source is missing.
        meta = client.get("/api/v1/meta/map")
        document = meta.json()
        next(entry for entry in document["entries"] if entry["virtual_path"] == "old/missing.png")["virtual_path"] = "ignore/old/missing.png"
        next(entry for entry in document["entries"] if entry["virtual_path"] == ignored)["virtual_path"] = "inbox/replacement.png"
        assert client.put("/api/v1/meta/map", json=document, headers={"If-Match": meta.headers["etag"]}).status_code == 200
        etag = client.get("/api/v1/meta/map").headers["etag"]
        assert client.post("/api/resources/rematch", json={"ifMatch": etag, "mode": "explicit", "matches": [{"targetVirtualPath": "ignore/old/missing.png", "candidateInboxVirtualPath": "inbox/replacement.png"}]}).status_code == 422


def test_reconcile_removes_missing_inbox_but_retains_missing_object_rematch_target(tmp_path):
    application, _ = app(tmp_path)
    root = tmp_path / "resources"
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]
        # Materializing makes the mapping a classified object. A new inbox file
        # gives this reconciliation both transient and persistent missing cases.
        created = client.post("/api/flights", json={"flightNumber": "1", "airlineCode": "CA", "departureAirport": "PEK", "arrivalAirport": "SHA", "departureDate": "2026-01-01", "paperBoardingPassFrontResourcePath": inbox})
        target = created.json()["flight"]["paperBoardingPassFrontResourcePath"]
        (root / "pending.png").write_bytes(b"pending")
        client.post("/api/resources/reconcile")
        assert any(entry["virtual_path"] == "inbox/pending.png" for entry in client.get("/api/v1/meta/map").json()["entries"])
        (root / "ticket.png").unlink(); (root / "pending.png").unlink()
        sync = client.post("/api/resources/reconcile")
        assert sync.status_code == 200
        entries = client.get("/api/v1/meta/map").json()["entries"]
        assert [entry["virtual_path"] for entry in entries] == [target]


def test_batch_rematch_only_applies_a_unique_pending_candidate(tmp_path):
    application, _ = app(tmp_path)
    root = tmp_path / "resources"
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]
        created = client.post("/api/flights", json={"flightNumber": "1", "airlineCode": "CA", "departureAirport": "PEK", "arrivalAirport": "SHA", "departureDate": "2026-01-01", "paperBoardingPassFrontResourcePath": inbox})
        target = created.json()["flight"]["paperBoardingPassFrontResourcePath"]
        fingerprint_etag = client.get("/api/v1/meta/map").headers["etag"]
        queued = client.post("/api/resources/fingerprints", json={"ifMatch": fingerprint_etag, "virtualPaths": [target], "algorithms": ["sha256"]})
        assert queued.status_code == 202
        task_id = queued.json()["task"]["id"]
        _await_task(client, task_id)
        (root / "ticket.png").rename(root / "moved.bin")
        (root / "replacement.png").write_bytes(b"ticket")
        client.post("/api/resources/reconcile")
        meta = client.get("/api/v1/meta/map")
        candidate = next(entry["virtual_path"] for entry in meta.json()["entries"] if entry["local_path"] == "replacement.png")
        task_count = len(_tasks(client))
        response = client.post("/api/resources/rematch", json={"ifMatch": meta.headers["etag"], "mode": "auto", "candidateInboxVirtualPaths": [candidate], "targetVirtualPaths": [target], "algorithms": ["sha256"]})
        assert response.status_code == 200 and response.json()["applied"] == 1
        assert set(response.json()) == {"applied", "ambiguous", "unmatched", "revision"}
        matched = next(entry for entry in client.get("/api/v1/meta/map").json()["entries"] if entry["virtual_path"] == target)
        assert matched["local_path"] == "replacement.png" and matched["sha256"]
        assert len(_tasks(client)) == task_count
        assert client.post("/api/resources/rematch", json={"ifMatch": response.json()["revision"], "mode": "auto", "candidateInboxVirtualPaths": [candidate], "targetVirtualPaths": ["inbox/not-a-target.png"], "algorithms": ["sha256"]}).status_code == 422


@pytest.mark.parametrize("algorithms", [["filename"], ["sizeBytes"]])
def test_batch_rematch_without_content_hash_enqueues_full_fingerprints(tmp_path, monkeypatch, algorithms):
    application, _ = app(tmp_path)
    root = tmp_path / "resources"
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]
        target = client.post("/api/flights", json={"flightNumber": "1", "airlineCode": "CA", "departureAirport": "PEK", "arrivalAirport": "SHA", "departureDate": "2026-01-01", "paperBoardingPassFrontResourcePath": inbox}).json()["flight"]["paperBoardingPassFrontResourcePath"]
        if algorithms == ["sizeBytes"]:
            mapping = client.get("/api/v1/meta/map")
            queued = client.post("/api/resources/fingerprints", json={
                "ifMatch": mapping.headers["etag"], "virtualPaths": [target], "algorithms": ["sha256"],
            })
            _await_task(client, queued.json()["task"]["id"])
        (root / "ticket.png").unlink()
        (root / "nested").mkdir()
        (root / "nested" / "ticket.png").write_bytes(b"newone")
        client.post("/api/resources/reconcile")
        meta = client.get("/api/v1/meta/map")
        candidate = next(entry["virtual_path"] for entry in meta.json()["entries"] if entry["local_path"] == "nested/ticket.png")
        captured = []
        monkeypatch.setattr(application.state.background_tasks, "enqueue_fingerprints", lambda lifecycle, work: captured.append(work))

        response = client.post("/api/resources/rematch", json={
            "ifMatch": meta.headers["etag"], "mode": "auto",
            "candidateInboxVirtualPaths": [candidate], "targetVirtualPaths": [target],
            "algorithms": algorithms,
        })

        assert response.status_code == 200 and response.json()["applied"] == 1
        assert set(response.json()) == {"applied", "ambiguous", "unmatched", "revision"}
        assert captured == [{target: ("crc32", "md5", "sha256", "ahash", "dhash", "phash")}]


def test_auto_rematch_rejects_candidate_replaced_after_hashing(tmp_path, monkeypatch):
    application, _ = app(tmp_path)
    root = tmp_path / "resources"
    lifecycle = application.state.resource_lifecycle
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]
        target = client.post("/api/flights", json={"flightNumber": "1", "airlineCode": "CA", "departureAirport": "PEK", "arrivalAirport": "SHA", "departureDate": "2026-01-01", "paperBoardingPassFrontResourcePath": inbox}).json()["flight"]["paperBoardingPassFrontResourcePath"]
        queued = client.post("/api/resources/fingerprints", json={"ifMatch": client.get("/api/v1/meta/map").headers["etag"], "virtualPaths": [target], "algorithms": ["sha256"]})
        _await_task(client, queued.json()["task"]["id"])
        (root / "ticket.png").rename(root / "moved.bin")
        candidate_source = root / "replacement.png"
        candidate_source.write_bytes(b"ticket")
        client.post("/api/resources/reconcile")
        meta = client.get("/api/v1/meta/map")
        candidate = next(entry["virtual_path"] for entry in meta.json()["entries"] if entry["local_path"] == "replacement.png")
        before = meta.json()
        original_hash = lifecycle.compute_rfg_hash

        async def replace_after_hash(local_path, algorithm):
            result = await original_hash(local_path, algorithm)
            candidate_source.write_bytes(b"replaced-after-hash")
            return result

        monkeypatch.setattr(lifecycle, "compute_rfg_hash", replace_after_hash)
        response = client.post("/api/resources/rematch", json={
            "ifMatch": meta.headers["etag"], "mode": "auto",
            "candidateInboxVirtualPaths": [candidate], "targetVirtualPaths": [target],
            "algorithms": ["sha256"],
        })

        assert response.status_code == 409
        assert response.json()["error"]["code"] == "resource-conflict"
        assert client.get("/api/v1/meta/map").json() == before


def test_resource_batch_mutations_reject_more_than_256_paths(tmp_path):
    application, _ = app(tmp_path)
    with TestClient(application) as client:
        etag = client.get("/api/v1/meta/map").headers["etag"]
        paths = [f"inbox/path-{index}.png" for index in range(257)]
        matches = [
            {"targetVirtualPath": f"objects/target-{index}.png", "candidateInboxVirtualPath": path}
            for index, path in enumerate(paths)
        ]
        requests = [
            ("/api/resources/ignore", {"ifMatch": etag, "virtualPaths": paths}),
            ("/api/resources/unignore", {"ifMatch": etag, "virtualPaths": paths}),
            ("/api/resources/release", {"ifMatch": etag, "virtualPaths": paths}),
            ("/api/resources/rematch", {"ifMatch": etag, "mode": "explicit", "matches": matches}),
            ("/api/resources/rematch", {"ifMatch": etag, "mode": "auto", "candidateInboxVirtualPaths": paths, "algorithms": ["sha256"]}),
            ("/api/resources/rematch", {"ifMatch": etag, "mode": "auto", "candidateInboxVirtualPaths": ["inbox/one.png"], "targetVirtualPaths": [f"objects/target-{index}.png" for index in range(257)], "algorithms": ["sha256"]}),
        ]
        for endpoint, payload in requests:
            response = client.post(endpoint, json=payload)
            assert response.status_code == 422, (endpoint, response.text)
            assert response.json()["error"]["code"] == "validation"


def test_batch_rematch_leaves_ambiguous_candidates_untouched(tmp_path):
    application, _ = app(tmp_path)
    root = tmp_path / "resources"
    with TestClient(application) as client:
        client.post("/api/resources/reconcile"); inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]
        target = client.post("/api/flights", json={"flightNumber": "1", "airlineCode": "CA", "departureAirport": "PEK", "arrivalAirport": "SHA", "departureDate": "2026-01-01", "paperBoardingPassFrontResourcePath": inbox}).json()["flight"]["paperBoardingPassFrontResourcePath"]
        fingerprint_etag = client.get("/api/v1/meta/map").headers["etag"]
        queued = client.post("/api/resources/fingerprints", json={"ifMatch": fingerprint_etag, "virtualPaths": [target], "algorithms": ["sha256"]})
        task_id = queued.json()["task"]["id"]
        _await_task(client, task_id)
        (root / "ticket.png").rename(root / "moved.bin")
        (root / "one.png").write_bytes(b"ticket"); (root / "two.png").write_bytes(b"ticket")
        client.post("/api/resources/reconcile"); meta = client.get("/api/v1/meta/map")
        candidates = [entry["virtual_path"] for entry in meta.json()["entries"] if entry["virtual_path"].startswith("inbox/")]
        task_count = len(_tasks(client))
        response = client.post("/api/resources/rematch", json={"ifMatch": meta.headers["etag"], "mode": "auto", "candidateInboxVirtualPaths": candidates, "algorithms": ["sha256"]})
        assert response.status_code == 200 and response.json()["applied"] == 0 and target in response.json()["ambiguous"]
        assert set(response.json()) == {"applied", "ambiguous", "unmatched", "revision"}
        assert len(_tasks(client)) == task_count


def test_batch_rematch_fingerprint_work_does_not_include_unrelated_business_images(tmp_path, monkeypatch):
    application, _ = app(tmp_path)
    root = tmp_path / "resources"
    (root / "other.png").write_bytes(b"other")
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        entries = {entry["local_path"]: entry["virtual_path"] for entry in client.get("/api/v1/meta/map").json()["entries"]}
        first = client.post("/api/flights", json={"flightNumber": "1", "airlineCode": "CA", "departureAirport": "PEK", "arrivalAirport": "SHA", "departureDate": "2026-01-01", "paperBoardingPassFrontResourcePath": entries["ticket.png"]})
        second = client.post("/api/flights", json={"flightNumber": "2", "airlineCode": "CA", "departureAirport": "PEK", "arrivalAirport": "SHA", "departureDate": "2026-01-02", "paperBoardingPassFrontResourcePath": entries["other.png"]})
        target = first.json()["flight"]["paperBoardingPassFrontResourcePath"]
        unrelated = second.json()["flight"]["paperBoardingPassFrontResourcePath"]
        for task in _tasks(client):
            _await_task(client, task["id"], expected_state="failed")

        (root / "ticket.png").unlink()
        (root / "other.png").unlink()
        (root / "replacement.png").write_bytes(b"ticket")
        client.post("/api/resources/reconcile")
        meta = client.get("/api/v1/meta/map")
        candidate = next(entry["virtual_path"] for entry in meta.json()["entries"] if entry["local_path"] == "replacement.png")
        captured = []
        monkeypatch.setattr(application.state.background_tasks, "enqueue_fingerprints", lambda lifecycle, work: captured.append(work))

        response = client.post("/api/resources/rematch", json={"ifMatch": meta.headers["etag"], "mode": "auto", "candidateInboxVirtualPaths": [candidate], "algorithms": ["sha256"]})
        assert response.status_code == 200 and response.json()["applied"] == 1
        assert response.json()["unmatched"] == [unrelated]
        assert captured == []


def test_static_spa_is_not_data_volume_content(tmp_path):
    root, data, static = tmp_path / "resources", tmp_path / "data", tmp_path / "frontend"
    root.mkdir()
    data.mkdir()
    static.mkdir()
    (static / "index.html").write_text("<html>FlightArchive</html>", encoding="utf-8")
    application = create_app(resource_root=root, data_root=data, static_dir=static)
    with TestClient(application) as client:
        assert client.get("/").text == "<html>FlightArchive</html>"
    assert not (data / "index").exists()


def test_update_resource_path_invalidates_boarding_pass_layout(tmp_path):
    """Changing a boarding-pass resource path clears the corresponding layout slot."""
    root, data = tmp_path / "resources", tmp_path / "data"
    root.mkdir(); data.mkdir()
    (root / "old.png").write_bytes(b"old")
    (root / "new.png").write_bytes(b"new")
    application = create_app(resource_root=root, data_root=data)
    with TestClient(application) as client:
        assert client.post("/api/resources/reconcile").status_code == 200
        entries = client.get("/api/v1/meta/map").json()["entries"]
        old_path = next(e["virtual_path"] for e in entries if e["virtual_path"].endswith("old.png"))
        new_path = next(e["virtual_path"] for e in entries if e["virtual_path"].endswith("new.png"))

        created = client.post("/api/flights", json={
            "flightNumber": "1", "airlineCode": "CA",
            "departureAirport": "PEK", "arrivalAirport": "SHA",
            "departureDate": "2026-01-01",
            "paperBoardingPassFrontResourcePath": old_path,
            "paperBoardingPassLayouts": {
                "paperBoardingPassFront": {
                    "schemaVersion": 1,
                    "algorithm": "adaptive",
                    "crop": {"centerX": 100, "centerY": 100, "width": 200, "height": 200, "rotationDegrees": 0},
                    "templateId": "bp-100-247.svg",
                    "placement": {"scale": 1.0, "rotationDegrees": 0, "offsetX": 0, "offsetY": 0},
                }
            },
        }).json()["flight"]
        flight_id = created["id"]
        assert created["paperBoardingPassLayouts"]["paperBoardingPassFront"] is not None

        updated = client.put(f"/api/flights/{flight_id}", json={
            "paperBoardingPassFrontResourcePath": new_path,
        }).json()["flight"]
        assert updated["paperBoardingPassFrontResourcePath"] != old_path
        assert "paperBoardingPassFront" not in updated["paperBoardingPassLayouts"]


def test_update_preserves_id_and_created_at(tmp_path):
    """Flight update must never mutate id or createdAt; updatedAt must advance."""
    import time
    application, _ = app(tmp_path)
    with TestClient(application) as client:
        created = client.post("/api/flights", json={
            "flightNumber": "1", "airlineCode": "CA",
            "departureAirport": "PEK", "arrivalAirport": "SHA",
            "departureDate": "2026-01-01",
        }).json()["flight"]
        time.sleep(0.05)
        updated = client.put(f"/api/flights/{created['id']}", json={
            "flightNumber": "2",
        }).json()["flight"]
        assert updated["id"] == created["id"]
        assert updated["createdAt"] == created["createdAt"]
        assert updated["updatedAt"] >= created["updatedAt"]
