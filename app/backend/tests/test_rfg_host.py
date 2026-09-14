# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

from __future__ import annotations

import json
import time

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
        assert client.post("/api/resources/sync").status_code == 200
        assert client.get("/api/v1/meta/map").status_code == 200
        unknown = client.post("/api/not-a-flightarchive-route")
        assert unknown.status_code == 404
        assert unknown.json() == {"error": {"code": "not-found", "message": "unknown API path /api/not-a-flightarchive-route"}}
        assert client.get("/asset.txt").text == "asset"
        assert client.get("/client/route").text == "<html>FlightArchive</html>"


def test_v1_persists_business_data_atomically(tmp_path):
    application, data = app(tmp_path)
    with TestClient(application) as client:
        assert client.get("/api/health").status_code == 200
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
        created = client.post("/api/catalogs/airlines", json={
            "code": "ZZ", "nameEn": "Zulu Air",
            "brandColors": {"primary": "#010203", "contrast": None},
        })
        assert created.status_code == 201
        assert created.json()["entry"]["brandColors"] == {"primary": "#010203", "contrast": None}
        legacy = client.post("/api/catalogs/airlines", json={
            "code": "ZY", "nameEn": "Legacy Air", "primaryBrandColor": "#010203",
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
        assert client.post("/api/resources/sync").json()["added"] == 1
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
        assert client.post("/api/resources/sync").json()["added"] == 1
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]

        updated = client.put(
            f"/api/flights/{created['id']}", json={"paperBoardingPassFrontResourcePath": inbox}
        )
        assert updated.status_code == 200
        assert updated.json()["flight"]["paperBoardingPassFrontResourcePath"] == "20260101ca0001a0.png"


def test_airline_submission_materializes_pending_logo_only_after_form_validation(tmp_path):
    application, _ = app(tmp_path)
    with TestClient(application) as client:
        assert client.post("/api/resources/sync").json()["added"] == 1
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]

        invalid = client.post("/api/catalogs/airlines", json={"horizontalLogoResourcePath": inbox})
        assert invalid.status_code == 422
        assert client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"] == inbox

        saved = client.post(
            "/api/catalogs/airlines",
            json={"code": "CA", "nameEn": "Air China", "horizontalLogoResourcePath": inbox},
        )
        assert saved.status_code == 201
        path = saved.json()["entry"]["horizontalLogoResourcePath"]
        assert path == "ca-horizontal.png"
        assert client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"] == path


def test_new_image_fingerprints_are_queued_as_a_background_task(tmp_path):
    application, _ = app(tmp_path)
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]
        created = client.post(
            "/api/flights",
            json={"flightNumber": "1", "airlineCode": "CA", "departureAirport": "PEK", "arrivalAirport": "SHA", "departureDate": "2026-01-01", "paperBoardingPassFrontResourcePath": inbox},
        )
        assert created.status_code == 201
        path = created.json()["flight"]["paperBoardingPassFrontResourcePath"]
        deadline = time.monotonic() + 2
        task = None
        while time.monotonic() < deadline:
            task = client.get("/api/tasks").json()["tasks"][0]
            if task["state"] in {"succeeded", "failed"}:
                break
            time.sleep(0.01)
        assert task is not None and task["state"] in {"succeeded", "failed"}
        assert task["total"] == 6 and task["completed"] == 6
        assert {item["virtualPath"] for item in task["items"]} == {path}


def test_resource_rematches_preserve_target_and_remove_inbox(tmp_path):
    application, _ = app(tmp_path)
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        mapping = client.get("/api/v1/meta/map")
        document = mapping.json()
        document["entries"][0]["virtual_path"] = "old/missing.png"
        assert client.put("/api/v1/meta/map", json=document, headers={"If-Match": mapping.headers["etag"]}).status_code == 200
        (tmp_path / "resources" / "ticket.png").unlink()
        (tmp_path / "resources" / "replacement.png").write_bytes(b"replacement")
        client.post("/api/resources/sync")
        candidate = next(x["virtual_path"] for x in client.get("/api/v1/meta/map").json()["entries"] if x["virtual_path"].startswith("inbox/"))
        response = client.post("/api/resources/rematches", json={"matches": [{"targetVirtualPath": "old/missing.png", "candidateInboxVirtualPath": candidate}]})
        assert response.status_code == 200
        assert response.json()["applied"] == 1
        entries = response.json()["mapping"]["entries"]
        assert entries == [{"virtual_path": "old/missing.png", "local_path": "replacement.png", "size_bytes": 11}]
        assert response.json()["etag"]


def test_resource_rematches_reject_non_inbox_candidate(tmp_path):
    application, _ = app(tmp_path)
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        mapping = client.get("/api/v1/meta/map")
        document = mapping.json()
        document["entries"][0]["virtual_path"] = "old/missing.png"
        assert client.put("/api/v1/meta/map", json=document, headers={"If-Match": mapping.headers["etag"]}).status_code == 200
        (tmp_path / "resources" / "ticket.png").unlink()
        (tmp_path / "resources" / "replacement.png").write_bytes(b"replacement")
        client.post("/api/resources/sync")
        response = client.post("/api/resources/rematches", json={"matches": [{"targetVirtualPath": "old/missing.png", "candidateInboxVirtualPath": "old/missing.png"}]})
        assert response.status_code == 422


def test_resource_rematches_reject_invalid_duplicate_and_stale_requests(tmp_path):
    application, _ = app(tmp_path)
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]
        payload = {"matches": [{"targetVirtualPath": "missing/path", "candidateInboxVirtualPath": inbox}]}
        assert client.post("/api/resources/rematches", json=payload).status_code == 404
        payload = {"matches": [{"targetVirtualPath": inbox, "candidateInboxVirtualPath": inbox}]}
        assert client.post("/api/resources/rematches", json=payload).status_code == 422
        duplicate_targets = {"matches": [{"targetVirtualPath": "a", "candidateInboxVirtualPath": inbox}, {"targetVirtualPath": "a", "candidateInboxVirtualPath": "other"}]}
        assert client.post("/api/resources/rematches", json=duplicate_targets).status_code == 422
        duplicate_candidates = {"matches": [{"targetVirtualPath": "a", "candidateInboxVirtualPath": inbox}, {"targetVirtualPath": "b", "candidateInboxVirtualPath": inbox}]}
        assert client.post("/api/resources/rematches", json=duplicate_candidates).status_code == 422
        assert client.post("/api/resources/rematches", json={"ifMatch": '"stale"', "matches": [{"targetVirtualPath": "missing/path", "candidateInboxVirtualPath": inbox}]}).status_code == 409


def test_fingerprints_are_authoritative_for_direct_flight_resources(tmp_path):
    application, _ = app(tmp_path)
    (tmp_path / "resources" / "ticket.png").rename(tmp_path / "resources" / "ticket.bin")
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]
        # Pending resources are rejected before the RFG hash endpoint is used.
        lifecycle = application.state.resource_lifecycle
        calls: list[str] = []
        original_hash = lifecycle._hash
        async def observed_hash(local_path, algorithm):
            calls.append(local_path)
            return await original_hash(local_path, algorithm)
        lifecycle._hash = observed_hash
        assert client.post("/api/resources/fingerprints", json={"virtualPaths": [inbox], "algorithms": ["sha256"]}).status_code == 422
        assert calls == []

        created = client.post("/api/flights", json={"flightNumber": "1", "airlineCode": "CA", "departureAirport": "PEK", "arrivalAirport": "SHA", "departureDate": "2026-01-01", "paperBoardingPassFrontResourcePath": inbox})
        assert created.status_code == 201
        path = created.json()["flight"]["paperBoardingPassFrontResourcePath"]
        assert client.get("/api/tasks").json()["tasks"] == []
        etag = client.get("/api/v1/meta/map").headers["etag"]
        response = client.post("/api/resources/fingerprints", json={"ifMatch": etag, "virtualPaths": [path], "algorithms": ["crc32", "sha256"]})
        assert response.status_code == 200
        results = response.json()["results"]
        assert [item["algorithm"] for item in results] == ["crc32", "sha256"]
        assert all(item["status"] == "succeeded" and item["persisted"] for item in results)
        entry = next(item for item in response.json()["mapping"]["entries"] if item["virtual_path"] == path)
        assert entry["crc32"] == results[0]["value"] and entry["sha256"] == results[1]["value"]
        assert entry["size_bytes"] == len(b"ticket")
        assert client.post("/api/resources/fingerprints", json={"ifMatch": etag, "virtualPaths": [path], "algorithms": ["md5"]}).status_code == 409


def test_fingerprints_include_airline_logo_and_reject_invalid_body(tmp_path):
    application, _ = app(tmp_path)
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]
        saved = client.post("/api/catalogs/airlines", json={"code": "CA", "nameEn": "Air China", "horizontalLogoResourcePath": inbox})
        assert saved.status_code == 201
        logo = saved.json()["entry"]["horizontalLogoResourcePath"]
        response = client.post("/api/resources/fingerprints", json={"virtualPaths": [logo], "algorithms": ["sha256"]})
        assert response.status_code == 200
        assert response.json()["results"][0]["persisted"] is True
        assert client.post("/api/resources/fingerprints", json={"virtualPaths": [logo, logo], "algorithms": ["sha256"], "localPath": "ticket.png"}).status_code == 422


def test_svg_automatic_fingerprints_exclude_perceptual_hashes(tmp_path):
    application, _ = app(tmp_path)
    root = tmp_path / "resources"
    (root / "ticket.png").unlink()
    (root / "logo.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>", encoding="utf-8")
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]
        saved = client.post("/api/catalogs/airlines", json={"code": "CA", "nameEn": "Air China", "symbolLogoResourcePath": inbox})
        assert saved.status_code == 201
        logo = saved.json()["entry"]["symbolLogoResourcePath"]
        tasks = client.get("/api/tasks").json()["tasks"]
        assert {item["algorithm"] for item in tasks[0]["items"]} == {"crc32", "md5", "sha256"}
        assert client.post("/api/resources/fingerprints", json={"virtualPaths": [logo], "algorithms": ["phash"]}).status_code == 422


def test_ignore_renames_present_inbox_without_business_mutation_and_sync_expires_it(tmp_path):
    application, _ = app(tmp_path)
    root = tmp_path / "resources"
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        meta = client.get("/api/v1/meta/map")
        inbox = meta.json()["entries"][0]["virtual_path"]
        ignored = client.post("/api/resources/ignore", json={"ifMatch": meta.headers["etag"], "virtualPath": inbox})
        assert ignored.status_code == 200
        assert ignored.json()["ignoredVirtualPath"].startswith("ignore/")
        assert client.get("/api/flights").json()["flights"] == []
        assert client.post("/api/resources/ignore", json={"ifMatch": '"stale"', "virtualPath": inbox}).status_code == 409
        (root / "ticket.png").unlink()
        sync = client.post("/api/resources/sync")
        assert sync.status_code == 200 and sync.json()["removedTemporary"] == 1
        assert client.get("/api/v1/meta/map").json()["entries"] == []


def test_sync_removes_missing_inbox_but_retains_missing_object_rematch_target(tmp_path):
    application, _ = app(tmp_path)
    root = tmp_path / "resources"
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]
        # Materializing makes the mapping a classified object. A new inbox file
        # gives this sync both transient and persistent missing cases.
        created = client.post("/api/flights", json={"flightNumber": "1", "airlineCode": "CA", "departureAirport": "PEK", "arrivalAirport": "SHA", "departureDate": "2026-01-01", "paperBoardingPassFrontResourcePath": inbox})
        target = created.json()["flight"]["paperBoardingPassFrontResourcePath"]
        (root / "pending.png").write_bytes(b"pending")
        client.post("/api/resources/sync")
        assert any(entry["virtual_path"] == "inbox/pending.png" for entry in client.get("/api/v1/meta/map").json()["entries"])
        (root / "ticket.png").unlink(); (root / "pending.png").unlink()
        sync = client.post("/api/resources/sync")
        assert sync.status_code == 200 and sync.json()["removedTemporary"] == 1
        entries = client.get("/api/v1/meta/map").json()["entries"]
        assert [entry["virtual_path"] for entry in entries] == [target]


def test_batch_rematch_only_applies_a_unique_pending_candidate(tmp_path):
    application, _ = app(tmp_path)
    root = tmp_path / "resources"
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]
        created = client.post("/api/flights", json={"flightNumber": "1", "airlineCode": "CA", "departureAirport": "PEK", "arrivalAirport": "SHA", "departureDate": "2026-01-01", "paperBoardingPassFrontResourcePath": inbox})
        target = created.json()["flight"]["paperBoardingPassFrontResourcePath"]
        assert client.post("/api/resources/fingerprints", json={"virtualPaths": [target], "algorithms": ["sha256"]}).status_code == 200
        (root / "ticket.png").rename(root / "moved.bin")
        (root / "replacement.png").write_bytes(b"ticket")
        client.post("/api/resources/sync")
        meta = client.get("/api/v1/meta/map")
        candidate = next(entry["virtual_path"] for entry in meta.json()["entries"] if entry["local_path"] == "replacement.png")
        response = client.post("/api/resources/batch-rematches", json={"ifMatch": meta.headers["etag"], "candidateInboxVirtualPaths": [candidate], "algorithms": ["sha256"]})
        assert response.status_code == 200 and response.json()["applied"] == 1
        assert next(entry for entry in response.json()["mapping"]["entries"] if entry["virtual_path"] == target)["local_path"] == "replacement.png"


def test_batch_rematch_leaves_ambiguous_candidates_untouched(tmp_path):
    application, _ = app(tmp_path)
    root = tmp_path / "resources"
    with TestClient(application) as client:
        client.post("/api/resources/sync"); inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]
        target = client.post("/api/flights", json={"flightNumber": "1", "airlineCode": "CA", "departureAirport": "PEK", "arrivalAirport": "SHA", "departureDate": "2026-01-01", "paperBoardingPassFrontResourcePath": inbox}).json()["flight"]["paperBoardingPassFrontResourcePath"]
        client.post("/api/resources/fingerprints", json={"virtualPaths": [target], "algorithms": ["sha256"]})
        (root / "ticket.png").rename(root / "moved.bin")
        (root / "one.png").write_bytes(b"ticket"); (root / "two.png").write_bytes(b"ticket")
        client.post("/api/resources/sync"); meta = client.get("/api/v1/meta/map")
        candidates = [entry["virtual_path"] for entry in meta.json()["entries"] if entry["virtual_path"].startswith("inbox/")]
        response = client.post("/api/resources/batch-rematches", json={"ifMatch": meta.headers["etag"], "candidateInboxVirtualPaths": candidates, "algorithms": ["sha256"]})
        assert response.status_code == 200 and response.json()["applied"] == 0 and target in response.json()["ambiguous"]


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
        assert client.post("/api/resources/sync").status_code == 200
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
