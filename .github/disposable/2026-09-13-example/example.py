# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""No-op template for future disposable workflows."""

import os
from datetime import datetime, timezone


print("FlightArchive disposable template started.")
print(f"UTC time: {datetime.now(timezone.utc).isoformat()}")
print(f"Dry run: {os.environ.get('DRY_RUN', 'true')}")
print("No repository data, releases, deployments, or Pages content was changed.")
