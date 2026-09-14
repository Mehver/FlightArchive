# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Flight domain models and validation.

The serialized field names form the current FlightArchive BusinessData contract.
New fields (``seat`` and ``notes``) are optional with defaults.
"""

from __future__ import annotations

import re
import math
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

# ---------------------------------------------------------------------------
# color types
# ---------------------------------------------------------------------------

_HEX_COLOR_RE = re.compile(r"^#[0-9A-F]{6}$")


def is_valid_hex_color(value: Any) -> bool:
    """Return whether a value is a well-formed 6-digit uppercase hex colour."""
    return isinstance(value, str) and bool(_HEX_COLOR_RE.match(value))


def normalize_hex_color(value: Any) -> str | None:
    """Coerce a hex colour from untrusted JSON."""
    if isinstance(value, str):
        upper = value.upper()
        return upper if _HEX_COLOR_RE.match(upper) else None
    return None


def validate_optional_hex_color(value: Any, label: str) -> list[str]:
    """Validate an optional hex colour value."""
    if value is None:
        return []
    if normalize_hex_color(value) is not None:
        return []
    return [f"{label} must be a 6-digit hex colour string (e.g. \"#E60012\")"]


# ---------------------------------------------------------------------------
# errors / helpers
# ---------------------------------------------------------------------------


class ValidationError(Exception):
    """Raised when domain data fails validation.

    ``issues`` is a list of human-readable strings; routes translate this
    into a 422 API error.
    """

    def __init__(self, issues: list[str]):
        self.issues = issues
        super().__init__("; ".join(issues))


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id() -> str:
    return uuid.uuid4().hex


def _is_str(value: Any) -> bool:
    return isinstance(value, str)


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME_RE = re.compile(r"^\d{2}:\d{2}(:\d{2})?$")
_IATA_RE = re.compile(r"^[A-Z0-9]{2,3}$")
_AIRLINE_ICAO_RE = re.compile(r"^[A-Z]{3}$")
_AIRPORT_ICAO_RE = re.compile(r"^[A-Z]{4}$")
_AIRCRAFT_TYPE_ICAO_RE = re.compile(r"^[A-Z0-9]{2,4}$")
_AIRCRAFT_TYPE_IATA_RE = re.compile(r"^[A-Z0-9]{3}$")
_AIRPORT_RE = re.compile(r"^[A-Z]{3,4}$")
_FLIGHT_NUMBER_RE = re.compile(r"^\d{1,4}$")
_AIRCRAFT_REGISTRATION_RE = re.compile(r"^[A-Z0-9]+(?:-[A-Z0-9]+)*$")


def _check_date(value: str) -> bool:
    if not _DATE_RE.match(value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return False
    return True


def _opt_str(value: Any, max_len: int = 512) -> str | None:
    """Coerce an optional string field coming from untrusted JSON."""
    if value is None:
        return None
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[:max_len] if value else None


def _str(value: Any, max_len: int = 512) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()[:max_len]


def _registration(value: Any) -> str | None:
    """Normalize a user-entered aircraft registration without truncating it."""
    if not isinstance(value, str):
        return None
    normalized = value.strip().upper()
    return normalized or None


def _str_list(value: Any, max_items: int = 64, max_len: int = 64) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value[:max_items]:
        if isinstance(item, str) and item.strip():
            normalized = item.strip()[:max_len]
            if normalized not in out:
                out.append(normalized)
    return out


def validate_resource_relation_payload(data: dict[str, Any], single_fields: tuple[str, ...], list_field: str | None = None) -> list[str]:
    """Validate RFG virtual-resource paths before coercion."""
    issues: list[str] = []
    for field in single_fields:
        if field not in data:
            continue
        value = data[field]
        if value is not None and (not isinstance(value, str) or not _resource_path(value)):
            issues.append(f"{field} must be null or a safe RFG virtual path")
    if list_field and list_field in data:
        value = data[list_field]
        if not isinstance(value, list) or len(value) > 32:
            issues.append(f"{list_field} must be an array of at most 32 resource paths")
        elif any(not isinstance(item, str) or not _resource_path(item) for item in value):
            issues.append(f"{list_field} entries must be safe RFG virtual paths")
    return issues


def _resource_path(value: str) -> bool:
    return bool(value and len(value) <= 512 and "\\" not in value and "\x00" not in value and not value.startswith("/") and all(part not in {"", ".", ".."} for part in value.split("/")))


# ---------------------------------------------------------------------------
# catalog models
# ---------------------------------------------------------------------------


@dataclass
class Airline:
    code: str
    icao: str = ""
    nameZh: str = ""
    nameEn: str = ""
    # Null means no alliance; a name may be either a common or custom alliance.
    alliance: str | None = None
    horizontalLogoResourcePath: str | None = None
    horizontalDarkLogoResourcePath: str | None = None
    symbolLogoResourcePath: str | None = None
    brandColors: dict[str, str | None] = field(
        default_factory=lambda: {"primary": None, "contrast": None}
    )

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "icao": self.icao,
            "nameZh": self.nameZh,
            "nameEn": self.nameEn,
            "alliance": self.alliance,
            "horizontalLogoResourcePath": self.horizontalLogoResourcePath,
            "horizontalDarkLogoResourcePath": self.horizontalDarkLogoResourcePath,
            "symbolLogoResourcePath": self.symbolLogoResourcePath,
            "brandColors": {
                "primary": self.brandColors["primary"],
                "contrast": self.brandColors["contrast"],
            },
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Airline":
        raw_colors = data.get("brandColors")
        colors = raw_colors if isinstance(raw_colors, dict) else {}
        return cls(
            code=_str(data.get("code"), 8).upper(),
            icao=_str(data.get("icao"), 8).upper(),
            nameZh=_str(data.get("nameZh"), 128),
            nameEn=_str(data.get("nameEn"), 128),
            alliance=_opt_str(data.get("alliance"), 64),
            horizontalLogoResourcePath=_opt_str(data.get("horizontalLogoResourcePath"), 512),
            horizontalDarkLogoResourcePath=_opt_str(data.get("horizontalDarkLogoResourcePath"), 512),
            symbolLogoResourcePath=_opt_str(data.get("symbolLogoResourcePath"), 512),
            brandColors={
                "primary": normalize_hex_color(colors.get("primary")),
                "contrast": normalize_hex_color(colors.get("contrast")),
            },
        )

    def validate(self) -> list[str]:
        issues: list[str] = []
        if not self.code:
            issues.append("airline.code is required")
        elif not _IATA_RE.match(self.code):
            issues.append(f"airline.code {self.code!r} must be 2-3 letters/digits")
        if self.icao and not _AIRLINE_ICAO_RE.match(self.icao):
            issues.append(f"airline.icao {self.icao!r} must be 3 letters")
        if not (self.nameZh or self.nameEn):
            issues.append("airline needs nameZh or nameEn")
        for field, value in (
            ("horizontalLogoResourcePath", self.horizontalLogoResourcePath),
            ("horizontalDarkLogoResourcePath", self.horizontalDarkLogoResourcePath),
            ("symbolLogoResourcePath", self.symbolLogoResourcePath),
        ):
            if value is not None and not _resource_path(value):
                issues.append(f"airline.{field} must be a safe RFG virtual path")
        issues.extend(validate_optional_hex_color(self.brandColors["primary"], "airline.brandColors.primary"))
        issues.extend(validate_optional_hex_color(self.brandColors["contrast"], "airline.brandColors.contrast"))
        return issues


@dataclass
class Airport:
    code: str
    icao: str = ""
    nameZh: str = ""
    nameEn: str = ""
    cityZh: str = ""
    cityEn: str = ""
    countryZh: str = ""
    countryEn: str = ""
    terminals: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "icao": self.icao,
            "nameZh": self.nameZh,
            "nameEn": self.nameEn,
            "cityZh": self.cityZh,
            "cityEn": self.cityEn,
            "countryZh": self.countryZh,
            "countryEn": self.countryEn,
            "terminals": list(self.terminals),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Airport":
        return cls(
            code=_str(data.get("code"), 8).upper(),
            icao=_str(data.get("icao"), 8).upper(),
            nameZh=_str(data.get("nameZh"), 128),
            nameEn=_str(data.get("nameEn"), 128),
            cityZh=_str(data.get("cityZh"), 128),
            cityEn=_str(data.get("cityEn"), 128),
            countryZh=_str(data.get("countryZh"), 128),
            countryEn=_str(data.get("countryEn"), 128),
            terminals=_str_list(data.get("terminals"), 32),
        )

    def validate(self) -> list[str]:
        issues: list[str] = []
        if not self.code:
            issues.append("airport.code is required")
        elif not _AIRPORT_RE.match(self.code):
            issues.append(f"airport.code {self.code!r} must be 3-4 letters")
        if self.icao and not _AIRPORT_ICAO_RE.match(self.icao):
            issues.append(f"airport.icao {self.icao!r} must be 4 letters")
        if not (self.nameZh or self.nameEn):
            issues.append("airport needs nameZh or nameEn")
        return issues


@dataclass
class AircraftType:
    icao: str
    iata: str = ""
    # Null means no manufacturer; a name may be a suggested or custom value.
    manufacturer: str | None = None
    displayName: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "icao": self.icao,
            "iata": self.iata,
            "manufacturer": self.manufacturer,
            "displayName": self.displayName,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AircraftType":
        return cls(
            icao=_str(data.get("icao"), 8).upper(),
            iata=_str(data.get("iata"), 8),
            manufacturer=_opt_str(data.get("manufacturer"), 128),
            displayName=_str(data.get("displayName"), 128),
        )

    def validate(self) -> list[str]:
        issues: list[str] = []
        if not self.icao:
            issues.append("aircraftType.icao is required")
        elif not _AIRCRAFT_TYPE_ICAO_RE.match(self.icao):
            issues.append(f"aircraftType.icao {self.icao!r} must be 2-4 letters/digits")
        if self.iata and not _AIRCRAFT_TYPE_IATA_RE.match(self.iata):
            issues.append(f"aircraftType.iata {self.iata!r} must be 3 letters/digits")
        if not self.displayName:
            issues.append("aircraftType.displayName is required")
        return issues


# ---------------------------------------------------------------------------
# flight record
# ---------------------------------------------------------------------------

PAPER_BOARDING_PASS_SLOTS = (
    "paperBoardingPassFront",
    "paperBoardingPassBack",
)
_PAPER_BOARDING_PASS_ASSET_FIELDS = {slot: f"{slot}ResourcePath" for slot in PAPER_BOARDING_PASS_SLOTS}
_LAYOUT_TEMPLATE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.svg$")


@dataclass
class PaperBoardingPassLayout:
    """Portable crop and placement data for one paper boarding-pass side."""

    schemaVersion: int = 1
    algorithm: str = "adaptive"
    crop: dict[str, Any] = field(default_factory=dict)
    templateId: str = ""
    placement: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schemaVersion,
            "algorithm": self.algorithm,
            "crop": dict(self.crop) if isinstance(self.crop, dict) else self.crop,
            "templateId": self.templateId,
            "placement": dict(self.placement) if isinstance(self.placement, dict) else self.placement,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PaperBoardingPassLayout":
        return cls(
            schemaVersion=data.get("schemaVersion", 1),
            algorithm=data.get("algorithm", "adaptive"),
            crop=dict(data["crop"]) if isinstance(data.get("crop"), dict) else data.get("crop", {}),
            templateId=data.get("templateId", ""),
            placement=dict(data["placement"]) if isinstance(data.get("placement"), dict) else data.get("placement", {}),
        )


@dataclass
class ElectronicBoardingPassPresentation:
    """Derived presentation metadata for an electronic boarding pass."""

    schemaVersion: int = 1
    extraction: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schemaVersion,
            "extraction": dict(self.extraction) if isinstance(self.extraction, dict) else self.extraction,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ElectronicBoardingPassPresentation":
        extraction = data.get("extraction")
        return cls(
            schemaVersion=data.get("schemaVersion", 1),
            extraction=dict(extraction) if isinstance(extraction, dict) else extraction,
        )


def validate_paper_boarding_pass_layouts(value: Any, flight: dict[str, Any]) -> list[str]:
    """Strictly validate portable, image-free paper boarding-pass layouts."""
    if not isinstance(value, dict):
        return ["must be an object"]
    if len(value) > len(PAPER_BOARDING_PASS_SLOTS):
        return ["has too many slots"]
    issues: list[str] = []
    def number(obj: dict[str, Any], key: str, low: float, high: float, label: str) -> None:
        item = obj.get(key)
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item) or not low <= item <= high:
            issues.append(f"{label}.{key} must be a finite number in {low}..{high}")
    for slot, config in value.items():
        prefix = f"{slot}"
        if slot not in PAPER_BOARDING_PASS_SLOTS:
            issues.append(f"unknown slot {slot!r}")
            continue
        if not flight.get(_PAPER_BOARDING_PASS_ASSET_FIELDS[slot]):
            issues.append(f"{prefix} requires {_PAPER_BOARDING_PASS_ASSET_FIELDS[slot]}")
        if not isinstance(config, dict):
            issues.append(f"{prefix} must be an object")
            continue
        allowed = {"schemaVersion", "algorithm", "crop", "templateId", "placement"}
        unknown = set(config) - allowed
        if unknown:
            issues.append(f"{prefix} has unknown fields: {', '.join(sorted(unknown))}")
        if config.get("schemaVersion") != 1:
            issues.append(f"{prefix}.schemaVersion must be 1")
        if config.get("algorithm") not in ("adaptive", "canny", "sobel", "laplacian"):
            issues.append(f"{prefix}.algorithm is invalid")
        template = config.get("templateId")
        if not isinstance(template, str) or not _LAYOUT_TEMPLATE_RE.fullmatch(template):
            issues.append(f"{prefix}.templateId must be a safe SVG filename (max 128 characters)")
        crop = config.get("crop")
        if not isinstance(crop, dict):
            issues.append(f"{prefix}.crop must be an object")
        else:
            unknown_crop = set(crop) - {"centerX", "centerY", "width", "height", "rotationDegrees", "corners"}
            if unknown_crop: issues.append(f"{prefix}.crop has unknown fields")
            number(crop, "centerX", 0, 1_000_000, f"{prefix}.crop")
            number(crop, "centerY", 0, 1_000_000, f"{prefix}.crop")
            number(crop, "width", 0.001, 1_000_000, f"{prefix}.crop")
            number(crop, "height", 0.001, 1_000_000, f"{prefix}.crop")
            number(crop, "rotationDegrees", -360, 360, f"{prefix}.crop")
            # Optional legacy ``corners`` are preserved but ignored.  Their
            # shape cannot affect the rectangular crop renderer.
        placement = config.get("placement")
        if not isinstance(placement, dict):
            issues.append(f"{prefix}.placement must be an object")
        else:
            if set(placement) - {"scale", "rotationDegrees", "offsetX", "offsetY"}: issues.append(f"{prefix}.placement has unknown fields")
            number(placement, "scale", 0.01, 10, f"{prefix}.placement")
            number(placement, "rotationDegrees", -360, 360, f"{prefix}.placement")
            number(placement, "offsetX", -1, 1, f"{prefix}.placement")
            number(placement, "offsetY", -1, 1, f"{prefix}.placement")
    return issues


def validate_electronic_boarding_pass(value: Any, flight: dict[str, Any]) -> list[str]:
    """Validate optional electronic boarding-pass presentation data."""
    if value is None:
        return []
    if not isinstance(value, dict):
        return ["must be an object or null"]
    issues: list[str] = []
    unknown = set(value) - {"schemaVersion", "extraction"}
    if unknown:
        issues.append(f"has unknown fields: {', '.join(sorted(unknown))}")
    if value.get("schemaVersion") != 1 or isinstance(value.get("schemaVersion"), bool):
        issues.append("schemaVersion must be 1")
    if not flight.get("electronicBoardingPassResourcePath"):
        issues.append("requires electronicBoardingPassResourcePath")
    extraction = value.get("extraction")
    if extraction is not None:
        if not isinstance(extraction, dict):
            issues.append("extraction must be an object or null")
        else:
            unknown_extraction = set(extraction) - {"crop", "presetName"}
            if unknown_extraction:
                issues.append("extraction has unknown fields")
            if not isinstance(extraction.get("crop"), dict):
                issues.append("extraction.crop must be an object")
            preset_name = extraction.get("presetName")
            if not isinstance(preset_name, str) or not preset_name.strip() or len(preset_name) > 128:
                issues.append("extraction.presetName must be a nonempty string of at most 128 characters")
    return issues


@dataclass
class FlightRecord:
    id: str
    flightNumber: str
    airlineCode: str
    departureAirport: str
    arrivalAirport: str
    departureDate: str
    departureTerminal: str | None = None
    arrivalTerminal: str | None = None
    departureTime: str | None = None
    arrivalTime: str | None = None
    aircraftTypeIcao: str | None = None
    registration: str | None = None
    seat: str | None = None
    notes: str = ""
    createdAt: str = ""
    updatedAt: str = ""
    paperBoardingPassFrontResourcePath: str | None = None
    paperBoardingPassBackResourcePath: str | None = None
    electronicBoardingPassResourcePath: str | None = None
    attachmentResourcePaths: list[str] = field(default_factory=list)
    paperBoardingPassLayouts: dict[str, PaperBoardingPassLayout] = field(default_factory=dict)
    electronicBoardingPass: ElectronicBoardingPassPresentation | None = None
    boardingPassColor: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "flightNumber": self.flightNumber,
            "airlineCode": self.airlineCode,
            "departureAirport": self.departureAirport,
            "arrivalAirport": self.arrivalAirport,
            "departureTerminal": self.departureTerminal,
            "arrivalTerminal": self.arrivalTerminal,
            "departureDate": self.departureDate,
            "departureTime": self.departureTime,
            "arrivalTime": self.arrivalTime,
            "aircraftTypeIcao": self.aircraftTypeIcao,
            "registration": self.registration,
            "seat": self.seat,
            "notes": self.notes,
            "createdAt": self.createdAt,
            "updatedAt": self.updatedAt,
            "paperBoardingPassFrontResourcePath": self.paperBoardingPassFrontResourcePath,
            "paperBoardingPassBackResourcePath": self.paperBoardingPassBackResourcePath,
            "electronicBoardingPassResourcePath": self.electronicBoardingPassResourcePath,
            "attachmentResourcePaths": list(self.attachmentResourcePaths),
            "paperBoardingPassLayouts": {
                slot: layout.to_dict() for slot, layout in self.paperBoardingPassLayouts.items()
            },
            "electronicBoardingPass": self.electronicBoardingPass.to_dict() if self.electronicBoardingPass else None,
            "boardingPassColor": self.boardingPassColor,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "FlightRecord":
        raw_paper_layouts = data.get("paperBoardingPassLayouts")
        if isinstance(raw_paper_layouts, dict):
            paper_layouts = {
                slot: PaperBoardingPassLayout.from_dict(layout)
                for slot, layout in raw_paper_layouts.items()
                if slot in PAPER_BOARDING_PASS_SLOTS and isinstance(layout, dict)
            }
        else:
            paper_layouts = {}
        raw_electronic = data.get("electronicBoardingPass")
        return cls(
            id=_str(data.get("id"), 64) or new_id(),
            flightNumber=_str(data.get("flightNumber"), 12),
            airlineCode=_str(data.get("airlineCode"), 8).upper(),
            departureAirport=_str(data.get("departureAirport"), 8).upper(),
            arrivalAirport=_str(data.get("arrivalAirport"), 8).upper(),
            departureDate=_str(data.get("departureDate"), 10),
            departureTerminal=_opt_str(data.get("departureTerminal"), 16),
            arrivalTerminal=_opt_str(data.get("arrivalTerminal"), 16),
            departureTime=_opt_str(data.get("departureTime"), 8),
            arrivalTime=_opt_str(data.get("arrivalTime"), 8),
            aircraftTypeIcao=(
                _str(data.get("aircraftTypeIcao"), 8).upper() or None
                if data.get("aircraftTypeIcao")
                else None
            ),
            registration=_registration(data.get("registration")),
            seat=_opt_str(data.get("seat"), 8),
            notes=_str(data.get("notes"), 4096),
            createdAt=_str(data.get("createdAt"), 40) or utc_now_iso(),
            updatedAt=_str(data.get("updatedAt"), 40) or utc_now_iso(),
            paperBoardingPassFrontResourcePath=_opt_str(data.get("paperBoardingPassFrontResourcePath"), 512),
            paperBoardingPassBackResourcePath=_opt_str(data.get("paperBoardingPassBackResourcePath"), 512),
            electronicBoardingPassResourcePath=_opt_str(data.get("electronicBoardingPassResourcePath"), 512),
            attachmentResourcePaths=_str_list(data.get("attachmentResourcePaths"), max_items=32, max_len=512),
            paperBoardingPassLayouts=paper_layouts,
            electronicBoardingPass=(
                ElectronicBoardingPassPresentation.from_dict(raw_electronic)
                if isinstance(raw_electronic, dict)
                else None
            ),
            boardingPassColor=normalize_hex_color(data.get("boardingPassColor")),
        )

    def validate(self, *, include_boarding_pass_layouts: bool = True) -> list[str]:
        issues: list[str] = []
        if not self.flightNumber:
            issues.append("flight.flightNumber is required")
        elif not _FLIGHT_NUMBER_RE.match(self.flightNumber):
            issues.append("flight.flightNumber must contain 1-4 digits")
        if not self.airlineCode:
            issues.append("flight.airlineCode is required")
        elif not _IATA_RE.match(self.airlineCode):
            issues.append(f"flight.airlineCode {self.airlineCode!r} must be 2-3 letters/digits")
        for label, code in (
            ("departureAirport", self.departureAirport),
            ("arrivalAirport", self.arrivalAirport),
        ):
            if not code:
                issues.append(f"flight.{label} is required")
            elif not _AIRPORT_RE.match(code):
                issues.append(f"flight.{label} {code!r} must be 3-4 letters")
        if not self.departureDate:
            issues.append("flight.departureDate is required")
        elif not _check_date(self.departureDate):
            issues.append(f"flight.departureDate {self.departureDate!r} must be YYYY-MM-DD")
        for label, value in (("departureTime", self.departureTime), ("arrivalTime", self.arrivalTime)):
            if value is not None and not _TIME_RE.match(value):
                issues.append(f"flight.{label} {value!r} must be HH:MM")
        if self.aircraftTypeIcao is not None and not _AIRCRAFT_TYPE_ICAO_RE.match(self.aircraftTypeIcao):
            issues.append(f"flight.aircraftTypeIcao {self.aircraftTypeIcao!r} must be 2-4 letters/digits")
        if self.registration is not None and (
            not 2 <= len(self.registration) <= 16
            or not _AIRCRAFT_REGISTRATION_RE.match(self.registration)
        ):
            issues.append(
                f"flight.registration {self.registration!r} must be 2-16 letters/digits with single internal hyphens"
            )
        for field, value in (
            ("paperBoardingPassFrontResourcePath", self.paperBoardingPassFrontResourcePath),
            ("paperBoardingPassBackResourcePath", self.paperBoardingPassBackResourcePath),
            ("electronicBoardingPassResourcePath", self.electronicBoardingPassResourcePath),
        ):
            if value is not None and not _resource_path(value):
                issues.append(f"flight.{field} must be a safe RFG virtual path")
        if any(not _resource_path(value) for value in self.attachmentResourcePaths):
            issues.append("flight.attachmentResourcePaths entries must be safe RFG virtual paths")
        issues.extend(validate_optional_hex_color(self.boardingPassColor, "flight.boardingPassColor"))
        if include_boarding_pass_layouts:
            record = self.to_dict()
            issues.extend(validate_paper_boarding_pass_layouts(record["paperBoardingPassLayouts"], record))
            issues.extend(validate_electronic_boarding_pass(record["electronicBoardingPass"], record))
        return issues
