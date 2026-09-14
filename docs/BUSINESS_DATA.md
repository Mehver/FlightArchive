# BusinessData contract

## Durable files and boundaries

| Path | Role | Lifecycle |
| --- | --- | --- |
| `<RFG_DATA_DIR>/flightarchive/v1/business-data.json` | FlightArchive business source of truth | atomically written after each successful business mutation |
| `<RFG_DATA_DIR>/rfg/mapping.json` | RFG mapping state, not BusinessData | owned by RFG / lifecycle service |
| `<RFG_DATA_DIR>/flightarchive/v1/preview-config.json` | strict restart-only rendering configuration | seeded if absent; invalid existing file aborts startup |
| `FLIGHTARCHIVE_CACHE_DIR/thumbnails/thumbnails.sqlite3` | derived WebP objects and bindings | disposable; never business data |

There is no browser-durable business persistence and no snapshot import/export API. The frontend build is image content, not data-volume content.

On first startup without a local business-data file, FlightArchive seeds its version-controlled catalogs. The airline seed includes a curated conversion of the legacy workspace airline list (names, codes, alliances, and theme colors) and retains useful current-only airlines. Legacy flights, layouts, settings, resource mappings, paths, and logo references are not imported; all seeded logo resource fields, including dark variants, are null.

## Top-level schema

`schemaVersion: 1` is supported. A document must contain arrays `airlines`, `airports`, `aircraftTypes`, `flights`, and object `settings`. Missing, future, boolean, or non-object versions are rejected. The persistence whitelist emits exactly those fields plus `schemaVersion`.

Schema 1 is deliberately a breaking local-data contract: retired fields and compatibility aliases are rejected rather than migrated. An incompatible file must be corrected or replaced before it can be loaded; FlightArchive does not silently reinterpret legacy business data.

Local source paths and legacy/local asset fields (`local_path`, `*AssetId`, `*AssetIds`, `assetTags`), retired flight `status`, and former flat airline color keys are forbidden anywhere in the document. Resource relations are safe RFG **virtual paths**, not source bytes or filesystem paths.

## Entity shape and resource relations

- **Airline:** IATA `code` (2–3 uppercase letters/digits), optional ICAO designator (exactly 3 uppercase letters), display/reference fields, and nullable `alliance`. `null` means no alliance; a non-null name is the airline's alliance. The UI may suggest values already stored in the current catalog, but suggestions do not restrict the stored name. There is no separate "other" alliance field. It also has nullable exactly three nullable logo slots: `horizontalLogoResourcePath`, `horizontalDarkLogoResourcePath`, and `symbolLogoResourcePath`. Its `brandColors` object always groups the nullable paired `primary` and `contrast` 6-digit uppercase hex colors. The first two are the light- and dark-theme horizontal logos: either may be absent, in which case the display uses the other. `symbolLogoResourcePath` is the single square-fitted symbol logo and supports PNG and SVG; there are no tail or theme-specific symbol slots.
- **Airport:** IATA `code` (3–4 uppercase letters), optional ICAO designator (exactly 4 uppercase letters), name/city/country fields, and `terminals`. Terminals are maintained exclusively by the airport catalog tag editor. Flight forms only select catalog suggestions; they never create or amend catalog terminals. A persisted flight terminal outside the current catalog remains an editable flight value, but is not promoted into the suggestions.
- **Aircraft type:** ICAO designator (2–4 uppercase letters/digits), optional IATA designator (exactly 3 uppercase letters/digits), nullable `manufacturer`, and `displayName`. `null` means no manufacturer; a non-null name is stored directly. The UI may suggest values already stored in the current catalog, but suggestions do not restrict the name. There is no separate "other" field. Aircraft type designators are intentionally not governed by airport or airline ICAO widths.
- **Flight:** identity/route/date/time/aircraft/registration/seat/tags/notes/ timestamps and nullable `boardingPassColor` (a 6-digit uppercase hex string, e.g. `#E60012`), plus nullable `paperBoardingPassFrontResourcePath`, `paperBoardingPassBackResourcePath`, `electronicBoardingPassResourcePath`, and deduplicated `attachmentResourcePaths` (at most 32).

Any one stable object path may be referenced by multiple flight slots, attachments, flights, and airline-logo slots. Ownership is therefore computed globally, not per record. Pending `inbox/...` paths are valid only while a form is being validated/materialized; persisted successful relations use the stable object path. Every persisted relation, including airline-logo relations, makes an available object eligible for the standard RFG fingerprint set. See [`RESOURCE_LIFECYCLE.md`](RESOURCE_LIFECYCLE.md).

`brandColors` is deliberately an object rather than two prefixed airline fields: it keeps the visual-identity pair adjacent in both API responses and on-disk JSON. Serializers preserve their documented business-field order (and emit `primary` before `contrast`) rather than alphabetizing nested objects. Airport bilingual fields, aircraft identifiers/manufacturer fields, flight operational fields, boarding-pass metadata, attachments, and RFG resource references remain flat where their existing order already makes their owning entity and relationship clear. No compatibility aliases are read: documents using former fields or unsupported aircraft-type fields are invalid for this schema.

`boardingPassColor` is specific to an individual flight's boarding pass. It is not an airline brand color: `brandColors.primary` and `brandColors.contrast` remain the airline catalog's paired visual-identity fields. The electronic-pass studio defaults it to the small average sampled at the selected crop centre; the user can replace that value by clicking a source pixel or entering hex. Former paired flight color fields are invalid and are not migrated or read.

## Reference catalog and identifier semantics

Catalog entries are optional enrichment for the codes already stored on each flight. A flight may therefore contain a valid airline, airport, or aircraft type code that does not yet have a catalog entry; catalog deletion also leaves the stored flight code intact.

The reference-library UI derives an unlisted row for such a flight code rather than silently creating a durable catalog record. Derived rows are sorted before persisted rows, carry the unlisted note, and cannot be selected or deleted. Editing and saving one uses the normal `PUT /api/catalogs/{kind}/{key}` upsert, after which it becomes an ordinary catalog entry. Its count is calculated from flights: one airline reference per flight, one airport reference when departure and arrival are the same airport, otherwise one of each, and one aircraft-type reference when present. Flight data is loaded independently: unavailable flight data yields unavailable counts and no derived rows, never misleading zeroes.

`registration` is an optional flight string, not a fleet entity or catalog relation. It is trimmed and uppercased, and must be 2–16 ASCII letters/digits with optional single internal hyphens; this admits common international forms such as `B1234`, `G-ABCD`, and `N123AB` without imposing a country-specific scheme. There is no automatic hyphen insertion, registry lookup, or durable group model. Any screen that needs an aircraft-type or registration grouping derives it from `aircraftTypeIcao` and `registration` on the flight records.

## Boarding-pass layout metadata

`flight.paperBoardingPassLayouts` is an image-free object keyed only by `paperBoardingPassFront` and `paperBoardingPassBack`. A paper slot layout requires that slot's resource relation and has exact v1 fields: `schemaVersion`, `algorithm`, `crop`, `templateId`, and `placement`.

`flight.electronicBoardingPass` is optional derived presentation data for the electronic resource. It has v1 `schemaVersion` and optional `extraction` (`crop` and `presetName`).

- Algorithms: `adaptive`, `canny`, `sobel`, or `laplacian`.
- `crop` stores bounded finite center/size/rotation values. Those summary fields are canonical; source-image bounds are checked when the image is available, and inclusive right/bottom source edges are accepted. Positive angles are clockwise in canvas/source coordinates. Frontend normalization rounds summaries to two decimals unless doing so would move an otherwise valid edge-adjacent rectangle outside its source bounds.
- Legacy `corners?: {x, y}[]` remain readable compatibility data but are ignored by validation, rendering, preview cache identity, and the frontend editor. New layouts omit them.
- `templateId` is a safe `.svg` filename. `placement` stores bounded scale, rotation, and normalized offsets.
- Replacing a paper slot resource removes that paper layout; replacing the electronic resource removes its presentation data. Updating/deleting/resetting a flight invalidates that flight's derived previews.

The exact parser, serializer, and validation limits are in `app/backend/flightarchive/business_data.py` and `domain/models.py`; frontend crop capture is `app/frontend/src/scanstudio/`. The crop worker and backend paper-preview endpoint both perform a rectangular source-coordinate sample; neither retains a perspective-correction path. The worker uses native rounded crop dimensions; the backend may proportionally downscale only the disposable paper-preview WebP to its configured `maxDimension`. The paper preview endpoint supports only paper slots. Electronic-pass presentation is separate metadata; the archive and detail UI do not request an electronic crop preview. A prepared electronic pass is shown as a saved-layout state with a non-image file marker, rather than being presented as a crop preview.
