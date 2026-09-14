# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

from __future__ import annotations

import asyncio
import io
import sqlite3
import threading
import time

from fastapi.testclient import TestClient
from PIL import Image

from flightarchive.server import create_app
from flightarchive.thumbnails import DATABASE_PATH, DEFAULT_MAX_SOURCE_BYTES, Thumbnail
from flightarchive.business_data import BusinessDataError


def _image_bytes(fmt: str = "PNG", size: tuple[int, int] = (640, 480), color: tuple[int, int, int] = (200, 30, 30)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, fmt)
    return buffer.getvalue()


def app(tmp_path, files: dict[str, bytes], *, cache: bool = True):
    root, data = tmp_path / "resources", tmp_path / "data"
    root.mkdir(); data.mkdir()
    for name, content in files.items():
        (root / name).write_bytes(content)
    cache_dir = (tmp_path / "cache") if cache else None
    return create_app(resource_root=root, data_root=data, cache_dir=cache_dir), data, tmp_path / "cache"


def _bindings(db_path):
    connection = sqlite3.connect(db_path)
    try:
        objects = connection.execute("SELECT count(*) FROM thumbnail_objects").fetchone()[0]
        bindings = connection.execute("SELECT virtual_path, local_path, thumbnail_id FROM thumbnail_bindings").fetchall()
        return objects, bindings
    finally:
        connection.close()


def test_cache_root_is_explicit_or_derived_as_data_sibling(tmp_path):
    root, data = tmp_path / "resources", tmp_path / "data"
    root.mkdir(); data.mkdir()
    explicit = create_app(resource_root=root, data_root=data, cache_dir=tmp_path / "picked")
    assert explicit.state.thumbnail_store.root == (tmp_path / "picked").resolve()
    assert (tmp_path / "picked" / DATABASE_PATH).is_file()
    derived = create_app(resource_root=root, data_root=data)
    assert derived.state.thumbnail_store.root == (tmp_path / "cache").resolve()
    assert derived.state.thumbnail_store.root != data.resolve()
    assert (tmp_path / "cache" / DATABASE_PATH).is_file()
    assert not (data / "flightarchive" / "v1" / "thumbnails").exists()


def test_thumbnail_source_limit_defaults_to_256_mib_and_retains_pixel_guard(tmp_path):
    application, _, _ = app(tmp_path, {})
    store = application.state.thumbnail_store
    assert store.max_source_bytes == 256 * 1024 * 1024 == DEFAULT_MAX_SOURCE_BYTES
    assert store.max_source_pixels == 100_000_000


def test_queued_thumbnail_miss_rechecks_cache_before_fetching_source(tmp_path, monkeypatch):
    application, _, _ = app(tmp_path, {"ticket.png": _image_bytes()})
    store = application.state.thumbnail_store
    lifecycle = application.state.resource_lifecycle
    cached: Thumbnail | None = None
    state_lock = threading.Lock()
    source_started = threading.Event()
    release_source = threading.Event()
    second_lookup = threading.Event()
    source_fetches = 0
    lookup_calls = 0
    thumbnail = Thumbnail("cached", b"webp", 1, 1)
    responses = []

    def lookup(_virtual_path, _local_path, _source_etag):
        nonlocal lookup_calls
        with state_lock:
            lookup_calls += 1
            if lookup_calls >= 2:
                second_lookup.set()
            return cached

    def get_or_create(_virtual_path, _local_path, _source_etag, _source):
        nonlocal cached
        with state_lock:
            cached = thumbnail
        return thumbnail

    async def resource_bytes(_virtual_path, *, max_bytes):
        nonlocal source_fetches
        assert max_bytes == store.max_source_bytes
        with state_lock:
            source_fetches += 1
        source_started.set()
        await asyncio.to_thread(release_source.wait)
        return b"source", '"source"'

    monkeypatch.setattr(store, "lookup", lookup)
    monkeypatch.setattr(store, "get_or_create", get_or_create)
    monkeypatch.setattr(lifecycle, "resource_bytes", resource_bytes)

    with TestClient(application) as client:
        assert client.post("/api/resources/sync").json()["added"] == 1
        def request_thumbnail():
            responses.append(client.get("/images/inbox/ticket.png"))

        first = threading.Thread(target=request_thumbnail)
        first.start()
        assert source_started.wait(timeout=2)
        second = threading.Thread(target=request_thumbnail)
        second.start()
        assert second_lookup.wait(timeout=2)
        release_source.set()
        first.join(timeout=2)
        second.join(timeout=2)

    assert not first.is_alive()
    assert not second.is_alive()
    assert [response.status_code for response in responses] == [200, 200]
    assert source_fetches == 1


def test_thumbnail_is_generated_lazily_and_reused(tmp_path):
    application, _, cache = app(tmp_path, {"ticket.png": _image_bytes()})
    database = cache / DATABASE_PATH
    with TestClient(application) as client:
        assert client.post("/api/resources/sync").json()["added"] == 1
        assert _bindings(database) == (0, [])
        first = client.get("/images/inbox/ticket.png")
        assert first.status_code == 200
        assert first.headers["content-type"] == "image/webp"
        assert first.headers["x-content-type-options"] == "nosniff"
        thumbnail = Image.open(io.BytesIO(first.content))
        assert thumbnail.format == "WEBP"
        assert thumbnail.size == (512, 384)
        objects, bindings = _bindings(database)
        assert objects == 1
        assert [row[:2] for row in bindings] == [("inbox/ticket.png", "ticket.png")]
        second = client.get("/images/inbox/ticket.png")
        assert second.status_code == 200 and second.headers["etag"] == first.headers["etag"]
        assert client.get("/images/inbox/ticket.png", headers={"If-None-Match": first.headers["etag"]}).status_code == 304
        head = client.head("/images/inbox/ticket.png")
        assert head.status_code == 200 and head.headers["etag"] == first.headers["etag"]
        # The cached object is reused; nothing is regenerated on repeat reads.
        assert _bindings(database)[0] == 1


def test_thumbnail_revalidates_an_in_place_source_replacement_before_304(tmp_path):
    application, _, cache = app(tmp_path, {"ticket.png": _image_bytes(color=(200, 30, 30))})
    source = tmp_path / "resources" / "ticket.png"
    database = cache / DATABASE_PATH
    with TestClient(application) as client:
        assert client.post("/api/resources/sync").json()["added"] == 1
        original = client.get("/images/inbox/ticket.png")
        assert original.status_code == 200
        # Do not synchronize manually. RFG rejects its stale scan, which the
        # image route refreshes before using the cached thumbnail binding.
        source.write_bytes(_image_bytes(color=(30, 30, 200)))
        replacement = client.get("/images/inbox/ticket.png", headers={"If-None-Match": original.headers["etag"]})
        assert replacement.status_code == 200
        assert replacement.headers["etag"] != original.headers["etag"]
        assert client.get("/images/inbox/ticket.png", headers={"If-None-Match": replacement.headers["etag"]}).status_code == 304
        rfg_etag = client.head("/res/inbox/ticket.png").headers["etag"]

    connection = sqlite3.connect(database)
    try:
        assert connection.execute(
            "SELECT source_etag FROM thumbnail_bindings WHERE virtual_path = ?", ("inbox/ticket.png",)
        ).fetchone() == (rfg_etag,)
    finally:
        connection.close()


def test_large_jpeg_uses_decoder_draft_before_pixel_limit(tmp_path):
    buffer = io.BytesIO()
    Image.new("RGB", (4000, 3000), (20, 40, 60)).save(buffer, "JPEG")
    application, _, _ = app(tmp_path, {"large.jpg": buffer.getvalue()})
    application.state.thumbnail_store.max_source_pixels = 3_000_000
    with TestClient(application) as client:
        assert client.post("/api/resources/sync").status_code == 200
        preview = client.get("/images/inbox/large.jpg")
        assert preview.status_code == 200
        assert Image.open(io.BytesIO(preview.content)).size[0] <= 512


def test_paper_preview_rejects_an_oversized_jpeg_before_crop_sampling(tmp_path):
    """Paper previews currently check full JPEG dimensions; unlike /images they do not draft."""
    buffer = io.BytesIO()
    Image.new("RGB", (4000, 3000), (20, 40, 60)).save(buffer, "JPEG")
    application, _, _ = app(tmp_path, {"large.jpg": buffer.getvalue()})
    application.state.thumbnail_store.max_source_pixels = 3_000_000
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        payload = _flight_payload("inbox/large.jpg")
        payload["paperBoardingPassLayouts"] = {"paperBoardingPassFront": _layout(center_x=2000, center_y=1500, width=320, height=160)}
        flight = client.post("/api/flights", json=payload).json()["flight"]

        response = client.get(f"/api/flights/{flight['id']}/boarding-passes/paperBoardingPassFront/preview")

    assert response.status_code == 422
    assert response.json()["error"] == {
        "code": "boarding-pass-preview-unavailable",
        "message": "image exceeds the decoder pixel safety limit",
    }


def test_images_rejects_unmapped_non_decodable_and_non_raster(tmp_path):
    files = {"note.txt": b"plain text", "vector.svg": b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', "empty.png": b""}
    application, _, cache = app(tmp_path, files)
    with TestClient(application) as client:
        assert client.post("/api/resources/sync").json()["added"] == 3
        missing = client.get("/images/nowhere/missing.png")
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "resource-not-found"
        for path in ("inbox/note.txt", "inbox/vector.svg", "inbox/empty.png"):
            rejected = client.get(f"/images/{path}")
            assert rejected.status_code == 415
            assert rejected.json()["error"]["code"] == "image-unsupported"
        # Failed renders never leave bindings or objects behind.
        assert _bindings(cache / DATABASE_PATH) == (0, [])
        # The original delivery route is untouched by the image-only policy.
        assert client.get("/res/inbox/note.txt").status_code == 200
        assert client.get("/res/inbox/vector.svg").status_code == 200


def test_classify_moves_thumbnail_binding_without_regeneration(tmp_path):
    application, _, cache = app(tmp_path, {"ticket.png": _image_bytes()})
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        original = client.get("/images/inbox/ticket.png")
        assert original.status_code == 200
        classified = client.post(
            "/api/flights",
            json={
                "flightNumber": "1",
                "airlineCode": "CA",
                "departureAirport": "PEK",
                "arrivalAirport": "SHA",
                "departureDate": "2026-01-01",
                "paperBoardingPassFrontResourcePath": "inbox/ticket.png",
            },
        )
        assert classified.status_code == 201
        target = classified.json()["flight"]["paperBoardingPassFrontResourcePath"]
        moved = client.get(f"/images/{target}")
        assert moved.status_code == 200
        assert moved.headers["etag"] == original.headers["etag"]
        assert client.get("/images/inbox/ticket.png").status_code == 404
        objects, bindings = _bindings(cache / DATABASE_PATH)
        assert objects == 1
        assert [row[:2] for row in bindings] == [(target, "ticket.png")]


def test_flight_submission_background_task_persists_every_image_fingerprint(tmp_path):
    application, _, _ = app(tmp_path, {"ticket.png": _image_bytes()})
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        created = client.post(
            "/api/flights",
            json={
                "flightNumber": "1",
                "airlineCode": "CA",
                "departureAirport": "PEK",
                "arrivalAirport": "SHA",
                "departureDate": "2026-01-01",
                "paperBoardingPassFrontResourcePath": "inbox/ticket.png",
            },
        )
        assert created.status_code == 201
        path = created.json()["flight"]["paperBoardingPassFrontResourcePath"]
        deadline = time.monotonic() + 5
        task = None
        while time.monotonic() < deadline:
            task = client.get("/api/tasks").json()["tasks"][0]
            if task["state"] in {"succeeded", "failed"}:
                break
            time.sleep(0.01)
        assert task is not None and task["state"] == "succeeded"
        assert all(item["state"] == "succeeded" for item in task["items"])
        entry = next(item for item in client.get("/api/v1/meta/map").json()["entries"] if item["virtual_path"] == path)
        assert all(entry[algorithm] for algorithm in ("crc32", "md5", "sha256", "ahash", "dhash", "phash"))


def test_lookup_invalidates_binding_when_mapping_changes_externally(tmp_path):
    files = {"first.png": _image_bytes(color=(200, 30, 30)), "second.png": _image_bytes(color=(30, 30, 200))}
    application, _, cache = app(tmp_path, files)
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        first = client.get("/images/inbox/first.png")
        assert first.status_code == 200
        # An external actor retargets the virtual path to another local file.
        mapping = client.get("/api/v1/meta/map")
        document = mapping.json()
        entry = next(item for item in document["entries"] if item["virtual_path"] == "inbox/first.png")
        entry["local_path"] = "second.png"
        document["entries"] = [item for item in document["entries"] if item["virtual_path"] != "inbox/second.png"]
        assert client.put("/api/v1/meta/map", json=document, headers={"If-Match": mapping.headers["etag"]}).status_code == 200
        regenerated = client.get("/images/inbox/first.png")
        assert regenerated.status_code == 200
        assert regenerated.headers["etag"] != first.headers["etag"]
        objects, bindings = _bindings(cache / DATABASE_PATH)
        assert [row[:2] for row in bindings] == [("inbox/first.png", "second.png")]
        # The orphaned first object was garbage-collected after regeneration.
        assert objects == 1


def test_rematch_replaces_stale_target_with_candidate_thumbnail(tmp_path):
    files = {"ticket.png": _image_bytes(color=(200, 30, 30)), "replacement.png": _image_bytes(color=(30, 200, 30))}
    application, _, cache = app(tmp_path, files)
    root = tmp_path / "resources"
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        mapping = client.get("/api/v1/meta/map")
        document = mapping.json()
        ticket = next(item for item in document["entries"] if item["local_path"] == "ticket.png")
        document["entries"] = [item for item in document["entries"] if item is not ticket]
        document["entries"].append({"virtual_path": "old/missing.png", "local_path": "ticket.png"})
        assert client.put("/api/v1/meta/map", json=document, headers={"If-Match": mapping.headers["etag"]}).status_code == 200
        stale = client.get("/images/old/missing.png")
        assert stale.status_code == 200
        candidate_etag = client.get("/images/inbox/replacement.png").headers["etag"]
        assert candidate_etag != stale.headers["etag"]
        # The target file disappears and the candidate replaces it.
        (root / "ticket.png").unlink()
        client.post("/api/resources/sync")
        response = client.post("/api/resources/rematches", json={"matches": [{"targetVirtualPath": "old/missing.png", "candidateInboxVirtualPath": "inbox/replacement.png"}]})
        assert response.status_code == 200
        rebound = client.get("/images/old/missing.png")
        assert rebound.status_code == 200
        assert rebound.headers["etag"] == candidate_etag
        objects, bindings = _bindings(cache / DATABASE_PATH)
        assert [row[:2] for row in bindings] == [("old/missing.png", "replacement.png")]
        # The stale target object was eliminated; only the candidate's remains.
        assert objects == 1


def _flight_payload(path: str | None = None, *, number: str = "1"):
    payload = {
        "flightNumber": number,
        "airlineCode": "CA",
        "departureAirport": "PEK",
        "arrivalAirport": "SHA",
        "departureDate": "2026-01-01",
    }
    if path is not None:
        payload["paperBoardingPassFrontResourcePath"] = path
    return payload


def _layout(corners=None, *, center_x=320, center_y=240, width=320, height=160, rotation=0):
    return {
        "schemaVersion": 1, "algorithm": "canny", "templateId": "default.svg",
        "crop": {"centerX": center_x, "centerY": center_y, "width": width, "height": height, "rotationDegrees": rotation,
                 **({"corners": [{"x": x, "y": y} for x, y in corners]} if corners is not None else {})},
        "placement": {"scale": 1, "rotationDegrees": 0, "offsetX": 0, "offsetY": 0},
    }


def test_deleting_last_flight_releases_mapping_and_rebinds_thumbnail_to_inbox(tmp_path):
    application, _, cache = app(tmp_path, {"ticket.png": _image_bytes()})
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        client.get("/images/inbox/ticket.png")
        created = client.post("/api/flights", json=_flight_payload("inbox/ticket.png"))
        assert created.status_code == 201
        path = created.json()["flight"]["paperBoardingPassFrontResourcePath"]
        assert client.delete(f"/api/flights/{created.json()['flight']['id']}").status_code == 200
        assert not any(item["virtual_path"] == path for item in client.get("/api/v1/meta/map").json()["entries"])
    assert _bindings(cache / DATABASE_PATH)[1][0][:2] == ("inbox/ticket.png", "ticket.png")


def test_shared_flight_and_airline_references_retain_mapping(tmp_path):
    application, _, cache = app(tmp_path, {"ticket.png": _image_bytes()})
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        client.get("/images/inbox/ticket.png")
        first = client.post("/api/flights", json=_flight_payload("inbox/ticket.png")).json()["flight"]
        path = first["paperBoardingPassFrontResourcePath"]
        second = client.post("/api/flights", json=_flight_payload(path, number="2")).json()["flight"]
        airline = client.put("/api/catalogs/airlines/CA", json={"nameEn": "Air China", "horizontalLogoResourcePath": path})
        assert airline.status_code == 200
        assert client.delete(f"/api/flights/{first['id']}").status_code == 200
        assert client.delete(f"/api/flights/{second['id']}").status_code == 200
        assert any(item["virtual_path"] == path for item in client.get("/api/v1/meta/map").json()["entries"])
        assert _bindings(cache / DATABASE_PATH)[1][0][:2] == (path, "ticket.png")
        assert client.delete("/api/catalogs/airlines/CA").status_code == 200
        assert not any(item["virtual_path"] == path for item in client.get("/api/v1/meta/map").json()["entries"])
    assert _bindings(cache / DATABASE_PATH)[1][0][:2] == ("inbox/ticket.png", "ticket.png")


def test_sync_drops_thumbnail_and_temporary_mapping_for_disappeared_inbox_source(tmp_path):
    application, _, cache = app(tmp_path, {"ticket.png": _image_bytes()})
    source = tmp_path / "resources" / "ticket.png"
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        assert client.get("/images/inbox/ticket.png").status_code == 200
        source.unlink()
        assert client.post("/api/resources/sync").status_code == 200
        assert not any(item["virtual_path"] == "inbox/ticket.png" for item in client.get("/api/v1/meta/map").json()["entries"])
    assert _bindings(cache / DATABASE_PATH) == (0, [])


def test_boarding_pass_preview_is_rotated_rectangular_crop_cached_and_cleaned(tmp_path):
    source = Image.new("RGB", (640, 480), "black")
        # The selected rectangle contains this red document; its surrounding pixels are
    # blue, proving the endpoint is not returning the source thumbnail.
    for x in range(140, 500):
        for y in range(140, 340):
            source.putpixel((x, y), (220, 20, 20))
    buffer = io.BytesIO(); source.save(buffer, "PNG")
    application, _, cache = app(tmp_path, {"ticket.png": buffer.getvalue()})
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        payload = _flight_payload("inbox/ticket.png")
        payload["paperBoardingPassLayouts"] = {"paperBoardingPassFront": _layout([(140, 140), (500, 140), (500, 340), (140, 340)])}
        created = client.post("/api/flights", json=payload)
        assert created.status_code == 201
        flight = created.json()["flight"]
        url = f"/api/flights/{flight['id']}/boarding-passes/paperBoardingPassFront/preview"
        first = client.get(url)
        assert first.status_code == 200 and first.headers["content-type"] == "image/webp"
        rendered = Image.open(io.BytesIO(first.content))
        assert rendered.size == (320, 160)
        assert rendered.convert("RGB").getpixel((180, 100))[0] > 150
        assert client.get(url, headers={"If-None-Match": first.headers["etag"]}).status_code == 304
        # A layout mutation discards the old flight-specific derivative.
        updated = client.put(f"/api/flights/{flight['id']}", json={"paperBoardingPassLayouts": {
            "paperBoardingPassFront": _layout(width=300, height=140)
        }})
        assert updated.status_code == 200
        second = client.get(url)
        assert second.status_code == 200 and second.headers["etag"] != first.headers["etag"]
        assert client.delete(f"/api/flights/{flight['id']}").status_code == 200
    assert _bindings(cache / DATABASE_PATH) == (0, [])


def test_boarding_pass_preview_requires_a_saved_crop(tmp_path):
    application, _, _ = app(tmp_path, {"ticket.png": _image_bytes()})
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        flight = client.post("/api/flights", json=_flight_payload("inbox/ticket.png")).json()["flight"]
        response = client.get(f"/api/flights/{flight['id']}/boarding-passes/paperBoardingPassFront/preview")
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "boarding-pass-preview-unavailable"


def test_boarding_pass_preview_keeps_rotated_rectangle_pixel_orientation(tmp_path):
    """A +90° rectangle is clockwise in Canvas/rectToQuad coordinates.

    Four coloured source quadrants make a sign inversion visibly detectable:
    the returned upright crop must retain TL/TR/BL/BR order, rather than merely
    contain the selected central colour.
    """
    source = Image.new("RGB", (640, 480), "black")
    colors = ((230, 20, 20), (20, 220, 20), (20, 20, 230), (220, 220, 20))
    center_x, center_y, crop_width, crop_height = 320, 240, 200, 100
    # Source coordinates for a +90° rectToQuad rectangle: (x, y) -> (-y, x).
    for local_x in range(-crop_width // 2, crop_width // 2):
        for local_y in range(-crop_height // 2, crop_height // 2):
            quadrant = (local_y >= 0) * 2 + (local_x >= 0)
            source.putpixel((center_x - local_y, center_y + local_x), colors[quadrant])
    buffer = io.BytesIO(); source.save(buffer, "PNG")
    application, _, _ = app(tmp_path, {"ticket.png": buffer.getvalue()})
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        payload = _flight_payload("inbox/ticket.png")
        payload["paperBoardingPassLayouts"] = {
            "paperBoardingPassFront": _layout(center_x=center_x, center_y=center_y, width=crop_width, height=crop_height, rotation=90)
        }
        flight = client.post("/api/flights", json=payload).json()["flight"]
        response = client.get(f"/api/flights/{flight['id']}/boarding-passes/paperBoardingPassFront/preview")
        assert response.status_code == 200
        rendered = Image.open(io.BytesIO(response.content)).convert("RGB")
        assert rendered.size == (200, 100)
        # Sample well inside every quadrant to avoid rotation and WebP edges.
        assert max(range(3), key=lambda channel: rendered.getpixel((50, 25))[channel]) == 0  # TL red
        assert max(range(3), key=lambda channel: rendered.getpixel((150, 25))[channel]) == 1  # TR green
        assert max(range(3), key=lambda channel: rendered.getpixel((50, 75))[channel]) == 2  # BL blue
        bottom_right = rendered.getpixel((150, 75))
        assert bottom_right[0] > 150 and bottom_right[1] > 150 and bottom_right[2] < 100  # BR yellow


def test_boarding_pass_preview_keeps_an_off_center_rotated_rectangle_inside_source(tmp_path):
    """A valid rotated rectangle must not inherit clipping from whole-image rotation."""
    source = Image.new("RGB", (640, 480), "black")
    center_x, center_y, crop_width, crop_height = 60, 240, 400, 80
    # This +90° rectangle is narrow in source X and tall in source Y. It is
    # fully in bounds, although an upright 400px crop around x=60 is not.
    for x in range(20, 101):
        for y in range(40, 441):
            source.putpixel((x, y), (220, 20, 20))
    buffer = io.BytesIO(); source.save(buffer, "PNG")
    application, _, _ = app(tmp_path, {"ticket.png": buffer.getvalue()})
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        payload = _flight_payload("inbox/ticket.png")
        payload["paperBoardingPassLayouts"] = {
            "paperBoardingPassFront": _layout(center_x=center_x, center_y=center_y, width=crop_width, height=crop_height, rotation=90)
        }
        flight = client.post("/api/flights", json=payload).json()["flight"]
        response = client.get(f"/api/flights/{flight['id']}/boarding-passes/paperBoardingPassFront/preview")
        assert response.status_code == 200
        rendered = Image.open(io.BytesIO(response.content)).convert("RGB")
        # The left side used to be black because Image.rotate clipped it before
        # the final crop. It is a valid part of the selected source rectangle.
        assert rendered.getpixel((50, 40))[0] > 150


def test_boarding_pass_preview_accepts_inclusive_right_and_bottom_source_edges(tmp_path):
    application, _, _ = app(tmp_path, {"ticket.png": _image_bytes(size=(640, 480))})
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        payload = _flight_payload("inbox/ticket.png")
        # ScanStudio's canvas coordinates deliberately use the inclusive outer
        # boundary, rather than Pillow's half-open pixel sample coordinates.
        payload["paperBoardingPassLayouts"] = {"paperBoardingPassFront": _layout(center_x=320, center_y=240, width=640, height=480)}
        flight = client.post("/api/flights", json=payload).json()["flight"]
        response = client.get(f"/api/flights/{flight['id']}/boarding-passes/paperBoardingPassFront/preview")
        assert response.status_code == 200
        assert Image.open(io.BytesIO(response.content)).size == (512, 384)


def test_boarding_pass_preview_ignores_legacy_corners_and_rejects_out_of_bounds_rectangle(tmp_path):
    application, _, _ = app(tmp_path, {"ticket.png": _image_bytes()})
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        payload = _flight_payload("inbox/ticket.png")
        payload["paperBoardingPassLayouts"] = {"paperBoardingPassFront": _layout([(100, 100), (500, 100), (250, 150), (100, 300)])}
        created = client.post("/api/flights", json=payload)
        assert created.status_code == 201
        flight = created.json()["flight"]
        url = f"/api/flights/{flight['id']}/boarding-passes/paperBoardingPassFront/preview"
        first = client.get(url)
        assert first.status_code == 200
        # Corrupt legacy corners do not affect the canonical geometry or ETag.
        application.state.flightarchive_workspace.domain.get_flight(flight["id"]).paperBoardingPassLayouts["paperBoardingPassFront"].crop["corners"] = "ignored"
        assert client.get(url).headers["etag"] == first.headers["etag"]
        application.state.flightarchive_workspace.domain.get_flight(flight["id"]).paperBoardingPassLayouts["paperBoardingPassFront"].crop["centerX"] = 10
        response = client.get(url)
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "boarding-pass-preview-unavailable"


def test_sync_discards_preview_for_missing_source_but_retains_rfg_mapping(tmp_path):
    application, _, cache = app(tmp_path, {"ticket.png": _image_bytes()})
    source = tmp_path / "resources" / "ticket.png"
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        payload = _flight_payload("inbox/ticket.png")
        payload["paperBoardingPassLayouts"] = {"paperBoardingPassFront": _layout(center_x=320, center_y=240, width=600, height=440)}
        flight = client.post("/api/flights", json=payload).json()["flight"]
        url = f"/api/flights/{flight['id']}/boarding-passes/paperBoardingPassFront/preview"
        assert client.get(url).status_code == 200
        source.unlink()
        assert client.post("/api/resources/sync").status_code == 200
        # The stable mapping remains available to RFG's rematch workflow, while
        # its image derivatives are deliberately disposable.
        assert any(entry["virtual_path"] == flight["paperBoardingPassFrontResourcePath"] for entry in client.get("/api/v1/meta/map").json()["entries"])
    assert _bindings(cache / DATABASE_PATH) == (0, [])


def test_failed_creation_releases_newly_materialized_mapping_and_rebinds_thumbnail(tmp_path, monkeypatch):
    application, _, cache = app(tmp_path, {"ticket.png": _image_bytes()})
    workspace = application.state.flightarchive_workspace
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        client.get("/images/inbox/ticket.png")
        monkeypatch.setattr(workspace, "persist_business_data", lambda: (_ for _ in ()).throw(BusinessDataError("write failed")))
        failed = client.post("/api/flights", json=_flight_payload("inbox/ticket.png"))
        assert failed.status_code == 500
        assert client.get("/api/v1/meta/map").json()["entries"] == [{"virtual_path": "inbox/ticket.png", "local_path": "ticket.png"}]
    assert _bindings(cache / DATABASE_PATH)[1][0][:2] == ("inbox/ticket.png", "ticket.png")


def test_manual_release_rebinds_thumbnail_and_clears_fingerprint_metadata(tmp_path):
    application, _, cache = app(tmp_path, {"ticket.png": _image_bytes()})
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        assert client.get("/images/inbox/ticket.png").status_code == 200
        mapping_response = client.get("/api/v1/meta/map")
        document, etag = mapping_response.json(), mapping_response.headers["etag"]
        document["entries"][0].update({"virtual_path": "object.png", "size_bytes": 123, "sha256": "stale"})
        assert client.put("/api/v1/meta/map", json=document, headers={"If-Match": etag}).status_code == 200
        # This mimics an object mapping with an existing generic cache binding.
        assert client.get("/images/object.png").status_code == 200
        etag = client.get("/api/v1/meta/map").headers["etag"]
        released = client.post("/api/resources/release", json={"ifMatch": etag, "virtualPaths": ["object.png"]})
        assert released.status_code == 200
        payload = released.json()
        assert payload["released"] == ["object.png"]
        entry = payload["mapping"]["entries"][0]
        assert entry["virtual_path"] == "inbox/ticket.png"
        assert entry["size_bytes"] == 123 and "sha256" not in entry
    assert _bindings(cache / DATABASE_PATH)[1][0][:2] == ("inbox/ticket.png", "ticket.png")


def test_manual_release_rejects_stale_missing_or_referenced_paths_without_changes(tmp_path):
    application, _, _ = app(tmp_path, {"ticket.png": _image_bytes(), "lost.png": _image_bytes()})
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        document_response = client.get("/api/v1/meta/map")
        document, etag = document_response.json(), document_response.headers["etag"]
        entries = {entry["local_path"]: entry for entry in document["entries"]}
        entries["ticket.png"]["virtual_path"] = "object.png"
        entries["lost.png"]["virtual_path"] = "lost-object.png"
        assert client.put("/api/v1/meta/map", json=document, headers={"If-Match": etag}).status_code == 200
        current = client.get("/api/v1/meta/map")
        current_etag = current.headers["etag"]
        flight = client.post("/api/flights", json=_flight_payload("object.png"))
        assert flight.status_code == 201
        before = client.get("/api/v1/meta/map").json()
        assert client.post("/api/resources/release", json={"ifMatch": '"stale"', "virtualPaths": ["lost-object.png"]}).status_code == 409
        assert client.get("/api/v1/meta/map").json() == before
        assert client.post("/api/resources/release", json={"ifMatch": current_etag, "virtualPaths": ["object.png"]}).status_code == 409
        assert client.get("/api/v1/meta/map").json() == before
        (tmp_path / "resources" / "lost.png").unlink()
        assert client.post("/api/resources/release", json={"ifMatch": None, "virtualPaths": ["lost-object.png"]}).status_code == 422
        assert client.get("/api/v1/meta/map").json() == before
        assert client.post("/api/resources/release", json={"ifMatch": None, "virtualPaths": ["missing.png"]}).status_code == 404
        assert client.get("/api/v1/meta/map").json() == before


def test_failed_automatic_release_is_repaired_by_a_later_sync(tmp_path, monkeypatch):
    application, _, _ = app(tmp_path, {"ticket.png": _image_bytes()})
    lifecycle = application.state.resource_lifecycle
    original_request = lifecycle._request
    fail_once = True

    async def transient_put(method, path, **kwargs):
        nonlocal fail_once
        if method == "PUT" and path == "/api/v1/meta/map" and fail_once:
            fail_once = False
            class FailedResponse:
                status_code = 503
            return FailedResponse()
        return await original_request(method, path, **kwargs)

    with TestClient(application) as client:
        client.post("/api/resources/sync")
        flight = client.post("/api/flights", json=_flight_payload("inbox/ticket.png")).json()["flight"]
        monkeypatch.setattr(lifecycle, "_request", transient_put)
        assert client.delete(f"/api/flights/{flight['id']}").status_code == 200
        assert lifecycle.deferred_releases
        assert client.post("/api/resources/sync").status_code == 200
        assert not lifecycle.deferred_releases
        assert client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"] == "inbox/ticket.png"


def test_manual_release_waits_for_the_business_resource_critical_section(tmp_path):
    application, _, _ = app(tmp_path, {"ticket.png": _image_bytes()})
    lifecycle = application.state.resource_lifecycle
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        document_response = client.get("/api/v1/meta/map")
        document, etag = document_response.json(), document_response.headers["etag"]
        document["entries"][0]["virtual_path"] = "object.png"
        assert client.put("/api/v1/meta/map", json=document, headers={"If-Match": etag}).status_code == 200
        etag = client.get("/api/v1/meta/map").headers["etag"]

        async def exercise():
            async with lifecycle.business_lock:
                task = asyncio.create_task(lifecycle.release({"ifMatch": etag, "virtualPaths": ["object.png"]}))
                await asyncio.sleep(0)
                assert not task.done()
            return await task

        assert asyncio.run(exercise())["released"] == ["object.png"]


def test_workspace_reset_releases_resources_and_discards_old_previews(tmp_path):
    application, _, cache = app(tmp_path, {"ticket.png": _image_bytes()})
    with TestClient(application) as client:
        client.post("/api/resources/sync")
        payload = _flight_payload("inbox/ticket.png")
        payload["paperBoardingPassLayouts"] = {"paperBoardingPassFront": _layout([(20, 20), (620, 20), (620, 460), (20, 460)])}
        flight = client.post("/api/flights", json=payload).json()["flight"]
        assert client.get(f"/api/flights/{flight['id']}/boarding-passes/paperBoardingPassFront/preview").status_code == 200
        assert client.post("/api/workspace/reset").status_code == 200
        assert client.get("/api/v1/meta/map").json()["entries"][0]["virtual_path"] == "inbox/ticket.png"
    assert all(not path.startswith("preview/") for path, _, _ in _bindings(cache / DATABASE_PATH)[1])
