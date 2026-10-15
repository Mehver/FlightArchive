# Architecture map

## Deployment shape

FlightArchive is single-user software for one operator on a local machine or a trusted LAN. The React SPA and the Python host share one origin and one data directory. The browser is the domain authority and the backend is a small static/HTTP host. There is no authentication, no multi-user model, and no horizontal scaling.

Two runtime directories are resolved by `app/backend/flightarchive/paths.py`:

| Directory | Environment | Default | Rule |
| --- | --- | --- | --- |
| Resource root | `RFG_RESOURCE_PATH` | `/resource` | must already exist; exposed read-only |
| Data root | `RFG_DATA_DIR` | `/data` | created if absent; writable |

`resolve_runtime_paths` also accepts explicit values (used by the CLI and tests). A configured resource- or data-root alias may be a directory symlink; resolution returns the canonical target directory used by the host and RFG. This configuration-boundary aliasing does not weaken store protection: direct store construction rejects a symlinked root, and the internal archive, activity, and legacy-task path components and leaf files must not be symlinks.

## Runtime ownership and request routing

`app/backend/flightarchive/server.py:create_app` builds the public FastAPI host:

- It constructs the RFG child application with `rfg.api.create_app(resource_root, data_root)` and enters RFG's lifespan from the host lifespan, so RFG's own startup scan runs.
- Host state holds `archive_store` (`ArchiveStore`), `activity_log` (`ActivityLog`), `legacy_task_reader` (`LegacyTaskReader`), and `thumbnail_service` (`ThumbnailService`). There is no lifecycle service, scheduler, or domain cache manager.
- The host router (`routes/api.py`, prefix `/api`) provides only `/api/healthz`, `/api/status`, the named-document archive routes, `/api/activity`, `/api/tasks`, and the domain-neutral `/api/thumbnails/{virtual_path:path}` relay.
- `ApiError` and request-validation failures render `{"error": {code, message, details?}}` JSON.
- A catch-all `/api/{path}` returning a JSON `not-found` error is registered on the RFG child **before** the SPA is mounted, so it covers unknown `/api/*` without shadowing RFG's `/api/v1/*` routes.
- The built SPA (`FLIGHTARCHIVE_STATIC_DIR`, a discovered `frontend/build`, or `--static-dir`) is mounted on the RFG child at `/` as `SpaStaticFiles`, which falls back to `index.html`. RFG is mounted on the host at `/` last.
- Effective precedence is: host `/api/*` routes → RFG `/api/v1/*` and `/res/*` → JSON 404 for unknown `/api/*` → SPA static/fallback.

`create_app` never seeds, migrates, or repairs data. It only reads what is already on disk. Startup initialization is a separate, explicitly invoked path.

### Launch entry points

| Entry point | Behavior |
| --- | --- |
| `python -m flightarchive` (`__main__.py`) | Local CLI. Calls `initialize_default_v2` (seed a missing v2 only; never reads v1), then serves with uvicorn. Default bind `127.0.0.1:8787`; `--host 0.0.0.0` exposes the app to the LAN and prints a warning because there is no auth layer. |
| `python -m flightarchive.container` (`container.py`) | Container entrypoint. Calls `prepare_archive` (validate an existing v2, else one-way v1 migration with at most two attempts, else seed fallback), prints the `BootstrapOutcome`, then always launches HTTP on `0.0.0.0:8080`. Preparation failures never prevent startup; consumers inspect `archive_state`. |

`app/Dockerfile` builds the SPA with Node, then installs only `backend/requirements.txt` (`fastapi`, `uvicorn`, `httpx`, `Pillow`, `remappable-file-gateway==1.0.0`) and runs `CMD ["python", "-m", "flightarchive.container"]`. `app/compose.yaml` mounts the resource directory read-only at `/resource` and the writable data directory at `/data`; the disposable thumbnail cache defaults to `/cache` inside the container. The optional `app/compose.cache-host.yaml` adds only a `/cache` bind mount for users who want to retain that disposable cache on the host.

## Authority boundaries

| Concern | Source of truth | Main code |
| --- | --- | --- |
| Business data shape, validation, and mutations | Frontend domain (browser memory, persisted as named JSON documents) | `domain/types.ts`, `domain/schemaV1.ts`, `domain/commands.ts`, `domain/archiveV2.ts`, `domain/BusinessDataProvider.tsx` |
| Generic named-document storage | `<RFG_DATA_DIR>/flightarchive/v2/<document>` | `archive.py`, `routes/api.py`, `api/client.ts` |
| Activity log | `<RFG_DATA_DIR>/flightarchive/log/activity/<UTC day>.jsonl` | `activity.py`, `routes/api.py`, `tasks/TasksPage.tsx` |
| Legacy fingerprint task history (read-only) | `<RFG_DATA_DIR>/flightarchive/log/task/<UTC day>.jsonl` | `legacy_tasks.py`, `routes/api.py` |
| Startup seed and one-way v1 migration | `.../flightarchive/v2`, `.../migrations`, `.../v1` (never modified) | `initialization.py`, `legacy_v1.py` |
| Resource catalog, mappings, hashes, source bytes | RFG data and documented HTTP endpoints | `rfg/api.ts`, `rfg/mapping.ts`, `rfg/ResourceMappingProvider.tsx` |
| Raster display relay and cache | RFG public HTTP endpoints, disposable local cache | `thumbnail.py`, `routes/api.py`, `resources/browserImageRenderer.ts`, `resources/useBrowserImage.ts` |

The backend has no domain routes: there are no `/api/flights`, `/api/catalogs`, `/api/resources/*`, `/api/workspace/reset`, `/api/images/*`, or boarding-pass preview endpoints. Those responsibilities live in the frontend and in RFG. The one backend image facility is the domain-neutral, scale-only thumbnail relay below; it never performs a domain crop, looks up a flight, or owns a resource or mapping.

## Named JSON document store

`archive.py` is a domain-neutral store for one registered application (`app_id = "flightarchive"`). It allowlists exactly six document ids:

`manifest.json`, `flights.json`, `airlines.json`, `airports.json`, `aircraft-types.json`, `settings.json`.

Rules:

- Documents are opaque JSON. The store rejects non-finite numbers, non-UTF-8 input, and payloads over `MAX_DOCUMENT_BYTES` (16 MiB); it does not validate business shape.
- Writes are atomic: a temp file in the same directory, flush + fsync, `os.replace`, then directory fsync. Deletes fsync the directory. Symlinked documents and symlinked path components are rejected.
- `state()` reports `missing` (no valid v2 root), `ready` (all six documents readable), or `migration-failed` (a document is unreadable/invalid or the root is unsafe).
- There is **no revision**, **no conditional/If-Match write**, **no multi-document transaction**, and **no lock**. Each document is saved independently; assembling a consistent aggregate is the frontend's responsibility. `create_app` never writes a missing document.

HTTP surface (`routes/api.py`, all responses `Cache-Control: no-store`):

| Method and path | Result |
| --- | --- |
| `GET /api/archive/{app_id}` | `{appId, documents}` (registered app only; unknown app → `404`) |
| `GET /api/archive/{app_id}/documents` | `{documents}` |
| `GET /api/archive/{app_id}/documents/{document_id}` | the stored JSON value (any finite JSON scalar/array/object) |
| `PUT .../documents/{document_id}` | validate finite UTF-8 JSON and size, atomically replace, `204` |
| `DELETE .../documents/{document_id}` | remove the document, `204` |

`GET /api/status` returns only domain-neutral status:

```json
{
  "status": {
    "persistence": {"mode": "named-json-documents", "writable": true, "persistenceError": null},
    "archiveState": "missing | ready | migration-failed",
    "activityRevision": "string | null"
  }
}
```

`GET /api/healthz` returns `{ok: true}` only.

## Thumbnail relay and cache

`thumbnail.py` is the only backend image facility. It is domain-neutral and reads source bytes exclusively through RFG's public HTTP endpoints (`/api/v1/meta/*` and `/res/*`); it never reads a source path or owns a resource or mapping.

`GET|HEAD /api/thumbnails/{virtual_path:path}?scale=<dyadic>` uses the same per-segment percent-decoding as `/res/` and accepts one optional decimal `scale` from `1, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625` (default `0.125`). Any other query parameter, a repeated `scale`, or an unsafe virtual path is `400`; there is no crop, flight lookup, or lifecycle concept.

Cold derivative generation is limited to one Pillow job. A disconnected GET waiter is removed before full source fetch/render; cancellation of a Pillow thread already in progress waits for that thread's safe completion before releasing the generation slot.

- `HEAD` reports runtime metadata without rendering or a full source `GET`: `X-Source-Width`/`Height` (EXIF-normalized), `X-Source-Bytes`, `X-Source-ETag`, `X-Thumbnail-Width`/`Height`/`Scale`, and a derivative `ETag`. Cold inspection fetches a bounded source prefix through an RFG `Range` request (256 KiB), plus at most one bounded 256 KiB tail range for a larger PNG whose prefix does not expose an orientation. A cached entry's geometry is revalidated through the same bounded inspection, never by re-reading or re-rendering the source.
- `GET` returns cached WebP bytes, or renders one on a cache miss. Rendering uses Pillow: JPEG decodes through the decoder's draft mode to bound cold work, while other formats may fully decode. A memory guard (Pillow decompression-bomb handling plus explicit dimension checks) and a one-job semaphore bound concurrency; these reduce risk but are not a hard memory guarantee.
- Responses use `Cache-Control: no-cache` plus the derivative `ETag`, allowing browser storage while requiring revalidation after a stable virtual path is remapped. `GET` and `HEAD` accept `If-None-Match` (including weak validators, lists, and `*`): the service first reconfirms current source identity and geometry through its bounded `HEAD` path, returns bodyless `304` on a match without fetching or rendering the full source, and returns the new representation when source identity changed.
- Limits: source at most 256 MiB / 160,000,000 pixels / 65,535 px per dimension; output at most 4,000,000 pixels / 4096 px / 4 MiB. Out-of-range requests are `413`, unsupported formats `415`, unmapped sources `404`, and missing mapped sources or unavailable RFG surfaces `503`.
- Frontend Studio loading retries a smaller permitted scale only for the precise encoded-output `413 thumbnail-output-too-large`; source-size/dimension guards and other failures remain terminal. Studio geometry remains in the original logical source coordinate system across such retries.
- The cache is disposable and flat: paired `thumb-<key>.webp` and `thumb-<key>.json` regular files replaced atomically, capped at 256 MiB with oldest-first eviction. Symlinked or special-file roots and leaves are rejected rather than followed. The root defaults to `<data parent>/cache` (`/cache` in the container) and can be overridden with `FLIGHTARCHIVE_CACHE_DIR`. It never stores business data.
- PNG EXIF orientation is recovered metadata-only from the bounded 256 KiB header prefix by walking chunk lengths. If a larger PNG has no visible prefix orientation, the thumbnail module makes one peer bounded offset `Range` request for the final 256 KiB and validates a post-`IDAT` `eXIf` candidate before using it; no pixels are decoded during inspection. This read-head/read-tail policy belongs to the thumbnail module, while RFG only supplies its public ranged file endpoint. An `eXIf` chunk too large for, or otherwise outside, both windows remains neutral during `HEAD`; if full decode then normalizes dimensions differently, `GET` retains `415 unsupported-header-orientation` and writes no cache entry rather than emitting pixels that contradict the headers.

## Activity and session feedback

`ActivityLog` is a standalone append-only JSONL log usable without FastAPI. It writes one file per UTC day under `flightarchive/log/activity/`. `report` generates the record identity and time; callers cannot supply `id` or `createdAt`:

- `id`: `activity-<UTC YYYYMMDDTHHMMSSffffffZ>-<random hex>`
- `createdAt`: microsecond-precision UTC ISO timestamp

`POST /api/activity` accepts exactly `{source, kind, severity, state, code, details}`. The five string fields are opaque labels; `details` must be finite JSON of at most 64 KiB, and the request body is capped at 128 KiB and rejected with `413` before it is read. In practice the frontend posts only important failures (not routine successes). Its shared failure publisher owns the complete result: one centered Snackbar, one static drawer record, and at most one optional best-effort activity submission. Re-reporting the same error object is idempotent, and activity transport failure neither removes the local result nor creates another failure toast. There are no page-top result banners. `GET /api/activity` returns `{days: [{date, activities}], nextCursor, hasMore, revision}`; it defaults to the newest three existing dates and accepts `before=YYYY-MM-DD&limitDays=1..30`. `revision` is the newest valid record id; oversized, non-finite, or damaged lines are skipped without rewriting the file.

The frontend heartbeat (`state/useWorkspaceHeartbeat.ts`) polls only `GET /api/status` every 30 seconds and exposes `checking | online | offline` plus the last status. `AppState` derives an unread badge from `activityRevision` versus the last revision the user acknowledged; opening the feedback drawer and loading activity advances that watermark. The drawer (`tasks/TasksPage.tsx`) shows three independent read-only streams: this session's feedback records, the persisted activity log, and the legacy fingerprint task history.

## Legacy fingerprint task history

`legacy_tasks.py` is a pure, read-only projection of the old task JSONL under `flightarchive/log/task/`. `GET /api/tasks` is its only HTTP surface: a paginated per-day read returning the latest record per task id. It never repairs, rewrites, resumes, or executes anything; stale `queued`/`running` records are displayed exactly as stored. There is no task scheduler, queue, or worker in the current backend.

## Frontend structure

- `main.tsx` composes `LanguageProvider` → one shared `FeedbackProvider` → `ResourceMappingProvider` → `App`; `AppStateProvider` reuses that feedback stream while adding business data and heartbeat. Isolated `AppStateProvider` mounts retain their own single feedback host for component tests and embedded surfaces.
- `domain/` owns `BusinessData`, schema v1 parse/normalize, pure mutation commands, the fixed v2 document split/aggregate, selectors, and `BusinessDataProvider` (the per-document save queue).
- `rfg/` owns the RFG HTTP client, pure mapping transforms, and `ResourceMappingProvider`. Provider refreshes register newly scanned catalog files as confirmed `inbox/` mappings and remove missing disposable inbox/ignore entries; same-frontend mapping write sections are FIFO so scans cannot overwrite explicit rename/release or final fingerprint writes. Coordinated writes resolve flat-name collisions against their latest mapping snapshot and return actual retargets to the domain coordinator.
- The reference-library UI is the composition boundary for explicit resource-bearing CRUD: it compares before/prospective domain snapshots, asks `ResourceMappingProvider` to prepare mapping renames/releases first, then commits a prepared `BusinessDataProvider` mutation. Neither provider imports the other's types or persists ownership state. Mapping and named JSON writes cannot be atomic, so transient per-entry recovery receipts provide bounded best-effort compensation and visible failure reporting without replacing unrelated mapping changes.
- `resources/` owns the picker/browser, the mappings page, and the bounded browser image renderer.
- `flights/`, `reference/`, `scanstudio/`, `boardingpass/` are the feature UI.
- `state/`, `feedback/`, `tasks/` own status/heartbeat, the session feedback stream, and the history drawer.
- `api/client.ts` is the host API boundary (`status`, archive documents, activity, tasks). There is no business-data, catalog, or resource API client because those are frontend/RFG concerns.

## Command scripts and validation

From `app/backend` (project virtualenv):

- `python -m pytest tests -q` — backend suite.
- `python -m pytest tests/test_rfg_host.py -q` — focused RFG host contract suite.

From `app/frontend`:

- `pnpm exec vitest run --maxWorkers=4` — frontend suite. On Node versions that expose an experimental global `localStorage` (which shadows jsdom's), run with `NODE_OPTIONS=--no-experimental-webstorage`.
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm build` — `tsc --noEmit && vite build` (output `build/`, served by the Python host).
- `pnpm dev` — Vite dev server on 5173, proxying `/api` and `/res` to the CLI default `127.0.0.1:8787`.
- `pnpm test:browser-images` — `node tests/browserImages.mjs`, a real-Chromium check of the bounded browser renderer with the relay itself **mocked** (small WebP derivatives plus original logical headers), so it verifies browser-side correctness, not live backend performance. Playwright is intentionally **not** a product dependency; the runner reads `PLAYWRIGHT_MODULE` (installed Playwright package directory or entry file, required), `CHROMIUM_PATH` (default `/usr/bin/chromium`), and `BROWSER_TEST_PORT` (default 41739) from the environment, starts a Vite dev server, and drives the page directly.
- `pnpm test:thumbnail-relay` — `node tests/thumbnailRelay.mjs`, an optional live acceptance and performance harness for the thumbnail relay. It is deliberately environment-dependent: it requires a built SPA (`app/frontend/build`), the Python backend dependencies, `PLAYWRIGHT_MODULE`, and `CHROMIUM_PATH` (all required), and uses `PYTHON` to select the interpreter (default `app/backend/.venv/bin/python`). It generates every fixture in a private temporary directory, starts the real backend against that directory, seeds 92 flights, and drives the built SPA through Chromium; it never opens the configured resource or data roots. It reports cold/hot JPEG and PNG render times, viewport relay-request counts while browsing, and the number of original-resource requests (expected zero during ordinary browse), and asserts a populated disposable cache. Unlike `test:browser-images`, it exercises the actual Pillow/backend path, but because it depends on a local Chromium and built artifacts it is not part of the default or CI suites.

Container helpers under `tools/`:

- `BuildAll.bat` — builds the `app/` Docker context.
- `BuildAndRunContainer.bat` — cleans build caches, rebuilds, and `docker run`s with `/resource:ro` and `/data`; it also offers an optional `/cache` bind mount for retaining the disposable thumbnail cache.
- `ClearAllTemplateFiles.bat` — removes local build/test caches.

The release workflow (`.github/workflows/docker-image.yml`) runs the backend suite, then frontend typecheck/suite/build, then publishes `linux/amd64` and `linux/arm64` images.

## Explicitly out of scope

No authentication, no multi-user or concurrency model, no sharding, no backend lifecycle/materialization/fingerprint services, no domain preview machinery or persistent preview cache, and no speculative expansion beyond the shipped single-user local/LAN feature set. The only backend image facility is the domain-neutral, scale-only thumbnail relay and its disposable cache.
