// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** API DTO types mirroring the backend JSON payloads. */

import type { HashAlgorithm } from '../rfg/api';

// Domain DTOs live with the pure frontend domain. Re-exporting preserves all
// existing UI imports while keeping API-only resource/task types in this file.
export type {
  AircraftType, Airline, Airport, BrandColors, Catalogs,
  ElectronicBoardingPassPresentation, FlightRecord, HexColor, PaperBoardingPassLayout,
} from '../domain/types';

export interface WorkspaceStatus {
  persistence: {
    mode: 'named-json-documents';
    writable: boolean;
    persistenceError: string | null;
  };
  archiveState: 'missing' | 'ready' | 'migration-failed';
  activityRevision: string | null;
}

export interface StatusResponse {
  status: WorkspaceStatus;
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

// ---- domain-neutral named JSON documents and activity ----

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ArchiveSummary {
  appId: string;
  documents: string[];
}

export interface ArchiveDocumentList {
  documents: string[];
}

export interface ActivitySubmission {
  source: string;
  kind: string;
  severity: string;
  state: string;
  code: string;
  details: JsonValue;
}

export interface ActivityRecord extends ActivitySubmission {
  id: string;
  createdAt: string;
}

export interface ActivityDay {
  date: string;
  activities: ActivityRecord[];
}

export interface ActivityPageResponse {
  days: ActivityDay[];
  nextCursor: string | null;
  hasMore: boolean;
  revision: string | null;
}

export type ListActivityParams = ListTasksParams;
