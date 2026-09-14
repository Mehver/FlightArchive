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
| Preview limits (restart-only) | `<RFG_DATA_DIR>/flightarchive/v1/preview-config.json` | `config.py` |
| Disposable WebP thumbnail and rectangular-preview cache | `FLIGHTARCHIVE_CACHE_DIR` (default: sibling `cache/` of data root) | `thumbnails.py`, `routes/images.py` |
| Deferred release retry candidates | process memory only | `routes/api.py:ResourceLifecycleService` |
| Process-local background fingerprint jobs | memory | `tasks.py` |

`Workspace.transaction` holds the domain rollback boundary: a failed atomic BusinessData write restores the in-memory domain. Resource mapping cleanup is separate and best-effort only after a completed business mutation; see [`RESOURCE_LIFECYCLE.md`](RESOURCE_LIFECYCLE.md).

## UI and domain flow

- React starts at `app/frontend/src/main.tsx`; routing/composition is in `App.tsx`. `api/client.ts` and `api/types.ts` are the browser API boundary.
- `theme.ts` owns shared UI palette semantics. Its `productAccent` identity blue (`#64B3F4`) is fixed across light and dark modes for product-status/action accents; it does not replace semantic success, warning, or error colours. Accent IconButtons retain the standard IconButton resting and interaction surfaces, applying the product colour to their icon rather than a persistent tray.
- Flight editing and display are in `flights/`; catalog/reference editing is in `reference/`; mapping, rematch, release, and fingerprints are in `resources/`.
- Flight records retain their own airline, airport, aircraft-type, and optional registration values. Reference catalogs enrich those values rather than own them, so deleting a catalog entry never rewrites a flight.
- Aircraft-type ICAO designators use their own 2–4 uppercase alphanumeric contract in both catalog and flight fields; this is separate from optional airline ICAO (3 letters) and airport ICAO (4 letters) catalog identifiers.
- Aircraft types use one nullable `manufacturer` value. Suggested and custom manufacturer names are stored directly; `null` means none. The reference editor derives free-text autocomplete suggestions from current catalog values, not a server-side standard list.
- `ReferenceLibraryPage` loads flights independently of catalogs to derive the per-row flight count and UI-only unlisted-code rows. Saving an unlisted row uses the ordinary catalog `PUT` upsert; until then it is neither selectable nor deletable and has no durable catalog record. If flight loading fails, the library remains usable but shows unavailable counts and derives no rows.
- The three resource-capable flight slots are `paperBoardingPassFront`, `paperBoardingPassBack`, and `electronicBoardingPass`; attachments and all three airline-logo slots may share the same mapped object path.
- Airline catalog colors are grouped as `brandColors.primary` and `brandColors.contrast`. Its nullable `alliance` is the sole alliance value: `null` means no alliance, while standard and custom alliance names are stored directly. A flight's optional electronic boarding-pass color is `boardingPassColor`. The crop-centre sample is its default, while a user pixel pick or manual hex entry replaces it. Display reuses that one color for both flight gradient inputs, preserving the existing low-saturation rendering structure.
- Scan/crop UI and worker protocol are in `scanstudio/`. The saved layout is image-free metadata with canonical center/size/rotation crop fields; legacy `corners` are ignored. Stage 1 edits only an in-bounds rotated rectangle; drawing corners are derived handles, not persisted geometry. The worker and preview endpoint each sample that rectangle upright without a perspective transform. The pointer magnifier is a separate source-pixel view and never affects crop geometry or editor zoom.
- `thumbnails.py` directly maps each **paper** preview output pixel back to its oriented source coordinate. Do not replace that with whole-image rotation followed by crop: a valid off-centre rectangle can otherwise be clipped before it is sampled.
- The browser worker creates the native `round(width)` by `round(height)` crop used by placement. The paper-preview endpoint samples the same geometry and then bounds only its disposable WebP to `maxDimension`; it must preserve aspect ratio rather than invent a second crop-size rule.
- `GET /api/flights/{id}/boarding-passes/{slot}/preview` accepts only paper front/back slots. Electronic presentation metadata is persisted and edited in its studio, but the archive/detail UI has no electronic crop-preview endpoint and shows a saved-layout state instead of issuing that request.

## API entry points

| Surface | Entry points |
| --- | --- |
| Workspace | `GET /api/health`, `GET /api/workspace/status`, `POST /api/workspace/reset`, `GET /api/tasks` |
| Flights | `GET/POST /api/flights`, `GET/PUT/DELETE /api/flights/{id}`, `GET /api/flights/{id}/boarding-passes/{slot}/preview` |
| Reference catalogs | `GET /api/catalogs`, `POST /api/catalogs/{kind}`, `PUT/DELETE /api/catalogs/{kind}/{key}`, `DELETE /api/catalogs/{kind}` |
| Resources | `GET /api/resources/catalog`, `POST /api/resources/sync`, `/ignore`, `/rematches`, `/batch-rematches`, `/release`, `/fingerprints`; `GET | HEAD /images/{virtual_path}` |
| RFG passthrough/fallback | `/api/v1/*` and `/res/*` |

Request/response validation and mutation sequencing live in `routes/api.py`; do not infer a public contract from a component alone. Resource sync removes only stale temporary `inbox/` and `ignore/` mappings; missing classified object mappings remain available for rematching. Ignoring is an explicit mapping mutation: it can only rename a present `inbox/` entry to `ignore/<encoded local path>`, never adds a business reference, and cannot be selected by a business form.

## Fast reconstruction path

1. Read [`BUSINESS_DATA.md`](BUSINESS_DATA.md) for durable data and layout invariants.
2. Read [`RESOURCE_LIFECYCLE.md`](RESOURCE_LIFECYCLE.md) before changing any resource relation, mapping, cache, or sync behavior.
3. Trace `server.py` -> `routes/api.py` -> `workspace/state.py` -> `domain/store.py` for a business mutation.
4. Use `app/backend/tests/test_rfg_host.py` for host/mapping, ignore, rematch, and fingerprint contracts; use `test_thumbnails.py` for cache, rectangular preview, release, and failure cases.
5. Use frontend tests adjacent to the affected feature, especially `reference/ReferenceLibraryPage.test.tsx` and `scanstudio/ScanStudioDialog.test.tsx`. Commands: from `app/backend`, run `pytest`; from `app/frontend`, run `pnpm test`, `pnpm typecheck`, or `pnpm build` as appropriate.
