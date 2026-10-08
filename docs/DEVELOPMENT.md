# Development

Developer setup and validation commands for FlightArchive. For deployment and day-to-day usage, see the [README](../README.md).

## Requirements

- [Docker](https://www.docker.com/)
- [Node.js](https://nodejs.org/) v22 or later for frontend development
- Python 3.10 or later for backend development and tests

## Install Dependencies

```shell
cd app/frontend
pnpm install

cd ../backend
python -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-dev.txt
```

## Frontend Development

```shell
cd app/frontend
pnpm dev
```

The Vite dev server proxies `/api` and `/res` to the backend CLI on `127.0.0.1:8787`.

## Frontend Compile

```shell
cd app/frontend
pnpm build
```

## Backend Server

```shell
cd app/backend
RFG_RESOURCE_PATH=/path/for/resources \
RFG_DATA_DIR=/path/for/data \
python -m flightarchive
```

## Tests / Typecheck

Backend:

```shell
cd app/backend
python -m pytest tests -q
```

Frontend:

```shell
cd app/frontend
pnpm exec vitest run --maxWorkers=4
pnpm typecheck
```

On Node versions that expose an experimental global `localStorage`, run the frontend suite with `NODE_OPTIONS=--no-experimental-webstorage`.

## Build Docker Image

```shell
docker build -f app/Dockerfile -t flightarchive:local app
```

On Windows, `tools/BuildAll.bat` builds the same local image. `tools/BuildAndRunContainer.bat` is a Windows helper that cleans local build artifacts, prompts for host mappings, and starts a detached container. On other platforms, use the `docker run` command in the [Usage](../README.md#2-usage) section.

## Architecture And Contracts

- [ARCHITECTURE.md](ARCHITECTURE.md) — runtime shape and component boundaries
- [BUSINESS_DATA.md](BUSINESS_DATA.md) — business data model and contracts
- [RESOURCE_LIFECYCLE.md](RESOURCE_LIFECYCLE.md) — resource mapping lifecycle
