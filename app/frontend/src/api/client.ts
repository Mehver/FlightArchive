// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Typed API client. All endpoints live under /api (proxied in dev). */

import type {
  Catalogs,
  FlightRecord,
  ResourceFingerprintsRequest,
  ResourceFingerprintsResponse,
  ResourceIgnoreRequest,
  ResourceIgnoreResponse,
  ResourceBatchRematchesRequest,
  ResourceBatchRematchesResponse,
  ResourceLocalFile,
  ResourceRematchesRequest,
  ResourceRematchesResponse,
  ResourceReleaseRequest,
  ResourceReleaseResponse,
  TaskRecord,
  WorkspaceStatus,
} from './types';

export class ApiError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, 'network', 'network');
  }
  if (!response.ok) {
    let code = 'http-error';
    let message = 'http-error';
    let details: unknown;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string; details?: unknown } };
      if (body.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
        details = body.error.details;
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(response.status, code, message, details);
  }
  return (await response.json()) as T;
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

async function businessMutation<T>(operation: Promise<T>): Promise<T> {
  return operation;
}

/** URL of the server-rendered upright rectangular WebP preview for a prepared
 * paper boarding-pass slot (GET /api/flights/{flightId}/boarding-passes/{slot}/preview).
 * Electronic-pass presentation has no endpoint preview. Both path parameters
 * are percent-encoded. */
export function boardingPassPreviewUrl(
  flightId: string,
  slot: 'paperBoardingPassFront' | 'paperBoardingPassBack',
): string {
  return `/api/flights/${encodeURIComponent(flightId)}/boarding-passes/${encodeURIComponent(slot)}/preview`;
}

export const api = {
  // ---- workspace ----
  status: (signal?: AbortSignal) => request<{ status: WorkspaceStatus; app: string; version: string }>('/workspace/status', { signal }),

  // ---- flights ----
  listFlights: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return request<{ flights: FlightRecord[] }>(`/flights${qs ? `?${qs}` : ''}`);
  },
  createFlight: (flight: Partial<FlightRecord>) => businessMutation(request<{ flight: FlightRecord }>('/flights', jsonInit('POST', flight))),
  updateFlight: (id: string, flight: Partial<FlightRecord>) =>
    businessMutation(request<{ flight: FlightRecord }>(`/flights/${encodeURIComponent(id)}`, jsonInit('PUT', flight))),
  deleteFlight: (id: string) => businessMutation(request<{ deleted: string }>(`/flights/${encodeURIComponent(id)}`, jsonInit('DELETE'))),

  // ---- catalogs ----
  getCatalogs: () => request<Catalogs>('/catalogs'),
  createCatalogEntry: (kind: string, entry: unknown) =>
    businessMutation(request<{ entry: unknown }>(`/catalogs/${kind}`, jsonInit('POST', entry))),
  updateCatalogEntry: (kind: string, key: string, entry: unknown) =>
    businessMutation(request<{ entry: unknown }>(`/catalogs/${kind}/${encodeURIComponent(key)}`, jsonInit('PUT', entry))),
  deleteCatalogEntry: (kind: string, key: string, force = false) =>
    businessMutation(request<{ deleted: string }>(
      `/catalogs/${kind}/${encodeURIComponent(key)}${force ? '?force=true' : ''}`,
      jsonInit('DELETE'),
    )),
  // Batch deletion is all-or-nothing on the server: a non-forced request
  // that hits referenced entries fails with the standard 409 and deletes
  // nothing, exactly like the single-key route.
  deleteCatalogEntries: (kind: string, keys: string[], force = false) =>
    businessMutation(request<{ deleted: string[] }>(`/catalogs/${kind}`, jsonInit('DELETE', { keys, force }))),

  // ---- RFG resources ----
  syncResources: () => request<{ cataloged: number; added: number }>('/resources/sync', jsonInit('POST', {})),

  // ---- RFG resource mappings ----
  getResourceCatalog: () => request<{ localFiles: ResourceLocalFile[] }>('/resources/catalog'),
  createResourceRematches: (payload: ResourceRematchesRequest) =>
    businessMutation(request<ResourceRematchesResponse>('/resources/rematches', jsonInit('POST', payload))),
  ignoreResource: (payload: ResourceIgnoreRequest) =>
    businessMutation(request<ResourceIgnoreResponse>('/resources/ignore', jsonInit('POST', payload))),
  createResourceBatchRematches: (payload: ResourceBatchRematchesRequest) =>
    businessMutation(request<ResourceBatchRematchesResponse>('/resources/batch-rematches', jsonInit('POST', payload))),
  // Release is a mapping mutation: it returns eligible object mappings to inbox.
  releaseResources: (payload: ResourceReleaseRequest) =>
    businessMutation(request<ResourceReleaseResponse>('/resources/release', jsonInit('POST', payload))),
  // Server-authorized fingerprints for persisted business-bound object resources.
  // The mapping ETag must be forwarded; a 409 means the reviewed mapping is
  // stale and the view has to be reloaded before retrying.
  calculateResourceFingerprints: (payload: ResourceFingerprintsRequest) =>
    businessMutation(request<ResourceFingerprintsResponse>('/resources/fingerprints', jsonInit('POST', payload))),

  // ---- background tasks (read-only status) ----
  listTasks: () => request<{ tasks: TaskRecord[] }>('/tasks'),

};
