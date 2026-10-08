# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

import flightarchive.initialization as initialization
from flightarchive.activity import ActivityLog
from flightarchive.archive import MAX_DOCUMENT_BYTES as ARCHIVE_MAX_DOCUMENT_BYTES
from flightarchive.legacy_v1 import LegacyV1Error, normalize_business_data_v1


FIXTURE = json.loads(
    (Path(__file__).parents[2] / "test-fixtures" / "business-data-v1.json").read_text(encoding="utf-8")
)


def _read_v2(root: Path) -> dict:
    archive = root / "flightarchive" / "v2"
    return {
        "schemaVersion": 1,
        "flights": json.loads((archive / "flights.json").read_text()),
        "airlines": json.loads((archive / "airlines.json").read_text()),
        "airports": json.loads((archive / "airports.json").read_text()),
        "aircraftTypes": json.loads((archive / "aircraft-types.json").read_text()),
        "settings": json.loads((archive / "settings.json").read_text()),
    }


def _write_v1(root: Path, value: object) -> Path:
    path = root / "flightarchive" / "v1" / "business-data.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def _activity_records(root: Path) -> list[dict]:
    return [record for day in ActivityLog(root).history()["days"] for record in day["activities"]]


def _records_with_code(root: Path, code: str) -> list[dict]:
    return [record for record in _activity_records(root) if record["code"] == code]


def test_missing_archive_initializes_seed_once_without_flights(tmp_path):
    first = initialization.prepare_archive(tmp_path)
    assert first.status == "initialized"
    aggregate = _read_v2(tmp_path)
    assert aggregate["flights"] == []
    assert aggregate["settings"] == {}
    assert aggregate["airlines"] == initialization.DEFAULT_AIRLINES
    assert aggregate["airports"] == initialization.DEFAULT_AIRPORTS
    assert aggregate["aircraftTypes"] == initialization.DEFAULT_AIRCRAFT_TYPES
    assert not (tmp_path / "flightarchive" / "migrations").exists()
    assert not (tmp_path / "flightarchive" / "log").exists()
    before = {path.name: path.read_bytes() for path in (tmp_path / "flightarchive" / "v2").iterdir()}
    assert initialization.prepare_archive(tmp_path).status == "existing"
    assert {path.name: path.read_bytes() for path in (tmp_path / "flightarchive" / "v2").iterdir()} == before


def test_golden_v1_is_normalized_split_and_compares_as_aggregate(tmp_path):
    source = _write_v1(tmp_path, FIXTURE["validDocument"])
    before = (source.read_bytes(), source.stat().st_mtime_ns)
    outcome = initialization.prepare_archive(tmp_path)
    assert outcome.status == "migrated"
    assert _read_v2(tmp_path) == FIXTURE["validDocument"]
    assert (source.read_bytes(), source.stat().st_mtime_ns) == before
    migration_dir = tmp_path / "flightarchive" / "migrations"
    assert json.loads((migration_dir / "v1-to-v2.status.json").read_text())["state"] == "succeeded"
    assert '"state":"succeeded"' in (migration_dir / "v1-to-v2.log.jsonl").read_text()
    activity = next((tmp_path / "flightarchive" / "log" / "activity").glob("*.jsonl")).read_text()
    assert '"code":"v1-to-v2-succeeded"' in activity


def test_frozen_parser_uses_shared_golden_normalization_and_rejects_invalid_documents():
    normalized = normalize_business_data_v1({
        "schemaVersion": 1,
        "airlines": [FIXTURE["catalogNormalization"]["airlineInput"]],
        "airports": [FIXTURE["catalogNormalization"]["airportInput"]],
        "aircraftTypes": [FIXTURE["catalogNormalization"]["aircraftTypeInput"]],
        "flights": [{
            **FIXTURE["normalization"]["flightInput"],
            "id": "generated-flight-id",
            "createdAt": "2026-08-09T10:11:12+00:00",
            "updatedAt": "2026-08-09T10:11:12+00:00",
        }],
        "settings": FIXTURE["settingsNormalization"]["input"],
    })
    assert normalized["airlines"] == [FIXTURE["catalogNormalization"]["airlineExpected"]]
    assert normalized["airports"] == [FIXTURE["catalogNormalization"]["airportExpected"]]
    assert normalized["aircraftTypes"] == [FIXTURE["catalogNormalization"]["aircraftTypeExpected"]]
    assert normalized["flights"] == [FIXTURE["normalization"]["expectedFullFlight"]]
    assert normalized["settings"] == FIXTURE["settingsNormalization"]["expected"]
    for case in FIXTURE["invalidDocuments"]:
        with pytest.raises(LegacyV1Error):
            normalize_business_data_v1(case["value"])


def test_frozen_parser_matches_shared_duplicate_last_wins_and_ordering_golden():
    golden = FIXTURE["duplicateNormalization"]
    airline, airport = FIXTURE["validDocument"]["airlines"][0], FIXTURE["validDocument"]["airports"][0]
    aircraft, flight = FIXTURE["validDocument"]["aircraftTypes"][0], FIXTURE["validDocument"]["flights"][0]
    normalized = normalize_business_data_v1({
        "schemaVersion": 1,
        "airlines": [{**airline, "code": code, "icao": "AAA" if code == "AA" else "ZEX", "nameEn": f"airline-{index}"} for index, code in enumerate(golden["input"]["airlineCodes"])],
        "airports": [{**airport, "code": code, "icao": "", "nameEn": f"airport-{index}"} for index, code in enumerate(golden["input"]["airportCodes"])],
        "aircraftTypes": [{**aircraft, "icao": icao, "iata": "738" if icao == "B738" else "32N", "displayName": f"aircraft-{index}"} for index, icao in enumerate(golden["input"]["aircraftIcaos"])],
        "flights": [{**flight, **item, "flightNumber": str(index + 1)} for index, item in enumerate(golden["input"]["flights"])],
        "settings": {},
    })
    summary = {
        "airlineCodes": [item["code"] for item in normalized["airlines"]],
        "airportCodes": [item["code"] for item in normalized["airports"]],
        "aircraftIcaos": [item["icao"] for item in normalized["aircraftTypes"]],
        "flightKeys": [f'{item["departureDate"]}|{item["departureTime"] or ""}|{item["id"]}' for item in normalized["flights"]],
    }
    assert summary == golden["expected"]
    assert next(item for item in normalized["airlines"] if item["code"] == "ZX")["nameEn"] == "airline-2"
    assert next(item for item in normalized["flights"] if item["id"] == "same")["flightNumber"] == "3"


def test_first_publish_failure_retries_and_second_succeeds(tmp_path, monkeypatch):
    _write_v1(tmp_path, FIXTURE["validDocument"])
    real = initialization._publish
    calls = 0

    def flaky(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError("injected first failure")
        return real(*args, **kwargs)

    monkeypatch.setattr(initialization, "_publish", flaky)
    outcome = initialization.prepare_archive(tmp_path)
    assert outcome.status == "migrated" and outcome.attempts == 2
    assert _read_v2(tmp_path) == FIXTURE["validDocument"]
    assert not list((tmp_path / "flightarchive").glob("v2.migrating-*"))


def test_two_migration_failures_fall_back_to_seed_and_record_error(tmp_path, monkeypatch):
    source = _write_v1(tmp_path, FIXTURE["validDocument"])
    original = source.read_bytes()

    def fail_migration(_root, documents, **kwargs):
        if documents["flights.json"]:
            raise OSError("injected migration failure")
        return initialization._publish_original(_root, documents, **kwargs)

    monkeypatch.setattr(initialization, "_publish", fail_migration)
    outcome = initialization.prepare_archive(tmp_path)
    assert outcome.status == "fallback-initialized"
    assert outcome.archive_state == "ready" and outcome.attempts == 2
    assert _read_v2(tmp_path)["flights"] == []
    assert source.read_bytes() == original
    migration_dir = tmp_path / "flightarchive" / "migrations"
    status = json.loads((migration_dir / "v1-to-v2.status.json").read_text())
    assert status["state"] == "failed" and status["attempts"] == 2
    assert "injected migration failure" in (migration_dir / "v1-to-v2.log.jsonl").read_text()
    records = _activity_records(tmp_path)
    seeded = [record for record in records if record["code"] == "v1-to-v2-failed-fallback-seeded"]
    assert len(seeded) == 1
    assert seeded[0]["severity"] == "error" and seeded[0]["state"] == "failed"
    assert seeded[0]["details"] == {
        "attempts": 2, "error": "injected migration failure", "noFlightsImported": True,
    }
    assert not any(record["code"] == "v1-to-v2-failed" for record in records)


def test_invalid_v1_fallback_seed_activity_contract(tmp_path):
    invalid = {**FIXTURE["validDocument"], "flights": [*FIXTURE["validDocument"]["flights"], {}]}
    _write_v1(tmp_path, invalid)
    outcome = initialization.prepare_archive(tmp_path)
    assert outcome.status == "fallback-initialized" and outcome.archive_state == "ready"
    assert _read_v2(tmp_path)["flights"] == []
    records = _activity_records(tmp_path)
    seeded = [record for record in records if record["code"] == "v1-to-v2-failed-fallback-seeded"]
    assert len(seeded) == 1
    record = seeded[0]
    assert record["source"] == "startup" and record["kind"] == "migration"
    assert record["severity"] == "error" and record["state"] == "failed"
    assert record["details"]["attempts"] == 2
    assert record["details"]["noFlightsImported"] is True
    assert record["details"]["error"]
    assert not any(record["code"] == "v1-to-v2-failed" for record in records)
    assert not any(record["code"] == "v1-to-v2-succeeded" for record in records)


def test_fallback_seed_failure_records_plain_failure_not_seeded(tmp_path, monkeypatch):
    _write_v1(tmp_path, {**FIXTURE["validDocument"], "flights": [{}]})
    monkeypatch.setattr(
        initialization, "initialize_default_v2",
        lambda _root: initialization.BootstrapOutcome("invalid-existing", "migration-failed", error="seed failed"),
    )
    outcome = initialization.prepare_archive(tmp_path)
    assert outcome.status == "migration-failed" and outcome.archive_state == "migration-failed"
    records = _activity_records(tmp_path)
    failed = [record for record in records if record["code"] == "v1-to-v2-failed"]
    assert len(failed) == 1
    assert failed[0]["severity"] == "error" and failed[0]["state"] == "failed"
    assert failed[0]["details"]["attempts"] == 2
    assert "seed failed" in failed[0]["details"]["error"]
    assert "noFlightsImported" not in failed[0]["details"]
    assert not any(record["code"] == "v1-to-v2-failed-fallback-seeded" for record in records)


def test_invalid_v1_never_drops_entries_and_falls_back(tmp_path):
    invalid = {**FIXTURE["validDocument"], "flights": [*FIXTURE["validDocument"]["flights"], {}]}
    _write_v1(tmp_path, invalid)
    outcome = initialization.prepare_archive(tmp_path)
    assert outcome.status == "fallback-initialized"
    assert _read_v2(tmp_path)["flights"] == []


def test_failed_migration_reporting_does_not_follow_log_symlink(tmp_path):
    _write_v1(tmp_path, {**FIXTURE["validDocument"], "flights": [{}]})
    migration_dir = tmp_path / "flightarchive" / "migrations"
    migration_dir.mkdir()
    outside = tmp_path / "outside-log"
    outside.write_text("safe")
    (migration_dir / "v1-to-v2.log.jsonl").symlink_to(outside)
    outcome = initialization.prepare_archive(tmp_path)
    assert outcome.status == "fallback-initialized" and outcome.archive_state == "ready"
    assert outside.read_text() == "safe"


def test_existing_valid_v2_skips_without_opening_v1(tmp_path, monkeypatch):
    initialization.initialize_default_v2(tmp_path)
    _write_v1(tmp_path, FIXTURE["validDocument"])
    monkeypatch.setattr(initialization, "_read_legacy_v1", lambda _path: (_ for _ in ()).throw(AssertionError("opened v1")))
    assert initialization.prepare_archive(tmp_path).status == "existing"


def test_invalid_formal_v2_is_preserved_and_v1_not_opened(tmp_path, monkeypatch):
    formal = tmp_path / "flightarchive" / "v2"
    formal.mkdir(parents=True)
    (formal / "manifest.json").write_text("{}", encoding="utf-8")
    before = (formal / "manifest.json").read_bytes()
    _write_v1(tmp_path, FIXTURE["validDocument"])
    monkeypatch.setattr(initialization, "_read_legacy_v1", lambda _path: (_ for _ in ()).throw(AssertionError("opened v1")))
    outcome = initialization.prepare_archive(tmp_path)
    assert outcome.status == "invalid-existing" and outcome.archive_state == "migration-failed"
    assert (formal / "manifest.json").read_bytes() == before


def test_preexisting_migrating_named_directories_and_symlinks_are_preserved(tmp_path):
    parent = tmp_path / "flightarchive"
    parent.mkdir()
    stale = parent / "v2.migrating-stale"
    stale.mkdir()
    (stale / "piece").write_text("partial")
    outside = tmp_path / "outside"
    outside.mkdir()
    marker = outside / "keep"
    marker.write_text("safe")
    link = parent / "v2.migrating-link"
    link.symlink_to(outside, target_is_directory=True)
    outcome = initialization.prepare_archive(tmp_path)
    assert outcome.status == "initialized" and outcome.archive_state == "ready"
    assert stale.is_dir() and (stale / "piece").read_text() == "partial"
    assert link.is_symlink() and marker.read_text() == "safe"


def test_symlinked_archive_parent_is_rejected_without_touching_target(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    marker = outside / "keep"
    marker.write_text("safe")
    (tmp_path / "flightarchive").symlink_to(outside, target_is_directory=True)
    outcome = initialization.prepare_archive(tmp_path)
    assert outcome.archive_state == "migration-failed"
    assert marker.read_text() == "safe" and not (outside / "v2").exists()


def test_symlinked_v1_directory_is_rejected_before_source_read_and_target_is_unchanged(tmp_path):
    parent = tmp_path / "flightarchive"
    parent.mkdir()
    outside = tmp_path / "outside-v1"
    outside.mkdir()
    source = outside / "business-data.json"
    source.write_text(json.dumps(FIXTURE["validDocument"]), encoding="utf-8")
    before = source.read_bytes()
    (parent / "v1").symlink_to(outside, target_is_directory=True)
    outcome = initialization.prepare_archive(tmp_path)
    assert outcome.archive_state == "migration-failed"
    assert source.read_bytes() == before
    assert not (parent / "v2").exists()
    status = json.loads((parent / "migrations" / "v1-to-v2.status.json").read_text())
    assert status["state"] == "failed"


@pytest.mark.parametrize("point", ["file_fsync", "directory_fsync", "compare", "rename"])
def test_injected_durability_and_compare_failures_leave_no_partial_v2(tmp_path, monkeypatch, point):
    _write_v1(tmp_path, FIXTURE["validDocument"])
    monkeypatch.setattr(initialization, f"_{point}", lambda *args, **kwargs: (_ for _ in ()).throw(OSError(point)))
    monkeypatch.setattr(initialization, "initialize_default_v2", lambda _root: (_ for _ in ()).throw(OSError("no fallback")))
    outcome = initialization.prepare_archive(tmp_path)
    assert outcome.archive_state == "migration-failed"
    assert not (tmp_path / "flightarchive" / "v2").exists()
    assert not list((tmp_path / "flightarchive").glob("v2.migrating-*"))
    records = _activity_records(tmp_path)
    assert [record["code"] for record in records] == ["v1-to-v2-failed"]
    assert records[0]["severity"] == "error" and records[0]["state"] == "failed"
    assert "noFlightsImported" not in records[0]["details"]


def test_document_size_limit_matches_runtime_rejection():
    assert initialization.MAX_DOCUMENT_BYTES == ARCHIVE_MAX_DOCUMENT_BYTES


def test_publish_refuses_document_over_runtime_size_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(initialization, "MAX_DOCUMENT_BYTES", 512)
    parent = tmp_path / "flightarchive"
    parent.mkdir()
    documents = initialization._documents(initialization._seed_aggregate())
    documents["flights.json"] = ["x" * 600]
    with pytest.raises(OSError):
        initialization._publish(parent, documents, expected=initialization._aggregate(documents))
    assert not (parent / "v2").exists()
    assert not list(parent.glob("v2.migrating-*"))


def test_existing_v2_with_oversized_document_is_invalid(tmp_path, monkeypatch):
    initialization.initialize_default_v2(tmp_path)
    formal = tmp_path / "flightarchive" / "v2"
    seed_max = max(path.stat().st_size for path in formal.iterdir())
    monkeypatch.setattr(initialization, "MAX_DOCUMENT_BYTES", seed_max + 10)
    (formal / "flights.json").write_text(json.dumps("x" * (seed_max + 50)), encoding="utf-8")
    outcome = initialization.initialize_default_v2(tmp_path)
    assert outcome.status == "invalid-existing" and outcome.archive_state == "migration-failed"
    assert outcome.error


def test_post_rename_fsync_failure_keeps_committed_migration(tmp_path, monkeypatch):
    _write_v1(tmp_path, FIXTURE["validDocument"])
    monkeypatch.setattr(
        initialization, "_fsync_published",
        lambda *args, **kwargs: (_ for _ in ()).throw(OSError("post-rename fsync")),
    )
    monkeypatch.setattr(initialization, "initialize_default_v2", lambda _root: (_ for _ in ()).throw(AssertionError("fallback")))
    outcome = initialization.prepare_archive(tmp_path)
    assert outcome.status == "migrated" and outcome.archive_state == "ready"
    assert outcome.attempts == 1
    assert _read_v2(tmp_path) == FIXTURE["validDocument"]
    activity = list((tmp_path / "flightarchive" / "log" / "activity").glob("*.jsonl"))
    assert activity
    activity_text = activity[0].read_text()
    assert "v1-to-v2-committed" in activity_text
    assert '"code":"v1-to-v2-succeeded"' in activity_text
    assert '"code":"v1-to-v2-failed"' not in activity_text
