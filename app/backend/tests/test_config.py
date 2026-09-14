# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Focused tests for the restart-only runtime configuration.

Covers the strict preview-config.json contract (seed, validation, startup
rejection with file preservation), wiring into the thumbnail store and job
semaphore, exact source-byte boundaries, controlled decompression-bomb 415s,
cache reprofiling when thumbnail settings change, and the Pillow/RFG
import-order guarantee via an isolated subprocess.
"""
from __future__ import annotations

import io
import json
import os
import sqlite3
import struct
import subprocess
import sys
import textwrap
import zlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from flightarchive.config import (
    CONFIG_MAX_BYTES,
    ConfigError,
    config_path,
    default_config_document,
)
from flightarchive.server import create_app
from flightarchive.thumbnails import (
    DATABASE_PATH,
    ThumbnailStore,
    UnsupportedImageError,
    render_webp,
    thumbnail_profile_id,
)


def _image_bytes(fmt: str = "PNG", size: tuple[int, int] = (640, 480), color: tuple[int, int, int] = (200, 30, 30)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, fmt)
    return buffer.getvalue()


def _noise_png() -> bytes:
    """A real, decodable PNG just over the 1 MiB minimum configurable limit."""
    image = Image.frombytes("RGB", (1024, 512), os.urandom(1024 * 512 * 3))
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    data = buffer.getvalue()
    assert len(data) > 1024 * 1024
    return data


def _bomb_png() -> bytes:
    """Valid PNG header declaring 10^10 pixels; raises at Image.open time."""
    def chunk(tag: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", 100000, 100000, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IEND", b"")


def _bomb_jpeg() -> bytes:
    """A real JPEG whose SOF0 dimensions are patched to 65535x65535."""
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), (10, 20, 30)).save(buffer, "JPEG")
    raw = bytearray(buffer.getvalue())
    offset = raw.find(b"\xff\xc0")
    assert offset > 0
    raw[offset + 5:offset + 9] = struct.pack(">HH", 65535, 65535)
    return bytes(raw)


def _roots(tmp_path: Path, files: dict[str, bytes] | None = None):
    root, data, cache = tmp_path / "resources", tmp_path / "data", tmp_path / "cache"
    root.mkdir(); data.mkdir()
    for name, content in (files or {}).items():
        (root / name).write_bytes(content)
    return root, data, cache


def _write_config(data: Path, document) -> Path:
    path = config_path(data)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


def _cache_rows(db_path: Path):
    connection = sqlite3.connect(db_path)
    try:
        bindings = connection.execute("SELECT virtual_path, profile FROM thumbnail_bindings").fetchall()
        objects = connection.execute("SELECT count(*) FROM thumbnail_objects").fetchone()[0]
        return bindings, objects
    finally:
        connection.close()


def test_default_config_is_seeded_and_business_data_is_not_contaminated(tmp_path):
    root, data, cache = _roots(tmp_path)
    application = create_app(resource_root=root, data_root=data, cache_dir=cache)
    path = config_path(data)
    assert path.is_file() and not path.is_symlink()
    on_disk = json.loads(path.read_text(encoding="utf-8"))
    assert on_disk == default_config_document()
    assert set(on_disk) == {"schemaVersion", "thumbnails", "rfg"}
    assert set(on_disk["thumbnails"]) == {"maxSourceBytes", "maxSourcePixels", "maxDimension", "quality", "jobConcurrency"}
    assert set(on_disk["rfg"]) == {"pillowImageMaxPixels"}
    # Seeding happens exactly once; a second startup reuses the same bytes.
    seeded = path.read_bytes()
    create_app(resource_root=root, data_root=data, cache_dir=cache)
    assert path.read_bytes() == seeded

    with TestClient(application) as client:
        created = client.post("/api/flights", json={"flightNumber": "1", "airlineCode": "CA", "departureAirport": "PEK", "arrivalAirport": "SHA", "departureDate": "2026-01-01"})
        assert created.status_code == 201
    business = json.loads((data / "flightarchive" / "v1" / "business-data.json").read_text(encoding="utf-8"))
    # The config module is dedicated: business data gains no config keys and
    # the config file carries no business keys.
    assert set(business) == {"schemaVersion", "airlines", "airports", "aircraftTypes", "flights", "settings"}
    assert "thumbnails" not in business and "rfg" not in business


def test_valid_custom_limits_are_wired_into_store_and_semaphore(tmp_path):
    root, data, cache = _roots(tmp_path, {"ticket.png": _image_bytes()})
    document = default_config_document()
    document["thumbnails"] = {
        "maxSourceBytes": 2 * 1024 * 1024,
        "maxSourcePixels": 2_000_000,
        "maxDimension": 256,
        "quality": 40,
        "jobConcurrency": 1,
    }
    document["rfg"] = {"pillowImageMaxPixels": 3_000_000}
    _write_config(data, document)
    application = create_app(resource_root=root, data_root=data, cache_dir=cache)
    store = application.state.thumbnail_store
    assert store.max_source_bytes == 2 * 1024 * 1024
    assert store.max_source_pixels == 2_000_000
    assert store.max_dimension == 256
    assert store.quality == 40
    assert store.profile == thumbnail_profile_id(
        max_dimension=256, quality=40, max_source_bytes=2 * 1024 * 1024, max_source_pixels=2_000_000
    )
    assert application.state.thumbnail_job_limiter._value == 1
    assert application.state.runtime_config.thumbnails.job_concurrency == 1
    assert application.state.runtime_config.rfg.pillow_image_max_pixels == 3_000_000
    with TestClient(application) as client:
        assert client.post("/api/resources/sync").json()["added"] == 1
        response = client.get("/images/inbox/ticket.png")
        assert response.status_code == 200
        assert Image.open(io.BytesIO(response.content)).size == (256, 192)


def _mutated(change) -> dict:
    document = default_config_document()
    change(document)
    return document


INVALID_CONFIGS = [
    ("top-level unknown key", _mutated(lambda d: d.update(unknown=1))),
    ("top-level missing rfg", _mutated(lambda d: d.pop("rfg"))),
    ("top-level missing thumbnails", _mutated(lambda d: d.pop("thumbnails"))),
    ("thumbnails unknown key", _mutated(lambda d: d["thumbnails"].update(maxDim=512))),
    ("thumbnails missing quality", _mutated(lambda d: d["thumbnails"].pop("quality"))),
    ("rfg unknown key", _mutated(lambda d: d["rfg"].update(maxPixels=1))),
    ("schemaVersion future", _mutated(lambda d: d.update(schemaVersion=2))),
    ("schemaVersion string", _mutated(lambda d: d.update(schemaVersion="1"))),
    ("schemaVersion bool", _mutated(lambda d: d.update(schemaVersion=True))),
    ("schemaVersion float", _mutated(lambda d: d.update(schemaVersion=1.0))),
    ("maxSourceBytes bool", _mutated(lambda d: d["thumbnails"].update(maxSourceBytes=True))),
    ("maxSourceBytes float", _mutated(lambda d: d["thumbnails"].update(maxSourceBytes=268435456.0))),
    ("maxSourceBytes string", _mutated(lambda d: d["thumbnails"].update(maxSourceBytes="268435456"))),
    ("maxSourceBytes null", _mutated(lambda d: d["thumbnails"].update(maxSourceBytes=None))),
    ("maxSourceBytes below min", _mutated(lambda d: d["thumbnails"].update(maxSourceBytes=1024 * 1024 - 1))),
    ("maxSourceBytes above max", _mutated(lambda d: d["thumbnails"].update(maxSourceBytes=1024 ** 3 + 1))),
    ("maxSourcePixels below min", _mutated(lambda d: d["thumbnails"].update(maxSourcePixels=999_999))),
    ("maxSourcePixels above max", _mutated(lambda d: d["thumbnails"].update(maxSourcePixels=500_000_001))),
    ("maxDimension zero", _mutated(lambda d: d["thumbnails"].update(maxDimension=0))),
    ("maxDimension above max", _mutated(lambda d: d["thumbnails"].update(maxDimension=2049))),
    ("quality negative", _mutated(lambda d: d["thumbnails"].update(quality=-1))),
    ("quality above max", _mutated(lambda d: d["thumbnails"].update(quality=101))),
    ("jobConcurrency zero", _mutated(lambda d: d["thumbnails"].update(jobConcurrency=0))),
    ("jobConcurrency above max", _mutated(lambda d: d["thumbnails"].update(jobConcurrency=3))),
    ("jobConcurrency bool", _mutated(lambda d: d["thumbnails"].update(jobConcurrency=False))),
    ("pillowImageMaxPixels below min", _mutated(lambda d: d["rfg"].update(pillowImageMaxPixels=999_999))),
    ("pillowImageMaxPixels above max", _mutated(lambda d: d["rfg"].update(pillowImageMaxPixels=500_000_001))),
    ("pillowImageMaxPixels float", _mutated(lambda d: d["rfg"].update(pillowImageMaxPixels=100000000.5))),
    ("thumbnails not an object", _mutated(lambda d: d.update(thumbnails=[]))),
    ("rfg not an object", _mutated(lambda d: d.update(rfg=None))),
    ("top-level array", []),
    ("top-level string", "config"),
    ("top-level number", 5),
    ("top-level null", None),
    ("top-level bool", True),
]


@pytest.mark.parametrize("label,document", INVALID_CONFIGS, ids=[label for label, _ in INVALID_CONFIGS])
def test_invalid_config_aborts_startup_and_preserves_the_file(tmp_path, label, document):
    root, data, cache = _roots(tmp_path)
    path = _write_config(data, document)
    original = path.read_bytes()
    with pytest.raises(ConfigError):
        create_app(resource_root=root, data_root=data, cache_dir=cache)
    assert path.read_bytes() == original


def test_malformed_json_config_is_rejected_and_preserved(tmp_path):
    root, data, cache = _roots(tmp_path)
    path = config_path(data)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ not json", encoding="utf-8")
    with pytest.raises(ConfigError):
        create_app(resource_root=root, data_root=data, cache_dir=cache)
    assert path.read_text(encoding="utf-8") == "{ not json"


def test_oversized_config_is_rejected(tmp_path):
    root, data, cache = _roots(tmp_path)
    path = config_path(data)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(default_config_document()) + " " * (CONFIG_MAX_BYTES + 1), encoding="utf-8")
    with pytest.raises(ConfigError, match="byte limit"):
        create_app(resource_root=root, data_root=data, cache_dir=cache)


def test_symlinked_config_is_rejected(tmp_path):
    root, data, cache = _roots(tmp_path)
    target = tmp_path / "elsewhere.json"
    target.write_text(json.dumps(default_config_document()), encoding="utf-8")
    path = config_path(data)
    path.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(target, path)
    with pytest.raises(ConfigError, match="symlink"):
        create_app(resource_root=root, data_root=data, cache_dir=cache)
    assert path.is_symlink()


def test_non_regular_config_is_rejected(tmp_path):
    root, data, cache = _roots(tmp_path)
    config_path(data).mkdir(parents=True)
    with pytest.raises(ConfigError, match="regular file"):
        create_app(resource_root=root, data_root=data, cache_dir=cache)


def test_source_byte_boundary_is_enforced_exactly(tmp_path):
    source = _noise_png()
    root, data, cache = _roots(tmp_path, {"exact.png": source, "over.png": source + b"\x00"})
    document = default_config_document()
    document["thumbnails"]["maxSourceBytes"] = len(source)
    _write_config(data, document)
    application = create_app(resource_root=root, data_root=data, cache_dir=cache)
    with TestClient(application) as client:
        assert client.post("/api/resources/sync").json()["added"] == 2
        exact = client.get("/images/inbox/exact.png")
        assert exact.status_code == 200
        over = client.get("/images/inbox/over.png")
        assert over.status_code == 415
        assert over.json()["error"]["code"] == "image-too-large"
    # Store-level gate: exactly the limit passes the byte check (and fails
    # later as undecodable); one byte more trips the byte limit itself.
    store = application.state.thumbnail_store
    with pytest.raises(UnsupportedImageError, match="not a decodable raster image"):
        store.get_or_create("probe/exact.png", "exact.png", '"exact"', b"x" * store.max_source_bytes)
    with pytest.raises(UnsupportedImageError, match="byte safety limit"):
        store.get_or_create("probe/over.png", "over.png", '"over"', b"x" * (store.max_source_bytes + 1))


def test_open_stage_decompression_bomb_is_controlled_not_a_500(tmp_path):
    files = {"bomb.png": _bomb_png(), "bomb.jpg": _bomb_jpeg()}
    root, data, cache = _roots(tmp_path, files)
    application = create_app(resource_root=root, data_root=data, cache_dir=cache)
    # Directly: the open-stage bomb becomes UnsupportedImageError at render.
    for payload in files.values():
        with pytest.raises(UnsupportedImageError, match="pixel safety limit"):
            render_webp(payload)
    with TestClient(application) as client:
        assert client.post("/api/resources/sync").json()["added"] == 2
        for path in ("inbox/bomb.png", "inbox/bomb.jpg"):
            response = client.get(f"/images/{path}")
            assert response.status_code == 415
            assert response.json()["error"]["code"] == "image-unsupported"
        assert _cache_rows(cache / DATABASE_PATH) == ([], 0)


def test_changed_thumbnail_settings_reprofile_existing_cached_preview(tmp_path):
    root, data, cache = _roots(tmp_path, {"ticket.png": _image_bytes()})
    first = create_app(resource_root=root, data_root=data, cache_dir=cache)
    first_profile = first.state.thumbnail_store.profile
    with TestClient(first) as client:
        client.post("/api/resources/sync")
        original = client.get("/images/inbox/ticket.png")
        assert original.status_code == 200
        assert Image.open(io.BytesIO(original.content)).size == (512, 384)
    database = cache / DATABASE_PATH
    assert _cache_rows(database) == ([("inbox/ticket.png", first_profile)], 1)

    # Restart with a different thumbnail profile on the same cache.
    document = default_config_document()
    document["thumbnails"]["maxDimension"] = 256
    document["thumbnails"]["quality"] = 40
    _write_config(data, document)
    second = create_app(resource_root=root, data_root=data, cache_dir=cache)
    second_profile = second.state.thumbnail_store.profile
    assert second_profile != first_profile
    with TestClient(second) as client:
        rerendered = client.get("/images/inbox/ticket.png")
        assert rerendered.status_code == 200
        assert rerendered.headers["etag"] != original.headers["etag"]
        assert Image.open(io.BytesIO(rerendered.content)).size == (256, 192)
    # The stale-profile binding was replaced, not reused, and the orphaned
    # object was garbage-collected.
    assert _cache_rows(database) == ([("inbox/ticket.png", second_profile)], 1)


def test_legacy_v1_database_migrates_and_legacy_bindings_reprofile(tmp_path):
    root, data, cache = _roots(tmp_path)
    database = cache / DATABASE_PATH
    database.parent.mkdir(parents=True)
    connection = sqlite3.connect(database)
    try:
        connection.executescript(
            """
            CREATE TABLE thumbnail_objects (
                id TEXT PRIMARY KEY, data BLOB NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
                source_sha256 TEXT NOT NULL, source_bytes INTEGER NOT NULL, created_at REAL NOT NULL
            );
            CREATE TABLE thumbnail_bindings (
                virtual_path TEXT PRIMARY KEY, local_path TEXT NOT NULL,
                thumbnail_id TEXT NOT NULL REFERENCES thumbnail_objects(id), created_at REAL NOT NULL
            );
            CREATE INDEX thumbnail_bindings_object ON thumbnail_bindings (thumbnail_id);
            """
        )
        connection.execute("INSERT INTO thumbnail_objects VALUES ('legacy', ?, 1, 1, 'src', 3, 0.0)", (b"webp",))
        connection.execute("INSERT INTO thumbnail_bindings VALUES ('inbox/ticket.png', 'ticket.png', 'legacy', 0.0)")
        connection.execute("PRAGMA user_version=1")
        connection.commit()
    finally:
        connection.close()

    store = ThumbnailStore(cache)
    try:
        columns = {row[1] for row in store._db.execute("PRAGMA table_info(thumbnail_bindings)")}
        assert "profile" in columns
        # A pre-profile binding is never reused: it is dropped lazily and its
        # orphaned object collected, then a fresh render takes its place.
        assert store.lookup("inbox/ticket.png", "ticket.png", '"current"') is None
        assert _cache_rows(database) == ([], 0)
        rendered = store.get_or_create("inbox/ticket.png", "ticket.png", '"current"', _image_bytes())
        assert rendered.width == 512
        assert _cache_rows(database) == ([("inbox/ticket.png", store.profile)], 1)
    finally:
        store.close()


def test_rfg_pillow_limit_is_applied_before_rfg_import(tmp_path):
    """In a fresh interpreter, rfg.hashes must snapshot the configured limit."""
    root, data, cache = _roots(tmp_path)
    document = default_config_document()
    document["rfg"]["pillowImageMaxPixels"] = 2_000_000
    _write_config(data, document)
    backend = Path(__file__).resolve().parents[1]
    script = textwrap.dedent(
        f"""
        import sys
        from flightarchive.server import create_app
        assert "rfg.api" not in sys.modules, "rfg.api imported before create_app ran"
        assert "rfg.hashes" not in sys.modules, "rfg.hashes imported before create_app ran"
        create_app(resource_root={str(root)!r}, data_root={str(data)!r}, cache_dir={str(cache)!r})
        from PIL import Image
        assert Image.MAX_IMAGE_PIXELS == 2000000, Image.MAX_IMAGE_PIXELS
        import rfg.hashes
        assert rfg.hashes.DEFAULT_IMAGE_MAX_PIXELS == 2000000, rfg.hashes.DEFAULT_IMAGE_MAX_PIXELS
        print("pre-import-ok")
        """
    )
    env = {**os.environ, "PYTHONPATH": str(backend)}
    result = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, cwd=backend, env=env, timeout=120
    )
    assert result.returncode == 0, result.stderr
    assert "pre-import-ok" in result.stdout
