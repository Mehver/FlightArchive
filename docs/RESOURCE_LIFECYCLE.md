# Resource lifecycle contract

## State machine

RFG discovers source files; FlightArchive never reads source paths directly.

```text
source discovered -> POST /api/resources/sync -> inbox/<local_path> (Pending)
Pending + explicit picker ignore -> ignore/<encoded local_path> (Transient, hidden)
Pending + valid persisted use -> human-readable object path (Materialized / referenced)
object has last persistent reference removed + source present -> inbox/<local_path>
object source disappears -> missing object mapping (retained, Rematchable)
missing object + cataloged inbox candidate -> target object path rebound (Rematched)
```

The object path is human-readable and derived from the resource's owners by `generate_resource_name` in `routes/api.py`. Flight assets use `YYYYMMDD + airlineCode.lower() + zero-padded flightNumber + role + index` (role `a` paper, `b` electronic, `c` attachment); airline logos use `airlineCode.lower() + '-' + logo role` (`horizontal`/`horizontal-dark`/ `symbol`). Shared resources merge every owner fragment with `+`, and a same-owner source replacement appends a short source hash to stay unique. Callers must not reconstruct these names and should treat persisted paths as stable; existing object paths are never renamed. A valid form is materialized only after complete business validation. Failed validation leaves its pending mapping unchanged.

## Invariants

- Sync adds every previously unmapped cataloged source as `inbox/<local_path>`. It removes temporary `inbox/` and `ignore/` mappings when their exact local paths leave the current catalog; a moved source is then discovered anew as inbox. It does not delete missing non-inbox/ignore object mappings: a target remains available for explicit rematch.
- Object paths are shareable across all three flight boarding-pass slots, flight attachment lists, flights, and all airline logo slots. Release occurs only after the **last persistent** reference disappears.
- An airline has one PNG/SVG symbol-logo slot and two equivalent horizontal-logo slots (light and dark). The display may use the other horizontal resource when the theme-preferred one is absent; neither a tail logo nor a dark symbol slot exists.
- Automatic release considers only paths made obsolete by that mutation; it never sweeps unrelated mappings. It returns a present unreferenced object to its inbox path and never deletes source files.
- There is no resource ownership registry, full orphan-mapping scan, or restart-durable cleanup queue. Business persistence is authoritative; any post-commit release retry is deliberately bounded best effort.
- `POST /api/resources/release` is explicit: each path must be mapped, non-inbox, present in the current RFG catalog, and unreferenced. It also never deletes a local source file. A missing, referenced, pending, or stale selection is rejected.
- Rematch accepts a missing non-inbox target and a distinct, present inbox candidate; it preserves the target virtual path while swapping its local source. Targets/candidates must be unique. Rebinding clears target hash metadata, so hashes always describe the current source.
- Fingerprinting accepts currently cataloged, non-inbox paths referenced by a saved flight **or an airline logo**. Content hashes are available for any such current source; perceptual hashes are restricted to `.avif`, `.bmp`, `.gif`, `.jpeg`/`.jpg`, `.png`, and `.webp`. Pending candidates may be hashed transiently for batch rematch comparison, but no fingerprint metadata is stored on their inbox mappings.

## Operations

| Trigger / API | Mapping effect | Business/cache consequence |
| --- | --- | --- |
| `POST /api/resources/sync` | catalog new sources into inbox; remove stale temporary inbox/ignore entries; preserve missing object mappings | reconcile disposable bindings; discard bindings whose mapping/source is no longer current |
| Create/update flight or airline with inbox relation | materialize once to a named object path | persist relation atomically; shared duplicate input resolves to one object |
| Flight/catalog update, delete, batch delete, or reset | after successful business transaction, release eligible former candidates | retain if still referenced; invalidate affected flight previews |
| `POST /api/resources/release` | selected eligible object -> inbox | clears fingerprint metadata on renamed entry and rebinds generic thumbnail |
| `POST /api/resources/rematches` | missing target takes candidate's local source, candidate inbox entry consumed | rebind/discard cache so target cannot show candidate/stale pixels incorrectly |
| `POST /api/resources/fingerprints` | persists requested RFG hashes for eligible, present persistent business resources | automatic work queues content hashes for images and perceptual hashes only for supported raster sources |
| `POST /api/resources/batch-rematches` | compares selected inbox files to missing mappings and applies only unambiguous one-to-one matches | candidate values are transient; replacement images queue standard fingerprint work |

## Picker behavior

The resource picker displays every mapping entry from the latest mapping; it does not hide mapped, in-use, pending, or missing entries. It joins those entries with the current local catalog to determine source availability:

- **Pending** inbox mappings with a present local source remain selectable.
- **Present mapped** object mappings remain selectable and shareable, including mappings already used by flights or airline logos.
- **Missing object** mappings remain visible as error-status **Source missing** entries so their retained object path can be reviewed and rematched. They use an unavailable file placeholder, do not load thumbnails, and cannot be newly selected by pointer or keyboard. A missing path that was already selected when the dialog opened is retained, allowing the existing value to be viewed or left unchanged.

## Concurrency, ETags, and failures

Mapping writes fetch RFG's `/api/v1/meta/map` ETag and send `If-Match`. Precondition failure is exposed as a conflict/retry condition. The lock order is `business_lock` before lifecycle mapping lock and workspace lock. It prevents a business reference from being acquired between release ownership check and map write; manual release waits for the same business critical section.

The business transaction rolls back in-memory domain state if atomic BusinessData persistence fails. Newly materialized paths are then best-effort released. Conversely, after a business mutation has succeeded, release failure does **not** undo it: only that mutation's candidate paths are queued in `deferred_releases` and retried on the next resource sync. Missing sources, surviving references, already-inbox paths, and absent mappings are final non-retry outcomes. `deferred_releases` is process-local and is intentionally not restored after restart; the resource page and later sync operations remain the recovery path.

## Cache behavior

All cache state is disposable and lives outside BusinessData.

- `GET|HEAD /images/{virtual_path}` stores generic WebP thumbnail objects by rendered bytes and binds them to `(virtual_path, local_path, RFG source ETag, render profile)`. Materialize/release moves the generic binding to the new virtual path when possible; no re-render is required. Source replacement, external mapping change, missing source, or profile change invalidates it.
- Boarding-pass preview is a separate `preview/<flight>/<slot>/<geometry>` binding. `GET /api/flights/{id}/boarding-passes/{slot}/preview` renders a bounded upright rectangular crop from canonical center/size/rotation fields, not a generic thumbnail. It accepts only `paperBoardingPassFront` and `paperBoardingPassBack`; an electronic slot is rejected with `404 boarding-pass-slot-not-found`. Electronic layouts have no server crop preview in the archive/detail UI. Paper rendering maps output pixels directly to oriented source coordinates, so an in-bounds rotated rectangle remains valid even near a source edge; do not implement it as whole-image rotation followed by crop. Legacy corners are ignored by rendering and geometry cache identity. Update, delete, reset, and sync reconciliation remove affected derived previews.
- Both paths fetch original bytes through RFG `/res/*`, enforce configured byte and pixel limits, share the app-local thumbnail miss limiter, and return WebP ETags. No cache row grants filesystem access.
- Generic `GET|HEAD /images/{virtual_path}` JPEG thumbnails ask Pillow for a decoder DCT draft targeting twice `maxDimension` before the configured pixel limit is checked. This can safely render a large JPEG when the decoder supplies a sufficiently small draft; other formats do not receive that path. Paper rectangular previews do **not** use JPEG drafting: they check the full decoded image dimensions against the configured pixel limit and reject an oversized JPEG before crop sampling.

## Source pointers and APIs

- Lifecycle implementation/helpers: `app/backend/flightarchive/routes/api.py` (`ResourceLifecycleService`, `persistent_business_resource_paths`, `_best_effort_release`, `ResourceOwner`, `generate_resource_name`).
- Cache and crop geometry: `thumbnails.py`; HTTP image serving: `routes/images.py`.
- Frontend mapping/release/rematch/fingerprint UI: `app/frontend/src/resources/`.
- Crop capture and geometry: `app/frontend/src/scanstudio/`.
- Contract tests: `app/backend/tests/test_rfg_host.py` and `test_thumbnails.py`.

Primary endpoints are `GET /api/resources/catalog`, `POST /api/resources/sync`, `POST /api/resources/rematches`, `POST /api/resources/release`, `POST /api/resources/fingerprints`, `GET|HEAD /images/{virtual_path}`, and the RFG endpoints `GET/PUT /api/v1/meta/map`, `GET /api/v1/meta/local`, and `GET|HEAD /res/{virtual_path}`.
