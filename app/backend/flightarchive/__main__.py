# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""CLI entry point: ``python -m flightarchive``.

Binds to loopback by default. Passing ``--host 0.0.0.0`` exposes the app
to the LAN — only do that on networks you trust; there is no auth layer.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import uvicorn

from . import APP_NAME, __version__
from .server import create_app, default_static_dir


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m flightarchive",
        description=f"{APP_NAME} local backend.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8787, help="bind port (default: 8787)")
    parser.add_argument(
        "--dev",
        action="store_true",
        help="development mode: allow CORS from the Vite dev server (localhost:5173)",
    )
    parser.add_argument(
        "--resource-root",
        type=Path,
        help="RFG resource root (default: RFG_RESOURCE_PATH or /resource)",
    )
    parser.add_argument(
        "--data-root",
        type=Path,
        help="RFG data root (default: RFG_DATA_DIR or /data)",
    )
    parser.add_argument(
        "--cache-dir",
        type=Path,
        help="thumbnail cache root (default: FLIGHTARCHIVE_CACHE_DIR or a 'cache' sibling of the data root)",
    )
    parser.add_argument(
        "--static-dir",
        type=Path,
        default=None,
        help="directory containing the built SPA (or FLIGHTARCHIVE_STATIC_DIR)",
    )
    parser.add_argument("--version", action="version", version=f"{APP_NAME} {__version__}")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    static_dir = args.static_dir or default_static_dir()
    app = create_app(resource_root=args.resource_root, data_root=args.data_root, static_dir=static_dir, cache_dir=args.cache_dir)
    url_host = "localhost" if args.host in ("127.0.0.1", "localhost", "::1") else args.host
    print(f"{APP_NAME} {__version__}")
    print(f"  API+SPA:  http://{url_host}:{args.port}/")
    if static_dir:
        print(f"  SPA dir:  {static_dir}")
    else:
        print("  SPA dir:  (not found — API only; run the frontend build)")
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("  WARNING: binding beyond loopback exposes the app to your network.", file=sys.stderr)
    try:
        uvicorn.run(app, host=args.host, port=args.port)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
