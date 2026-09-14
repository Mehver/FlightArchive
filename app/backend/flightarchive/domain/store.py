# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""In-memory domain store: flights, catalogs and settings.

Pure Python, no I/O, no framework imports. The store never writes to disk;
the workspace persists a successful mutation atomically.
"""

from __future__ import annotations

from typing import Any, Callable, Iterable

from .models import (
    AircraftType,
    Airline,
    Airport,
    FlightRecord,
    ValidationError,
    validate_electronic_boarding_pass,
    validate_paper_boarding_pass_layouts,
    validate_resource_relation_payload,
    utc_now_iso,
)
from .seed import DEFAULT_AIRCRAFT_TYPES, DEFAULT_AIRLINES, DEFAULT_AIRPORTS

CATALOG_KINDS = ("airlines", "airports", "aircraft-types")


class NotFoundError(Exception):
    """Raised when a requested domain entity does not exist."""


class ConflictError(Exception):
    """Raised when an operation conflicts with existing data."""


class DomainStore:
    def __init__(self) -> None:
        self.airlines: dict[str, Airline] = {}
        self.airports: dict[str, Airport] = {}
        self.aircraft_types: dict[str, AircraftType] = {}
        self.flights: dict[str, FlightRecord] = {}
        self.settings: dict[str, str] = {}
        self.on_change: Callable[[], None] | None = None

    # ------------------------------------------------------------------
    # internal helpers
    # ------------------------------------------------------------------

    def _changed(self) -> None:
        if self.on_change is not None:
            self.on_change()

    # ------------------------------------------------------------------
    # seeding / (de)serialization
    # ------------------------------------------------------------------

    def seed_defaults(self) -> None:
        """Populate catalogs with the built-in defaults (idempotent)."""
        if not self.airlines:
            for raw in DEFAULT_AIRLINES:
                airline = Airline.from_dict(raw)
                self.airlines[airline.code] = airline
        if not self.airports:
            for raw in DEFAULT_AIRPORTS:
                airport = Airport.from_dict(raw)
                self.airports[airport.code] = airport
        if not self.aircraft_types:
            for raw in DEFAULT_AIRCRAFT_TYPES:
                aircraft = AircraftType.from_dict(raw)
                self.aircraft_types[aircraft.icao] = aircraft

    def to_dict(self) -> dict[str, Any]:
        return {
            "airlines": [a.to_dict() for a in self._sorted(self.airlines.values())],
            "airports": [a.to_dict() for a in self._sorted(self.airports.values())],
            "aircraftTypes": [a.to_dict() for a in self._sorted(self.aircraft_types.values())],
            "flights": [f.to_dict() for f in self._sorted_flights(self.flights.values())],
            "settings": dict(sorted(self.settings.items())),
        }

    @staticmethod
    def _sorted(items: Iterable[Any]) -> list[Any]:
        return sorted(items, key=lambda x: (x.code if hasattr(x, "code") else x.icao))

    @staticmethod
    def _sorted_flights(items: Iterable[FlightRecord]) -> list[FlightRecord]:
        return sorted(items, key=lambda f: (f.departureDate, f.departureTime or "", f.id))

    def load_dict(self, data: dict[str, Any]) -> list[str]:
        """Replace all domain content from a validated dict.

        Returns a list of non-fatal issues (skipped invalid entries).
        Raises :class:`ValidationError` when the top-level shape is wrong.
        """
        if not isinstance(data, dict):
            raise ValidationError(["domain payload must be a JSON object"])
        issues: list[str] = []
        for key in ("airlines", "airports", "aircraftTypes", "flights"):
            if key in data and not isinstance(data[key], list):
                raise ValidationError([f"domain.{key} must be an array"])
        if "settings" in data and not isinstance(data["settings"], dict):
            raise ValidationError(["domain.settings must be an object"])

        airlines: dict[str, Airline] = {}
        for raw in data.get("airlines") or []:
            try:
                airline = Airline.from_dict(raw)
            except (AttributeError, TypeError):
                issues.append("skipped malformed airline entry")
                continue
            validation_issues = airline.validate()
            if validation_issues:
                issues.extend(f"skipped airline {airline.code!r}: {issue}" for issue in validation_issues)
            elif airline.code:
                airlines[airline.code] = airline
            else:
                issues.append("skipped airline without code")

        airports: dict[str, Airport] = {}
        for raw in data.get("airports") or []:
            try:
                airport = Airport.from_dict(raw)
            except (AttributeError, TypeError):
                issues.append("skipped malformed airport entry")
                continue
            validation_issues = airport.validate()
            if validation_issues:
                issues.extend(f"skipped airport {airport.code!r}: {issue}" for issue in validation_issues)
            elif airport.code:
                airports[airport.code] = airport
            else:
                issues.append("skipped airport without code")

        aircraft_types: dict[str, AircraftType] = {}
        for raw in data.get("aircraftTypes") or []:
            try:
                aircraft = AircraftType.from_dict(raw)
            except (AttributeError, TypeError):
                issues.append("skipped malformed aircraft type entry")
                continue
            validation_issues = aircraft.validate()
            if validation_issues:
                issues.extend(f"skipped aircraft type {aircraft.icao!r}: {issue}" for issue in validation_issues)
            elif aircraft.icao:
                aircraft_types[aircraft.icao] = aircraft
            else:
                issues.append("skipped aircraft type without icao")

        flights: dict[str, FlightRecord] = {}
        for raw in data.get("flights") or []:
            try:
                record = FlightRecord.from_dict(raw)
            except (AttributeError, TypeError):
                issues.append("skipped malformed flight entry")
                continue
            layout_issues = ([
                *validate_paper_boarding_pass_layouts(raw.get("paperBoardingPassLayouts", {}), raw),
                *validate_electronic_boarding_pass(raw.get("electronicBoardingPass"), raw),
            ] if isinstance(raw, dict) else ["boarding-pass presentation invalid"])
            flight_issues = layout_issues or record.validate()
            if flight_issues:
                issues.extend(f"flight {record.id}: {msg}" for msg in flight_issues)
                continue
            flights[record.id] = record

        settings_raw = data.get("settings") or {}
        settings: dict[str, str] = {}
        if isinstance(settings_raw, dict):
            for key, value in settings_raw.items():
                if isinstance(key, str) and isinstance(value, str):
                    settings[key[:128]] = value[:4096]

        self.airlines = airlines
        self.airports = airports
        self.aircraft_types = aircraft_types
        self.flights = flights
        self.settings = settings
        self._changed()
        return issues

    # ------------------------------------------------------------------
    # flights
    # ------------------------------------------------------------------

    def list_flights(
        self,
        *,
        query: str = "",
        airline: str = "",
        date_from: str = "",
        date_to: str = "",
    ) -> list[FlightRecord]:
        query_l = query.strip().lower()
        out: list[FlightRecord] = []
        for record in self.flights.values():
            if airline and record.airlineCode != airline:
                continue
            if date_from and record.departureDate < date_from:
                continue
            if date_to and record.departureDate > date_to:
                continue
            if query_l:
                haystack = " ".join(
                    [
                        record.airlineCode + record.flightNumber,
                        record.departureAirport,
                        record.arrivalAirport,
                        record.registration or "",
                        record.seat or "",
                        record.notes,
                    ]
                ).lower()
                if query_l not in haystack:
                    continue
            out.append(record)
        out.sort(key=lambda f: (f.departureDate, f.departureTime or "", int(f.flightNumber)), reverse=True)
        return out

    def get_flight(self, flight_id: str) -> FlightRecord:
        record = self.flights.get(flight_id)
        if record is None:
            raise NotFoundError(f"flight {flight_id!r} not found")
        return record

    def create_flight(self, data: dict[str, Any]) -> FlightRecord:
        resource_issues = validate_resource_relation_payload(data, ("paperBoardingPassFrontResourcePath", "paperBoardingPassBackResourcePath", "electronicBoardingPassResourcePath"), "attachmentResourcePaths")
        if resource_issues:
            raise ValidationError(resource_issues)
        layout_issues = validate_paper_boarding_pass_layouts(data.get("paperBoardingPassLayouts", {}), data)
        layout_issues.extend(validate_electronic_boarding_pass(data.get("electronicBoardingPass"), data))
        if layout_issues:
            raise ValidationError(layout_issues)
        record = FlightRecord.from_dict(data)
        if record.id in self.flights:
            from .models import new_id

            record.id = new_id()
        issues = record.validate()
        if issues:
            raise ValidationError(issues)
        now = utc_now_iso()
        record.createdAt = now
        record.updatedAt = now
        self.flights[record.id] = record
        self._changed()
        return record

    def update_flight(self, flight_id: str, data: dict[str, Any]) -> FlightRecord:
        resource_issues = validate_resource_relation_payload(data, ("paperBoardingPassFrontResourcePath", "paperBoardingPassBackResourcePath", "electronicBoardingPassResourcePath"), "attachmentResourcePaths")
        if resource_issues:
            raise ValidationError(resource_issues)
        existing = self.get_flight(flight_id)
        merged = existing.to_dict()
        for key, value in data.items():
            if key in merged and key not in ("id", "createdAt"):
                merged[key] = value
        # A crop/layout belongs to the exact selected RFG virtual resource.
        paper_layouts = merged.get("paperBoardingPassLayouts", {})
        if isinstance(paper_layouts, dict):
            for slot, asset_field in (("paperBoardingPassFront", "paperBoardingPassFrontResourcePath"), ("paperBoardingPassBack", "paperBoardingPassBackResourcePath")):
                if existing.to_dict()[asset_field] != merged.get(asset_field):
                    paper_layouts.pop(slot, None)
        if existing.electronicBoardingPassResourcePath != merged.get("electronicBoardingPassResourcePath"):
            merged["electronicBoardingPass"] = None
        layout_issues = validate_paper_boarding_pass_layouts(merged.get("paperBoardingPassLayouts", {}), merged)
        layout_issues.extend(validate_electronic_boarding_pass(merged.get("electronicBoardingPass"), merged))
        if layout_issues:
            raise ValidationError(layout_issues)
        record = FlightRecord.from_dict(merged)
        record.id = existing.id
        record.createdAt = existing.createdAt
        issues = record.validate()
        if issues:
            raise ValidationError(issues)
        record.updatedAt = utc_now_iso()
        self.flights[record.id] = record
        self._changed()
        return record

    def delete_flight(self, flight_id: str) -> None:
        self.get_flight(flight_id)
        del self.flights[flight_id]
        self._changed()

    # ------------------------------------------------------------------
    # catalogs
    # ------------------------------------------------------------------

    def catalog_table(self, kind: str) -> dict[str, Any]:
        if kind == "airlines":
            return self.airlines
        if kind == "airports":
            return self.airports
        if kind == "aircraft-types":
            return self.aircraft_types
        raise NotFoundError(f"unknown catalog kind {kind!r}")

    @staticmethod
    def catalog_model(kind: str) -> type:
        if kind == "airlines":
            return Airline
        if kind == "airports":
            return Airport
        if kind == "aircraft-types":
            return AircraftType
        raise NotFoundError(f"unknown catalog kind {kind!r}")

    @staticmethod
    def catalog_key(kind: str, data: dict[str, Any]) -> str:
        if kind in ("airlines", "airports"):
            return str(data.get("code", "")).strip().upper()
        if kind == "aircraft-types":
            return str(data.get("icao", "")).strip().upper()
        raise NotFoundError(f"unknown catalog kind {kind!r}")

    def list_catalog(self, kind: str) -> list[Any]:
        return list(self.catalog_table(kind).values())

    def upsert_catalog_entry(self, kind: str, data: dict[str, Any]) -> Any:
        if kind == "airlines":
            resource_issues = validate_resource_relation_payload(data, (
                "horizontalLogoResourcePath", "horizontalDarkLogoResourcePath",
                "symbolLogoResourcePath",
            ))
            if resource_issues:
                raise ValidationError(resource_issues)
        model = self.catalog_model(kind)
        entry = model.from_dict(data)
        issues = entry.validate()
        if issues:
            raise ValidationError(issues)
        key = self.catalog_key(kind, entry.to_dict())
        self.catalog_table(kind)[key] = entry
        self._changed()
        return entry

    def delete_catalog_entry(self, kind: str, key: str, *, force: bool = False) -> None:
        table = self.catalog_table(kind)
        key = key.strip().upper()
        if key not in table:
            raise NotFoundError(f"{kind} entry {key!r} not found")
        if not force:
            refs = self._catalog_references(kind, key)
            if refs:
                raise ConflictError(
                    f"{kind} entry {key!r} is referenced by {refs} flight(s); "
                    "pass force=true to delete anyway"
                )
        del table[key]
        self._changed()

    def delete_catalog_entries(self, kind: str, keys: list[str], *, force: bool = False) -> list[str]:
        """Delete catalog entries as one all-or-nothing domain operation.

        Callers provide normalized, unique keys.  Unknown keys retain the
        single-delete API's not-found behavior, and are checked before any
        mutation.  Non-forced deletions similarly check every selected entry's
        flight references before removing any of them.
        """
        table = self.catalog_table(kind)
        normalized_keys = [key.strip().upper() for key in keys]
        for key in normalized_keys:
            if key not in table:
                raise NotFoundError(f"{kind} entry {key!r} not found")
        if not force:
            references = [(key, self._catalog_references(kind, key)) for key in normalized_keys]
            referenced = [(key, count) for key, count in references if count]
            if referenced:
                details = ", ".join(f"{key!r} ({count} flight(s))" for key, count in referenced)
                raise ConflictError(
                    f"{kind} entries {details} are referenced by flight(s); "
                    "pass force=true to delete anyway"
                )
        for key in normalized_keys:
            del table[key]
        self._changed()
        return normalized_keys

    def _catalog_references(self, kind: str, key: str) -> int:
        count = 0
        for record in self.flights.values():
            if kind == "airlines" and record.airlineCode == key:
                count += 1
            elif kind == "airports" and key in (record.departureAirport, record.arrivalAirport):
                count += 1
            elif kind == "aircraft-types" and record.aircraftTypeIcao == key:
                count += 1
        return count
