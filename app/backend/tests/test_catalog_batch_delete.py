# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

from __future__ import annotations

from fastapi.testclient import TestClient

from flightarchive.server import create_app


def app(tmp_path):
    root, data = tmp_path / "resources", tmp_path / "data"
    root.mkdir()
    data.mkdir()
    return create_app(resource_root=root, data_root=data)


def airline(code: str) -> dict[str, str]:
    return {"code": code, "nameEn": f"{code} Air"}


def catalog_codes(client: TestClient) -> set[str]:
    return {entry["code"] for entry in client.get("/api/catalogs").json()["airlines"]}


def test_airline_alliance_is_one_nullable_name_through_api_and_persistence(tmp_path):
    application = app(tmp_path)
    alliances = {"SA": "星空联盟", "ST": "天合联盟", "OW": "寰宇一家", "CU": "Regional Connect", "NO": None}
    with TestClient(application) as client:
        for code, alliance in alliances.items():
            response = client.put(f"/api/catalogs/airlines/{code}", json={"nameEn": f"{code} Air", "alliance": alliance})
            assert response.status_code == 200
            assert response.json()["entry"]["alliance"] == alliance

    reloaded = create_app(resource_root=tmp_path / "resources", data_root=tmp_path / "data")
    with TestClient(reloaded) as client:
        stored = {entry["code"]: entry["alliance"] for entry in client.get("/api/catalogs").json()["airlines"]}
    assert {code: stored[code] for code in alliances} == alliances


def test_batch_catalog_delete_deduplicates_keys_and_returns_canonical_keys(tmp_path):
    application = app(tmp_path)
    with TestClient(application) as client:
        assert client.put("/api/catalogs/airlines/ZX", json=airline("ZX")).status_code == 200
        assert client.put("/api/catalogs/airlines/ZY", json=airline("ZY")).status_code == 200

        response = client.post("/api/catalogs/airlines/delete", json={"keys": [" zx ", "ZY", "ZX"], "force": False})

        assert response.status_code == 200
        assert response.json() == {"deleted": ["ZX", "ZY"]}
        assert not {"ZX", "ZY"} & catalog_codes(client)


def test_batch_catalog_delete_reference_conflict_is_atomic(tmp_path):
    application = app(tmp_path)
    with TestClient(application) as client:
        assert client.put("/api/catalogs/airlines/ZX", json=airline("ZX")).status_code == 200
        assert client.put("/api/catalogs/airlines/ZY", json=airline("ZY")).status_code == 200
        flight = client.post(
            "/api/flights",
            json={
                "flightNumber": "1",
                "airlineCode": "ZX",
                "departureAirport": "PEK",
                "arrivalAirport": "SHA",
                "departureDate": "2026-01-01",
            },
        )
        assert flight.status_code == 201

        response = client.post("/api/catalogs/airlines/delete", json={"keys": ["ZX", "ZY"], "force": False})

        assert response.status_code == 409
        assert response.json()["error"]["code"] == "conflict"
        assert "ZX" in response.json()["error"]["message"]
        assert {"ZX", "ZY"} <= catalog_codes(client)


def test_batch_catalog_delete_force_removes_referenced_entries(tmp_path):
    application = app(tmp_path)
    with TestClient(application) as client:
        assert client.put("/api/catalogs/airlines/ZX", json=airline("ZX")).status_code == 200
        assert client.post("/api/flights", json={"flightNumber": "1", "airlineCode": "ZX", "departureAirport": "PEK", "arrivalAirport": "SHA", "departureDate": "2026-01-01"}).status_code == 201

        response = client.post("/api/catalogs/airlines/delete", json={"keys": ["ZX"], "force": True})

        assert response.status_code == 200
        assert response.json() == {"deleted": ["ZX"]}
        assert "ZX" not in catalog_codes(client)
        assert client.get("/api/flights").json()["flights"][0]["airlineCode"] == "ZX"


def test_batch_catalog_delete_rejects_invalid_payload_and_unknown_key_without_mutation(tmp_path):
    application = app(tmp_path)
    with TestClient(application) as client:
        assert client.put("/api/catalogs/airlines/ZX", json=airline("ZX")).status_code == 200

        for payload in ({"keys": []}, {"keys": ["   "]}, {"keys": ["ZX"], "force": "false"}):
            assert client.post("/api/catalogs/airlines/delete", json=payload).status_code == 400

        unknown = client.post("/api/catalogs/airlines/delete", json={"keys": ["ZX", "NO"]})
        assert unknown.status_code == 404
        assert unknown.json()["error"]["code"] == "not-found"
        assert "ZX" in catalog_codes(client)


def test_catalog_routes_are_converged_and_put_is_merge_upsert(tmp_path):
    application = app(tmp_path)
    with TestClient(application) as client:
        created = client.put("/api/catalogs/airlines/ZX", json={"nameEn": "Zulu Air", "alliance": "Test"})
        assert created.status_code == 200
        assert created.json()["entry"]["code"] == "ZX"

        updated = client.put("/api/catalogs/airlines/ZX", json={"nameEn": "Zulu Airways"})
        assert updated.status_code == 200
        assert updated.json()["entry"]["nameEn"] == "Zulu Airways"
        assert updated.json()["entry"]["alliance"] == "Test"

        assert client.post("/api/catalogs/airlines", json=airline("ZY")).status_code == 404
        assert client.delete("/api/catalogs/airlines/ZX").status_code == 404
        assert client.request("DELETE", "/api/catalogs/airlines", json={"keys": ["ZX"]}).status_code == 404


def test_batch_catalog_delete_rejects_more_than_256_unique_keys(tmp_path):
    application = app(tmp_path)
    with TestClient(application) as client:
        response = client.post(
            "/api/catalogs/airlines/delete",
            json={"keys": [f"K{index}" for index in range(257)]},
        )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation"
