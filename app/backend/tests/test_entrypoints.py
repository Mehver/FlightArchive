# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

from __future__ import annotations

import pytest

from flightarchive import __main__ as local_cli
from flightarchive import container
from flightarchive.initialization import BootstrapOutcome


def test_local_cli_initializes_defaults_without_reading_v1(tmp_path, monkeypatch):
    calls = []
    sentinel = tmp_path / "flightarchive" / "v1" / "business-data.json"
    sentinel.parent.mkdir(parents=True)
    sentinel.write_bytes(b"do-not-open")

    initialize = local_cli.initialize_default_v2
    def observed_initialize(root):
        calls.append(("init", root))
        return initialize(root)
    monkeypatch.setattr(local_cli, "initialize_default_v2", observed_initialize)
    monkeypatch.setattr(local_cli, "create_app", lambda **kwargs: calls.append(("app", kwargs)) or object())
    monkeypatch.setattr(local_cli.uvicorn, "run", lambda app, **kwargs: calls.append(("run", app, kwargs)))

    assert local_cli.main(["--resource-root", str(tmp_path), "--data-root", str(tmp_path)]) == 0
    assert [call[0] for call in calls] == ["init", "app", "run"]
    assert "cache_dir" not in calls[1][1]
    assert sentinel.read_bytes() == b"do-not-open"
    assert (tmp_path / "flightarchive" / "v2" / "flights.json").read_text(encoding="utf-8").strip() == "[]"


def test_local_cli_parser_has_no_inert_dev_or_cors_option(capsys):
    parser = local_cli.build_parser()
    assert "--dev" not in parser.format_help()
    assert "CORS" not in parser.format_help()
    with pytest.raises(SystemExit, match="2"):
        parser.parse_args(["--dev"])
    assert "unrecognized arguments: --dev" in capsys.readouterr().err


def test_local_cli_parser_preserves_host_port_and_path_options(tmp_path):
    args = local_cli.build_parser().parse_args([
        "--host", "0.0.0.0", "--port", "9001",
        "--resource-root", str(tmp_path / "resources"),
        "--data-root", str(tmp_path / "runtime"),
        "--static-dir", str(tmp_path / "frontend"),
    ])
    assert args.host == "0.0.0.0"
    assert args.port == 9001
    assert args.resource_root == tmp_path / "resources"
    assert args.data_root == tmp_path / "runtime"
    assert args.static_dir == tmp_path / "frontend"


def test_container_bootstrap_launches_server_even_when_prepare_fails(tmp_path, monkeypatch):
    calls = []
    failed = BootstrapOutcome("migration-failed", "migration-failed", attempts=2, error="boom")
    monkeypatch.setattr(container, "prepare_archive", lambda root: calls.append(("prepare", root)) or failed)
    monkeypatch.setattr(container.uvicorn, "run", lambda target, **kwargs: calls.append(("run", target, kwargs)))
    monkeypatch.setenv("RFG_DATA_DIR", str(tmp_path))

    assert container.main() == 0
    assert calls[0] == ("prepare", tmp_path.resolve())
    assert calls[1][0:2] == ("run", "flightarchive.server:create_app")
    assert calls[1][2]["factory"] is True


def test_container_bootstrap_handles_unexpected_prepare_exception(tmp_path, monkeypatch):
    launched = []
    monkeypatch.setattr(container, "prepare_archive", lambda _root: (_ for _ in ()).throw(OSError("broken")))
    monkeypatch.setattr(container.uvicorn, "run", lambda target, **kwargs: launched.append((target, kwargs)))
    monkeypatch.setenv("RFG_DATA_DIR", str(tmp_path))
    assert container.main() == 0
    assert launched and launched[0][0] == "flightarchive.server:create_app"
