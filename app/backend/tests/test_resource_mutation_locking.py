# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

from __future__ import annotations

import asyncio

import httpx
from fastapi.testclient import TestClient

from flightarchive.server import create_app


def test_concurrent_flight_updates_merge_after_the_business_lock_snapshot(tmp_path, monkeypatch):
    root, data = tmp_path / "resources", tmp_path / "data"
    root.mkdir()
    data.mkdir()
    application = create_app(resource_root=root, data_root=data)

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
        )
        assert created.status_code == 201
        flight_id = created.json()["flight"]["id"]

    lifecycle = application.state.resource_lifecycle
    entered, proceed = asyncio.Event(), asyncio.Event()

    async def pause_first_materialization(payload):
        entered.set()
        await proceed.wait()
        return payload, []

    monkeypatch.setattr(lifecycle, "materialize_flight_resources", pause_first_materialization)

    async def exercise():
        transport = httpx.ASGITransport(app=application)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            first = asyncio.create_task(client.put(f"/api/flights/{flight_id}", json={"flightNumber": "2"}))
            await entered.wait()
            second = asyncio.create_task(client.put(f"/api/flights/{flight_id}", json={"departureAirport": "PVG"}))
            await asyncio.sleep(0)
            proceed.set()
            return await first, await second

    first, second = asyncio.run(exercise())
    assert first.status_code == second.status_code == 200
    flight = second.json()["flight"]
    assert flight["flightNumber"] == "2"
    assert flight["departureAirport"] == "PVG"
