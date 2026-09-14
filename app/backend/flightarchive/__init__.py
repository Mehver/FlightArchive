# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""FlightArchive local backend.

A containerized flight-history service:

- serves the statically built React SPA in production,
- exposes a documented JSON HTTP API under ``/api``,
- persists business data atomically under the configured RFG data root,
- delegates resource cataloguing and mappings to RFG.
"""

__version__ = "1.0.0"

APP_NAME = "FlightArchive"
