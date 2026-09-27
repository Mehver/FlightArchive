# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

from __future__ import annotations

import json
import os

import pytest

from flightarchive.business_data import BusinessDataError, read_business_data
from flightarchive.server import create_app


def _document() -> dict:
    return {
        "schemaVersion": 1,
        "airlines": [],
        "airports": [],
        "aircraftTypes": [],
        "flights": [],
        "settings": {},
    }


def test_invalid_loaded_entries_create_backup_without_replacing_original(tmp_path):
    root, data = tmp_path / "resources", tmp_path / "data"
    root.mkdir()
    data.mkdir()
    path = data / "flightarchive" / "v1" / "business-data.json"
    path.parent.mkdir(parents=True)
    document = _document()
    document["aircraftTypes"] = [{"icao": "A", "iata": "320", "displayName": "Invalid type"}]
    original = json.dumps(document).encode("utf-8")
    path.write_bytes(original)

    application = create_app(resource_root=root, data_root=data)

    assert application.state.flightarchive_workspace.domain.aircraft_types == {}
    assert path.read_bytes() == original
    backups = list(path.parent.glob("business-data.corrupt-*.json"))
    assert len(backups) == 1
    assert backups[0].read_bytes() == original


def test_business_data_reader_rejects_symlink_leaf(tmp_path):
    target = tmp_path / "actual.json"
    target.write_text(json.dumps(_document()), encoding="utf-8")
    path = tmp_path / "business-data.json"
    os.symlink(target, path)

    with pytest.raises(BusinessDataError, match="symlink"):
        read_business_data(path)


def test_business_data_reader_rejects_dangling_symlink_leaf(tmp_path):
    path = tmp_path / "business-data.json"
    os.symlink(tmp_path / "missing.json", path)

    with pytest.raises(BusinessDataError, match="symlink"):
        read_business_data(path)
