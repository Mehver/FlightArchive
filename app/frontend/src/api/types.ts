// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** API DTO types mirroring the backend JSON payloads. */

import type { HashAlgorithm } from '../rfg/api';

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

export interface StatusResponse {
  status: WorkspaceStatus;
}

export interface CatalogDeleteRequest {
  keys: string[];
  force?: boolean;
}

export interface CatalogDeleteResponse {
  deleted: string[];
}


// ---- resource mappings ----

export type ResourceReviewState = 'mapped' | 'pending' | 'ignored' | 'missing' | 'local_only';

export type ResourceUse =
  | { kind: 'flight'; id: string; airlineCode: string; flightNumber: string; departureDate: string; role: 'paperBoardingPassFront' | 'paperBoardingPassBack' | 'electronicBoardingPass' | 'attachment' }
  | { kind: 'airline'; code: string; role: 'horizontal' | 'horizontal-dark' | 'symbol' };

export interface ResourceReviewCapabilities {
  ignore: boolean;
  unignore: boolean;
  release: boolean;
  fingerprint: boolean;
  rematchTarget: boolean;
  rematchCandidate: boolean;
}

/** Backend-authoritative mapping/catalog/business-use projection. */
export interface ResourceReviewRow {
  virtualPath: string | null;
  localPath: string;
  state: ResourceReviewState;
  present: boolean;
  sizeBytes: number | null;
  fingerprints: HashAlgorithm[];
  uses: ResourceUse[];
  capabilities: ResourceReviewCapabilities;
}

export interface ResourceReviewSnapshot {
  /** Current RFG mapping ETag, required by reviewed mutations. */
  revision: string;
  rows: ResourceReviewRow[];
}

export interface ResourceIgnoreRequest {
  ifMatch: string | null;
  virtualPaths: string[];
}

export interface ResourceIgnoreResponse {
  ignored: string[];
  count: number;
  revision: string;
}

/** Restore one or more current ignored temporary mappings to Pending inbox paths. */
export interface ResourceUnignoreRequest {
  ifMatch: string | null;
  virtualPaths: string[];
}

export interface ResourceUnignoreResponse {
  restored: string[];
  count: number;
  revision: string;
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
  revision: string;
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

/** POST enqueues a process-local task; GET /api/tasks is its terminal surface. */
export interface ResourceFingerprintsResponse {
  task: TaskRecord;
}

export interface ResourceExplicitRematchRequest {
  ifMatch: string | null;
  mode: 'explicit';
  matches: { targetVirtualPath: string; candidateInboxVirtualPath: string }[];
}

export interface ResourceAutoRematchRequest {
  ifMatch: string | null;
  mode: 'auto';
  candidateInboxVirtualPaths: string[];
  /** Optional reviewed subset of missing stable-object targets. */
  targetVirtualPaths?: string[];
  algorithms: (HashAlgorithm | 'filename' | 'sizeBytes')[];
}

export type ResourceRematchRequest = ResourceExplicitRematchRequest | ResourceAutoRematchRequest;

export interface ResourceRematchResponse {
  applied: number;
  ambiguous: string[];
  unmatched: string[];
  revision: string;
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

/** One UTC log-date group returned by the paginated task-history endpoint. */
export interface TaskDay {
  date: string;
  tasks: TaskRecord[];
}

/** GET /api/tasks log-day page. */
export interface TasksPageResponse {
  days: TaskDay[];
  /** Oldest date in this page when an earlier page exists. */
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ListTasksParams {
  /** Select existing log dates strictly earlier than this ISO calendar date. */
  before?: string;
  /** Number of existing log dates to return; the backend accepts 1–30. */
  limitDays?: number;
}
