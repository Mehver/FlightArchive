// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** API DTO types mirroring the backend JSON payloads. */

import type { HashAlgorithm, MappingDocument } from '../rfg/api';

export interface FlightRecord {
  id: string;
  flightNumber: string;
  airlineCode: string;
  departureAirport: string;
  arrivalAirport: string;
  departureTerminal: string | null;
  arrivalTerminal: string | null;
  departureDate: string;
  departureTime: string | null;
  arrivalTime: string | null;
  aircraftTypeIcao: string | null;
  registration: string | null;
  seat: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
  paperBoardingPassFrontResourcePath: string | null;
  paperBoardingPassBackResourcePath: string | null;
  electronicBoardingPassResourcePath: string | null;
  attachmentResourcePaths: string[];
  paperBoardingPassLayouts?: Partial<Record<'paperBoardingPassFront' | 'paperBoardingPassBack', PaperBoardingPassLayout>>;
  electronicBoardingPass?: ElectronicBoardingPassPresentation | null;
  /** Optional single color sampled from or selected for this boarding pass. */
  boardingPassColor: HexColor | null;
}

export interface PaperBoardingPassLayout {
  schemaVersion: 1;
  algorithm: 'adaptive' | 'canny' | 'sobel' | 'laplacian';
  crop: {
    centerX: number;
    centerY: number;
    width: number;
    height: number;
    rotationDegrees: number;
    /** Legacy source points are readable for compatibility but ignored. */
    corners?: { x: number; y: number }[];
  };
  templateId: string;
  placement: { scale: number; rotationDegrees: number; offsetX: number; offsetY: number };
}

export interface ElectronicBoardingPassPresentation {
  schemaVersion: 1;
  extraction?: {
    crop: {
      centerX: number;
      centerY: number;
      width: number;
      height: number;
      mirrorAcrossImageCenterX: boolean;
    };
    presetName?: string;
  };
}

/** A 6-digit uppercase hex colour string, e.g. ``"#E60012"``. */
export type HexColor = `#${string}`;

export interface Airline {
  code: string;
  icao: string;
  nameZh: string;
  nameEn: string;
  /** Null means no alliance; any name may be a common or custom alliance. */
  alliance: string | null;
  horizontalLogoResourcePath: string | null;
  horizontalDarkLogoResourcePath: string | null;
  symbolLogoResourcePath: string | null;
  brandColors: BrandColors;
}

/** The airline's paired visual identity colors. */
export interface BrandColors {
  primary: HexColor | null;
  contrast: HexColor | null;
}


export interface Airport {
  code: string;
  icao: string;
  nameZh: string;
  nameEn: string;
  cityZh: string;
  cityEn: string;
  countryZh: string;
  countryEn: string;
  terminals: string[];
}

export interface AircraftType {
  icao: string;
  iata: string;
  /** Null means no manufacturer; any name may be a suggested or custom value. */
  manufacturer: string | null;
  displayName: string;
}

export interface Catalogs {
  airlines: Airline[];
  airports: Airport[];
  aircraftTypes: AircraftType[];
}

export interface StatusCounts {
  flights: number;
  airlines: number;
  airports: number;
  aircraftTypes: number;
}

export interface WorkspaceStatus {
  persistence: {
    mode: 'local';
    schemaVersion: number;
    writable: boolean;
    loaded: boolean;
    persistenceError: string | null;
  };
  counts: StatusCounts;
}


// ---- resource mappings ----

/** One file in RFG's current local catalog (GET /api/resources/catalog). */
export interface ResourceLocalFile {
  local_path: string;
  size_bytes?: number | null;
}

/**
 * One retained rematch: keep the existing object-ID target virtual path
 * and replace its missing local source with a new inbox candidate's file.
 * Virtual paths are never edited or re-planned by this operation.
 */
export interface ResourceRematch {
  targetVirtualPath: string;
  candidateInboxVirtualPath: string;
}

export interface ResourceRematchesRequest {
  /** ETag captured when the reviewed mapping was read; null when RFG sent none. */
  ifMatch: string | null;
  matches: ResourceRematch[];
}

/**
 * Response concept for POST /api/resources/rematches: the refreshed mapping
 * document, refreshed local catalog, and the new mapping ETag. The page
 * still reloads through the read routes after applying, so consumers do not
 * depend on this body's exact shape while the endpoint is finalized.
 */
export interface ResourceRematchesResponse {
  applied: number;
  mapping: MappingDocument;
  localFiles: ResourceLocalFile[];
  etag: string | null;
}

export interface ResourceIgnoreRequest {
  ifMatch: string | null;
  virtualPath: string;
}

export interface ResourceIgnoreResponse {
  ignoredVirtualPath: string;
  mapping: MappingDocument;
  localFiles: ResourceLocalFile[];
  etag: string | null;
}

/**
 * POST /api/resources/release request. This mutation returns unreferenced,
 * present object mappings to pending inbox paths; missing mappings remain
 * available for rematching.
 */
export interface ResourceReleaseRequest {
  ifMatch: string | null;
  virtualPaths: string[];
}

export interface ResourceReleaseResponse {
  released: string[];
  mapping: MappingDocument;
  localFiles: ResourceLocalFile[];
  etag: string | null;
}

// ---- resource fingerprints (server-authorized hash calculation) ----

/**
 * POST /api/resources/fingerprints request. Only non-inbox objects referenced
 * by persisted flight boarding-pass or attachment fields, or airline-logo
 * fields, are eligible; pending or unreferenced entries are rejected (422) and
 * inbox entries are never hashed. ETag mismatches are surfaced as 409.
 */
export interface ResourceFingerprintsRequest {
  /** ETag captured when the reviewed mapping was read; null when RFG sent none. */
  ifMatch: string | null;
  virtualPaths: string[];
  algorithms: HashAlgorithm[];
}

/** Terminal per-(resource, algorithm) outcome of a fingerprint run. */
export interface ResourceFingerprintResult {
  virtualPath: string;
  algorithm: HashAlgorithm;
  status: 'succeeded' | 'failed';
  /**
   * Success: `computed` | `reused`. Failure: `source_stale`,
   * `changed_during_hash`, `unsupported_image`, `image_too_large`,
   * `hash_failed`, `capacity_exceeded` or `rfg_unavailable`.
   */
  code: string;
  value: string | null;
  /** Hash profile (e.g. `imagehash-8-v1` for perceptual hashes); null otherwise. */
  profile: string | null;
  /** True when the value was persisted onto the RFG mapping entry. */
  persisted: boolean;
}

export interface ResourceFingerprintsResponse {
  mapping: MappingDocument;
  etag: string | null;
  results: ResourceFingerprintResult[];
}

export interface ResourceBatchRematchesRequest {
  ifMatch: string | null;
  candidateInboxVirtualPaths: string[];
  algorithms: (HashAlgorithm | 'filename' | 'sizeBytes')[];
}

export interface ResourceBatchRematchesResponse extends ResourceRematchesResponse {
  ambiguous: string[];
  unmatched: string[];
}

// ---- background tasks (read-only status) ----

/** Lifecycle state shared by tasks and their per-item records. */
export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed';

/** One (virtual path, algorithm) unit of work inside a task. */
export interface TaskItemRecord {
  virtualPath: string;
  algorithm: HashAlgorithm;
  state: TaskState;
  /** Machine-readable terminal code (fingerprint vocabulary); null otherwise. */
  code: string | null;
  message: string | null;
}

/**
 * One background task returned by GET /api/tasks. The UI displays task status
 * read-only and does not mutate or clear tasks.
 */
export interface TaskRecord {
  id: string;
  kind: 'fingerprints';
  state: TaskState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  items: TaskItemRecord[];
}
