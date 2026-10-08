<div align="center">
    <img src="https://github.com/Mehver/FlightArchive/raw/main/docs/icon/256.png" width="20%" alt="FlightArchive"/>
    <h1>FlightArchive <code>v1.0.1</code></h1>
    <p>English | <a href="https://github.com/Mehver/FlightArchive/blob/main/docs/README-cn.md">简体中文</a></p>
    <a href="https://github.com/Mehver/FlightArchive"><img src="https://img.shields.io/badge/-GitHub-3A3A3A?style=flat&amp;logo=GitHub&amp;logoColor=white" referrerpolicy="no-referrer" alt="FlightArchive on GitHub"></a>
	<a href='https://github.com/Mehver/FlightArchive/pkgs/container/flightarchive'><img src="https://img.shields.io/badge/-GHCR-8957E5?style=flat&amp;logo=GitHub&amp;logoColor=white" alt="GHCR"></a>
	<a href='https://hub.docker.com/r/mehver/flightarchive'><img src="https://img.shields.io/badge/-DockerHub-1c90ed?style=flat&amp;logo=Docker&amp;logoColor=white" alt="DockerHub"></a>
</div>

## 1 Description

FlightArchive is a self-hosted, single-user personal flight archive for a local machine or a trusted home/LAN network. It keeps your flight history, boarding-pass scans, and related files together in one private place you control, with no accounts and no cloud dependency.

It is written with Python, FastAPI, React 19, TypeScript, and Material UI, and ships as a single container. Your existing media folders are exposed read-only through [RemappableFileGateway](https://github.com/MehverLibs/remappable-file-gateway) (RFG), so FlightArchive references them without taking ownership of your files.

### Features

- Browse your flight history in a list or card grid, and open per-flight details.
- Add and edit flights, and maintain reference catalogs for airlines, airports, and aircraft types.
- Crop boarding-pass scans and arrange paper passes on templates.
- Link boarding-pass scans, airline logos, and other attachments to files in your resource folder.
- Review resource mappings, ignore files you do not need, and reconnect moved files when sources go missing.
- Import and export business data, and follow operations in the Activity & Tasks drawer.

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

How the pieces fit together is documented in [ARCHITECTURE.md](docs/ARCHITECTURE.md), [BUSINESS_DATA.md](docs/BUSINESS_DATA.md), and [RESOURCE_LIFECYCLE.md](docs/RESOURCE_LIFECYCLE.md).

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
  -v /path/for/cache:/cache \
   flightarchive:local
```

Open http://localhost:8080 after the container starts.

| Parameter | Function |
| --- | --- |
| `-p 127.0.0.1:8080:8080/tcp` | HTTP web interface |
| `-v /path/for/resources:/resource:ro` | Your existing resource folder, mounted read-only |
| `-v /path/for/data:/data` | FlightArchive data and resource mappings; keep this to preserve your archive |
| `-v /path/for/cache:/cache` | Optional thumbnail cache; safe to delete and rebuild |

Your archive is kept in `/data`; `/resource` is read-only. The optional `/cache` mount stores rebuildable thumbnails; without it, the cache stays inside the container.

> FlightArchive has no authentication and is intended for one user on a local machine or a trusted LAN. Do not expose it to the public internet.

**Published images:** Each published GitHub Release tag is used directly as the image tag (without version normalization) and also updates `latest`:

```shell
docker pull ghcr.io/mehver/flightarchive:<release-tag>
docker pull docker.io/mehver/flightarchive:<release-tag>
```

Release assets also include separately loadable `linux/amd64` and `linux/arm64` Docker image tarballs.

---

**Docker Compose:**

```shell
cp app/.env.example app/.env
docker compose --env-file app/.env -f app/compose.yaml up --build
```

For a persistent thumbnail cache, uncomment `FLIGHTARCHIVE_CACHE_HOST_PATH` in `app/.env` and add the optional override, which mounts only `/cache`:

```shell
docker compose --env-file app/.env -f app/compose.yaml -f app/compose.cache-host.yaml up --build
```

## 3 Development

Developer setup, local run commands, and test instructions are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

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

## 5 License

This project is released under the BSD 3-Clause License. Code may be reused with proper attribution.

Copyright (c) 2026 Mehver (https://github.com/Mehver). All rights reserved.

All dependencies are open-source and licensed under permissive licenses. No copyleft (for example GPL or AGPL) components are included.
