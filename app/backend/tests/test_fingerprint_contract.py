# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Characterization of fingerprint/rematch contract edges not covered elsewhere.

Two concrete gaps are pinned here before behavior-neutral cleanup:

- a rematch clears every fingerprint stored for the target's previous source
  (``target.clear()`` in the lifecycle) while preserving the virtual path, so
  stale hashes can never survive a source replacement;
- strict request-shape and eligibility enforcement on
  POST /api/resources/fingerprints: the 1..32 unique-paths cap, the six
  supported algorithms, per-field semantic prefixes (front/back/electronic/
  attachments), and the current-catalog requirement — all rejected before any
  RFG hash call is made.
"""
from __future__ import annotations

import hashlib
import time

from fastapi.testclient import TestClient

from flightarchive.server import create_app


def app(tmp_path, files: dict[str, bytes] | None = None):
    root, data = tmp_path / "resources", tmp_path / "data"
    root.mkdir(); data.mkdir()
    for name, content in (files or {"ticket.png": b"ticket"}).items():
        (root / name).write_bytes(content)
    return create_app(resource_root=root, data_root=data)


def _tasks(client):
    return [task for day in client.get("/api/tasks").json()["days"] for task in day["tasks"]]


def _map_object(client, inbox: str) -> str:
    """Construct object-mapping states needed by fingerprint-only tests."""
    mapping = client.get("/api/v1/meta/map")
    document = mapping.json()
    entry = next(item for item in document["entries"] if item["virtual_path"] == inbox)
    target = hashlib.sha256(entry["local_path"].encode()).hexdigest() + "." + entry["local_path"].rsplit(".", 1)[-1]
    entry["virtual_path"] = target
    assert client.put("/api/v1/meta/map", json=document, headers={"If-Match": mapping.headers["etag"]}).status_code == 200
    return target


def _flight(client, **fields) -> None:
    payload = {"flightNumber": "1", "airlineCode": "CA", "departureAirport": "PEK", "arrivalAirport": "SHA", "departureDate": "2026-01-01"}
    payload.update(fields)
    assert client.post("/api/flights", json=payload).status_code == 201


def _fingerprint(client, paths, algorithms=("sha256",), **extra):
    payload = {"virtualPaths": paths, "algorithms": list(algorithms)}
    if "ifMatch" not in extra:
        payload["ifMatch"] = client.get("/api/v1/meta/map").headers["etag"]
    payload.update(extra)
    return client.post("/api/resources/fingerprints", json=payload)


def _await_task(client, task_id):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        task = next((item for item in _tasks(client) if item["id"] == task_id), None)
        if task is not None and task["state"] in {"succeeded", "failed"}:
            return task
        time.sleep(0.01)
    raise AssertionError(f"task {task_id} did not finish")


def test_rematch_clears_stored_fingerprints_and_preserves_virtual_path(tmp_path):
    application = app(tmp_path)
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        path = _map_object(client, "inbox/ticket.png")
        _flight(client, paperBoardingPassFrontResourcePath=path)
        stored = _fingerprint(client, [path], ("crc32", "sha256"))
        assert stored.status_code == 202
        task = _await_task(client, stored.json()["task"]["id"])
        assert task["state"] == "succeeded" and task["total"] == 2
        old = next(item for item in client.get("/api/v1/meta/map").json()["entries"] if item["virtual_path"] == path)
        assert old["crc32"] and old["sha256"] and old["size_bytes"] == len(b"ticket")

        # The source is replaced on disk; the classified entry becomes missing.
        (tmp_path / "resources" / "ticket.png").unlink()
        (tmp_path / "resources" / "replacement.png").write_bytes(b"replacement")
        client.post("/api/resources/reconcile")

        etag = client.get("/api/v1/meta/map").headers["etag"]
        response = client.post("/api/resources/rematch", json={"ifMatch": etag, "mode": "explicit", "matches": [{"targetVirtualPath": path, "candidateInboxVirtualPath": "inbox/replacement.png"}]})
        assert response.status_code == 200
        assert set(response.json()) == {"applied", "ambiguous", "unmatched", "revision"}

        # Explicit rematch automatically schedules every content and
        # perceptual fingerprint for the newly bound source.
        automatic = next(task for task in _tasks(client) if task["id"] != stored.json()["task"]["id"])
        assert {item["virtualPath"] for item in automatic["items"]} == {path}
        assert {item["algorithm"] for item in automatic["items"]} == {
            "crc32", "md5", "sha256", "ahash", "dhash", "phash",
        }
        # The tiny synthetic bytes are not a decodable image, so perceptual
        # items may fail; content items still complete and persist.
        assert _await_task(client, automatic["id"])["state"] in {"succeeded", "failed"}

        # The preserved path stays flight-bound and the automatically refreshed
        # hashes describe the replacement, not the stale file.
        fresh = next(item for item in client.get("/api/v1/meta/map").json()["entries"] if item["virtual_path"] == path)
        assert fresh["crc32"] != old["crc32"] and fresh["sha256"] != old["sha256"]


def test_explicit_rematch_rebinds_present_stable_object_and_enqueues_fingerprints(tmp_path, monkeypatch):
    application = app(tmp_path, {"ticket.png": b"ticket", "replacement.png": b"replacement"})
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        path = _map_object(client, "inbox/ticket.png")
        _flight(client, paperBoardingPassFrontResourcePath=path)
        stored = _fingerprint(client, [path], ("crc32", "sha256"))
        assert stored.status_code == 202
        assert _await_task(client, stored.json()["task"]["id"])["state"] == "succeeded"
        before = next(item for item in client.get("/api/v1/meta/map").json()["entries"] if item["virtual_path"] == path)
        assert before["local_path"] == "ticket.png" and before["crc32"] and before["sha256"]

        captured = []
        monkeypatch.setattr(
            application.state.background_tasks,
            "enqueue_fingerprints",
            lambda lifecycle, work: captured.append(work),
        )
        mapping = client.get("/api/v1/meta/map")
        response = client.post("/api/resources/rematch", json={
            "ifMatch": mapping.headers["etag"],
            "mode": "explicit",
            "matches": [{
                "targetVirtualPath": path,
                "candidateInboxVirtualPath": "inbox/replacement.png",
            }],
        })

        assert response.status_code == 200
        assert set(response.json()) == {"applied", "ambiguous", "unmatched", "revision"}
        rebound = next(item for item in client.get("/api/v1/meta/map").json()["entries"] if item["virtual_path"] == path)
        assert rebound == {
            "virtual_path": path,
            "local_path": "replacement.png",
            "size_bytes": len(b"replacement"),
        }
        assert captured == [{path: ("crc32", "md5", "sha256", "ahash", "dhash", "phash")}]


def test_fingerprints_reject_malformed_request_shapes_before_any_lookup(tmp_path):
    application = app(tmp_path)
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        lifecycle = application.state.resource_lifecycle
        calls: list[str] = []
        original_hash = lifecycle.compute_rfg_hash
        async def observed_hash(local_path, algorithm):
            calls.append(local_path)
            return await original_hash(local_path, algorithm)
        lifecycle.compute_rfg_hash = observed_hash

        unmapped = "0" * 64 + ".png"
        assert _fingerprint(client, []).status_code == 422                       # below the 1..32 cap
        assert _fingerprint(client, [f"p{i}" for i in range(33)]).status_code == 422  # above the cap
        assert _fingerprint(client, [unmapped, unmapped]).status_code == 422     # duplicate paths
        assert _fingerprint(client, [""]).status_code == 422                     # empty path
        assert _fingerprint(client, [unmapped], ("sha256", "sha256")).status_code == 422  # duplicate algorithms
        assert _fingerprint(client, [unmapped], ("sha512",)).status_code == 422  # unsupported algorithm
        assert _fingerprint(client, [unmapped], ()).status_code == 422           # no algorithms
        assert client.post("/api/resources/fingerprints", json={"virtualPaths": [unmapped]}).status_code == 422
        assert client.post("/api/resources/fingerprints", json={"algorithms": ["sha256"]}).status_code == 422
        assert _fingerprint(client, [unmapped], localPath="ticket.png").status_code == 422  # unknown key
        assert _fingerprint(client, [unmapped], ifMatch=123).status_code == 422  # non-string ifMatch
        assert calls == []

        # A well-formed but unmapped path passes shape validation and fails lookup.
        missing = _fingerprint(client, [unmapped])
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "resource-not-found"
        assert calls == []


def test_fingerprints_reject_classified_reference_whose_source_left_the_catalog(tmp_path):
    application = app(tmp_path)
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        path = _map_object(client, "inbox/ticket.png")
        _flight(client, paperBoardingPassFrontResourcePath=path)
        (tmp_path / "resources" / "ticket.png").unlink()

        lifecycle = application.state.resource_lifecycle
        calls: list[str] = []
        original_hash = lifecycle.compute_rfg_hash
        async def observed_hash(local_path, algorithm):
            calls.append(local_path)
            return await original_hash(local_path, algorithm)
        lifecycle.compute_rfg_hash = observed_hash

        # Mapped, classified and flight-bound, but the source file is gone:
        # rejected without touching RFG's hash API.
        response = _fingerprint(client, [path])
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "resource-not-eligible"
        assert calls == []


def test_fingerprints_cover_every_direct_flight_object_field(tmp_path):
    application = app(tmp_path, {"front.png": b"front", "receipt.png": b"receipt", "pass.png": b"pass"})
    with TestClient(application) as client:
        client.post("/api/resources/reconcile")
        front = _map_object(client, "inbox/front.png")
        attachment = _map_object(client, "inbox/receipt.png")
        electronic = _map_object(client, "inbox/pass.png")

        # Attachments referenced through attachmentResourcePaths are eligible.
        _flight(client, attachmentResourcePaths=[attachment])
        attachment_fingerprint = _fingerprint(client, [attachment], ("md5",))
        assert attachment_fingerprint.status_code == 202
        assert _await_task(client, attachment_fingerprint.json()["task"]["id"])["state"] == "succeeded"

        # Object IDs have no resource-kind prefix. Any direct flight field is
        # therefore an eligible owner for an existing object mapping.
        _flight(client, paperBoardingPassFrontResourcePath=electronic, electronicBoardingPassResourcePath=front, attachmentResourcePaths=[front])
        for path in (front, electronic):
            fingerprint = _fingerprint(client, [path])
            assert fingerprint.status_code == 202
            assert _await_task(client, fingerprint.json()["task"]["id"])["state"] == "succeeded"

        # Referenced through the correct fields, both become eligible.
        _flight(client, paperBoardingPassFrontResourcePath=front, electronicBoardingPassResourcePath=electronic)
        fingerprint = _fingerprint(client, [front, electronic], ("crc32",))
        assert fingerprint.status_code == 202
        assert _await_task(client, fingerprint.json()["task"]["id"])["state"] == "succeeded"
