# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

from __future__ import annotations

from flightarchive.paths import resolve_data_root, resolve_runtime_paths
from flightarchive.server import create_app


def test_explicit_runtime_root_aliases_resolve_to_canonical_targets(tmp_path):
    resources = tmp_path / "real-resources"
    data = tmp_path / "real-data"
    resources.mkdir()
    data.mkdir()
    resource_alias = tmp_path / "resource-alias"
    data_alias = tmp_path / "data-alias"
    resource_alias.symlink_to(resources, target_is_directory=True)
    data_alias.symlink_to(data, target_is_directory=True)

    assert resolve_runtime_paths(resource_root=resource_alias, data_root=data_alias) == (
        resources.resolve(), data.resolve(),
    )


def test_environment_data_root_alias_resolves_to_canonical_target(tmp_path, monkeypatch):
    data = tmp_path / "real-data"
    data.mkdir()
    alias = tmp_path / "data-alias"
    alias.symlink_to(data, target_is_directory=True)
    monkeypatch.setenv("RFG_DATA_DIR", str(alias))

    assert resolve_data_root() == data.resolve()


def test_create_app_accepts_configured_root_aliases_but_uses_canonical_roots(tmp_path, monkeypatch):
    import rfg.api

    resources = tmp_path / "real-resources"
    data = tmp_path / "real-data"
    resources.mkdir()
    data.mkdir()
    resource_alias = tmp_path / "resource-alias"
    data_alias = tmp_path / "data-alias"
    resource_alias.symlink_to(resources, target_is_directory=True)
    data_alias.symlink_to(data, target_is_directory=True)
    create_rfg_app = rfg.api.create_app
    received = []
    def observed_create_app(resource, runtime):
        received.append((resource, runtime))
        return create_rfg_app(resource, runtime)
    monkeypatch.setattr(rfg.api, "create_app", observed_create_app)

    app = create_app(
        resource_root=resource_alias,
        data_root=data_alias,
        static_dir=tmp_path / "absent-frontend",
        cache_dir=tmp_path / "cache",
    )

    assert received == [(resources.resolve(), data.resolve())]
    assert app.state.archive_store.data_root == data.resolve()
    assert app.state.activity_log.data_root == data.resolve()
    assert app.state.legacy_task_reader.data_root == data.resolve()
