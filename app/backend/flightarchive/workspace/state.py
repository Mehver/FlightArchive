# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Locked business workspace with rollback on failed atomic persistence."""

from __future__ import annotations

import asyncio
from typing import Any

from ..domain.store import DomainStore
from ..business_data import BUSINESS_DATA_SCHEMA_VERSION, BusinessDataError, BusinessDataPersistence, make_business_data


class Workspace:
    def __init__(self, *, seed: bool = True) -> None:
        self.domain = DomainStore()
        self.domain.on_change = self.touch_business
        self.lock = asyncio.Lock()
        self.business_persistence: BusinessDataPersistence | None = None
        if seed:
            self.domain.seed_defaults()

    def touch_business(self) -> None:
        pass

    def configure_business_persistence(self, persistence: BusinessDataPersistence) -> bool:
        """Load local business data before initial seeding; invalid files stay safe."""
        self.business_persistence = persistence
        data = persistence.load()
        if data is None:
            return False
        self.domain.load_dict(data)
        return True

    def business_data(self) -> dict[str, Any]:
        return make_business_data(self.domain.to_dict())

    def persist_business_data(self) -> None:
        """Called under the workspace lock after a successful domain mutation."""
        assert self.business_persistence is not None
        self.business_persistence.save(self.business_data())

    def transaction(self, operation):
        """Apply a visible change only if its business data can persist."""
        domain_before = self.domain.to_dict()
        assert self.business_persistence is not None
        persistence_before = (
            self.business_persistence.loaded,
            self.business_persistence.writable,
            self.business_persistence.last_error,
        )
        try:
            result = operation()
            self.persist_business_data()
            return result
        except Exception as exc:
            # Restore via the established deserializers, then undo their touch
            # callbacks so a failed operation has no observable data revision.
            self.domain.load_dict(domain_before)
            if not isinstance(exc, BusinessDataError):
                (
                    self.business_persistence.loaded,
                    self.business_persistence.writable,
                    self.business_persistence.last_error,
                ) = persistence_before
            raise

    def business_status(self) -> dict[str, Any]:
        assert self.business_persistence is not None
        persistence = self.business_persistence
        return {
            "mode": persistence.mode,
            "schemaVersion": BUSINESS_DATA_SCHEMA_VERSION,
            "writable": persistence.writable,
            "loaded": persistence.loaded,
            "persistenceError": persistence.last_error,
        }

    def reset(self) -> None:
        """Discard all in-memory state and reseed defaults."""
        self.domain = DomainStore()
        self.domain.on_change = self.touch_business
        self.domain.seed_defaults()

    # ------------------------------------------------------------------
    # status
    # ------------------------------------------------------------------

    def status(self) -> dict[str, Any]:
        return {
            "persistence": self.business_status(),
            "counts": {
                "flights": len(self.domain.flights),
                "airlines": len(self.domain.airlines),
                "airports": len(self.domain.airports),
                "aircraftTypes": len(self.domain.aircraft_types),
            },
        }
