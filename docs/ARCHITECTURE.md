# Architecture map

## Runtime ownership and request routing

`app/backend/flightarchive/server.py:create_app` builds the public FastAPI host.

- The host owns FlightArchive business endpoints at `/api/*` and derived images at `/images/*`; routers are in `routes/api.py` and `routes/images.py`.
- It constructs the RFG application, explicitly enters RFG's lifespan (so its startup catalog scan runs), then mounts RFG at `/` **last**. RFG therefore supplies `/api/v1/*`, `/res/*`, and the final SPA/static fallback without shadowing business routes.
- The child order is RFG explicit routes, a JSON 404 for unknown `/api/*`, then the SPA fallback. Do not add a host catch-all that changes this precedence.
- RFG remains the resource catalog, mapping, hash, and original-byte delivery authority. FlightArchive talks to its documented HTTP endpoints only.

## Backend ownership

| Concern | Source of truth | Main code |
| --- | --- | --- |
| Flights and reference catalogs | `BusinessData` | `domain/models.py`, `domain/store.py`, `workspace/state.py` |
| Business persistence / schema gate | `<RFG_DATA_DIR>/flightarchive/v1/business-data.json` | `business_data.py` |
| RFG local-source catalog and virtual-path mapping | RFG data, including `<RFG_DATA_DIR>/rfg/mapping.json` | `routes/api.py:ResourceLifecycleService` |
| Resource review projection (state, usage, and allowed actions) | joined RFG mapping/catalog plus `BusinessData` references; never persisted | `routes/api.py:resource_review_snapshot` |
| Preview limits (restart-only) | `<RFG_DATA_DIR>/flightarchive/v1/preview-config.json` | `config.py` |
| Disposable WebP thumbnail and rectangular-preview cache | `FLIGHTARCHIVE_CACHE_DIR` (default: sibling `cache/` of data root) | `thumbnails.py`, `routes/images.py` |
| Deferred release retry candidates | process memory only | `routes/api.py:ResourceLifecycleService` |
| Automatic fingerprint scheduling | process memory only (never replayed) | `tasks.py` |
| Fingerprint task status/result history | `<RFG_DATA_DIR>/flightarchive/log/task/<UTC creation day>.jsonl` | `tasks.py` |

`Workspace.transaction` holds the domain rollback boundary: a failed atomic BusinessData write restores the in-memory domain. Resource mapping cleanup is separate and best-effort only after a completed business mutation; see [`RESOURCE_LIFECYCLE.md`](RESOURCE_LIFECYCLE.md).

For reviewed resource mapping mutations, a successful RFG mapping PUT is final. Response shaping reuses the preflight catalog; because the current RFG PUT response has no ETag, the host makes at most two post-commit mapping-read attempts. Exhaustion returns `503 resource-committed-refresh-failed` with `error.details.committed: true` and operation result fields: this reports an indeterminate refresh, not a rolled-back mutation.

`tasks.py` is an explicit single-worker FIFO for automatic and manually requested fingerprints, not a durable job system. `POST /api/resources/fingerprints` validates and enqueues work, returning `202` plus its task snapshot; it never hashes inline. Scheduling state is lost on restart/shutdown and logged tasks are **not replayed**. Task IDs are lexically time-oriented (`task-<UTC YYYYMMDDTHHMMSSffffffZ>-<random hex>`). Every queued/running/progress/terminal state is an append-only full JSON snapshot, followed by a separate result record, under `<RFG_DATA_DIR>/flightarchive/log/task/`. A task always stays in its UTC creation-day file even when it crosses midnight.

`GET /api/tasks` reads that log history, not the bounded in-memory scheduler view. With no parameters it returns the newest three dates for which a JSONL file exists. `before=YYYY-MM-DD` selects dates strictly before the cursor; `limitDays` is 1–30. The shape is `{days: [{date, tasks}], nextCursor, hasMore}`. On this read path, under a process-local lock, a latest `queued` or `running` status whose ID is not active in this process is atomically completed as `failed` with `task_interrupted`, followed by its result record. This repair is idempotent. A trailing crash-damaged partial line is ignored. The deployment contract is one backend process; files are not automatically removed.

## UI and domain flow

- React starts at `app/frontend/src/main.tsx`; routing/composition is in `App.tsx`. `api/client.ts` and `api/types.ts` are the browser API boundary.
- `theme.ts` owns shared UI palette semantics. Its `productAccent` identity blue (`#64B3F4`) is fixed across light and dark modes for product-status/action accents; it does not replace semantic success, warning, or error colours. Accent IconButtons retain the standard IconButton resting and interaction surfaces, applying the product colour to their icon rather than a persistent tray.
- Flight editing and display are in `flights/`; catalog/reference editing is in `reference/`; mapping, rematch, release, and fingerprints are in `resources/`. A shared file browser (`useResourceBrowser` + `ResourceBrowser`: search, thumbnail/list views, paging, classification, usage, empty/error states, configurable filtering and ordering) backs per-scenario shells. `ResourcePickerDialog` is the form shell used by flight/airline editors and by manual single-target rebinding (`selectable="inbox"`); by default it lists inbox pending files first, then already mapped/associated files, and hides the rest. `AutoRematchDialog` is the inbox-only multi-to-multi shell that combines candidate selection with matching-field rules. Resource Mappings keeps All browse-only; the Pending tab offers batch ignore only; the Missing tab offers batch auto-rematch and per-row manual rebind; Rebuild Mapping fixes the selected missing targets and lets the picker add or remove inbox candidates; the Paired tab offers per-row manual rebind beside fingerprinting.
- Flight records retain their own airline, airport, aircraft-type, and optional registration values. Reference catalogs enrich those values rather than own them, so deleting a catalog entry never rewrites a flight.
- Aircraft-type ICAO designators use their own 2–4 uppercase alphanumeric contract in both catalog and flight fields; this is separate from optional airline ICAO (3 letters) and airport ICAO (4 letters) catalog identifiers.
- Aircraft types use one nullable `manufacturer` value. Suggested and custom manufacturer names are stored directly; `null` means none. The reference editor derives free-text autocomplete suggestions from current catalog values, not a server-side standard list.
- `ReferenceLibraryPage` loads flights independently of catalogs to derive the per-row flight count and UI-only unlisted-code rows. Saving an unlisted row uses the ordinary catalog `PUT` upsert; until then it is neither selectable nor deletable and has no durable catalog record. If flight loading fails, the library remains usable but shows unavailable counts and derives no rows.
- `PUT /api/catalogs/{kind}/{key}` is deliberately a merge upsert: the path key is authoritative, omitted fields retain existing values, and a missing key creates an entry from model defaults plus submitted fields. Both ordinary Add and unlisted-code registration use this route. All catalog deletion, including one item, uses `POST /api/catalogs/{kind}/delete` with `{keys, force?}` and is atomic.
- The three resource-capable flight slots are `paperBoardingPassFront`, `paperBoardingPassBack`, and `electronicBoardingPass`; attachments and all three airline-logo slots may share the same mapped object path.
- Airline catalog colors are grouped as `brandColors.primary` and `brandColors.contrast`. Its nullable `alliance` is the sole alliance value: `null` means no alliance, while standard and custom alliance names are stored directly. A flight's optional electronic boarding-pass color is `boardingPassColor`. The crop-centre sample is its default, while a user pixel pick or manual hex entry replaces it. Display reuses that one color for both flight gradient inputs, preserving the existing low-saturation rendering structure.
- Scan/crop UI and worker protocol are in `scanstudio/`. The saved layout is image-free metadata with canonical center/size/rotation crop fields; legacy `corners` are ignored. Stage 1 edits only an in-bounds rotated rectangle; drawing corners are derived handles, not persisted geometry. The worker and preview endpoint each sample that rectangle upright without a perspective transform. The pointer magnifier is a separate source-pixel view and never affects crop geometry or editor zoom.
- `thumbnails.py` directly maps each **paper** preview output pixel back to its oriented source coordinate. Do not replace that with whole-image rotation followed by crop: a valid off-centre rectangle can otherwise be clipped before it is sampled.
- The browser worker creates the native `round(width)` by `round(height)` crop used by placement. The paper-preview endpoint samples the same geometry and then bounds only its disposable WebP to `maxDimension`; it must preserve aspect ratio rather than invent a second crop-size rule.
- `GET /api/flights/{id}/boarding-passes/{slot}/preview` accepts only paper front/back slots. Electronic presentation metadata is persisted and edited in its studio, but the archive/detail UI has no electronic crop-preview endpoint and shows a saved-layout state instead of issuing that request.

## API entry points

| Surface | Entry points |
| --- | --- |
| Workspace | `GET /api/status`, `GET /api/healthz`, `POST /api/workspace/reset`, `GET /api/tasks` |
| Flights | `GET/POST /api/flights`, `GET/PUT/DELETE /api/flights/{id}`, `GET /api/flights/{id}/boarding-passes/{slot}/preview` |
| Reference catalogs | `GET /api/catalogs`, `PUT /api/catalogs/{kind}/{key}`, `POST /api/catalogs/{kind}/delete` |
| Resources | `GET /api/resources/review`; `POST /api/resources/reconcile`, `/ignore`, `/unignore`, `/rematch`, `/release`, `/fingerprints`; `GET | HEAD /images/{virtual_path}` |
| RFG passthrough/fallback | `/api/v1/*` and `/res/*` |

Request/response validation and mutation sequencing live in `routes/api.py`; do not infer a public contract from a component alone. `GET /api/resources/review` is the backend-authoritative, read-only full join of RFG mapping/catalog and persisted flight/airline references. It returns the mapping ETag as `revision`, normalized rows, fingerprint presence, detailed uses, and server-computed capabilities; an unclaimed catalog file is a `local_only` row with `virtualPath: null`. `POST /api/resources/reconcile` performs discovery and stale-temporary cleanup, then returns exactly the same snapshot shape. The retired `/api/resources/sync` route is not retained. The resource picker and mappings page both consume this snapshot through `useResourceReview`; they no longer read raw RFG mapping, catalog, flights, and catalogs and join those four responses in the browser. The shared `ResourceBrowser` core reconciles once on each closed-to-open edge and renders backend `uses`/`capabilities`; shells only configure filtering, ordering, selection mode, and the action applied on confirm, while ordinary post-mutation refreshes use the read-only review endpoint.

`inbox/` and `ignore/` are the single temporary-mapping layer: resource reconciliation removes stale entries from either prefix, while missing stable object mappings remain available for rematching. Ignoring is an explicit mapping mutation: it can only rename a present `inbox/` entry to `ignore/<encoded local path>`; batch unignore can only restore selected present ignored entries to `inbox/<local path>` atomically. Ignored mappings are never stable objects, so they cannot be persisted in business data, released, fingerprinted, or used as rematch targets/candidates.

`GET /api/status` returns only `{status: {persistence, counts}}`; product name/version are not runtime status data. `GET /api/healthz` is the minimal container liveness probe and returns only `{ok: true}`. The sole in-repository product-version source is backend `flightarchive.__version__` for CLI/build metadata. Product and private frontend-package versions may change incompatibly, while persisted `flightarchive/v1` paths and `schemaVersion` payloads remain compatible within a product major version. RFG `/api/v1/*` is an upstream contract and is not a FlightArchive product-version declaration.

Reviewed mapping commands carry `{ifMatch, ...}` and return compact operation results plus the new `revision`; they do not echo the raw RFG mapping or local catalog. `POST /api/resources/ignore` always accepts `virtualPaths` (including a one-element array). `POST /api/resources/rematch` is discriminated by `mode`: `explicit` accepts target/candidate pairs (a target may be a present or missing stable object, i.e. a manual force rebind), while `auto` accepts candidates, an optional target subset, and server-evaluated algorithms. Both rematch modes return `{applied, ambiguous, unmatched, revision}`. A rebind queues a full fingerprint run for each rebound target that remains business-referenced and stored no content hash (fingerprinting is scoped to business-referenced stable objects). The shared submit point is `ResourceLifecycleService.enqueue_fingerprint_work`; `enqueue_fingerprints` is the default-algorithm convenience wrapper.

## Fast reconstruction path

1. Read [`BUSINESS_DATA.md`](BUSINESS_DATA.md) for durable data and layout invariants.
2. Read [`RESOURCE_LIFECYCLE.md`](RESOURCE_LIFECYCLE.md) before changing any resource relation, mapping, cache, or reconciliation behavior.
3. Trace `server.py` -> `routes/api.py` -> `workspace/state.py` -> `domain/store.py` for a business mutation.
4. Use `app/backend/tests/test_rfg_host.py` for host/mapping, ignore, rematch, and fingerprint contracts; use `test_thumbnails.py` for cache, rectangular preview, release, and failure cases.
5. Use frontend tests adjacent to the affected feature, especially `reference/ReferenceLibraryPage.test.tsx` and `scanstudio/ScanStudioDialog.test.tsx`. Commands: from `app/backend`, run `pytest`; from `app/frontend`, run `pnpm test`, `pnpm typecheck`, or `pnpm build` as appropriate.
