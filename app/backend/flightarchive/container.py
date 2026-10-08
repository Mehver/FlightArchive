# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Container bootstrap: prepare the archive, then always launch HTTP."""
from __future__ import annotations

import json
import sys
from dataclasses import asdict

import uvicorn

from .initialization import prepare_archive
from .paths import resolve_data_root


def main() -> int:
    data_root = resolve_data_root()
    try:
        outcome = prepare_archive(data_root)
        print(json.dumps(asdict(outcome), ensure_ascii=False))
    except Exception as exc:
        print(f"warning: archive preparation failed: {exc}", file=sys.stderr)
    uvicorn.run("flightarchive.server:create_app", factory=True, host="0.0.0.0", port=8080)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
