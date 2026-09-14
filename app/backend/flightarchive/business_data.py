# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Portable persistence for FlightArchive business records only.

This deliberately serializes the domain store only. Resource relations are RFG
virtual paths; source scans and local filesystem paths never enter this contract.
"""
from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

BUSINESS_DATA_SCHEMA_VERSION = 1
BUSINESS_DATA_FILENAME = "business-data.json"


class BusinessDataError(Exception):
    pass


def make_business_data(domain: dict[str, Any]) -> dict[str, Any]:
    """Whitelist domain keys so accidental registry/path data cannot leak."""
    return {
        "schemaVersion": BUSINESS_DATA_SCHEMA_VERSION,
        "airlines": domain.get("airlines") or [],
        "airports": domain.get("airports") or [],
        "aircraftTypes": domain.get("aircraftTypes") or [],
        "flights": domain.get("flights") or [],
        "settings": domain.get("settings") or {},
    }


def parse_business_data(raw: Any) -> dict[str, Any]:
    """Validate BusinessData at the current schema version."""
    if not isinstance(raw, dict):
        raise BusinessDataError("business data must be a JSON object")
    version = raw.get("schemaVersion")
    # Booleans compare equal to ints, so reject them explicitly.
    if isinstance(version, bool) or version != BUSINESS_DATA_SCHEMA_VERSION:
        raise BusinessDataError(f"business data schemaVersion must be exactly {BUSINESS_DATA_SCHEMA_VERSION}")
    for key in ("airlines", "airports", "aircraftTypes", "flights"):
        if key not in raw:
            raise BusinessDataError(f"business data {key} is required for schemaVersion {BUSINESS_DATA_SCHEMA_VERSION}")
        if not isinstance(raw[key], list):
            raise BusinessDataError(f"business data {key} must be an array")
    if "settings" not in raw:
        raise BusinessDataError(f"business data settings is required for schemaVersion {BUSINESS_DATA_SCHEMA_VERSION}")
    if not isinstance(raw["settings"], dict):
        raise BusinessDataError("business data settings must be an object")
    def reject_legacy(value: Any) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if key in {"local_path", "status", "primaryBrandColor", "contrastBrandColor", "boardingPassPrimaryColor", "boardingPassContrastColor"} or key.endswith("AssetId") or key.endswith("AssetIds") or key == "assetTags":
                    raise BusinessDataError(f"business data may not contain legacy or local field {key}")
                reject_legacy(child)
        elif isinstance(value, list):
            for child in value: reject_legacy(child)
    reject_legacy(raw)
    for index, aircraft_type in enumerate(raw["aircraftTypes"]):
        if isinstance(aircraft_type, dict) and set(aircraft_type) - {"icao", "iata", "manufacturer", "displayName"}:
            raise BusinessDataError(f"aircraft type {index} contains unsupported fields")
    # Validate portable flight presentation data on every disk load as well as
    # at CRUD time.
    from .domain.models import (
        validate_electronic_boarding_pass,
        validate_paper_boarding_pass_layouts,
    )
    for index, flight in enumerate(raw.get("flights") or []):
        if not isinstance(flight, dict):
            continue
        issues = validate_paper_boarding_pass_layouts(flight.get("paperBoardingPassLayouts", {}), flight)
        issues.extend(validate_electronic_boarding_pass(flight.get("electronicBoardingPass"), flight))
        if issues:
            raise BusinessDataError(f"flight {index} boarding-pass presentation: {'; '.join(issues)}")
    return make_business_data(raw)


def read_business_data(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BusinessDataError("could not read valid business data JSON") from exc
    return parse_business_data(raw)


def write_business_data_atomic(path: Path, data: dict[str, Any]) -> None:
    # Model serializers deliberately order fields by business group.  Preserve
    # that order for a human-readable, stable document instead of alphabetizing
    # nested concepts apart.
    payload = json.dumps(parse_business_data(data), ensure_ascii=False, indent=2).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except OSError:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


@dataclass
class BusinessDataPersistence:
    directory: Path
    loaded: bool = False
    writable: bool = True
    last_error: str | None = None

    @property
    def mode(self) -> str: return "local"

    @property
    def path(self) -> Path:
        return self.directory / "flightarchive" / "v1" / BUSINESS_DATA_FILENAME

    def load(self) -> dict[str, Any] | None:
        if not self.path.exists():
            return None
        try:
            data = read_business_data(self.path)
        except BusinessDataError as exc:
            self.last_error = str(exc)
            return None
        self.loaded = True
        return data

    def save(self, data: dict[str, Any]) -> None:
        try:
            write_business_data_atomic(self.path, data)
            self.writable = True
            self.last_error = None
        except OSError as exc:
            self.writable = False
            self.last_error = "could not save business data"
            raise BusinessDataError(self.last_error) from exc
