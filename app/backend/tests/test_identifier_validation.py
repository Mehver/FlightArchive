# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from flightarchive.business_data import BusinessDataError, parse_business_data
from flightarchive.domain.models import AircraftType
from flightarchive.domain.store import DomainStore
from flightarchive.server import create_app


def app(tmp_path):
    root, data = tmp_path / "resources", tmp_path / "data"
    root.mkdir()
    data.mkdir()
    return create_app(resource_root=root, data_root=data)


def flight_payload(aircraft_type_icao: str) -> dict[str, str]:
    return {
        "flightNumber": "1",
        "airlineCode": "CA",
        "departureAirport": "PEK",
        "arrivalAirport": "SHA",
        "departureDate": "2026-01-01",
        "aircraftTypeIcao": aircraft_type_icao,
    }


def test_aircraft_type_icao_accepts_two_through_four_characters_and_normalizes_case(tmp_path):
    with TestClient(app(tmp_path)) as client:
        for code in ("at", "a3b", "a320"):
            response = client.post(
                "/api/catalogs/aircraft-types",
                json={"icao": code, "iata": "320", "displayName": f"Type {code}"},
            )
            assert response.status_code == 201
            assert response.json()["entry"]["icao"] == code.upper()

        for code in ("at", "a3b", "a320"):
            response = client.post("/api/flights", json=flight_payload(code))
            assert response.status_code == 201
            assert response.json()["flight"]["aircraftTypeIcao"] == code.upper()


@pytest.mark.parametrize("code", ("A", "A3200"))
def test_aircraft_type_icao_rejects_one_and_five_characters(tmp_path, code):
    with TestClient(app(tmp_path)) as client:
        catalog = client.post(
            "/api/catalogs/aircraft-types",
            json={"icao": code, "iata": "320", "displayName": "Invalid type"},
        )
        flight = client.post("/api/flights", json=flight_payload(code))
    assert catalog.status_code == 422
    assert flight.status_code == 422


def test_aircraft_type_iata_remains_an_optional_three_character_designator():
    assert AircraftType.from_dict({"icao": "A320", "iata": "32N", "displayName": "A320neo"}).validate() == []
    assert "must be 3 letters/digits" in "; ".join(
        AircraftType.from_dict({"icao": "A320", "iata": "32", "displayName": "A320neo"}).validate()
    )


def test_aircraft_type_uses_one_nullable_manufacturer_value(tmp_path):
    assert AircraftType.from_dict({"icao": "A320", "displayName": "A320", "manufacturer": "   "}).to_dict()["manufacturer"] is None
    with TestClient(app(tmp_path)) as client:
        created = client.post(
            "/api/catalogs/aircraft-types",
            json={"icao": "TEST", "iata": "TST", "displayName": "Test Type", "manufacturer": "Custom Works DE"},
        )
        assert created.status_code == 201
        assert created.json()["entry"] == {
            "icao": "TEST", "iata": "TST", "manufacturer": "Custom Works DE", "displayName": "Test Type",
        }
        unsupported = client.post(
            "/api/catalogs/aircraft-types",
            json={"icao": "TST2", "displayName": "Unsupported", "obsoleteManufacturer": "Legacy"},
        )
        assert unsupported.status_code == 422

    with pytest.raises(BusinessDataError, match="unsupported fields"):
        parse_business_data({
            "schemaVersion": 1,
            "airlines": [], "airports": [],
            "aircraftTypes": [{"icao": "TEST", "displayName": "Test Type", "obsoleteManufacturer": "Legacy"}],
            "flights": [], "settings": {},
        })


def test_business_data_load_skips_invalid_aircraft_type_designators():
    store = DomainStore()
    issues = store.load_dict({
        "airlines": [], "airports": [],
        "aircraftTypes": [{"icao": "A", "iata": "320", "displayName": "Invalid type"}],
        "flights": [], "settings": {},
    })
    assert store.aircraft_types == {}
    assert any("must be 2-4 letters/digits" in issue for issue in issues)


def test_flight_registration_normalizes_common_international_forms_and_allows_empty(tmp_path):
    with TestClient(app(tmp_path)) as client:
        for registration, expected in ((" b1234 ", "B1234"), ("g-abcd", "G-ABCD"), ("n123ab", "N123AB"), ("   ", None)):
            response = client.post("/api/flights", json={**flight_payload("A320"), "registration": registration})
            assert response.status_code == 201
            assert response.json()["flight"]["registration"] == expected


@pytest.mark.parametrize("registration", ("A", "A1234567890123456", "N@123", "-N123", "N123-", "N--123"))
def test_flight_registration_rejects_invalid_syntax_through_the_api(tmp_path, registration):
    with TestClient(app(tmp_path)) as client:
        response = client.post("/api/flights", json={**flight_payload("A320"), "registration": registration})
    assert response.status_code == 422


def test_flight_terminals_do_not_mutate_airport_catalogs(tmp_path):
    with TestClient(app(tmp_path)) as client:
        created = client.post("/api/catalogs/airports", json={"code": "QZX", "nameEn": "QZX Airport", "terminals": ["T1"]})
        assert created.status_code == 201
        flight = client.post("/api/flights", json={**flight_payload("A320"), "departureAirport": "QZX", "departureTerminal": "T2"})
        assert flight.status_code == 201
        airport = next(entry for entry in client.get("/api/catalogs").json()["airports"] if entry["code"] == "QZX")
        assert airport["terminals"] == ["T1"]


def test_airport_and_airline_icao_widths_remain_distinct(tmp_path):
    with TestClient(app(tmp_path)) as client:
        assert client.post("/api/catalogs/airlines", json={"code": "ZZ", "icao": "ZZZ", "nameEn": "Zulu Air"}).status_code == 201
        assert client.post("/api/catalogs/airports", json={"code": "ZZZ", "icao": "ZZZZ", "nameEn": "Zulu Airport"}).status_code == 201
        assert client.post("/api/catalogs/airlines", json={"code": "ZY", "icao": "ZZZZ", "nameEn": "Zulu Air"}).status_code == 422
        assert client.post("/api/catalogs/airports", json={"code": "ZZY", "icao": "ZZZ", "nameEn": "Zulu Airport"}).status_code == 422
