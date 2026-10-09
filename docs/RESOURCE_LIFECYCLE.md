# Resource lifecycle contract

## Authority

RFG (the pinned `remappable-file-gateway` package) is the authority for the resource catalog, virtual-path mapping, hashes, and original source bytes. FlightArchive never reads resource source paths directly; it uses only RFG's documented HTTP endpoints. The browser holds the current mapping document, applies explicit transforms to it, and writes it back.

There is no backend resource lifecycle service: no `/api/resources/*`, no automatic reconciliation, no automatic release, no deferred-release queue, no ownership registry, and no fingerprint queue. The backend host exposes only the named-document archive, activity, status, and legacy task read routes, plus the domain-neutral, scale-only `/api/thumbnails` relay described under [Browser image rendering](#browser-image-rendering).

## RFG client

`app/frontend/src/rfg/api.ts` is the minimal same-origin client:

| Call | Endpoint |
| --- | --- |
| `getCatalog` | `GET /api/v1/meta/local` → `{local_files: [{local_path, size_bytes}]}` |
| `getMapping` | `GET /api/v1/meta/map` → `{document, etag}` (the `ETag` header is read, or `null`) |
| `putMapping` | `PUT /api/v1/meta/map` with the full mapping document |
| `computeHash` | `POST /api/v1/hashes` |
| `getResource` / `headResource` | `GET` / `HEAD /res/{virtual_path}` |

`resourceUrl` percent-encodes each path segment and addresses original source bytes; it is used for explicit downloads and for bounded Studio fallback formats such as SVG that the raster relay does not support. Raster display and raster Studio editing use `thumbnailUrl` (`/api/thumbnails/...`) through the bounded relay, and the original URL is never assigned directly to a raster `<img>`.

There is **no `If-Match`** on mapping writes and no conditional-write revision. `getMapping` surfaces RFG's `ETag`, but no render or write path depends on it. Mapping writes are read-modify-write with last-writer-wins; the single-user LAN deployment relies on explicit operations rather than server-side concurrency control.

`HASH_ALGORITHMS` is `['crc32', 'md5', 'sha256', 'ahash', 'dhash', 'phash']`; `PERCEPTUAL_ALGORITHMS` is `['ahash', 'dhash', 'phash']`.

## Inventory and states

`app/frontend/src/rfg/mapping.ts` derives an inventory from the mapping document plus the catalog (`resourceInventory`). Every row has `virtualPath` (null only for `local_only`), `localPath`, `state`, `present`, `sizeBytes`, and `entry`.

| State | Meaning |
| --- | --- |
| `mapped` | stable object path whose local source is present |
| `pending` | `inbox/<local_path>` mapping |
| `ignored` | `ignore/<local_path>` mapping |
| `missing` | stable object path whose local source is absent (retained so it can be reviewed and rematched) |
| `local_only` | catalog source with no mapping |

`resources/mappingRows.ts` projects these into the mappings page's `paired`, `inbox`, `ignored`, `missing`, and `local_only` row kinds.

## Path rules

- A safe relative POSIX path is non-empty, does not start with `/`, contains no `\` or NUL, and has no empty, `.` or `..` segment.
- `inbox/` and `ignore/` are the only temporary prefixes. `isStablePath` is a safe relative path outside both.
- `validateMapping` accepts only an `entries` document, safe relative virtual/local paths, unique virtual and local paths, `size_bytes` as a non-negative safe integer or null, and each hash algorithm as a non-empty string or null; unsupported fields are rejected.
- Batch mutations accept 1–256 unique safe paths (`MAX_MAPPING_BATCH`).

## Explicit mapping operations

All transforms are pure functions in `rfg/mapping.ts`; `ResourceMappingProvider` writes the result only when it actually changed.

- `reconcileMapping` — drops a temporary entry whose exact local source is gone, then adds each unmapped catalog source as `inbox/<local_path>`. Stable entries, including missing ones, are preserved. A virtual-path collision is an error.
- `materializeMapping` — moves one present `inbox/` entry to a requested stable path that preserves the source extension and does not collide. Metadata is reset to the new path/size.
- `ignoreMappings` / `unignoreMappings` — move selected present temporary entries between `inbox/` and `ignore/`; every selected entry must currently be in the expected prefix.
- `releaseMappings` — moves selected present stable entries back to `inbox/<local_path>`. It is an explicit mapping mutation and does not consult business references (there is no uses/ownership index); the operator is responsible for not releasing a path that is still referenced by saved business data.
- `rematchMappings` — for each unique target/candidate pair, the stable target (present or missing) takes the present `inbox/<local_path>` candidate's local source while keeping its virtual path; the candidate entry is consumed. Optional supplied hashes are copied onto the target.
- `autoMatchMappings` — compares each selected missing stable target against selected present inbox candidates on the chosen fields (`filename`, `sizeBytes`, or stored hash algorithms) and applies only unambiguous one-to-one matches; multiply-matched targets are `ambiguous` and field-less targets are `unmatched`.
- `applyFingerprints` — writes verified hashes onto the matching present stable entry; entries that are temporary, local-only, missing, or whose local path no longer matches are skipped.

## ResourceMappingProvider

`rfg/ResourceMappingProvider.tsx` owns `{catalog, mapping, inventory, loading, error, fingerprintProgress}` and exposes `refresh`, `reconcile`, `materialize`, `release`, `ignore`, `unignore`, `rematch`, `autoRematch`, `fingerprint`, and `cancelFingerprint`.

- `refresh` reads the catalog and mapping and publishes them (`loading`/`error` reflect the read).
- `mutate` re-reads both, applies a pure transform, writes the mapping only if it changed, then re-reads and publishes. This is the explicit-operation path for reconcile, materialize, release, ignore, unignore, and manual rematch.
- `autoRematch` validates the batch, computes each candidate's selected hashes through RFG in the browser, re-reads the mapping and verifies the candidate's `local_path` did not change while hashing, applies only unambiguous matches, writes if any were applied, and returns `{applied, ambiguous, unmatched}`.
- `fingerprint` validates 1–32 unique present stable targets and non-empty unique valid algorithms, aborts any previous run, starts a new session id, computes each `(virtualPath, algorithm)` through RFG, and applies the successful results. `fingerprintProgress` reports `running`, `succeeded`, `failed`, or `cancelled` with completed/succeeded/failed/total. `cancelFingerprint` aborts the active `AbortController`; a cancelled run does not publish its results.
- Important mapping/fingerprint failures are reported to `POST /api/activity` (source `frontend-resources`, codes `resource-mapping-failed` / `resource-fingerprint-failed`).

All hashing, reconciliation, and rematching run in the browser and are computed by RFG through its documented HTTP API; RFG is the source of truth for hashes. There is no backend fingerprint task, no in-memory scheduler, and no server-side hash cache. (The `/api/thumbnails` relay keeps only disposable resized images and never stores hashes.)

## Picker and mappings UI

- `resources/useResourceBrowser.ts` opens a fresh session on each false→true `active` edge: it resets selection, query, error, and page, and calls the read-only `mapping.refresh()` once. Newly discovered files enter `inbox/` only through an explicit reconcile operation. The initial selection is captured at that edge, so parent rerenders and language changes do not reload the browser or reset in-progress state.
- Visible rows always hide `ignored` entries and `pending` entries whose source is absent. The picker's default filter shows present stable mappings and retains an initial selection that has since gone missing (`resource.state === 'missing'` and already selected). `selectable="inbox"` restricts selection to present `pending` rows. Ordering is inbox-first, then by virtual path; page size is 24.
- `resources/ResourceBrowser.tsx` renders thumbnails or a table, marks rows missing/pending/mapped, and disables pointer and keyboard selection for absent sources.
- `resources/ResourceMappingsPage.tsx` exposes All, Rebuild (missing + inbox), Missing, Inbox, Ignored, Paired, and Local-only filters. Inbox supports materialize/ignore, Ignored supports unignore, Missing supports manual and automatic rematch, Paired supports fingerprint, manual rematch, and release. Selection is pruned to the current filter against complete mapping data.

## Browser image rendering

Raster display is relay-only. `resources/browserImageRenderer.ts` asks the backend's domain-neutral, scale-only `/api/thumbnails` relay for a small WebP and paints it, so an ordinary preview never holds a source-sized bitmap in the browser:

- The relay enforces the source/output bounds in [ARCHITECTURE.md](ARCHITECTURE.md) (256 MiB / 160,000,000 px source; 4,000,000 px / 4096 px / 4 MiB output). The browser renderer additionally caps a fetched relay blob at 4 MiB. It has no application-level blob cache: stable relay URLs use the browser's normal HTTP cache and conditional revalidation. `loadBoundedSource` caps relay-unsupported Studio originals at 24 MiB and rejects a decoded bitmap over 40,000,000 px / 16,384 px, with a default render dimension of 512 px.
- A render first performs `HEAD /api/thumbnails/{path}?scale=0.015625` to read runtime metadata (`X-Source-Width`/`Height`/`Bytes`/`ETag`, `X-Thumbnail-*`). `selectThumbnailScale` picks the **smallest** allowed dyadic scale whose output still reaches the display-quality target, bounded by the pixel/dimension/source-byte budget; if the target is unreachable within the permitted sizes, the **largest permitted** scale is used. The render then `GET`s that scale, verifies the returned source identity equals the preflight, streams the small relay WebP under the 4 MiB cap, and rejects a response without a strong source `ETag`.
- Raster Studio loading uses the same metadata preflight but selects the largest dyadic relay output within 4,000,000 pixels and 4096 px, independently of the ordinary display byte-quality hint. Only an exact `413 thumbnail-output-too-large` response (encoded WebP over 4 MiB) retries the next smaller dyadic scale; source guards and all other errors do not retry or fall back to the original. The decoded thumbnail is painted and sampled with independent X/Y ratios in the original EXIF-normalized logical coordinate system; persisted crop coordinates and worker crop transforms therefore remain source-pixel coordinates. Electronic color extraction samples this bounded preview, and an already stored color is not automatically overwritten.
- A crop is a canonical in-bounds rotated rectangle (`centerX`, `centerY`, `width`, `height`, `rotationDegrees`); `validateRenderBounds` requires all four rotated corners to fall inside the source. The output canvas is sized to the requested dimension and paints the already-EXIF-normalized relay bitmap in the original logical coordinate space (rotation applied), so persisted crop geometry stays exact without a source-sized canvas. Legacy `corners` are ignored.
- Every active consumer owns its final object URL until unmount or a render-input change and then revokes it. Near-viewport gating is sticky after first intersection, so scrolling away and back neither revokes the URL nor starts another render. Components that never approach the viewport still do no raster work. HTTP reuse is left to the browser; there is no frontend blob LRU, TTL, timer, service worker, or persistent image cache.
- `render` accepts an `AbortSignal`; `resources/useBrowserImage.ts` uses both abort and generation guards, releases late results, and preserves failure causes. `resources/useNearViewport.ts` starts work through an `IntersectionObserver` (`rootMargin: 250px 0px`) and stays enabled after first intersection; scrolling away does not release or reload the image, while unmount and render-input changes still abort pending work and revoke owned blob URLs. Raster display has **no automatic raw fallback**: a failed relay request shows an unavailable/preview-unavailable state instead of fetching the original. Raster Studio editing uses bounded relay thumbnails; `loadBoundedSource` is retained only for relay-unsupported Studio formats such as SVG, while explicit downloads use `resourceUrl` directly. SVG resources stay on the direct `resourceUrl` route because they are already scalable and bounded by layout.

The retired domain endpoints stay retired: there is no `/images/*` route and no crop or boarding-pass preview endpoint. The only backend image route is the domain-neutral, scale-only `/api/thumbnails` relay, which accepts no crop, flight, or lifecycle input.

## Fingerprints

For present stable mappings, the browser orchestrates fingerprint requests and RFG computes the hashes. Content hashes (`crc32`, `md5`, `sha256`) work on any source; perceptual hashes (`ahash`, `dhash`, `phash`) are offered only for raster extensions (`.avif`, `.bmp`, `.gif`, `.jpeg`/`.jpg`, `.png`, `.webp`) and fail terminally in RFG for unsupported payloads. `resources/fingerprints.ts` resolves calculable targets, hides controls for temporary/local-only rows, and chunks requests (at most 32 virtual paths per call). Stored hash metadata lives only on the mapping entry; it is never duplicated into BusinessData.

## Legacy fingerprint task history

`app/backend/flightarchive/legacy_tasks.py` read-only projects the retired task JSONL under `<RFG_DATA_DIR>/flightarchive/log/task/`. `GET /api/tasks` is its only HTTP surface: it returns the latest record per task id per UTC day with `before`/`limitDays` paging. It never repairs, rewrites, resumes, or executes work, and reading does not change file contents or mtimes.

## Source pointers

- RFG client and path rules: `app/frontend/src/rfg/api.ts`, `app/frontend/src/rfg/mapping.ts`.
- Explicit operations and progress: `app/frontend/src/rfg/ResourceMappingProvider.tsx`.
- Picker, mappings page, rendering: `app/frontend/src/resources/` (`useResourceBrowser.ts`, `ResourceBrowser.tsx`, `ResourcePickerDialog.tsx`, `ResourceMappingsPage.tsx`, `browserImageRenderer.ts`, `useBrowserImage.ts`, `useNearViewport.ts`, `fingerprints.ts`).
- Crop capture and geometry: `app/frontend/src/scanstudio/`.
- Host routes: `app/backend/flightarchive/routes/api.py`; thumbnail relay: `app/backend/flightarchive/thumbnail.py`; legacy task projection: `app/backend/flightarchive/legacy_tasks.py`.
