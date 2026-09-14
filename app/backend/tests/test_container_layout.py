# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Contract checks for the self-contained application Docker build context."""

from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[3]
APP = ROOT / "app"


def test_container_configuration_lives_in_the_app_build_context():
    for name in ("Dockerfile", ".dockerignore", "compose.yaml", "compose.cache-host.yaml", ".env.example"):
        assert (APP / name).is_file()
        assert not (ROOT / name).exists()

    dockerfile = (APP / "Dockerfile").read_text(encoding="utf-8")
    assert "COPY frontend/" in dockerfile
    assert "COPY backend/" in dockerfile
    assert "COPY app/" not in dockerfile
    assert "COPY backend/flightarchive ./flightarchive" in dockerfile
    assert '"flightarchive.server:create_app"' in dockerfile

    compose = (APP / "compose.yaml").read_text(encoding="utf-8")
    assert "context: ." in compose
    assert "dockerfile: Dockerfile" in compose
    assert "flightarchive:" in compose
    assert "container_name: flightarchive" in compose
    assert "../data/resource" in compose
    assert "../data/runtime" in compose


def test_public_app_branding_uses_flight_archive():
    frontend = APP / "frontend"
    index = (frontend / "index.html").read_text(encoding="utf-8")
    package = (frontend / "package.json").read_text(encoding="utf-8")

    assert "<title>FlightArchive</title>" in index
    assert 'content="FlightArchive — local flight records and resource management workspace"' in index
    assert '"name": "flight-archive-frontend"' in package


def test_app_dockerignore_keeps_private_runtime_content_out_of_the_context():
    dockerignore = (APP / ".dockerignore").read_text(encoding="utf-8")
    assert "node_modules" in dockerignore
    assert "frontend/build" in dockerignore
    assert "data" in dockerignore
    assert ".env.*" in dockerignore


def _workflow_steps(workflow):
    """Return each GitHub Actions step as a source block without a YAML parser."""
    starts = [match.start() for match in re.finditer(r"^      - (?=(?:name|uses):)", workflow, re.MULTILINE)]
    return [workflow[start:end] for start, end in zip(starts, starts[1:] + [len(workflow)])]


def _step_with_name(steps, name):
    return next(step for step in steps if f"name: {name}\n" in step)


def _assert_pinned_actions(workflow, expected_actions):
    uses_lines = re.findall(r"^[ \t]*(?:-[ \t]+)?uses:[ \t]*(.+)$", workflow, re.MULTILINE)
    assert uses_lines
    actual_actions = []
    for value in uses_lines:
        match = re.fullmatch(r"([^@\s]+)@([0-9a-f]{40})\s+# v(\d+)", value)
        assert match, f"Action is not pinned to an annotated immutable SHA: {value}"
        actual_actions.append((match.group(1), match.group(2), match.group(3)))

    assert set(actual_actions) == expected_actions


def test_release_workflow_has_quality_gates_before_mutations_and_correct_routes():
    workflow = (ROOT / ".github/workflows/docker-image.yml").read_text(encoding="utf-8")
    steps = _workflow_steps(workflow)

    assert "release:\n    types: [published]" in workflow
    assert "\n  pull_request:\n" not in workflow
    assert "\n  push:\n" not in workflow
    assert "python -m pytest tests -q" in workflow
    assert "pnpm typecheck" in workflow
    assert "pnpm exec vitest run --maxWorkers=4" in workflow
    assert "pnpm build" in workflow
    test_step_index = steps.index(_step_with_name(steps, "Test backend"))
    frontend_test_step_index = steps.index(_step_with_name(steps, "Test and build frontend"))
    mutation_steps = (
        "Update version numbers and save patch",
        "Log in to GitHub Container Registry",
        "Log in to Docker Hub",
        "Build and publish Docker images",
        "Record container image publications",
        "Export Docker images for the release",
        "Update Docker Hub description",
        "Upload to Release",
        "Commit version number update",
    )
    for name in mutation_steps:
        assert frontend_test_step_index < steps.index(_step_with_name(steps, name))
        assert test_step_index < steps.index(_step_with_name(steps, name))

    assert "context: ./app" in workflow
    assert "file: ./app/Dockerfile" in workflow
    for image in (
        "ghcr.io/mehver/flightarchive:${{ env.TAG }}",
        "ghcr.io/mehver/flightarchive:latest",
        "docker.io/mehver/flightarchive:${{ env.TAG }}",
        "docker.io/mehver/flightarchive:latest",
    ):
        assert image in workflow
    assert "flightarchive-${{ env.TAG }}-docker-amd64.tar.gz" in workflow
    assert "flightarchive-${{ env.TAG }}-docker-arm64.tar.gz" in workflow
    assert "platforms: linux/amd64,linux/arm64" in workflow

    qemu_index = next(index for index, step in enumerate(steps) if "docker/setup-qemu-action@" in step)
    buildx_index = next(index for index, step in enumerate(steps) if "docker/setup-buildx-action@" in step)
    assert qemu_index < buildx_index

    # Release tags are intentionally passed through unchanged, without a schema gate.
    assert "TAG: ${{ github.event.release.tag_name }}" in workflow
    assert not re.search(r"(?:semver|version[-_ ]?schema|validate[-_ ]?tag|tag[-_ ]?validator)", workflow, re.I)

    forbidden = ("pages", "standalone", "deploy-pages", "upload-pages-artifact")
    assert not any(term in workflow.lower() for term in forbidden)

    _assert_pinned_actions(
        workflow,
        {
            ("actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1", "7"),
            ("actions/setup-python", "ece7cb06caefa5fff74198d8649806c4678c61a1", "6"),
            ("actions/setup-node", "820762786026740c76f36085b0efc47a31fe5020", "7"),
            ("pnpm/action-setup", "0977fd99725f1db4007ccb2928dbb4e90d06cc86", "6"),
            ("docker/setup-qemu-action", "1f40c72289eff860ee54a304f1438e3cff362e0a", "4"),
            ("docker/setup-buildx-action", "37fe631027851001ddb9b187196cc803df7f5f0e", "4"),
            ("docker/login-action", "dbcb813823bdd20940b903addbd779551569679f", "4"),
            ("docker/build-push-action", "53b7df96c91f9c12dcc8a07bcb9ccacbed38856a", "7"),
            ("peter-evans/dockerhub-description", "432a30c9e07499fd01da9f8a49f0faf9e0ca5b77", "4"),
            ("softprops/action-gh-release", "efb35369e0ad2afab669f228072c1b0d510eae64", "3"),
        },
    )

    description_step = _step_with_name(steps, "Update Docker Hub description")
    assert "continue-on-error: true" in description_step


def test_disposable_template_is_read_only_and_has_no_release_side_effects():
    workflow = (ROOT / ".github/workflows/disposable-run.yml").read_text(encoding="utf-8")
    script = ROOT / ".github/disposable/2026-09-13-example/example.py"

    assert "workflow_dispatch:" in workflow
    assert "target:" in workflow
    assert "dry_run:" in workflow
    assert "confirm == 'YES'" in workflow
    assert "contents: read" in workflow
    assert "contents: write" not in workflow
    assert "deployments:" not in workflow
    checkout_step = next(step for step in _workflow_steps(workflow) if "actions/checkout@" in step)
    assert "persist-credentials: false" in checkout_step
    _assert_pinned_actions(
        workflow,
        {("actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1", "7")},
    )
    assert script.is_file()
    assert "No repository data, releases, deployments, or Pages content was changed." in script.read_text(encoding="utf-8")


def test_version_number_script_only_updates_line_three_in_both_readmes(tmp_path):
    original_readme = ["heading\n", "detail\n", "version old-tag old-tag\n", "old-tag remains\n"]
    original_chinese_readme = ["标题\n", "说明\n", "版本 old-tag\n", "old-tag 保持不变\n"]
    (tmp_path / "README.md").write_text("".join(original_readme), encoding="utf-8")
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "README-cn.md").write_text("".join(original_chinese_readme), encoding="utf-8")

    script = ROOT / ".github/scripts/UpdateVersionNumber.py"
    subprocess.run([sys.executable, script, "old-tag", "new-tag"], cwd=tmp_path, check=True)

    assert (tmp_path / "README.md").read_text(encoding="utf-8").splitlines(keepends=True) == [
        "heading\n",
        "detail\n",
        "version new-tag new-tag\n",
        "old-tag remains\n",
    ]
    assert (docs / "README-cn.md").read_text(encoding="utf-8").splitlines(keepends=True) == [
        "标题\n",
        "说明\n",
        "版本 new-tag\n",
        "old-tag 保持不变\n",
    ]
