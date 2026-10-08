# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

from __future__ import annotations

import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from flightarchive.server import create_app


def _image_bytes(fmt="PNG", size=(80, 40), mode="RGB", **save_options):
    output = io.BytesIO()
    Image.new(mode, size, (40, 80, 120, 128) if mode == "RGBA" else (40, 80, 120)).save(
        output, format=fmt, **save_options,
    )
    return output.getvalue()


def _noisy_png_bytes(size=(1024, 768), level=90, **save_options):
    """High-entropy PNG whose compressed IDAT exceeds the bounded header range."""
    output = io.BytesIO()
    noise = Image.effect_noise(size, level)
    noise.save(output, "PNG", optimize=False, **save_options)
    noise.close()
    return output.getvalue()


def _move_png_exif_after_idat(payload):
    """Move an existing PNG eXIf chunk immediately before IEND."""
    import struct

    assert payload[:8] == b"\x89PNG\r\n\x1a\n"
    cursor = 8
    chunks = []
    while cursor < len(payload):
        length = struct.unpack(">I", payload[cursor:cursor + 4])[0]
        chunks.append(payload[cursor:cursor + 12 + length])
        cursor += 12 + length
    exif_chunk = next(chunk for chunk in chunks if chunk[4:8] == b"eXIf")
    rest = [chunk for chunk in chunks if chunk[4:8] != b"eXIf"]
    return b"\x89PNG\r\n\x1a\n" + b"".join(rest[:-1] + [exif_chunk, rest[-1]])


def _png_with_exif_after_idat(size=(80, 40), orientation=6):
    """A legitimate PNG that carries its eXIf chunk after IDAT.

    The bounded prefix stops at IDAT, so a metadata-only inspection can never
    see this orientation without decoding the whole image.
    """
    exif = Image.Exif()
    exif[274] = orientation
    output = io.BytesIO()
    image = Image.new("RGB", size, "blue")
    image.paste("red", (0, 0, size[0] // 2, size[1]))
    image.save(output, "PNG", exif=exif)

    return _move_png_exif_after_idat(output.getvalue())


def _client(tmp_path, sources, mapping, *, cache=None):
    resources = tmp_path / "resources"
    runtime = tmp_path / "runtime"
    resources.mkdir(exist_ok=True)
    runtime.mkdir(exist_ok=True)
    for name, payload in sources.items():
        path = resources / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
    app = create_app(
        resource_root=resources,
        data_root=runtime,
        cache_dir=cache if cache is not None else tmp_path / "cache",
    )
    client = TestClient(app)
    client.__enter__()
    response = client.put("/api/v1/meta/map", json={"entries": mapping})
    assert response.status_code == 200
    return app, client


def _close(client):
    client.__exit__(None, None, None)


def test_thumbnail_nested_encoded_path_headers_and_original_range(tmp_path):
    virtual = "nested/航 班/100%#scan.png"
    payload = _image_bytes(size=(80, 40))
    _, client = _client(tmp_path, {"source.png": payload}, [{
        "virtual_path": virtual, "local_path": "source.png",
    }])
    try:
        url = "/api/thumbnails/nested/%E8%88%AA%20%E7%8F%AD/100%25%23scan.png?scale=0.125"
        head = client.head(url)
        assert head.status_code == 200
        assert head.headers["x-source-width"] == "80"
        assert head.headers["x-source-height"] == "40"
        assert head.headers["x-source-bytes"] == str(len(payload))
        assert head.headers["x-thumbnail-width"] == "10"
        assert head.headers["x-thumbnail-height"] == "5"
        assert head.headers["x-thumbnail-scale"] == "0.125"
        assert head.headers["cache-control"] == "no-cache"
        assert "content-length" not in head.headers

        result = client.get(url)
        assert result.status_code == 200 and result.headers["content-type"] == "image/webp"
        assert result.headers["x-source-etag"] == head.headers["x-source-etag"]
        with Image.open(io.BytesIO(result.content)) as rendered:
            assert rendered.size == (10, 5)

        original = client.get(
            "/res/nested/%E8%88%AA%20%E7%8F%AD/100%25%23scan.png",
            headers={"Range": "bytes=0-7"},
        )
        assert original.status_code == 206
        assert original.content == payload[:8]
        assert original.headers["content-range"].startswith("bytes 0-7/")
    finally:
        _close(client)


def test_thumbnail_head_content_type_matches_get_cold_and_warm(tmp_path, monkeypatch):
    payload = _image_bytes(size=(80, 40))
    app, client = _client(tmp_path, {"x.png": payload}, [{
        "virtual_path": "x.png", "local_path": "x.png",
    }])
    service = app.state.thumbnail_service
    url = "/api/thumbnails/x.png?scale=0.5"

    def forbidden(action):
        def call(*_args, **_kwargs):
            raise AssertionError(f"HEAD must not {action}")
        return call

    try:
        monkeypatch.setattr(service, "_source_get", forbidden("fetch the full source"))
        monkeypatch.setattr(service, "_render", forbidden("render"))
        cold = client.head(url)
        assert cold.status_code == 200
        assert cold.headers["content-type"] == "image/webp"
        assert "content-length" not in cold.headers
        monkeypatch.undo()

        rendered = client.get(url)
        assert rendered.status_code == 200
        assert rendered.headers["content-type"] == "image/webp"

        monkeypatch.setattr(service, "_source_get", forbidden("fetch the full source"))
        monkeypatch.setattr(service, "_render", forbidden("render"))
        warm = client.head(url)
        assert warm.status_code == 200
        assert warm.headers["content-type"] == "image/webp"
        assert warm.headers["content-length"] == rendered.headers["content-length"]
    finally:
        _close(client)


@pytest.mark.parametrize("scale", ["nan", "inf", "0", "0.2", "2", "1/8", ""])
def test_thumbnail_rejects_invalid_scale(tmp_path, scale):
    _, client = _client(tmp_path, {"x.png": _image_bytes()}, [{
        "virtual_path": "x.png", "local_path": "x.png",
    }])
    try:
        assert client.get(f"/api/thumbnails/x.png?scale={scale}").status_code == 400
    finally:
        _close(client)


@pytest.mark.parametrize("query", ["crop=x", "rotationDegrees=90", "scale=0.5&scale=0.25"])
def test_thumbnail_rejects_non_scale_or_repeated_parameters(tmp_path, query):
    _, client = _client(tmp_path, {"x.png": _image_bytes()}, [{
        "virtual_path": "x.png", "local_path": "x.png",
    }])
    try:
        assert client.get(f"/api/thumbnails/x.png?{query}").status_code == 400
    finally:
        _close(client)


@pytest.mark.parametrize("path", ["%2E%2E%2Fx.png", ".%2Fx.png", "a%5Cb.png", "a//b.png"])
def test_thumbnail_rejects_unsafe_virtual_path(tmp_path, path):
    _, client = _client(tmp_path, {"x.png": _image_bytes()}, [])
    try:
        assert client.get(f"/api/thumbnails/{path}").status_code == 400
    finally:
        _close(client)


def test_thumbnail_magic_validation_and_unmapped_or_missing_status(tmp_path):
    _, client = _client(tmp_path, {"poison.png": b"<svg></svg>"}, [
        {"virtual_path": "poison.png", "local_path": "poison.png"},
        {"virtual_path": "gone.png", "local_path": "gone.png"},
    ])
    try:
        assert client.get("/api/thumbnails/poison.png").status_code == 415
        assert client.get("/api/thumbnails/not-mapped.png").status_code == 404
        assert client.get("/api/thumbnails/gone.png").status_code == 503
    finally:
        _close(client)


@pytest.mark.parametrize("payload", [b"plain text", b"%PDF-1.7\n", b"<svg xmlns='http://www.w3.org/2000/svg'/>"])
def test_thumbnail_rejects_non_raster_payloads(tmp_path, payload):
    _, client = _client(tmp_path, {"poison.bin": payload}, [{
        "virtual_path": "looks-like.png", "local_path": "poison.bin",
    }])
    try:
        assert client.head("/api/thumbnails/looks-like.png").status_code == 415
    finally:
        _close(client)


def test_thumbnail_exif_orientation_alpha_and_first_gif_frame(tmp_path):
    jpeg = io.BytesIO()
    exif = Image.Exif()
    exif[274] = 6
    Image.new("RGB", (40, 20), "red").save(jpeg, "JPEG", exif=exif)
    gif = io.BytesIO()
    Image.new("RGB", (30, 20), "red").save(
        gif, "GIF", save_all=True, append_images=[Image.new("RGB", (30, 20), "blue")], duration=10,
    )
    sources = {"oriented.jpg": jpeg.getvalue(), "alpha.png": _image_bytes(mode="RGBA"), "anim.gif": gif.getvalue()}
    mapping = [{"virtual_path": name, "local_path": name} for name in sources]
    _, client = _client(tmp_path, sources, mapping)
    try:
        oriented = client.head("/api/thumbnails/oriented.jpg?scale=0.5")
        assert (oriented.headers["x-source-width"], oriented.headers["x-source-height"]) == ("20", "40")
        assert (oriented.headers["x-thumbnail-width"], oriented.headers["x-thumbnail-height"]) == ("10", "20")
        alpha = client.get("/api/thumbnails/alpha.png?scale=0.5")
        with Image.open(io.BytesIO(alpha.content)) as image:
            assert image.mode == "RGBA" and image.getchannel("A").getextrema() == (128, 128)
        first = client.get("/api/thumbnails/anim.gif?scale=0.5")
        with Image.open(io.BytesIO(first.content)) as image:
            assert image.convert("RGB").getpixel((1, 1))[0] > image.convert("RGB").getpixel((1, 1))[2]
    finally:
        _close(client)


def test_thumbnail_cache_survives_restart_invalidates_and_recovers_corruption(tmp_path, monkeypatch):
    cache = tmp_path / "cache"
    mapping = [{"virtual_path": "x.png", "local_path": "x.png"}]
    _, first = _client(tmp_path, {"x.png": _image_bytes()}, mapping, cache=cache)
    try:
        initial = first.get("/api/thumbnails/x.png?scale=0.5")
        assert initial.status_code == 200
    finally:
        _close(first)

    from flightarchive.thumbnail import ThumbnailService
    monkeypatch.setattr(ThumbnailService, "_render", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("rendered")))
    monkeypatch.setattr(ThumbnailService, "_source_get", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("full GET")))
    _, second = _client(tmp_path, {}, mapping, cache=cache)
    try:
        cached = second.get("/api/thumbnails/x.png?scale=0.5")
        assert cached.status_code == 200 and cached.content == initial.content
    finally:
        _close(second)

    monkeypatch.undo()
    metadata = next(cache.glob("thumb-*.json"))
    metadata.write_text("not-json", encoding="utf-8")
    _, third = _client(tmp_path, {}, mapping, cache=cache)
    try:
        rebuilt = third.get("/api/thumbnails/x.png?scale=0.5")
        assert rebuilt.status_code == 200
        assert json.loads(next(cache.glob("thumb-*.json")).read_text())["sourceEtag"]
    finally:
        _close(third)


def test_thumbnail_head_never_full_fetches_or_renders(tmp_path, monkeypatch):
    app, client = _client(tmp_path, {"x.png": _image_bytes()}, [{"virtual_path": "x.png", "local_path": "x.png"}])
    service = app.state.thumbnail_service
    monkeypatch.setattr(service, "_source_get", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("full GET")))
    monkeypatch.setattr(service, "_render", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("render")))
    try:
        response = client.head("/api/thumbnails/x.png?scale=0.25")
        assert response.status_code == 200
        assert "content-length" not in response.headers
        assert not (tmp_path / "cache").exists() or not list((tmp_path / "cache").glob("thumb-*"))
    finally:
        _close(client)


def test_thumbnail_source_change_invalidates_and_mid_get_retries_without_old_cache(tmp_path, monkeypatch):
    old = _image_bytes(size=(80, 40))
    new = _image_bytes(size=(96, 48))
    app, client = _client(tmp_path, {"x.png": old}, [{"virtual_path": "x.png", "local_path": "x.png"}])
    resource = tmp_path / "resources" / "x.png"
    service = app.state.thumbnail_service
    original_get = service._source_get
    calls = 0

    async def change_before_first_get(virtual_path, source):
        nonlocal calls
        calls += 1
        if calls == 1:
            resource.write_bytes(new)
        return await original_get(virtual_path, source)

    monkeypatch.setattr(service, "_source_get", change_before_first_get)
    try:
        result = client.get("/api/thumbnails/x.png?scale=0.5")
        assert result.status_code == 200 and calls == 2, result.text
        assert result.headers["x-source-width"] == "96"
        assert result.headers["x-thumbnail-width"] == "48"
        documents = [json.loads(path.read_text()) for path in (tmp_path / "cache").glob("thumb-*.json")]
        assert len(documents) == 1 and documents[0]["sourceEtag"] == result.headers["x-source-etag"]
    finally:
        _close(client)


def test_thumbnail_rebind_same_virtual_path_uses_new_source_version(tmp_path):
    mapping = [{"virtual_path": "stable/scan.png", "local_path": "first.png"}]
    _, client = _client(tmp_path, {
        "first.png": _image_bytes(size=(80, 40)),
        "second.png": _image_bytes(size=(120, 60)),
    }, mapping)
    try:
        first = client.get("/api/thumbnails/stable/scan.png?scale=0.5")
        assert first.status_code == 200 and first.headers["x-thumbnail-width"] == "40"
        rematched = client.put("/api/v1/meta/map", json={"entries": [{
            "virtual_path": "stable/scan.png", "local_path": "second.png",
        }]})
        assert rematched.status_code == 200
        second = client.get("/api/thumbnails/stable/scan.png?scale=0.5")
        assert second.status_code == 200 and second.headers["x-thumbnail-width"] == "60"
        assert second.headers["x-source-etag"] != first.headers["x-source-etag"]
        assert second.headers["etag"] != first.headers["etag"]
    finally:
        _close(client)


def test_thumbnail_requests_do_not_mutate_mapping_or_archive_documents(tmp_path):
    app, client = _client(tmp_path, {"x.png": _image_bytes()}, [{"virtual_path": "x.png", "local_path": "x.png"}])
    runtime = tmp_path / "runtime"
    archive = runtime / "flightarchive" / "v2"
    archive.mkdir(parents=True)
    sentinel = archive / "flights.json"
    sentinel.write_text("[]\n", encoding="utf-8")
    mapping_before = client.get("/api/v1/meta/map")
    archive_before = (sentinel.read_bytes(), sentinel.stat().st_mtime_ns)
    try:
        assert client.head("/api/thumbnails/x.png").status_code == 200
        assert client.get("/api/thumbnails/x.png").status_code == 200
        mapping_after = client.get("/api/v1/meta/map")
        assert mapping_after.json() == mapping_before.json()
        assert mapping_after.headers.get("etag") == mapping_before.headers.get("etag")
        assert (sentinel.read_bytes(), sentinel.stat().st_mtime_ns) == archive_before
    finally:
        _close(client)


def test_thumbnail_deleted_or_unavailable_cache_still_returns_rendered_bytes(tmp_path):
    cache = tmp_path / "cache"
    mapping = [{"virtual_path": "x.png", "local_path": "x.png"}]
    _, first = _client(tmp_path, {"x.png": _image_bytes()}, mapping, cache=cache)
    try:
        assert first.get("/api/thumbnails/x.png").status_code == 200
    finally:
        _close(first)
    for path in cache.iterdir():
        path.unlink()
    cache.rmdir()
    _, second = _client(tmp_path, {}, mapping, cache=cache)
    try:
        assert second.get("/api/thumbnails/x.png").status_code == 200
        assert cache.is_dir()
    finally:
        _close(second)

    for path in cache.iterdir():
        path.unlink()
    cache.rmdir()
    cache.write_text("not-a-directory", encoding="utf-8")
    _, third = _client(tmp_path, {}, mapping, cache=cache)
    try:
        assert third.get("/api/thumbnails/x.png").status_code == 200
        assert cache.read_text(encoding="utf-8") == "not-a-directory"
    finally:
        _close(third)


def test_large_jpeg_uses_decoder_draft_before_load(tmp_path, monkeypatch):
    # 140 MP is intentional: it is a valid scan, while the dyadic JPEG draft
    # keeps the decoded working bitmap bounded before the exact resize.
    source = io.BytesIO()
    image = Image.new("L", (14_000, 10_000), 127)
    image.save(source, "JPEG", quality=70)
    image.close()
    observed_load_sizes = []
    original_load = Image.Image.load

    def observed_load(self, *args, **kwargs):
        if getattr(self, "format", None) == "JPEG":
            observed_load_sizes.append(self.size)
        return original_load(self, *args, **kwargs)

    monkeypatch.setattr(Image.Image, "load", observed_load)
    _, client = _client(tmp_path, {"large.jpg": source.getvalue()}, [{
        "virtual_path": "large.jpg", "local_path": "large.jpg",
    }])
    try:
        response = client.get("/api/thumbnails/large.jpg?scale=0.015625")
        assert response.status_code == 200
        assert response.headers["x-source-width"] == "14000"
        assert response.headers["x-thumbnail-width"] == "218"
        assert observed_load_sizes and max(width * height for width, height in observed_load_sizes) < 3_000_000
    finally:
        _close(client)


def test_thumbnail_cache_budget_does_not_touch_unrelated_files(tmp_path, monkeypatch):
    cache = tmp_path / "cache"
    cache.mkdir()
    unrelated = cache / "keep.txt"
    unrelated.write_text("safe", encoding="utf-8")
    from flightarchive import thumbnail
    monkeypatch.setattr(thumbnail, "MAX_CACHE_BYTES", 1)
    _, client = _client(tmp_path, {"x.png": _image_bytes()}, [{"virtual_path": "x.png", "local_path": "x.png"}], cache=cache)
    try:
        assert client.get("/api/thumbnails/x.png").status_code == 200
    finally:
        _close(client)
    assert unrelated.read_text(encoding="utf-8") == "safe"


def test_thumbnail_cache_symlink_is_never_followed(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    marker = outside / "marker"
    marker.write_text("safe", encoding="utf-8")
    cache = tmp_path / "cache"
    cache.symlink_to(outside, target_is_directory=True)
    _, client = _client(tmp_path, {"x.png": _image_bytes()}, [{"virtual_path": "x.png", "local_path": "x.png"}], cache=cache)
    try:
        response = client.get("/api/thumbnails/x.png")
        assert response.status_code == 200
    finally:
        _close(client)
    assert marker.read_text(encoding="utf-8") == "safe"
    assert list(outside.iterdir()) == [marker]


def test_thumbnail_cache_leaf_symlink_is_never_followed(tmp_path):
    cache = tmp_path / "cache"
    mapping = [{"virtual_path": "x.png", "local_path": "x.png"}]
    _, first = _client(tmp_path, {"x.png": _image_bytes()}, mapping, cache=cache)
    try:
        assert first.get("/api/thumbnails/x.png").status_code == 200
    finally:
        _close(first)
    blob = next(cache.glob("thumb-*.webp"))
    blob.unlink()
    outside = tmp_path / "outside.webp"
    outside.write_bytes(b"safe")
    blob.symlink_to(outside)
    _, second = _client(tmp_path, {}, mapping, cache=cache)
    try:
        assert second.get("/api/thumbnails/x.png").status_code == 200
    finally:
        _close(second)
    assert blob.is_symlink() and outside.read_bytes() == b"safe"


def test_requested_output_over_limits_is_413(tmp_path):
    _, client = _client(tmp_path, {"large.png": _image_bytes(size=(2100, 2000))}, [{
        "virtual_path": "large.png", "local_path": "large.png",
    }])
    try:
        assert client.head("/api/thumbnails/large.png?scale=1").status_code == 413
    finally:
        _close(client)


@pytest.mark.parametrize("method", ["head", "get"])
def test_thumbnail_maps_pillow_decompression_bomb_to_dimension_413(tmp_path, monkeypatch, method):
    payload = _image_bytes(size=(80, 40))
    _, client = _client(tmp_path, {"x.png": payload}, [{"virtual_path": "x.png", "local_path": "x.png"}])
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 1)
    try:
        response = getattr(client, method)("/api/thumbnails/x.png?scale=0.125")
        assert response.status_code == 413
        if method == "get":
            assert response.json()["error"]["code"] == "thumbnail-source-dimensions-too-large"
    finally:
        _close(client)


@pytest.mark.parametrize("mutation", [
    {"scale": "0.25"},
    {"renderProfile": "other"},
    {"sourceWidth": True},
    {"sourceBytesAsFloat": True},
    {"sourceWidth": 80_000},
    {"thumbnailWidth": 41},
    {"format": "TIFF"},
])
def test_thumbnail_rejects_forged_cached_geometry_and_profile(tmp_path, monkeypatch, mutation):
    cache = tmp_path / "cache"
    mapping = [{"virtual_path": "x.png", "local_path": "x.png"}]
    _, first = _client(tmp_path, {"x.png": _image_bytes(size=(80, 40))}, mapping, cache=cache)
    try:
        initial = first.get("/api/thumbnails/x.png?scale=0.5")
        assert initial.status_code == 200
    finally:
        _close(first)

    metadata_path = next(cache.glob("thumb-*.json"))
    metadata = json.loads(metadata_path.read_text())
    metadata.update(mutation)
    if metadata.pop("sourceBytesAsFloat", False):
        metadata["sourceBytes"] = float(metadata["sourceBytes"])
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

    from flightarchive.thumbnail import ThumbnailService
    calls = 0
    original = ThumbnailService._render
    def observed(*args, **kwargs):
        nonlocal calls
        calls += 1
        return original(*args, **kwargs)
    monkeypatch.setattr(ThumbnailService, "_render", staticmethod(observed))
    _, second = _client(tmp_path, {}, mapping, cache=cache)
    try:
        rebuilt = second.get("/api/thumbnails/x.png?scale=0.5")
        assert rebuilt.status_code == 200
        assert rebuilt.headers["x-source-width"] == "80"
        assert rebuilt.headers["x-thumbnail-width"] == "40"
        assert calls == 1
    finally:
        _close(second)


def test_thumbnail_rejects_self_consistent_forged_source_geometry_and_webp_header(tmp_path, monkeypatch):
    cache = tmp_path / "cache"
    mapping = [{"virtual_path": "x.png", "local_path": "x.png"}]
    _, first = _client(tmp_path, {"x.png": _image_bytes(size=(80, 40))}, mapping, cache=cache)
    try:
        assert first.get("/api/thumbnails/x.png?scale=0.5").status_code == 200
    finally:
        _close(first)

    blob_path = next(cache.glob("thumb-*.webp"))
    metadata_path = next(cache.glob("thumb-*.json"))
    forged = _image_bytes(fmt="WEBP", size=(50, 25))
    blob_path.write_bytes(forged)
    metadata = json.loads(metadata_path.read_text())
    metadata.update({
        "sourceWidth": 100, "sourceHeight": 50,
        "thumbnailWidth": 50, "thumbnailHeight": 25,
        "encodedBytes": len(forged),
        "blobSha256": __import__("hashlib").sha256(forged).hexdigest(),
    })
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

    from flightarchive.thumbnail import ThumbnailService
    calls = 0
    original = ThumbnailService._render
    def observed(*args, **kwargs):
        nonlocal calls
        calls += 1
        return original(*args, **kwargs)
    monkeypatch.setattr(ThumbnailService, "_render", staticmethod(observed))
    _, second = _client(tmp_path, {}, mapping, cache=cache)
    try:
        rebuilt = second.get("/api/thumbnails/x.png?scale=0.5")
        assert rebuilt.status_code == 200
        assert rebuilt.headers["x-source-width"] == "80"
        assert rebuilt.headers["x-thumbnail-width"] == "40"
        assert calls == 1
    finally:
        _close(second)


def test_thumbnail_cache_evicts_complete_pairs_and_only_owned_orphans(tmp_path, monkeypatch):
    from flightarchive import thumbnail
    cache = tmp_path / "cache"
    cache.mkdir()
    unrelated = cache / "keep.txt"
    unrelated.write_text("safe", encoding="utf-8")
    outside = tmp_path / "outside"
    outside.write_text("safe", encoding="utf-8")
    symlink = cache / ("thumb-" + "f" * 64 + ".webp")
    symlink.symlink_to(outside)
    orphan = cache / ("thumb-" + "e" * 64 + ".json")
    orphan.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(thumbnail, "MAX_CACHE_BYTES", 600)

    mapping = [
        {"virtual_path": "a.png", "local_path": "a.png"},
        {"virtual_path": "b.png", "local_path": "b.png"},
    ]
    _, client = _client(tmp_path, {"a.png": _image_bytes(size=(120, 80)), "b.png": _image_bytes(size=(120, 80))}, mapping, cache=cache)
    try:
        assert client.get("/api/thumbnails/a.png?scale=0.5").status_code == 200
        assert client.get("/api/thumbnails/b.png?scale=0.5").status_code == 200
    finally:
        _close(client)

    regular_owned = [p for p in cache.iterdir() if p.is_file() and not p.is_symlink() and p.name.startswith("thumb-")]
    grouped = {}
    for path in regular_owned:
        grouped.setdefault(path.stem, set()).add(path.suffix)
    assert grouped
    assert all(suffixes == {".webp", ".json"} for suffixes in grouped.values())
    assert not orphan.exists()
    assert unrelated.read_text(encoding="utf-8") == "safe"
    assert symlink.is_symlink() and outside.read_text(encoding="utf-8") == "safe"


def test_inspect_rejects_ignored_large_range_without_consuming_body(tmp_path):
    from flightarchive.thumbnail import MAX_HEADER_BYTES, SourceIdentity, ThumbnailService, ThumbnailError

    class Response:
        status_code = 200
        headers = {"etag": '"v1"'}
        consumed = False
        async def aiter_bytes(self):
            self.consumed = True
            yield b"x" * (MAX_HEADER_BYTES + 1)

    response = Response()
    class Context:
        async def __aenter__(self): return response
        async def __aexit__(self, *args): return None
    class Client:
        def stream(self, *args, **kwargs): return Context()

    service = object.__new__(ThumbnailService)
    service._client = Client()
    import asyncio
    with pytest.raises(ThumbnailError) as caught:
        asyncio.run(service._inspect("x.png", SourceIdentity('"v1"', MAX_HEADER_BYTES + 1), 0.5))
    assert caught.value.code == "resource-range-unavailable"
    assert response.consumed is False



def test_thumbnail_rejects_cached_webp_header_dimension_mismatch(tmp_path, monkeypatch):
    cache = tmp_path / "cache"
    mapping = [{"virtual_path": "x.png", "local_path": "x.png"}]
    _, first = _client(tmp_path, {"x.png": _image_bytes(size=(80, 40))}, mapping, cache=cache)
    try:
        assert first.get("/api/thumbnails/x.png?scale=0.5").status_code == 200
    finally:
        _close(first)

    blob_path = next(cache.glob("thumb-*.webp"))
    metadata_path = next(cache.glob("thumb-*.json"))
    forged = _image_bytes(fmt="WEBP", size=(39, 20))
    blob_path.write_bytes(forged)
    metadata = json.loads(metadata_path.read_text())
    metadata.update({
        "encodedBytes": len(forged),
        "blobSha256": __import__("hashlib").sha256(forged).hexdigest(),
    })
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

    from flightarchive.thumbnail import ThumbnailService
    calls = 0
    original = ThumbnailService._render
    def observed(*args, **kwargs):
        nonlocal calls
        calls += 1
        return original(*args, **kwargs)
    monkeypatch.setattr(ThumbnailService, "_render", staticmethod(observed))
    _, second = _client(tmp_path, {}, mapping, cache=cache)
    try:
        rebuilt = second.get("/api/thumbnails/x.png?scale=0.5")
        assert rebuilt.status_code == 200
        assert rebuilt.headers["x-thumbnail-width"] == "40"
        assert calls == 1
    finally:
        _close(second)


def test_thumbnail_retries_when_source_etag_changes_during_prefix_inspection(tmp_path, monkeypatch):
    old = _image_bytes(size=(80, 40))
    new = _image_bytes(size=(96, 48))
    app, client = _client(tmp_path, {"x.png": old}, [{"virtual_path": "x.png", "local_path": "x.png"}])
    resource = tmp_path / "resources" / "x.png"
    service = app.state.thumbnail_service
    original_inspect = service._inspect
    calls = 0

    async def change_before_first_prefix(virtual_path, source, scale):
        nonlocal calls
        calls += 1
        if calls == 1:
            resource.write_bytes(new)
        return await original_inspect(virtual_path, source, scale)

    monkeypatch.setattr(service, "_inspect", change_before_first_prefix)
    try:
        response = client.get("/api/thumbnails/x.png?scale=0.5")
        assert response.status_code == 200
        assert calls == 2
        assert response.headers["x-source-width"] == "96"
    finally:
        _close(client)



def test_thumbnail_cached_head_retries_source_change_during_prefix_validation(tmp_path, monkeypatch):
    old = _image_bytes(size=(80, 40))
    new = _image_bytes(size=(96, 48))
    app, client = _client(tmp_path, {"x.png": old}, [{"virtual_path": "x.png", "local_path": "x.png"}])
    try:
        assert client.get("/api/thumbnails/x.png?scale=0.5").status_code == 200
        resource = tmp_path / "resources" / "x.png"
        service = app.state.thumbnail_service
        original_inspect = service._inspect
        calls = 0

        async def change_before_cached_prefix(virtual_path, source, scale):
            nonlocal calls
            calls += 1
            if calls == 1:
                resource.write_bytes(new)
            return await original_inspect(virtual_path, source, scale)

        monkeypatch.setattr(service, "_inspect", change_before_cached_prefix)
        response = client.head("/api/thumbnails/x.png?scale=0.5")
        assert response.status_code == 200
        assert calls == 2
        assert response.headers["x-source-width"] == "96"
        assert response.headers["x-thumbnail-width"] == "48"
    finally:
        _close(client)


def test_inspect_prefix_reads_png_geometry_without_pixel_decode(monkeypatch):
    from PIL.PngImagePlugin import PngImageFile

    from flightarchive.thumbnail import ThumbnailService

    payload = _image_bytes(size=(320, 200))
    loads = []
    original_load = PngImageFile.load

    def observed_load(self, *args, **kwargs):
        loads.append(self.size)
        return original_load(self, *args, **kwargs)

    monkeypatch.setattr(PngImageFile, "load", observed_load)
    geometry = ThumbnailService._inspect_prefix(payload, 0.5)
    assert (geometry.source_width, geometry.source_height) == (320, 200)
    assert (geometry.thumbnail_width, geometry.thumbnail_height) == (160, 100)
    assert geometry.format == "PNG"
    assert loads == []


def test_inspect_prefix_applies_png_header_exif_without_pixel_decode(monkeypatch):
    from PIL.PngImagePlugin import PngImageFile

    from flightarchive.thumbnail import ThumbnailService

    exif = Image.Exif()
    exif[274] = 6
    payload = _image_bytes(size=(80, 40), exif=exif)
    loads = []
    original_load = PngImageFile.load

    def observed_load(self, *args, **kwargs):
        loads.append(self.size)
        return original_load(self, *args, **kwargs)

    monkeypatch.setattr(PngImageFile, "load", observed_load)
    geometry = ThumbnailService._inspect_prefix(payload, 0.5)
    assert (geometry.source_width, geometry.source_height) == (40, 80)
    assert (geometry.thumbnail_width, geometry.thumbnail_height) == (20, 40)
    assert loads == []


def test_thumbnail_head_of_png_larger_than_prefix_returns_geometry_without_pixel_decode(tmp_path, monkeypatch):
    from PIL.PngImagePlugin import PngImageFile

    from flightarchive.thumbnail import MAX_HEADER_BYTES

    payload = _noisy_png_bytes()
    assert len(payload) > MAX_HEADER_BYTES
    app, client = _client(tmp_path, {"noisy.png": payload}, [{
        "virtual_path": "noisy.png", "local_path": "noisy.png",
    }])
    service = app.state.thumbnail_service
    monkeypatch.setattr(service, "_source_get", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("full GET")))
    monkeypatch.setattr(service, "_render", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("render")))
    loads = []
    original_load = PngImageFile.load

    def observed_load(self, *args, **kwargs):
        loads.append(self.size)
        return original_load(self, *args, **kwargs)

    monkeypatch.setattr(PngImageFile, "load", observed_load)
    try:
        response = client.head("/api/thumbnails/noisy.png?scale=0.5")
        assert response.status_code == 200, response.text
        assert response.headers["x-source-width"] == "1024"
        assert response.headers["x-source-height"] == "768"
        assert response.headers["x-thumbnail-width"] == "512"
        assert response.headers["x-thumbnail-height"] == "384"
        assert "content-length" not in response.headers
        assert loads == []
    finally:
        _close(client)


def test_thumbnail_cached_head_validates_without_render_full_source_or_pixel_decode(tmp_path, monkeypatch):
    from PIL.PngImagePlugin import PngImageFile

    payload = _image_bytes(size=(80, 40))
    mapping = [{"virtual_path": "x.png", "local_path": "x.png"}]
    _, first = _client(tmp_path, {"x.png": payload}, mapping)
    try:
        assert first.get("/api/thumbnails/x.png?scale=0.5").status_code == 200
    finally:
        _close(first)

    app, second = _client(tmp_path, {}, mapping)
    service = app.state.thumbnail_service
    monkeypatch.setattr(service, "_source_get", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("full GET")))
    monkeypatch.setattr(service, "_render", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("render")))
    loads = []
    original_load = PngImageFile.load

    def observed_load(self, *args, **kwargs):
        loads.append(self.size)
        return original_load(self, *args, **kwargs)

    monkeypatch.setattr(PngImageFile, "load", observed_load)
    try:
        response = second.head("/api/thumbnails/x.png?scale=0.5")
        assert response.status_code == 200
        assert response.headers["content-length"]
        assert loads == []
    finally:
        _close(second)


def test_small_png_late_exif_in_prefix_has_normalized_head_and_matching_pixels(tmp_path, monkeypatch):
    from PIL.PngImagePlugin import PngImageFile

    payload = _png_with_exif_after_idat(size=(80, 40), orientation=6)
    app, client = _client(tmp_path, {"late.png": payload}, [{
        "virtual_path": "late.png", "local_path": "late.png",
    }])
    loads = []
    original_load = PngImageFile.load

    def observed_load(self, *args, **kwargs):
        loads.append(self.size)
        return original_load(self, *args, **kwargs)

    monkeypatch.setattr(PngImageFile, "load", observed_load)
    try:
        head = client.head("/api/thumbnails/late.png?scale=0.5")
        assert head.status_code == 200
        assert (head.headers["x-source-width"], head.headers["x-source-height"]) == ("40", "80")
        assert (head.headers["x-thumbnail-width"], head.headers["x-thumbnail-height"]) == ("20", "40")
        assert head.headers["x-source-bytes"] == str(len(payload))
        assert loads == []

        result = client.get("/api/thumbnails/late.png?scale=0.5")
        assert result.status_code == 200, result.text
        assert result.headers["x-source-bytes"] == str(len(payload))
        with Image.open(io.BytesIO(result.content)) as image:
            assert image.size == (20, 40)
            rgb = image.convert("RGB")
            top = rgb.getpixel((10, 5))
            bottom = rgb.getpixel((10, 35))
            assert top[0] > 180 and top[2] < 80
            assert bottom[2] > 180 and bottom[0] < 80
    finally:
        _close(client)


def test_png_exif_beyond_prefix_is_rejected_without_cache(tmp_path):
    from flightarchive.thumbnail import MAX_HEADER_BYTES

    exif = Image.Exif()
    exif[274] = 6
    payload = _move_png_exif_after_idat(_noisy_png_bytes(size=(1024, 768), exif=exif))
    assert len(payload) > MAX_HEADER_BYTES
    assert payload.find(b"eXIf") > MAX_HEADER_BYTES
    _, client = _client(tmp_path, {"late.png": payload}, [{
        "virtual_path": "late.png", "local_path": "late.png",
    }])
    try:
        response = client.get("/api/thumbnails/late.png?scale=0.5")
        assert response.status_code == 415
        assert response.json()["error"]["code"] == "unsupported-header-orientation"
        assert not (tmp_path / "cache").exists() or not list((tmp_path / "cache").glob("thumb-*"))
    finally:
        _close(client)
