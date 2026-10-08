# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Shared resolution of the two runtime directories."""
from __future__ import annotations

import os
from pathlib import Path


def _directory(value: str | Path | None, env: str, default: str, *, create: bool) -> Path:
    configured = value
    if configured is None or (isinstance(configured, str) and not configured.strip()):
        configured = os.getenv(env) or default
    path = Path(configured).expanduser()
    if create:
        path.mkdir(parents=True, exist_ok=True)
    if not path.is_dir():
        raise RuntimeError(f"{env} must name {'a creatable' if create else 'an existing'} directory: {path}")
    return path.resolve()


def resolve_runtime_paths(*, resource_root: str | Path | None = None, data_root: str | Path | None = None) -> tuple[Path, Path]:
    return (
        _directory(resource_root, "RFG_RESOURCE_PATH", "/resource", create=False),
        _directory(data_root, "RFG_DATA_DIR", "/data", create=True),
    )


def resolve_data_root(value: str | Path | None = None) -> Path:
    return _directory(value, "RFG_DATA_DIR", "/data", create=True)
