# BusinessData contract

## Durable layout

Business data is six JSON documents under `<RFG_DATA_DIR>/flightarchive/v2/`:

| Document | Content |
| --- | --- |
| `manifest.json` | fixed format marker |
| `flights.json` | array of flight records |
| `airlines.json` | array of airline catalog entries |
| `airports.json` | array of airport catalog entries |
| `aircraft-types.json` | array of aircraft-type catalog entries |
| `settings.json` | object of string settings |

The manifest is fixed and validated by the frontend before the other five documents are read:

```json
{
  "formatVersion": 1,
  "businessDataSchemaVersion": 1,
  "documents": ["flights.json", "airlines.json", "airports.json", "aircraft-types.json", "settings.json"]
}
```

`domain/archiveV2.ts` enforces the exact key set, both version numbers, and the exact document list and order. `aggregateBusinessData` combines the five documents and passes them through the schema v1 parser; `splitBusinessData` performs the inverse.

The browser owns the domain model and working state, while the backend archive is the durable canonical store. `domain/BusinessDataProvider.tsx` reads the manifest, then the five documents, and writes each document independently through `/api/archive/flightarchive/documents/{id}`. There are **no revisions, no conditional writes, no multi-document transactions, and no locks**: the backend store is opaque and atomic per file, and the browser coordinates cross-document consistency. A multi-document save can therefore be partial: failed data documents remain dirty and are reported for retry, the manifest is written only after all five data documents succeed, and a manifest write failure is reported separately even though those data-document writes completed.

## Backend store boundary

`app/backend/flightarchive/archive.py` is deliberately domain-neutral. It allowlists only the six names, treats each as opaque finite UTF-8 JSON, enforces a 16 MiB limit, rejects symlinks, and writes atomically. It exposes read/write/delete/list and a `missing | ready | migration-failed` state. It does not know about flights, catalogs, or schema versions. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the HTTP surface.

## Frontend schema

`domain/types.ts` defines the aggregate:

```ts
interface BusinessData {
  schemaVersion: 1;
  airlines: Airline[];
  airports: Airport[];
  aircraftTypes: AircraftType[];
  flights: FlightRecord[];
  settings: Record<string, string>;
}
```

`domain/schemaV1.ts:parseBusinessDataV1` validates a whole aggregate:

- `schemaVersion` must be exactly the integer `1`; the top-level key set is exact.
- The four collections must be arrays and `settings` an object. String keys are trimmed to 128 chars and string values to 4096; settings are sorted by key.
- Retired local/legacy fields are rejected anywhere in the document: `local_path`, `status`, `primaryBrandColor`, `contrastBrandColor`, `boardingPassPrimaryColor`, `boardingPassContrastColor`, `assetTags`, and any key ending in `AssetId`/`AssetIds`.
- Duplicate catalog keys (airline `code`, airport `code`, aircraft `icao`) and duplicate flight `id`s are last-wins; catalogs are sorted by key, flights by `(departureDate, departureTime, id)`.
- Persisted flights require an `id` and `createdAt`/`updatedAt`; import rejects records missing them rather than synthesizing identity.

`domain/commands.ts` holds pure mutations that never touch I/O: `createFlight`, `updateFlight`, `deleteFlight`, `upsertCatalogEntry`, `deleteCatalogEntries`, `updateSettings`. `BusinessDataProvider` applies a command to the in-memory aggregate and enqueues a save of only the affected document(s) (`flights.json`, the relevant catalog document, or `settings.json`).

## BusinessDataProvider persistence

- Each of the five documents has `{dirty, saving, pending, generation, error}` state.
- A command synchronously replaces the working aggregate, bumps the affected document generation, and enqueues an immutable snapshot write. Writes are serialized through one promise queue; a completed write only clears `dirty` when its generation is still current.
- `saveDocument`/`saveAll` join the queue and report per-document results. `saveAll` writes all five documents, and only when all five succeed writes `manifest.json`.
- `retryDocument` re-enqueues the current snapshot; `importBusinessData` parses and validates an aggregate, marks all five documents dirty, and then calls `saveAll`; `exportBusinessData`/`downloadBusinessData` serialize the in-memory aggregate; `reload({discardChanges})` refuses to overwrite dirty state unless explicitly granted and rejects a load that raced local edits.
- A failed document write is reported to `POST /api/activity` (source `frontend-business-data`, code `archive-document-save-failed`) and surfaced in the header chip; successes are not posted.
- `whenIdle()` resolves when the write queue drains.

## Entity shape and resource relations

- **Airline:** IATA `code` (2–3 uppercase letters/digits), optional ICAO (exactly 3 uppercase letters), `nameZh`/`nameEn`, nullable `alliance`, exactly three nullable logo slots (`horizontalLogoResourcePath`, `horizontalDarkLogoResourcePath`, `symbolLogoResourcePath`), and `brandColors: {primary, contrast}` of nullable 6-digit uppercase hex colors. A non-null alliance name is stored directly; `null` means none. Either horizontal logo may be absent; display falls back to the other. There is no tail or theme-specific symbol slot.
- **Airport:** IATA `code` (3–4 uppercase letters), optional ICAO (exactly 4 uppercase letters), bilingual name/city/country fields, and `terminals`. Terminals are edited in the catalog; flight forms only select catalog values.
- **Aircraft type:** ICAO (2–4 uppercase letters/digits), optional IATA (exactly 3 uppercase letters/digits), nullable `manufacturer`, and `displayName`. The allowed key set is exactly `{icao, iata, manufacturer, displayName}`.
- **Flight:** route/date/time/aircraft/registration/seat/notes/timestamps, nullable `boardingPassColor` (6-digit uppercase hex), the three nullable boarding-pass resource slots, and deduplicated `attachmentResourcePaths` (at most 32). `registration` is trimmed and uppercased and must be 2–16 ASCII letters/digits with optional single internal hyphens.

Every persisted resource relation is a **stable** RFG virtual path. `inbox/` and `ignore/` paths are temporary and are rejected for flights and airlines. One stable object may be shared by any number of flight slots, attachments, and airline logo slots; ownership is computed from the aggregate, not stored. See [`RESOURCE_LIFECYCLE.md`](RESOURCE_LIFECYCLE.md).

## Reference catalog semantics

Catalog entries are optional enrichment for the codes already on flights. A flight may carry a code with no catalog entry, and deleting a catalog entry never rewrites a flight.

- The keyed upsert is a frontend command (`upsertCatalogEntry`): the argument key is authoritative, submitted fields overwrite, omitted fields retain existing values, and a missing key is created from model defaults plus submitted fields. There is no backend catalog route.
- Catalog deletion (`deleteCatalogEntries`) deduplicates and uppercases 1–256 keys, rejects a missing key, and refuses to delete entries still referenced by flights unless `force` is set. With `force`, the catalog entries are removed and the flight codes remain.
- The reference UI derives unlisted rows for catalog-less flight codes. Such rows sort first, are not durably stored, and become ordinary entries when saved through the upsert command. Flight counts are derived from the loaded aggregate; if flights are unavailable the UI shows unavailable counts and derives no rows.

## Boarding-pass layout metadata

`flight.paperBoardingPassLayouts` is an image-free object keyed only by `paperBoardingPassFront` and `paperBoardingPassBack`. A paper layout requires that slot's resource and has exact v1 fields `schemaVersion`, `algorithm`, `crop`, `templateId`, `placement`:

- `algorithm`: `adaptive`, `canny`, `sobel`, or `laplacian`.
- `crop`: finite `centerX`, `centerY`, `width`, `height`, `rotationDegrees`. Positive angles are clockwise in source/canvas coordinates. Legacy `corners` remain readable but are ignored by validation, editing, rendering, and cache identity; new layouts omit them.
- `templateId`: a safe `.svg` filename.
- `placement`: bounded `scale`, `rotationDegrees`, `offsetX`, `offsetY`.

`flight.electronicBoardingPass` is optional presentation metadata with v1 `schemaVersion` and optional `extraction` (`crop`, `presetName`). Replacing a slot's resource removes its layout/presentation: `updateFlight` deletes a paper layout when that slot's resource changes and clears electronic presentation when the electronic resource changes.

There is no backend crop or boarding-pass preview endpoint. The backend's only image route is the domain-neutral, scale-only `/api/thumbnails` relay, which never receives crop or flight data. Crop rendering is browser-side: `resources/browserImageRenderer.ts` validates that the canonical rotated rectangle is fully in bounds and paints it upright from the relay thumbnail. See [`RESOURCE_LIFECYCLE.md`](RESOURCE_LIFECYCLE.md).

## Startup initialization, seed, and one-way v1 migration

`initialization.py` is intentionally isolated from the HTTP runtime: `server.create_app` does not import it. It owns the only copy of the built-in seed data and is invoked only by the launch entry points.

- `initialize_default_v2(data_root)` is the local-CLI path. If a valid `v2` exists it returns `existing`; if an invalid `v2` exists it returns `invalid-existing` and leaves it untouched; otherwise it publishes an atomic seed and never reads v1.
- `prepare_archive(data_root)` is the container path. It validates an existing `v2` first (never opening v1). Otherwise, if `v1/business-data.json` exists it reads and normalizes it, publishes the result, and retries at most twice. If migration still fails it falls back to the same seed initializer (`fallback-initialized` when the seed publishes, otherwise `migration-failed`) and records the single terminal outcome afterwards. It always returns a `BootstrapOutcome` rather than aborting.
- A published v2 is built in a unique sibling `v2.migrating-<hex>` directory, fsynced, compared against the expected aggregate, then renamed to `v2`. A post-rename fsync failure keeps the committed archive and reports it as committed.
- The dependency-injection handle `_publish` exists so tests can inject migration-write failures without changing the initializer.

### v1 is permanently preserved

The v1 source (`<RFG_DATA_DIR>/flightarchive/v1/business-data.json`) is read-only input. Its bytes and modification time are never changed, and it is never moved, renamed, or deleted. `legacy_v1.py` is a frozen, self-contained normalizer that must not import the retired domain/workspace/models code. `normalize_business_data_v1`:

- Requires `schemaVersion === 1`, the four collections as arrays, and `settings` as an object.
- Rejects legacy/local fields (`local_path`, `status`, flat color keys, `assetTags`, `*AssetId`/`*AssetIds`) rather than migrating them.
- Normalizes every record; an invalid record fails the whole document, so migration never silently drops entries.
- Rejects unsafe/absolute/backslash resource paths and `inbox/`/`ignore/` prefixes; keeps nullable logo and boarding-pass resource references.
- Returns the canonical persisted aggregate: catalogs sorted by key, flights by `(departureDate, departureTime, id)`, settings sorted. The seed is passed through this same normalizer so a fresh seed has the same shape the old store persisted.

### Seed content

The built-in seed is airline, airport, and aircraft-type catalogs only. It has no flights and empty settings. The airline seed merges a curated supplemental list with the selected legacy workspace airline names, alliances, and theme colors; all seeded logo resource fields are null. The seed is not shipped or evaluated by the frontend; it exists only in the isolated initializer.

### Migration bookkeeping

`prepare_archive` writes best-effort records under `<RFG_DATA_DIR>/flightarchive/migrations/`:

- `v1-to-v2.status.json` — latest outcome `{migration, state: "succeeded"|"failed", attempts, error, recordedAt}`.
- `v1-to-v2.log.jsonl` — append-only outcome history.

It also appends the terminal migration activity after the final outcome is known: `v1-to-v2-succeeded`, `v1-to-v2-failed`, or `v1-to-v2-failed-fallback-seeded` (migration failed but the seed fallback published; details include `noFlightsImported: true`). A committed migration whose final fsync failed additionally gets a `v1-to-v2-committed` warning before its `v1-to-v2-succeeded` note. Migration reporting never blocks startup; the feedback drawer localizes known migration codes.

`BootstrapOutcome` uses statuses `initialized`, `existing`, `invalid-existing`, `migrated`, `migration-failed`, and `fallback-initialized`, paired with an archive state of `missing`, `ready`, or `migration-failed`.
