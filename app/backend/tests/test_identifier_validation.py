# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from flightarchive.business_data import BusinessDataError, parse_business_data
from flightarchive.domain.models import (
    AircraftType,
    validate_electronic_boarding_pass,
    validate_paper_boarding_pass_layouts,
)
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
            response = client.put(
                f"/api/catalogs/aircraft-types/{code}",
                json={"iata": "320", "displayName": f"Type {code}"},
            )
            assert response.status_code == 200
            assert response.json()["entry"]["icao"] == code.upper()

        for code in ("at", "a3b", "a320"):
            response = client.post("/api/flights", json=flight_payload(code))
            assert response.status_code == 201
            assert response.json()["flight"]["aircraftTypeIcao"] == code.upper()


@pytest.mark.parametrize("code", ("A", "A3200"))
def test_aircraft_type_icao_rejects_one_and_five_characters(tmp_path, code):
    with TestClient(app(tmp_path)) as client:
        catalog = client.put(
            f"/api/catalogs/aircraft-types/{code}",
            json={"iata": "320", "displayName": "Invalid type"},
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
        created = client.put(
            "/api/catalogs/aircraft-types/TEST",
            json={"iata": "TST", "displayName": "Test Type", "manufacturer": "Custom Works DE"},
        )
        assert created.status_code == 200
        assert created.json()["entry"] == {
            "icao": "TEST", "iata": "TST", "manufacturer": "Custom Works DE", "displayName": "Test Type",
        }
        unsupported = client.put(
            "/api/catalogs/aircraft-types/TST2",
            json={"displayName": "Unsupported", "obsoleteManufacturer": "Legacy"},
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


@pytest.mark.parametrize("prefix", ("inbox", "ignore"))
def test_persisted_domain_resource_paths_reject_temporary_prefixes(prefix):
    document = {
        "schemaVersion": 1,
        "airlines": [], "airports": [], "aircraftTypes": [], "settings": {},
        "flights": [{
            **flight_payload("A320"),
            "paperBoardingPassFrontResourcePath": f"{prefix}/ticket.png",
        }],
    }
    with pytest.raises(BusinessDataError, match="stable RFG object"):
        parse_business_data(document)


@pytest.mark.parametrize("version", [True, 1.0, None])
def test_business_data_schema_version_requires_a_strict_integer(version):
    with pytest.raises(BusinessDataError, match="schemaVersion"):
        parse_business_data({
            "schemaVersion": version,
            "airlines": [], "airports": [], "aircraftTypes": [],
            "flights": [], "settings": {},
        })


@pytest.mark.parametrize("version", [True, 1.0, None])
def test_boarding_pass_schema_versions_require_strict_integers(version):
    resource_path = "objects/ticket.png"
    flight = {
        "paperBoardingPassFrontResourcePath": resource_path,
        "electronicBoardingPassResourcePath": resource_path,
    }
    layout = {
        "paperBoardingPassFront": {
            "schemaVersion": version,
            "algorithm": "canny",
            "templateId": "default.svg",
            "crop": {"centerX": 1, "centerY": 1, "width": 1, "height": 1, "rotationDegrees": 0},
            "placement": {"scale": 1, "rotationDegrees": 0, "offsetX": 0, "offsetY": 0},
        },
    }
    assert any("schemaVersion must be 1" in issue for issue in validate_paper_boarding_pass_layouts(layout, flight))
    assert "schemaVersion must be 1" in validate_electronic_boarding_pass(
        {"schemaVersion": version, "extraction": None}, flight
    )


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
        created = client.put("/api/catalogs/airports/QZX", json={"nameEn": "QZX Airport", "terminals": ["T1"]})
        assert created.status_code == 200
        flight = client.post("/api/flights", json={**flight_payload("A320"), "departureAirport": "QZX", "departureTerminal": "T2"})
        assert flight.status_code == 201
        airport = next(entry for entry in client.get("/api/catalogs").json()["airports"] if entry["code"] == "QZX")
        assert airport["terminals"] == ["T1"]


def test_airport_and_airline_icao_widths_remain_distinct(tmp_path):
    with TestClient(app(tmp_path)) as client:
        assert client.put("/api/catalogs/airlines/ZZ", json={"icao": "ZZZ", "nameEn": "Zulu Air"}).status_code == 200
        assert client.put("/api/catalogs/airports/ZZZ", json={"icao": "ZZZZ", "nameEn": "Zulu Airport"}).status_code == 200
        assert client.put("/api/catalogs/airlines/ZY", json={"icao": "ZZZZ", "nameEn": "Zulu Air"}).status_code == 422
        assert client.put("/api/catalogs/airports/ZZY", json={"icao": "ZZZ", "nameEn": "Zulu Airport"}).status_code == 422
