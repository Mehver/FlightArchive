# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Frozen, self-contained reader and normalizer for BusinessData schema v1.

This module belongs only to the one-way startup migration tool.  It must not
import the legacy domain, workspace, models, or persistence implementation.
"""
from __future__ import annotations

import math
import re
import uuid
from datetime import datetime, timezone
from typing import Any


class LegacyV1Error(ValueError):
    pass


_HEX = re.compile(r"^#[0-9A-F]{6}$")
_IATA = re.compile(r"^[A-Z0-9]{2,3}$")
_AIRLINE_ICAO = re.compile(r"^[A-Z]{3}$")
_AIRPORT = re.compile(r"^[A-Z]{3,4}$")
_AIRPORT_ICAO = re.compile(r"^[A-Z]{4}$")
_AIRCRAFT_ICAO = re.compile(r"^[A-Z0-9]{2,4}$")
_AIRCRAFT_IATA = re.compile(r"^[A-Z0-9]{3}$")
_FLIGHT_NUMBER = re.compile(r"^\d{1,4}$")
_TIME = re.compile(r"^\d{2}:\d{2}(:\d{2})?$")
_REGISTRATION = re.compile(r"^[A-Z0-9]+(?:-[A-Z0-9]+)*$")
_TEMPLATE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.svg$")
_LEGACY_FIELDS = {
    "local_path", "status", "primaryBrandColor", "contrastBrandColor",
    "boardingPassPrimaryColor", "boardingPassContrastColor", "assetTags",
}


def _string(value: Any, limit: int = 512) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _optional(value: Any, limit: int = 512) -> str | None:
    result = _string(value, limit)
    return result or None


def _strings(value: Any, limit: int, item_limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value[:limit]:
        normalized = _string(item, item_limit)
        if normalized and normalized not in result:
            result.append(normalized)
    return result


def _color(value: Any) -> str | None:
    upper = value.upper() if isinstance(value, str) else ""
    return upper if _HEX.fullmatch(upper) else None


def _safe_path(value: Any) -> bool:
    return bool(
        isinstance(value, str) and value and len(value) <= 512
        and "\\" not in value and "\0" not in value and not value.startswith("/")
        and all(part not in {"", ".", ".."} for part in value.split("/"))
        and not value.startswith(("inbox/", "ignore/"))
    )


def _reject_legacy(value: Any) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key in _LEGACY_FIELDS or key.endswith("AssetId") or key.endswith("AssetIds"):
                raise LegacyV1Error(f"unsupported legacy or local field {key}")
            _reject_legacy(child)
    elif isinstance(value, list):
        for child in value:
            _reject_legacy(child)


def _airline(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise LegacyV1Error("malformed airline entry")
    colors = raw.get("brandColors") if isinstance(raw.get("brandColors"), dict) else {}
    value = {
        "code": _string(raw.get("code"), 8).upper(),
        "icao": _string(raw.get("icao"), 8).upper(),
        "nameZh": _string(raw.get("nameZh"), 128),
        "nameEn": _string(raw.get("nameEn"), 128),
        "alliance": _optional(raw.get("alliance"), 64),
        "horizontalLogoResourcePath": _optional(raw.get("horizontalLogoResourcePath"), 512),
        "horizontalDarkLogoResourcePath": _optional(raw.get("horizontalDarkLogoResourcePath"), 512),
        "symbolLogoResourcePath": _optional(raw.get("symbolLogoResourcePath"), 512),
        "brandColors": {"primary": _color(colors.get("primary")), "contrast": _color(colors.get("contrast"))},
    }
    if not _IATA.fullmatch(value["code"]) or not (value["nameZh"] or value["nameEn"]):
        raise LegacyV1Error(f"invalid airline entry {value['code']!r}")
    if value["icao"] and not _AIRLINE_ICAO.fullmatch(value["icao"]):
        raise LegacyV1Error(f"invalid airline ICAO {value['icao']!r}")
    for field in ("horizontalLogoResourcePath", "horizontalDarkLogoResourcePath", "symbolLogoResourcePath"):
        if value[field] is not None and not _safe_path(value[field]):
            raise LegacyV1Error(f"invalid airline resource path {field}")
    return value


def _airport(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise LegacyV1Error("malformed airport entry")
    value = {
        "code": _string(raw.get("code"), 8).upper(), "icao": _string(raw.get("icao"), 8).upper(),
        "nameZh": _string(raw.get("nameZh"), 128), "nameEn": _string(raw.get("nameEn"), 128),
        "cityZh": _string(raw.get("cityZh"), 128), "cityEn": _string(raw.get("cityEn"), 128),
        "countryZh": _string(raw.get("countryZh"), 128), "countryEn": _string(raw.get("countryEn"), 128),
        "terminals": _strings(raw.get("terminals"), 32, 64),
    }
    if not _AIRPORT.fullmatch(value["code"]) or not (value["nameZh"] or value["nameEn"]):
        raise LegacyV1Error(f"invalid airport entry {value['code']!r}")
    if value["icao"] and not _AIRPORT_ICAO.fullmatch(value["icao"]):
        raise LegacyV1Error(f"invalid airport ICAO {value['icao']!r}")
    return value


def _aircraft(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or set(raw) - {"icao", "iata", "manufacturer", "displayName"}:
        raise LegacyV1Error("malformed or unsupported aircraft type entry")
    value = {
        "icao": _string(raw.get("icao"), 8).upper(), "iata": _string(raw.get("iata"), 8),
        "manufacturer": _optional(raw.get("manufacturer"), 128),
        "displayName": _string(raw.get("displayName"), 128),
    }
    if not _AIRCRAFT_ICAO.fullmatch(value["icao"]) or not value["displayName"]:
        raise LegacyV1Error(f"invalid aircraft type {value['icao']!r}")
    if value["iata"] and not _AIRCRAFT_IATA.fullmatch(value["iata"]):
        raise LegacyV1Error(f"invalid aircraft IATA {value['iata']!r}")
    return value


def _number(container: dict[str, Any], key: str, low: float, high: float) -> bool:
    value = container.get(key)
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and low <= value <= high


def _layouts(value: Any, flight: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(value, dict) or len(value) > 2:
        raise LegacyV1Error("invalid paper boarding pass layouts")
    result: dict[str, Any] = {}
    for slot, config in value.items():
        resource = f"{slot}ResourcePath"
        if slot not in {"paperBoardingPassFront", "paperBoardingPassBack"} or not flight.get(resource):
            raise LegacyV1Error(f"invalid boarding pass layout {slot!r}")
        if not isinstance(config, dict) or set(config) - {"schemaVersion", "algorithm", "crop", "templateId", "placement"}:
            raise LegacyV1Error(f"invalid boarding pass layout {slot!r}")
        crop, placement = config.get("crop"), config.get("placement")
        if (
            type(config.get("schemaVersion")) is not int or config.get("schemaVersion") != 1
            or config.get("algorithm") not in {"adaptive", "canny", "sobel", "laplacian"}
            or not isinstance(config.get("templateId"), str) or not _TEMPLATE.fullmatch(config["templateId"])
            or not isinstance(crop, dict) or set(crop) - {"centerX", "centerY", "width", "height", "rotationDegrees", "corners"}
            or not isinstance(placement, dict) or set(placement) - {"scale", "rotationDegrees", "offsetX", "offsetY"}
            or not all((_number(crop, "centerX", 0, 1_000_000), _number(crop, "centerY", 0, 1_000_000),
                        _number(crop, "width", .001, 1_000_000), _number(crop, "height", .001, 1_000_000),
                        _number(crop, "rotationDegrees", -360, 360), _number(placement, "scale", .01, 10),
                        _number(placement, "rotationDegrees", -360, 360), _number(placement, "offsetX", -1, 1),
                        _number(placement, "offsetY", -1, 1)))
        ):
            raise LegacyV1Error(f"invalid boarding pass layout {slot!r}")
        result[slot] = {
            "schemaVersion": config["schemaVersion"], "algorithm": config["algorithm"],
            "crop": dict(crop), "templateId": config["templateId"], "placement": dict(placement),
        }
    return result


def _electronic(value: Any, flight: dict[str, Any]) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - {"schemaVersion", "extraction"} or type(value.get("schemaVersion")) is not int or value.get("schemaVersion") != 1:
        raise LegacyV1Error("invalid electronic boarding pass")
    if not flight.get("electronicBoardingPassResourcePath"):
        raise LegacyV1Error("electronic boarding pass has no resource")
    extraction = value.get("extraction")
    if extraction is not None:
        if not isinstance(extraction, dict) or set(extraction) - {"crop", "presetName"}:
            raise LegacyV1Error("invalid electronic boarding pass extraction")
        preset = extraction.get("presetName")
        if not isinstance(extraction.get("crop"), dict) or not isinstance(preset, str) or not preset.strip() or len(preset) > 128:
            raise LegacyV1Error("invalid electronic boarding pass extraction")
    return {"schemaVersion": 1, "extraction": dict(extraction) if isinstance(extraction, dict) else None}


def _flight(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise LegacyV1Error("malformed flight entry")
    paths = ("paperBoardingPassFrontResourcePath", "paperBoardingPassBackResourcePath", "electronicBoardingPassResourcePath")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    value: dict[str, Any] = {
        "id": _string(raw.get("id"), 64) or uuid.uuid4().hex, "flightNumber": _string(raw.get("flightNumber"), 12),
        "airlineCode": _string(raw.get("airlineCode"), 8).upper(),
        "departureAirport": _string(raw.get("departureAirport"), 8).upper(),
        "arrivalAirport": _string(raw.get("arrivalAirport"), 8).upper(),
        "departureTerminal": _optional(raw.get("departureTerminal"), 16),
        "arrivalTerminal": _optional(raw.get("arrivalTerminal"), 16),
        "departureDate": _string(raw.get("departureDate"), 10),
        "departureTime": _optional(raw.get("departureTime"), 8), "arrivalTime": _optional(raw.get("arrivalTime"), 8),
        "aircraftTypeIcao": _string(raw.get("aircraftTypeIcao"), 8).upper() or None,
        "registration": _string(raw.get("registration"), 10_000).upper() or None,
        "seat": _optional(raw.get("seat"), 8), "notes": _string(raw.get("notes"), 4096),
        "createdAt": _string(raw.get("createdAt"), 40) or now, "updatedAt": _string(raw.get("updatedAt"), 40) or now,
        **{field: _optional(raw.get(field), 512) for field in paths},
        "attachmentResourcePaths": _strings(raw.get("attachmentResourcePaths"), 32, 512),
        "boardingPassColor": _color(raw.get("boardingPassColor")),
    }
    try:
        datetime.strptime(value["departureDate"], "%Y-%m-%d")
    except ValueError as exc:
        raise LegacyV1Error("invalid flight departure date") from exc
    if not value["id"] or not _FLIGHT_NUMBER.fullmatch(value["flightNumber"]) or not _IATA.fullmatch(value["airlineCode"]):
        raise LegacyV1Error(f"invalid flight {value['id']!r}")
    if not _AIRPORT.fullmatch(value["departureAirport"]) or not _AIRPORT.fullmatch(value["arrivalAirport"]):
        raise LegacyV1Error(f"invalid flight airports {value['id']!r}")
    if any(value[field] is not None and not _safe_path(value[field]) for field in paths):
        raise LegacyV1Error(f"invalid flight resource path {value['id']!r}")
    if any(not _safe_path(path) for path in value["attachmentResourcePaths"]):
        raise LegacyV1Error(f"invalid flight attachments {value['id']!r}")
    if any(item is not None and not _TIME.fullmatch(item) for item in (value["departureTime"], value["arrivalTime"])):
        raise LegacyV1Error(f"invalid flight time {value['id']!r}")
    registration = value["registration"]
    if registration is not None and (not 2 <= len(registration) <= 16 or not _REGISTRATION.fullmatch(registration)):
        raise LegacyV1Error(f"invalid flight registration {value['id']!r}")
    aircraft = value["aircraftTypeIcao"]
    if aircraft is not None and not _AIRCRAFT_ICAO.fullmatch(aircraft):
        raise LegacyV1Error(f"invalid flight aircraft type {value['id']!r}")
    value["paperBoardingPassLayouts"] = _layouts(raw.get("paperBoardingPassLayouts", {}), value)
    value["electronicBoardingPass"] = _electronic(raw.get("electronicBoardingPass"), value)
    # Match the historical serializer's field order.
    return {key: value[key] for key in (
        "id", "flightNumber", "airlineCode", "departureAirport", "arrivalAirport", "departureTerminal",
        "arrivalTerminal", "departureDate", "departureTime", "arrivalTime", "aircraftTypeIcao", "registration",
        "seat", "notes", "createdAt", "updatedAt", "paperBoardingPassFrontResourcePath",
        "paperBoardingPassBackResourcePath", "electronicBoardingPassResourcePath", "attachmentResourcePaths",
        "paperBoardingPassLayouts", "electronicBoardingPass", "boardingPassColor",
    )}


def normalize_business_data_v1(raw: Any) -> dict[str, Any]:
    """Validate and normalize every record; no invalid record is skipped."""
    if not isinstance(raw, dict) or type(raw.get("schemaVersion")) is not int or raw.get("schemaVersion") != 1:
        raise LegacyV1Error("business data schemaVersion must be exactly 1")
    for key in ("airlines", "airports", "aircraftTypes", "flights"):
        if key not in raw or not isinstance(raw[key], list):
            raise LegacyV1Error(f"business data {key} must be an array")
    if "settings" not in raw or not isinstance(raw["settings"], dict):
        raise LegacyV1Error("business data settings must be an object")
    _reject_legacy(raw)
    airlines: dict[str, dict[str, Any]] = {}
    airports: dict[str, dict[str, Any]] = {}
    aircraft: dict[str, dict[str, Any]] = {}
    flights: dict[str, dict[str, Any]] = {}
    for item in raw["airlines"]:
        normalized = _airline(item)
        airlines[normalized["code"]] = normalized
    for item in raw["airports"]:
        normalized = _airport(item)
        airports[normalized["code"]] = normalized
    for item in raw["aircraftTypes"]:
        normalized = _aircraft(item)
        aircraft[normalized["icao"]] = normalized
    for item in raw["flights"]:
        normalized = _flight(item)
        flights[normalized["id"]] = normalized
    settings = {key[:128]: value[:4096] for key, value in raw["settings"].items() if isinstance(key, str) and isinstance(value, str)}
    return {
        "schemaVersion": 1,
        "airlines": [airlines[key] for key in sorted(airlines)],
        "airports": [airports[key] for key in sorted(airports)],
        "aircraftTypes": [aircraft[key] for key in sorted(aircraft)],
        "flights": sorted(flights.values(), key=lambda item: (item["departureDate"], item["departureTime"] or "", item["id"])),
        "settings": dict(sorted(settings.items())),
    }
