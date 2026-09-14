<div align="center">
    <img src="https://github.com/Mehver/FlightArchive/raw/main/docs/icon/256.png" width="20%" alt="FlightArchive"/>
    <h1>FlightArchive <code>v1.0.0</code></h1>
    <p>English | <a href="https://github.com/Mehver/FlightArchive/blob/main/docs/README-cn.md">简体中文</a></p>
    <a href="https://github.com/Mehver/FlightArchive"><img src="https://img.shields.io/badge/-GitHub-3A3A3A?style=flat&amp;logo=GitHub&amp;logoColor=white" referrerpolicy="no-referrer" alt="FlightArchive on GitHub"></a>
	<a href='https://github.com/Mehver/FlightArchive/pkgs/container/flightarchive'><img src="https://img.shields.io/badge/-GHCR-8957E5?style=flat&amp;logo=GitHub&amp;logoColor=white" alt="GHCR"></a>
	<a href='https://hub.docker.com/r/mehver/flightarchive'><img src="https://img.shields.io/badge/-DockerHub-1c90ed?style=flat&amp;logo=Docker&amp;logoColor=white" alt="DockerHub"></a>
</div>

## 1 Description

FlightArchive is a containerized flight-history application written with Python, FastAPI, React 19, TypeScript, and Material UI. It uses [RemappableFileGateway](https://github.com/MehverLibs/remappable-file-gateway) (RFG) for read-only source discovery, virtual-path mappings, resource delivery, and hashes.

It follows these rules:

- flight, catalog, and boarding-pass-layout data is atomically persisted by the backend
- resources are selected from an RFG resource root and business records retain only classified virtual paths
- resource mappings can be inspected and manually re-matched without editing virtual paths
- thumbnails are disposable derived cache data; they never enter business data
- fingerprint storage is limited to classified resources directly bound to saved flight boarding passes or attachments, or to a saved airline logo

<table>
    <tr>
        <td><img src="https://github.com/Mehver/FlightArchive/raw/main/docs/img/1.png"/></td>
        <td><img src="https://github.com/Mehver/FlightArchive/raw/main/docs/img/2.png"/></td>
        <td><img src="https://github.com/Mehver/FlightArchive/raw/main/docs/img/3.png"/></td>
    </tr>
<tr>
        <td><img src="https://github.com/Mehver/FlightArchive/raw/main/docs/img/4.png"/></td>
        <td><img src="https://github.com/Mehver/FlightArchive/raw/main/docs/img/5.png"/></td>
        <td><img src="https://github.com/Mehver/FlightArchive/raw/main/docs/img/6.png"/></td>
    </tr>
</table>

### 1.1 Resource Model

RFG owns the read-only resource root and `<data>/rfg/mapping.json`. FlightArchive owns `<data>/flightarchive/v1/business-data.json`. A separate cache root stores rebuildable thumbnail objects and is never part of business data.

### 1.2 Preview Configuration

On first start, FlightArchive atomically seeds the restart-only, user-editable configuration file `<RFG_DATA_DIR>/flightarchive/v1/preview-config.json`. It is separate from both BusinessData and the disposable thumbnail cache. The file must be valid version 1 configuration; an invalid file blocks startup until it is corrected. Changes take effect only after restarting the backend.

```json
{
  "schemaVersion": 1,
  "thumbnails": {
    "maxSourceBytes": 268435456,
    "maxSourcePixels": 100000000,
    "maxDimension": 512,
    "quality": 82,
    "jobConcurrency": 2
  },
  "rfg": {
    "pillowImageMaxPixels": 100000000
  }
}
```

`thumbnails.maxSourceBytes` defaults to 256 MiB. Raising it, the source-pixel limit, or job concurrency can increase memory use; concurrent image work has a corresponding memory cost. Changing thumbnail settings invalidates and reprofiles the thumbnail cache.

`rfg.pillowImageMaxPixels` is the only supported host-configurable RFG image safety setting. It is applied before RFG initializes and affects perceptual hashes. RFG ZIP guards, hash capacity, and internal thresholds are not configurable through this file.

### 1.3 Current Features

FlightArchive provides a responsive flight dashboard, flight and flight-reference (airline / airport / aircraft type) catalog editing, resource selection and classification, mapping review with ignore and re-match operations, business-bound resource fingerprints, and a boarding-pass crop & layout tool.

## 2 Usage

Run the following container commands from the repository root.

**Build Docker Image:**

```shell
docker build -f app/Dockerfile -t flightarchive:local app
```

**Run Docker Image:**

```shell
docker run -d \
  --name=flightarchive \
  --restart=unless-stopped \
  -p 127.0.0.1:8080:8080/tcp \
  -v /path/for/resources:/resource:ro \
  -v /path/for/data:/data \
   flightarchive:local
```

**Published images:** Each published GitHub Release tag is used directly as the image tag (without version normalization) and also updates `latest`:

```shell
docker pull ghcr.io/mehver/flightarchive:<release-tag>
docker pull docker.io/mehver/flightarchive:<release-tag>
```

Release assets also include separately loadable `linux/amd64` and `linux/arm64` Docker image tarballs.

| Parameter | Function |
| --- | --- |
| `-p 127.0.0.1:8080:8080/tcp` | HTTP web interface |
| `-v /path/for/resources:/resource:ro` | Existing RFG resource root, read-only |
| `-v /path/for/data:/data` | RFG mapping and FlightArchive business data |
| `-v /path/for/cache:/cache` | Optional rebuildable thumbnail cache |

Open http://localhost:8080 after the container starts. Without the optional cache mount, `/cache` remains an ordinary disposable container directory.

---

**Docker Compose:**

```shell
cp app/.env.example app/.env
docker compose --env-file app/.env -f app/compose.yaml up --build
```

For a persistent or high-speed thumbnail cache, set `FLIGHTARCHIVE_CACHE_HOST_PATH` and run:

```shell
docker compose --env-file app/.env -f app/compose.yaml -f app/compose.cache-host.yaml up --build
```

The override mounts only `/cache`; the resource mount remains read-only and the data mount retains RFG mapping and business state.

## 3 Development

**Requirements**

- [Docker](https://www.docker.com/)
- [Node.js](https://nodejs.org/) v22 or later for frontend development
- Python 3.10 or later for backend development and tests

**Install Dependency**

```shell
cd app/frontend
pnpm install

cd ../backend
python -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-dev.txt
```

**Frontend Development**

```shell
cd app/frontend
pnpm dev
```

**Frontend Compile**

```shell
cd app/frontend
pnpm build
```

**Backend Server**

```shell
cd app/backend
RFG_RESOURCE_PATH=/path/for/resources \
RFG_DATA_DIR=/path/for/data \
python -m flightarchive
```

**Tests / Typecheck**

```shell
cd app/backend
python -m pytest tests -q

cd ../frontend
pnpm exec vitest run --maxWorkers=4
pnpm typecheck
```

**Build Docker Image**

```shell
docker build -f app/Dockerfile -t flightarchive:local app
```

On Windows, `tools/BuildAll.bat` builds the same local image. `tools/BuildAndRunContainer.bat` is a Windows helper that cleans local build artifacts, prompts for host mappings, and starts a detached container. On other platforms, use the `docker run` command in [Usage](#2-usage).

## 4 Built With

> All dependencies are open-source and licensed under permissive licenses. No copyleft (for example GPL or AGPL) components are included.

- Python
  - [FastAPI](https://github.com/fastapi/fastapi)
  - [Uvicorn](https://github.com/encode/uvicorn)
  - [RemappableFileGateway](https://github.com/MehverLibs/remappable-file-gateway)
  - [Pillow](https://github.com/python-pillow/Pillow)
- Node.js
  - React 19 + Vite
    - [Material UI](https://github.com/mui/material-ui)
    - [Vitest](https://github.com/vitest-dev/vitest)
- Docker
  - `node:22-bookworm-slim`
  - `python:3.14-slim`

## 5 License

This project is released under the BSD 3-Clause License. Code may be reused with proper attribution.

Copyright (c) 2026 Mehver (https://github.com/Mehver). All rights reserved.

All dependencies are open-source and licensed under permissive licenses. No copyleft (for example GPL or AGPL) components are included.
