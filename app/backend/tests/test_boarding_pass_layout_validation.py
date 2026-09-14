# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

from __future__ import annotations

import io

from fastapi.testclient import TestClient
from PIL import Image

from flightarchive.server import create_app


def _layout() -> dict:
    return {
        "schemaVersion": 1, "algorithm": "canny", "templateId": "default.svg",
        "crop": {"centerX": 320, "centerY": 240, "width": 320, "height": 160, "rotationDegrees": 0},
        "placement": {"scale": 1, "rotationDegrees": 0, "offsetX": 0, "offsetY": 0},
    }


def _app_with_resource(tmp_path):
    root, data = tmp_path / "resources", tmp_path / "data"
    root.mkdir(); data.mkdir()
    image = io.BytesIO()
    Image.new("RGB", (640, 480), "white").save(image, "PNG")
    (root / "ticket.png").write_bytes(image.getvalue())
    return create_app(resource_root=root, data_root=data)


def test_boarding_pass_preview_accepts_paper_slots_and_rejects_electronic(tmp_path):
    """The rotated-crop endpoint is a paper-only API contract."""
    application = _app_with_resource(tmp_path)
    with TestClient(application) as client:
        assert client.post("/api/resources/sync").status_code == 200
        payload = {
            "flightNumber": "1", "airlineCode": "CA", "departureAirport": "PEK",
            "arrivalAirport": "SHA", "departureDate": "2026-01-01",
            "paperBoardingPassFrontResourcePath": "inbox/ticket.png",
            "paperBoardingPassBackResourcePath": "inbox/ticket.png",
            "paperBoardingPassLayouts": {
                "paperBoardingPassFront": _layout(),
                "paperBoardingPassBack": _layout(),
            },
            "electronicBoardingPassResourcePath": "inbox/ticket.png",
        }
        flight = client.post("/api/flights", json=payload).json()["flight"]

        for slot in ("paperBoardingPassFront", "paperBoardingPassBack"):
            paper = client.get(f"/api/flights/{flight['id']}/boarding-passes/{slot}/preview")
            assert paper.status_code == 200
            assert paper.headers["content-type"] == "image/webp"

        electronic = client.get(f"/api/flights/{flight['id']}/boarding-passes/electronicBoardingPass/preview")
        assert electronic.status_code == 404
        assert electronic.json()["error"] == {
            "code": "boarding-pass-slot-not-found",
            "message": "boarding-pass slot is not recognized",
        }

        unknown = client.get(f"/api/flights/{flight['id']}/boarding-passes/unknownSlot/preview")
        assert unknown.status_code == 404
        assert unknown.json()["error"]["code"] == "boarding-pass-slot-not-found"


def test_put_clearing_resource_path_invalidates_split_presentations(tmp_path):
    """Clearing a resource path drops its stale split presentation before validation."""
    application = _app_with_resource(tmp_path)
    with TestClient(application) as client:
        assert client.post("/api/resources/sync").status_code == 200
        payload = {
            "flightNumber": "1", "airlineCode": "CA", "departureAirport": "PEK",
            "arrivalAirport": "SHA", "departureDate": "2026-01-01",
            "paperBoardingPassFrontResourcePath": "inbox/ticket.png",
            "electronicBoardingPassResourcePath": "inbox/ticket.png",
            "paperBoardingPassLayouts": {"paperBoardingPassFront": _layout()},
            "electronicBoardingPass": {
                "schemaVersion": 1,
                "extraction": None,
            },
            "boardingPassColor": "#010203",
        }
        created = client.post("/api/flights", json=payload)
        assert created.status_code == 201
        flight = created.json()["flight"]
        assert "paperBoardingPassFront" in flight["paperBoardingPassLayouts"]
        assert flight["boardingPassColor"] == "#010203"

        rejected = client.put(f"/api/flights/{flight['id']}", json={"boardingPassPrimaryColor": "#FFFFFF"})
        assert rejected.status_code == 422

        updated = client.put(f"/api/flights/{flight['id']}", json={
            "paperBoardingPassFrontResourcePath": None,
            "electronicBoardingPassResourcePath": None,
        })
        assert updated.status_code == 200
        result = updated.json()["flight"]
        assert result["paperBoardingPassFrontResourcePath"] is None
        assert result["paperBoardingPassLayouts"] == {}
        assert result["electronicBoardingPassResourcePath"] is None
        assert result["electronicBoardingPass"] is None
