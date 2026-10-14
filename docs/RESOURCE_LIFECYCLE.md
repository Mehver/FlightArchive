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

`app/frontend/src/rfg/mapping.ts` derives an inventory from confirmed mapping entries plus the catalog (`resourceInventory`). Every row has a required `virtualPath`, `localPath`, mapping `entry`, `state`, `present`, and `sizeBytes`. A catalog source is published in normal inventory only after refresh has successfully registered and confirmed its `inbox/<local_path>` mapping.

| State | Meaning |
| --- | --- |
| `mapped` | stable object path whose local source is present |
| `pending` | `inbox/<local_path>` mapping |
| `ignored` | `ignore/<local_path>` mapping |
| `missing` | stable object path whose local source is absent (retained so it can be reviewed and rematched) |

`resources/mappingRows.ts` projects these four confirmed states into the mappings page's `paired`, `inbox`, `ignored`, and `missing` row kinds.

## Path rules

- A safe relative POSIX path is non-empty, does not start with `/`, contains no `\` or NUL, and has no empty, `.` or `..` segment.
- `inbox/` and `ignore/` are the only temporary prefixes. `isStablePath` is a safe relative path outside both.
- `validateMapping` accepts only an `entries` document, safe relative virtual/local paths, unique virtual and local paths, `size_bytes` as a non-negative safe integer or null, and each hash algorithm as a non-empty string or null; unsupported fields are rejected.
- Batch mutations accept 1–256 unique safe paths (`MAX_MAPPING_BATCH`).

## Explicit mapping operations

All transforms are pure functions in `rfg/mapping.ts`; `ResourceMappingProvider` writes the result only when it actually changed.

- `reconcileMapping` — drops missing `inbox/` and `ignore/` entries, then adds each unmapped catalog source as `inbox/<local_path>`. Both temporary states are disposable: a returning source is discovered in inbox again. Stable entries, including missing ones, are preserved. A virtual-path collision is an error.
- `ignoreMappings` / `unignoreMappings` — ignoring requires a present `inbox/` source. Unignoring a present source moves it back to `inbox/`; cancellation is harmless if reconciliation already removed an absent ignored source.
- `releaseMappings` — the domain-neutral transform releases selected stable mappings. A present source returns to `inbox/<local_path>` with refreshed size and cleared hashes. If the source is absent, its virtual mapping is removed; a future discovery registers the source in `inbox/`. Neither path deletes a local file. The mappings page separately checks the latest in-memory flight and airline references inside the serialized write section and refuses manual release while any reference remains; coordinated last-reference release uses the prospective business aggregate instead.
- `transitionMappings` — applies the first-bind/rename/release set prepared by an explicit flight or airline CRUD operation in one mapping write. A first binding accepts only a present `inbox/` source and a stable same-extension target. Renames preserve `local_path`, size, and hashes even when the source is absent. A present release returns to `inbox/` and clears hashes; an absent release removes the mapping. Virtual/local collisions fail closed.
- `rematchMappings` — for each unique target/candidate pair, the stable target (present or missing) takes the present `inbox/<local_path>` candidate's local source while keeping its virtual path; the candidate entry is consumed. If the target's previous source is still present, it returns immediately to `inbox/<local_path>` with current size and cleared hashes; an absent previous source creates no entry. Optional supplied hashes are copied onto the target.
- `autoMatchMappings` — compares each selected missing stable target against selected present inbox candidates on the chosen fields (`filename`, `sizeBytes`, or stored hash algorithms) and applies only unambiguous one-to-one matches; multiply-matched targets are `ambiguous` and field-less targets are `unmatched`.
- `applyFingerprints` — writes verified hashes onto the matching present stable entry; temporary or missing entries and entries whose local path no longer matches are skipped.

## ResourceMappingProvider

`rfg/ResourceMappingProvider.tsx` owns `{catalog, mapping, inventory, loading, error, fingerprintProgress}` and exposes `refresh`, `reconcile`, `release`, coordinated `transition`/`restore`, `ignore`, `unignore`, `rematch`, `autoRematch`, `fingerprint`, and `cancelFingerprint`.

- `refresh` reads the catalog and mapping, reconciles newly discovered catalog sources into `inbox/<local_path>`, writes only when the transform changed the document, confirms that write, and then publishes the confirmed pair (`loading`/`error` reflect the operation). Stable missing entries are preserved; missing inbox and ignore entries are pruned. If scoped compensation remains unconfirmed, refresh first retries it as an internal precondition of this ordinary action.
- `mutate` re-reads both, applies a pure transform, writes the mapping only if it changed, and publishes only after a GET exactly confirms the expected document. This is the explicit-operation path for reconcile, release, ignore, unignore, and manual rematch. Auto-rematch and final fingerprint writes use the same confirmation rule; a mismatched read is an error, not success.
- `transition` allows at most three operation PUT attempts, but never blindly repeats a write: after a rejected response it reads the mapping and retries only after confirming the before-state or performing scoped recovery. Its session-only recovery receipt records the before and expected-after entry for each affected local path. Recovery re-reads the latest mapping and reverses only those entries, preserving unrelated discoveries, aliases, and hashes. A rename recovery changes only the virtual alias and therefore preserves later same-source metadata; a release recovery restores its before metadata. If an affected source was rebound incompatibly, recovery fails closed rather than overwriting the later change. An unconfirmed receipt remains private provider state and is retried by the next ordinary refresh or mutation; it is not exposed as a separate user operation, persistent queue, or journal and does not survive a page refresh.
- `autoRematch` validates the batch, computes each candidate's selected hashes through RFG in the browser, re-reads the mapping and verifies the candidate's `local_path` did not change while hashing, applies only unambiguous matches, writes if any were applied, and returns `{applied, ambiguous, unmatched}`.
- `fingerprint` validates 1–32 unique present stable targets and non-empty unique valid algorithms, aborts any previous run, starts a new session id, computes each `(virtualPath, algorithm)` through RFG, and applies the successful results. `fingerprintProgress` reports `running`, `succeeded`, `failed`, or `cancelled` with completed/succeeded/failed/total. `cancelFingerprint` aborts the active `AbortController`; a cancelled run does not publish its results.
- Mapping read-transform-write-confirm sections are serialized within one provider session. Catalog scans, explicit transitions/restores, rematches, and final fingerprint writes therefore re-read the latest mapping without holding the queue during long hash computation. This is same-frontend ordering, not a server transaction or multi-client concurrency protocol.
- Important mapping/fingerprint failures use the shared failure publisher, which creates one Snackbar and one static session record and optionally makes one best-effort `POST /api/activity` (source `frontend-resources`, codes `resource-mapping-failed` / `resource-fingerprint-failed`). Activity transport failure never suppresses or recursively republishes the user-visible result.

All hashing, reconciliation, and rematching run in the browser and are computed by RFG through its documented HTTP API; RFG is the source of truth for hashes. There is no backend fingerprint task, no in-memory scheduler, and no server-side hash cache. (The `/api/thumbnails` relay keeps only disposable resized images and never stores hashes.)

## Picker and mappings UI

Explicit flight and airline saves/deletions in the reference library coordinate direct resource references before publishing business changes. The browser scans the three flight slots, attachments, and three airline logo slots from the before/prospective aggregates. Flight names are flat root objects: `YYYYMMDD` + lowercase airline code + flight number padded to four characters + role (`a0` front, `a1` back, `b0` electronic, `cN` attachment) + lowercase source extension. Airline logos use `<code>-horizontal`, `<code>-horizontal-dark`, and `<code>-symbol`. No owner-ID directory, hash token, or ownership registry is stored.

Different sources that collide on one natural flight role advance within its family (`a0/a2/...`, `a1/a3/...`, `b0/b1/...`). Attachment allocation uses one more than the highest currently surviving `cN` for that flight stem across all extensions: gaps are not filled, removing the tail permits that tail to be reused, and clearing all attachments restarts at `c0`. This keeps names aligned with addition order without recursively renaming array members; array reordering never renumbers existing names. The provider resolves these names from its latest confirmed mapping and returns the actual retargets to the archive coordinator, so a source being released in the same operation still occupies its old URL and cannot be overwritten by replacement bytes.

One source always has one RFG mapping even when many records or slots reference it. Its naming reference rolls up by role (front, back, electronic, attachment); equal-priority sharing retains the current name. If that reference leaves or a higher role is added, remaining references are selected deterministically by flight date, airline, flight number, and ID, without `createdAt`, and all references are retargeted without clearing their independent crop/extraction metadata. Airline logo categories retain their own precedence. Only the final unlink releases to `inbox/`. Editing a controlling flight's date, airline, or flight number first confirms the resource rename and only then saves the record; a lower-priority sharer's metadata change does not take the name. Arbitrary legacy stable paths remain readable and are not swept into this naming scheme by unrelated saves. Form drafts and cancellation do not rename or release mappings; opening or refreshing a picker may independently register newly scanned files in `inbox/` and thumbnail requests remain read-only.

The coordination is limited to resources affected by that explicit CRUD command; it never sweeps unrelated mappings. Unchanged legacy/custom references are not renamed during metadata-only saves; first binding, binding-location changes, primary-owner removal, and a canonical managed primary's label change are the triggers. Resource preparation must succeed before a record is committed. Batch record deletion is serial, removes successful records from selection, and leaves failures selected. Failures create matching session feedback and activity records with the actual resource-attempt count and compensation state. If archive persistence fails after a mapping change, the browser best-effort applies its scoped recovery receipt; an uncompensated failure is explicitly reported rather than presented as a transaction success.

- `resources/useResourceBrowser.ts` opens a fresh session on each false→true `active` edge: it resets selection, query, error, and page, and calls `mapping.refresh()` once. That scan registers newly discovered files in `inbox/` but does not change form drafts, stable names, releases, hashes, or business records. The initial selection is captured at that edge, so parent rerenders and language changes do not reload the browser or reset in-progress state.
- Visible rows always hide `ignored` entries and `pending` entries whose source is absent. The picker's default filter shows present stable and present `inbox/` mappings, and retains an initial stable selection that has since gone missing (`resource.state === 'missing'` and already selected). `selectable="inbox"` restricts selection to present `pending` rows. Ordering is inbox-first, then by virtual path; page size is 24.
- `resources/ResourceBrowser.tsx` renders thumbnails or a table, marks rows missing/pending/mapped, and disables pointer and keyboard selection for absent sources.
- `resources/ResourceMappingsPage.tsx` exposes All, Rebuild (missing + inbox), Missing, Inbox, Ignored, and Paired filters. Inbox supports ignore but has no manual stable-path editor; first binding occurs only when a flight or airline form is saved. Ignored entries exist only while their source is present and support unignore; Missing supports manual and automatic rematch plus release, and Paired supports fingerprint, manual rematch, and release. Selection is pruned to the current filter against complete mapping data.
- The mappings page has no dedicated recovery button, recovery panel, or page-top operation alert. Ordinary actions transparently retry private scoped compensation first; failure is published once through the shared Snackbar/static-record channel and the original action remains available for retry.

## Browser image rendering

Raster display is relay-only. `resources/browserImageRenderer.ts` asks the backend's domain-neutral, scale-only `/api/thumbnails` relay for a small WebP and paints it, so an ordinary preview never holds a source-sized bitmap in the browser:

- The relay enforces the source/output bounds in [ARCHITECTURE.md](ARCHITECTURE.md) (256 MiB / 160,000,000 px source; 4,000,000 px / 4096 px / 4 MiB output). A flat alias is used directly as `/api/thumbnails/<encoded-flat-name>?scale=...`; there is no thumbnail namespace or filename suffix. The browser renderer additionally caps a fetched relay blob at 4 MiB. It has no application-level blob cache: stable relay URLs use the browser's normal HTTP cache and conditional revalidation. `loadBoundedSource` caps relay-unsupported Studio originals at 24 MiB and rejects a decoded bitmap over 40,000,000 px / 16,384 px, with a default render dimension of 512 px.
- A render first performs `HEAD /api/thumbnails/{path}?scale=0.015625` to read runtime metadata (`X-Source-Width`/`Height`/`Bytes`/`ETag`, `X-Thumbnail-*`). `selectThumbnailScale` picks the smallest allowed dyadic scale that meets the fixed 512 px detail-preview requirement for the saved crop (or the full source when uncropped), bounded by complete-source pixels, dimensions, and the conservative source-byte hint. Consumer canvas size is not part of selection, so list, grid, detail, and a boarding-pass file row supplied with the same crop-quality hint share one relay URL/backend cache key. The render then `GET`s that scale, verifies the returned source identity equals the preflight, streams the small relay WebP under the 4 MiB cap, and rejects a response without a strong source `ETag`.
- Raster Studio loading uses the same metadata preflight but selects the largest dyadic relay output within 4,000,000 pixels and 4096 px, independently of the ordinary display byte-quality hint. Only an exact `413 thumbnail-output-too-large` response (encoded WebP over 4 MiB) retries the next smaller dyadic scale; source guards and all other errors do not retry or fall back to the original. The decoded thumbnail is painted and sampled with independent X/Y ratios in the original EXIF-normalized logical coordinate system; persisted crop coordinates and worker crop transforms therefore remain source-pixel coordinates. Electronic color extraction samples this bounded preview, and an already stored color is not automatically overwritten.
- A crop is a canonical in-bounds rotated rectangle (`centerX`, `centerY`, `width`, `height`, `rotationDegrees`); `validateRenderBounds` requires all four rotated corners to fall inside the source. The output canvas is sized to the requested dimension and paints the already-EXIF-normalized relay bitmap in the original logical coordinate space (rotation applied), so persisted crop geometry stays exact without a source-sized canvas. Legacy `corners` are ignored.
- Every active consumer owns its final object URL until unmount or a render-input change and then revokes it. Actual viewport visibility, active retained view/dialog scope, and document visibility gate unfinished work; becoming inactive aborts queued/running work but keeps an already-ready URL. Returning to a retained surface therefore does not rerender loaded images and does not add an application image cache. HTTP reuse is left to the browser; there is no frontend blob LRU, TTL, timer, service worker, or persistent image cache.
- `render` accepts an `AbortSignal`; `resources/useBrowserImage.ts` uses both abort and generation guards, releases late results, and preserves failure causes. One module-level gate admits at most two effective ordinary display pipelines/on-wire requests; an aborted queued consumer is removed before fetching, and abort-aware decode/encode waits release its gate slot immediately. Browser decode/encode primitives cannot themselves be preempted, so they may briefly finish in the background, but late bitmaps are closed, late blobs are discarded, and no URL is published. `resources/useNearViewport.ts` observes the actual viewport (`rootMargin: 0`) continuously. Raster display has **no automatic raw fallback**: a failed relay request shows an unavailable/preview-unavailable state instead of fetching the original. Raster Studio editing uses bounded relay thumbnails; `loadBoundedSource` is retained only for relay-unsupported Studio formats such as SVG, while explicit downloads use `resourceUrl` directly. SVG resources stay on the direct `resourceUrl` route because they are already scalable and bounded by layout.
- List, grid, and detail presentations of a saved paper slot use its fixed detail-quality crop reference even when their final canvas dimensions differ. A detail file row reusing a paper resource receives the highest required crop reference among that flight's front/back bindings, while unrelated resource previews remain independent full-source detail-quality consumers. Their loading ring is delayed briefly to avoid flashing on decoded/cache-fast paths and is sized from the shorter edge of its overlay host (12–24 px) without applying CSS size containment to the preview layout.

The retired domain endpoints stay retired: there is no `/images/*` route and no crop or boarding-pass preview endpoint. The only backend image route is the domain-neutral, scale-only `/api/thumbnails` relay, which accepts no crop, flight, or lifecycle input.

## Fingerprints

For present stable mappings, the browser orchestrates fingerprint requests and RFG computes the hashes. Content hashes (`crc32`, `md5`, `sha256`) work on any source; perceptual hashes (`ahash`, `dhash`, `phash`) are offered only for raster extensions (`.avif`, `.bmp`, `.gif`, `.jpeg`/`.jpg`, `.png`, `.webp`) and fail terminally in RFG for unsupported payloads. `resources/fingerprints.ts` resolves calculable targets, hides controls for temporary and missing rows, and chunks requests (at most 32 virtual paths per call). Stored hash metadata lives only on the mapping entry; it is never duplicated into BusinessData.

## Legacy fingerprint task history

`app/backend/flightarchive/legacy_tasks.py` read-only projects the retired task JSONL under `<RFG_DATA_DIR>/flightarchive/log/task/`. `GET /api/tasks` is its only HTTP surface: it returns the latest record per task id per UTC day with `before`/`limitDays` paging. It never repairs, rewrites, resumes, or executes work, and reading does not change file contents or mtimes.

## Source pointers

- RFG client and path rules: `app/frontend/src/rfg/api.ts`, `app/frontend/src/rfg/mapping.ts`.
- Explicit operations and progress: `app/frontend/src/rfg/ResourceMappingProvider.tsx`.
- Picker, mappings page, rendering: `app/frontend/src/resources/` (`useResourceBrowser.ts`, `ResourceBrowser.tsx`, `ResourcePickerDialog.tsx`, `ResourceMappingsPage.tsx`, `browserImageRenderer.ts`, `useBrowserImage.ts`, `useNearViewport.ts`, `fingerprints.ts`).
- Crop capture and geometry: `app/frontend/src/scanstudio/`.
- Host routes: `app/backend/flightarchive/routes/api.py`; thumbnail relay: `app/backend/flightarchive/thumbnail.py`; legacy task projection: `app/backend/flightarchive/legacy_tasks.py`.
