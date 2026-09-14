# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Human-readable resource naming for materialized flight and airline assets.

Materialization turns an ``inbox/<local_path>`` mapping into a stable object
path derived from the resource's owners rather than an opaque hash.  This file
pins the naming format, the shared-resource merge, the source-disambiguation
fallback, and the backward-compatibility guarantee that existing object paths
are never renamed.
"""
from __future__ import annotations

import hashlib

import pytest
from fastapi.testclient import TestClient

from flightarchive.routes.api import ResourceOwner, generate_resource_name
from flightarchive.server import create_app


def app(tmp_path, files: dict[str, bytes] | None = None):
    root, data = tmp_path / "resources", tmp_path / "data"
    root.mkdir(); data.mkdir()
    for name, content in (files or {"ticket.png": b"ticket"}).items():
        (root / name).write_bytes(content)
    return create_app(resource_root=root, data_root=data)


# ---------------------------------------------------------------------------
# pure naming helpers
# ---------------------------------------------------------------------------


def test_generate_resource_name_single_flight_owner():
    owner = ResourceOwner(date="20230610", code="ac", flight_number="0001", role="a", index=0)
    assert generate_resource_name([owner], "jpg") == "20230610ac0001a0.jpg"


def test_generate_resource_name_merges_shared_owners_sorted_by_date_code_role():
    first = ResourceOwner(date="20230610", code="ac", flight_number="0001", role="a", index=0)
    second = ResourceOwner(date="20230611", code="ac", flight_number="0002", role="a", index=0)
    # Input order is deliberately reversed; the output is canonical.
    assert generate_resource_name([second, first], "jpg") == "20230610ac0001a0+20230611ac0002a0.jpg"


def test_generate_resource_name_airline_owner_uses_hyphenated_role():
    assert generate_resource_name([ResourceOwner(code="ca", role="horizontal")], "jpg") == "ca-horizontal.jpg"
    assert generate_resource_name([ResourceOwner(code="ca", role="horizontal-dark")], "png") == "ca-horizontal-dark.png"
    assert generate_resource_name([ResourceOwner(code="ca", role="symbol")], "svg") == "ca-symbol.svg"


def test_generate_resource_name_requires_an_owner():
    with pytest.raises(ValueError):
        generate_resource_name([], "jpg")


# ---------------------------------------------------------------------------
# materialization integration
# ---------------------------------------------------------------------------


def _inbox_entries(client: TestClient) -> dict[str, str]:
    """Map local source name -> inbox virtual path."""
    return {e["local_path"]: e["virtual_path"] for e in client.get("/api/v1/meta/map").json()["entries"]}


def test_flight_resources_materialize_to_human_readable_names(tmp_path):
    files = {"front.png": b"f", "back.png": b"b", "pass.png": b"p", "a1.png": b"a1", "a2.png": b"a2"}
    application = app(tmp_path, files)
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        inbox = _inbox_entries(client)
        created = client.post(
            "/api/flights",
            json={
                "flightNumber": "1",
                "airlineCode": "CA",
                "departureAirport": "PEK",
                "arrivalAirport": "SHA",
                "departureDate": "2023-06-10",
                "paperBoardingPassFrontResourcePath": inbox["front.png"],
                "paperBoardingPassBackResourcePath": inbox["back.png"],
                "electronicBoardingPassResourcePath": inbox["pass.png"],
                "attachmentResourcePaths": [inbox["a1.png"], inbox["a2.png"]],
            },
        )
        assert created.status_code == 201
        flight = created.json()["flight"]
        assert flight["paperBoardingPassFrontResourcePath"] == "20230610ca0001a0.png"
        assert flight["paperBoardingPassBackResourcePath"] == "20230610ca0001a1.png"
        assert flight["electronicBoardingPassResourcePath"] == "20230610ca0001b0.png"
        assert flight["attachmentResourcePaths"] == ["20230610ca0001c0.png", "20230610ca0001c1.png"]


def test_airline_logos_materialize_to_human_readable_names(tmp_path):
    files = {"h.png": b"h", "hd.png": b"hd", "s.svg": b"<svg/>"}
    application = app(tmp_path, files)
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        inbox = _inbox_entries(client)
        created = client.post(
            "/api/catalogs/airlines",
            json={
                "code": "CA",
                "nameEn": "Air China",
                "horizontalLogoResourcePath": inbox["h.png"],
                "horizontalDarkLogoResourcePath": inbox["hd.png"],
                "symbolLogoResourcePath": inbox["s.svg"],
            },
        )
        assert created.status_code == 201
        entry = created.json()["entry"]
        assert entry["horizontalLogoResourcePath"] == "ca-horizontal.png"
        assert entry["horizontalDarkLogoResourcePath"] == "ca-horizontal-dark.png"
        assert entry["symbolLogoResourcePath"] == "ca-symbol.svg"


def test_replacing_a_resource_disambiguates_the_new_source(tmp_path):
    application = app(tmp_path, {"old.png": b"old", "new.png": b"new"})
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        inbox = _inbox_entries(client)
        created = client.post(
            "/api/flights",
            json={
                "flightNumber": "1",
                "airlineCode": "CA",
                "departureAirport": "PEK",
                "arrivalAirport": "SHA",
                "departureDate": "2026-01-01",
                "paperBoardingPassFrontResourcePath": inbox["old.png"],
            },
        ).json()["flight"]
        assert created["paperBoardingPassFrontResourcePath"] == "20260101ca0001a0.png"

        updated = client.put(
            f"/api/flights/{created['id']}",
            json={"paperBoardingPassFrontResourcePath": inbox["new.png"]},
        ).json()["flight"]
        assert updated["paperBoardingPassFrontResourcePath"].startswith("20260101ca0001a0-")
        assert updated["paperBoardingPassFrontResourcePath"].endswith(".png")
        # The old source is returned to inbox after the successful update.
        entries = _inbox_entries(client)
        assert entries["old.png"].startswith("inbox/")


def test_existing_object_mappings_are_never_renamed(tmp_path):
    application = app(tmp_path)
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        mapping = client.get("/api/v1/meta/map")
        document = mapping.json()
        legacy = hashlib.sha256(b"ticket.png").hexdigest() + ".png"
        document["entries"][0]["virtual_path"] = legacy
        assert client.put("/api/v1/meta/map", json=document, headers={"If-Match": mapping.headers["etag"]}).status_code == 200

        created = client.post(
            "/api/flights",
            json={
                "flightNumber": "1",
                "airlineCode": "CA",
                "departureAirport": "PEK",
                "arrivalAirport": "SHA",
                "departureDate": "2026-01-01",
                "paperBoardingPassFrontResourcePath": legacy,
            },
        )
        assert created.status_code == 201
        assert created.json()["flight"]["paperBoardingPassFrontResourcePath"] == legacy


def test_airline_logo_is_released_after_airline_deletion(tmp_path):
    application = app(tmp_path)
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        inbox = client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"]
        created = client.post(
            "/api/catalogs/airlines",
            json={"code": "CA", "nameEn": "Air China", "horizontalLogoResourcePath": inbox},
        ).json()["entry"]
        assert created["horizontalLogoResourcePath"] == "ca-horizontal.png"

        assert client.delete("/api/catalogs/airlines/CA").status_code == 200
        entries = client.get("/api/v1/meta/map").json()["entries"]
        assert any(e["virtual_path"] == "inbox/ticket.png" for e in entries)
        assert not any(e["virtual_path"] == "ca-horizontal.png" for e in entries)


def test_airline_logo_replacements_release_only_obsolete_slots(tmp_path):
    application = app(tmp_path, {"horizontal.png": b"h", "dark.png": b"d", "symbol.svg": b"<svg/>"})
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        inbox = _inbox_entries(client)
        created = client.post(
            "/api/catalogs/airlines",
            json={
                "code": "CA", "nameEn": "Air China",
                "horizontalLogoResourcePath": inbox["horizontal.png"],
                "horizontalDarkLogoResourcePath": inbox["dark.png"],
                "symbolLogoResourcePath": inbox["symbol.svg"],
            },
        )
        assert created.status_code == 201

        updated = client.put("/api/catalogs/airlines/CA", json={"symbolLogoResourcePath": None})
        assert updated.status_code == 200
        entry = updated.json()["entry"]
        assert entry["horizontalLogoResourcePath"] == "ca-horizontal.png"
        assert entry["horizontalDarkLogoResourcePath"] == "ca-horizontal-dark.png"
        assert entry["symbolLogoResourcePath"] is None

        entries = {item["virtual_path"] for item in client.get("/api/v1/meta/map").json()["entries"]}
        assert "inbox/symbol.svg" in entries
        assert "ca-horizontal.png" in entries
        assert "ca-horizontal-dark.png" in entries


def test_catalog_create_upsert_releases_replaced_airline_logo(tmp_path):
    application = app(tmp_path, {"first.png": b"first", "second.png": b"second"})
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        inbox = _inbox_entries(client)
        first = client.post(
            "/api/catalogs/airlines",
            json={"code": "CA", "nameEn": "Air China", "horizontalLogoResourcePath": inbox["first.png"]},
        )
        assert first.status_code == 201

        second = client.post(
            "/api/catalogs/airlines",
            json={"code": "CA", "nameEn": "Air China", "horizontalLogoResourcePath": inbox["second.png"]},
        )
        assert second.status_code == 201
        entries = {item["virtual_path"] for item in client.get("/api/v1/meta/map").json()["entries"]}
        assert "inbox/first.png" in entries
        assert second.json()["entry"]["horizontalLogoResourcePath"] in entries
