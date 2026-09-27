# Resource lifecycle contract

## State machine

RFG discovers source files; FlightArchive never reads source paths directly.

```text
source discovered -> POST /api/resources/reconcile -> inbox/<local_path> (Pending)
Pending + explicit picker ignore -> ignore/<encoded local_path> (Temporary, ignored)
Ignored + Resource Mappings restore -> inbox/<local_path> (Pending)
Pending + valid persisted use -> human-readable object path (Materialized / referenced)
object has last persistent reference removed + source present -> inbox/<local_path>
object source disappears -> missing object mapping (retained, Rematchable)
missing object + cataloged inbox candidate -> target object path rebound (Rematched)
present object + manual force rebind -> same object path rebound to a chosen inbox candidate (Rematched)
```

The object path is human-readable and derived from the resource's owners by `generate_resource_name` in `routes/api.py`. Flight assets use `YYYYMMDD + airlineCode.lower() + zero-padded flightNumber + role + index` (role `a` paper, `b` electronic, `c` attachment); airline logos use `airlineCode.lower() + '-' + logo role` (`horizontal`/`horizontal-dark`/ `symbol`). Shared resources merge every owner fragment with `+`, and a same-owner source replacement appends a short source hash to stay unique. Callers must not reconstruct these names and should treat persisted paths as stable; existing object paths are never renamed. A valid form is materialized only after complete business validation. Failed validation leaves its pending mapping unchanged.

## Invariants

- `inbox/` and `ignore/` are the one temporary-mapping layer. Reconciliation adds every previously unmapped cataloged source as `inbox/<local_path>` and removes either temporary mapping when its exact local path leaves the current catalog; a moved source is then discovered anew as inbox. Every non-temporary path is a stable object mapping, so any stable object remains available for explicit rematch (a present object can be force-rebound).
- Object paths are shareable across all three flight boarding-pass slots, flight attachment lists, flights, and all airline logo slots. Release occurs only after the **last persistent** reference disappears.
- An airline has one PNG/SVG symbol-logo slot and two equivalent horizontal-logo slots (light and dark). The display may use the other horizontal resource when the theme-preferred one is absent; neither a tail logo nor a dark symbol slot exists.
- Automatic release considers only paths made obsolete by that mutation; it never sweeps unrelated mappings. It returns a present unreferenced object to its inbox path and never deletes source files.
- There is no resource ownership registry, full orphan-mapping scan, or restart-durable cleanup queue. Business persistence is authoritative; any post-commit release retry is deliberately bounded best effort.
- Business persistence, release, fingerprinting, and rematch targets require stable object mappings; neither kind of temporary mapping can be persisted, released, fingerprinted, or targeted for rematch. Materialization and rematch candidates explicitly require present `inbox/` mappings. Ignore, unignore, release, and rematch batch mutations accept at most 256 selected paths. `POST /api/resources/ignore` accepts one or more `virtualPaths`, and it and `POST /api/resources/unignore` validate and commit their selected temporary mappings atomically; unignore applies only to present ignored mappings.
- `POST /api/resources/release` is explicit: each path must be a mapped, stable object, present in the current RFG catalog, and unreferenced. It also never deletes a local source file. A missing, referenced, temporary, or stale selection is rejected.
- Rematch accepts a stable object target (present or missing) and a distinct, present inbox candidate; it preserves the target virtual path while swapping its local source. Targets/candidates must be unique. Rebinding clears target hash metadata; auto rematch restores only hashes verified against the selected new source. A rebound target that remains business-referenced and stored no content hash is queued a full fingerprint run (fingerprinting is scoped to business-referenced stable objects).
- Fingerprinting accepts currently cataloged stable object paths referenced by a saved flight **or an airline logo**. Content hashes are available for any such current source; perceptual hashes are restricted to `.avif`, `.bmp`, `.gif`, `.jpeg`/`.jpg`, `.png`, and `.webp`. Manual single- and multi-resource runs are incremental by default (targets already storing every selected algorithm are skipped); the review dialog offers an explicit force-overwrite option. Pending inbox candidates may be hashed transiently for batch rematch comparison, but no fingerprint metadata is stored on either temporary mapping kind.
- Automatic image fingerprinting and `POST /api/resources/fingerprints` use one process-local, single-worker FIFO queue. The POST validates its body, reviewed mapping ETag and eligibility, then returns `202` with a task snapshot without hashing inline. Queue scheduling remains ephemeral and is never replayed after restart. Status and result history is append-only JSONL in `<RFG_DATA_DIR>/flightarchive/log/task/<UTC creation day>.jsonl`; all later updates stay in the creation-day file. IDs use `task-<compact UTC timestamp with microseconds>-<random suffix>`. Before persistence, the worker captures and revalidates mapping/local-source and RFG source ETags, so a hash for an old source fails rather than being stored on a replacement mapping.

## Operations

| Trigger / API | Mapping effect | Business/cache consequence |
| --- | --- | --- |
| `GET /api/resources/review` | none (pure read) | return the mapping revision and authoritative mapping/catalog/business-use join without an RFG write |
| `POST /api/resources/reconcile` | catalog new sources into inbox; remove stale temporary inbox/ignore entries; preserve missing object mappings | reconcile disposable bindings, discard stale bindings, and return the same snapshot shape as review |
| Create/update flight or airline with inbox relation | materialize once to a named object path | only inbox may materialize; ignored mappings are never persisted |
| Flight mutation, catalog merge-upsert (`PUT /api/catalogs/{kind}/{key}`), catalog delete command (`POST /api/catalogs/{kind}/delete`), or reset | after successful business transaction, release eligible former candidates | retain if still referenced; invalidate affected flight previews |
| `POST /api/resources/release` | selected eligible object -> inbox | clears fingerprint metadata on renamed entry and rebinds generic thumbnail |
| `POST /api/resources/ignore` | selected present inbox entries -> ignore | all-or-nothing mapping-only hide; request is `{ifMatch, virtualPaths}` |
| `POST /api/resources/unignore` | selected present ignore entries -> inbox | all-or-nothing mapping-only restore; clears temporary fingerprint metadata and rebinds generic thumbnail where possible |
| `POST /api/resources/rematch` (`mode: "explicit"`) | each selected stable target (present or missing) takes its specified candidate's local source; candidate inbox entries are consumed once | preflights the complete unique target/candidate set, performs one mapping PUT and cache rebind/discard, then queues a full fingerprint run for each business-referenced rebound target that stored no content hash |
| `POST /api/resources/rematch` (`mode: "auto"`) | compares selected inbox files to the target missing mappings on every selected field and applies only unambiguous one-to-one matches; unmatched or multiply-matched targets are skipped | optional `targetVirtualPaths` limits the reviewed missing subset; candidate hashes are computed by the backend and remain transient; business-referenced matches that stored no content hash queue a full fingerprint run |
| `POST /api/resources/fingerprints` | validates then enqueues requested RFG hashes for eligible, present stable business resources; returns `202` task snapshot | temporary mappings are ineligible; status/result snapshots are appended to the task log and read through `GET /api/tasks` |

Mutation wire shapes are intentionally compact:

- `ignore`: `{ifMatch, virtualPaths: string[]}` -> `{ignored: string[], count, revision}`.
- `unignore`: `{ifMatch, virtualPaths: string[]}` -> `{restored: string[], count, revision}`.
- `release`: `{ifMatch, virtualPaths: string[]}` -> `{released: string[], revision}`.
- explicit `rematch`: `{ifMatch, mode: "explicit", matches: [{targetVirtualPath, candidateInboxVirtualPath}]}` -> `{applied, ambiguous, unmatched, revision}`.
- automatic `rematch`: `{ifMatch, mode: "auto", candidateInboxVirtualPaths, targetVirtualPaths?, algorithms}` -> the same rematch response. `algorithms` may contain stored content/perceptual fingerprints plus `filename` and `sizeBytes`; candidate values are always derived server-side.
- `fingerprints`: `{ifMatch, virtualPaths, algorithms}` -> `202 {task}`.

Catalog deletion is also a single compact command: `POST /api/catalogs/{kind}/delete` accepts `{keys, force?}`. Single-row deletion sends one key in the array; preflight and business mutation are atomic, and resource release remains post-commit best effort under the rules above. Catalog creation/update uses the keyed merge-upsert `PUT /api/catalogs/{kind}/{key}` so an unlisted flight code can become a catalog entry without a second creation route.

Product/frontend versions may change incompatibly and do not alter resource persistence semantics. Within a product major version, `<RFG_DATA_DIR>/flightarchive/v1/`, BusinessData and preview-config `schemaVersion`, embedded layout/electronic `schemaVersion`, and the upstream RFG `/api/v1/*` contract remain compatible.

## Picker behavior

The resource screens consume the review snapshot directly through a shared browser core (`useResourceBrowser` + `ResourceBrowser`). It reconciles once on each closed-to-open edge so newly discovered files can enter Pending, then uses read-only review refreshes after mutations. It does not read raw mapping/catalog/business records or rebuild usage in the browser. Ignored mappings remain non-selectable temporary entries. The form picker shell (`ResourcePickerDialog`) lists inbox pending first, then mapped/associated entries, and hides the rest; automatic rematch (`AutoRematchDialog`) and manual rebind show inbox candidates only.

## Review snapshot

`GET /api/resources/review` and successful `POST /api/resources/reconcile` both return `{revision, rows}`. Each row has camel-case `virtualPath` (null only for `local_only`), `localPath`, `state`, `present`, `sizeBytes`, stored fingerprint algorithm names, detailed `uses`, and `capabilities`. States are `mapped`, `pending`, `ignored`, `missing`, and `local_only`.

Flight uses include `id`, `airlineCode`, `flightNumber`, `departureDate`, and the precise boarding-pass/attachment `role`; airline uses include `code` and a `horizontal`, `horizontal-dark`, or `symbol` role. This index is also the source for the existing persistent-reference set, so release and fingerprint ownership checks do not maintain a second ownership implementation.

Capabilities are computed by the backend: `release` requires a present stable object with no uses; `fingerprint` requires a present stable object with at least one use; `rematchTarget` requires a missing stable object; `rematchCandidate` and `ignore` require a present inbox row; and `unignore` is confined to ignored rows. Review does not reconcile, clean up, persist business data, or write the RFG mapping.

- **Pending** inbox mappings with a present local source remain selectable.
- **Present mapped** object mappings remain selectable and shareable, including mappings already used by flights or airline logos.
- **Missing object** mappings remain visible as error-status **Source missing** entries so their retained object path can be reviewed and rematched. They use an unavailable file placeholder, do not load thumbnails, and cannot be newly selected by pointer or keyboard. A missing path that was already selected when the dialog opened is retained, allowing the existing value to be viewed or left unchanged.
- Picker inventory is loaded on each closed-to-open transition. The initial selection is snapshotted at that edge, so parent rerenders and language changes while the dialog is open do not reload inventory or reset temporary selection, search, or pagination state. Closing the dialog cancels its in-flight reads, and only the latest opening may publish a response.

## Concurrency, ETags, and failures

Reviewed resource-mapping writes (`ignore`, `unignore`, `release`, `rematch`, and `fingerprints`) require a string `ifMatch` equal to RFG's current `/api/v1/meta/map` ETag; null, omitted, or stale values are conflict/retry conditions. A missing RFG ETag is an availability failure. Mapping writes send that revision as `If-Match`. Successful `ignore`, `unignore`, `release`, and `rematch` responses contain only operation results plus `revision`, never raw `mapping` or `localFiles`; fingerprints remains a `202` task response. The lock order is `business_lock` before lifecycle mapping lock and workspace lock. It prevents a business reference from being acquired between release ownership check and map write; manual release waits for the same business critical section.

The frontend treats `revision` as a coarse review lock. A shared `useResourceReview` request lifecycle exposes snapshot/loading/error/revision, aborts reads when its consumer closes or unmounts, and allows only the latest request to publish. Both resource screens render backend `uses` and obey backend `capabilities`; they do not repeat the mapping/catalog join, usage indexing, or action-eligibility rules. On `409` the mappings page clears all reviewed actions, replaces the actionable view with a fresh review load, and emits one shared warning asking the user to review and retry; it does not merge or replay stale selections. A committed mutation is never retried merely because the subsequent display refresh failed.

A successful RFG mapping `PUT` is the commit point. RFG currently omits the new ETag from that response, so FlightArchive reuses its preflight catalog and retries the required mapping refresh once (two attempts total). If both reads fail, the mapping remains committed and the API returns `503 resource-committed-refresh-failed`; `error.details.committed` is true and operation-specific result fields identify what was applied. Clients must refresh to confirm rather than retrying the mutation blindly. If RFG supplies a PUT ETag in the future, the committed document and that ETag are returned without a trailing mapping read.

The business transaction rolls back in-memory domain state if atomic BusinessData persistence fails. Newly materialized paths are then best-effort released. Conversely, after a business mutation has succeeded, release failure does **not** undo it: only that mutation's stable-object candidates are queued in `deferred_releases` and retried on the next resource reconciliation. Missing sources, surviving references, temporary paths, and absent mappings are final non-retry outcomes. `deferred_releases` is process-local and is intentionally not restored after restart; the resource page and later reconciliation operations remain the recovery path.

Task-log reads are serialized with appends inside one backend process. `GET /api/tasks` defaults to the newest three existing log dates and supports `before=<YYYY-MM-DD>&limitDays=<1..30>`; it returns `{days, nextCursor, hasMore}` and skips dates with no file. If the latest status for a task is `queued` **or** `running` but that task ID is absent from the current process's active registry, the read atomically appends a failed `task_interrupted` status and a result before returning it. Repeated reads do not append duplicates, and an incomplete trailing JSONL line is ignored. This is crash accounting, not work replay. The supported deployment is a single backend process; automatic log retention/deletion is intentionally deferred.

## Cache behavior

All cache state is disposable and lives outside BusinessData.

- `GET|HEAD /images/{virtual_path}` stores generic WebP thumbnail objects by rendered bytes and binds them to `(virtual_path, local_path, RFG source ETag, render profile)`. Materialize/release moves the generic binding to the new virtual path when possible; no re-render is required. Source replacement, external mapping change, missing source, or profile change invalidates it.
- Boarding-pass preview is a separate `preview/<flight>/<slot>/<geometry>` binding. `GET /api/flights/{id}/boarding-passes/{slot}/preview` renders a bounded upright rectangular crop from canonical center/size/rotation fields, not a generic thumbnail. It accepts only `paperBoardingPassFront` and `paperBoardingPassBack`; an electronic slot is rejected with `404 boarding-pass-slot-not-found`. Electronic layouts have no server crop preview in the archive/detail UI. Paper rendering maps output pixels directly to oriented source coordinates, so an in-bounds rotated rectangle remains valid even near a source edge; do not implement it as whole-image rotation followed by crop. Legacy corners are ignored by rendering and geometry cache identity. Update, delete, reset, and resource reconciliation remove affected derived previews.
- Both paths fetch original bytes through RFG `/res/*`, enforce configured byte and pixel limits, share the app-local thumbnail miss limiter, and return WebP ETags. No cache row grants filesystem access.
- Generic `GET|HEAD /images/{virtual_path}` JPEG thumbnails ask Pillow for a decoder DCT draft targeting twice `maxDimension` before the configured pixel limit is checked. This can safely render a large JPEG when the decoder supplies a sufficiently small draft; other formats do not receive that path. Paper rectangular previews do **not** use JPEG drafting: they check the full decoded image dimensions against the configured pixel limit and reject an oversized JPEG before crop sampling.

## Source pointers and APIs

- Lifecycle implementation/helpers: `app/backend/flightarchive/routes/api.py` (`ResourceLifecycleService`, `resource_review_snapshot`, `persistent_business_resource_uses`, `persistent_business_resource_paths`, `_best_effort_release`, `ResourceOwner`, `generate_resource_name`).
- Cache and crop geometry: `thumbnails.py`; HTTP image serving: `routes/images.py`.
- Frontend mapping/release/rematch/fingerprint UI: `app/frontend/src/resources/` (`useResourceBrowser` + `ResourceBrowser`, `ResourcePickerDialog`, `AutoRematchDialog`, `ResourceMappingsPage`).
- Crop capture and geometry: `app/frontend/src/scanstudio/`.
- Contract tests: `app/backend/tests/test_resource_review.py`, `test_rfg_host.py`, and `test_thumbnails.py`.

Primary browser lifecycle endpoints are `GET /api/resources/review`, `POST /api/resources/reconcile`, `POST /api/resources/ignore`, `POST /api/resources/unignore`, `POST /api/resources/rematch`, `POST /api/resources/release`, `POST /api/resources/fingerprints`, and `GET|HEAD /images/{virtual_path}`. The host still uses RFG's internal mapping/catalog and `/res/{virtual_path}` APIs, but resource review screens do not call those raw metadata endpoints.
