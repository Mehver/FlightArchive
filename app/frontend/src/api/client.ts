// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Typed API client. All endpoints live under /api (proxied in dev). */

import type {
  Catalogs,
  CatalogDeleteRequest,
  CatalogDeleteResponse,
  FlightRecord,
  ResourceFingerprintsRequest,
  ResourceFingerprintsResponse,
  ResourceReviewSnapshot,
  ResourceIgnoreRequest,
  ResourceIgnoreResponse,
  ResourceRematchRequest,
  ResourceRematchResponse,
  ResourceReleaseRequest,
  ResourceReleaseResponse,
  ResourceUnignoreRequest,
  ResourceUnignoreResponse,
  ListTasksParams,
  TasksPageResponse,
  StatusResponse,
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
  status: (signal?: AbortSignal) => request<StatusResponse>('/status', { signal }),

  // ---- flights ----
  listFlights: (params: Record<string, string> = {}, signal?: AbortSignal) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return request<{ flights: FlightRecord[] }>(`/flights${qs ? `?${qs}` : ''}`, signal ? { signal } : undefined);
  },
  createFlight: (flight: Partial<FlightRecord>) => request<{ flight: FlightRecord }>('/flights', jsonInit('POST', flight)),
  updateFlight: (id: string, flight: Partial<FlightRecord>) =>
    request<{ flight: FlightRecord }>(`/flights/${encodeURIComponent(id)}`, jsonInit('PUT', flight)),
  deleteFlight: (id: string) => request<{ deleted: string }>(`/flights/${encodeURIComponent(id)}`, jsonInit('DELETE')),

  // ---- catalogs ----
  getCatalogs: (signal?: AbortSignal) => request<Catalogs>('/catalogs', signal ? { signal } : undefined),
  putCatalogEntry: (kind: string, key: string, entry: unknown) =>
    request<{ entry: unknown }>(`/catalogs/${kind}/${encodeURIComponent(key)}`, jsonInit('PUT', entry)),
  // This is the sole deletion command, including one-key deletion. The server
  // preflights the complete array, so conflicts and unknown keys delete nothing.
  deleteCatalogEntries: (kind: string, keys: string[], force = false) => {
    const payload: CatalogDeleteRequest = { keys, force };
    return request<CatalogDeleteResponse>(`/catalogs/${kind}/delete`, jsonInit('POST', payload));
  },

  // ---- RFG resource mappings ----
  getResourceReview: (signal?: AbortSignal) => request<ResourceReviewSnapshot>('/resources/review', signal ? { signal } : undefined),
  reconcileResources: (signal?: AbortSignal) => request<ResourceReviewSnapshot>('/resources/reconcile', { ...jsonInit('POST'), signal }),
  ignoreResource: (payload: ResourceIgnoreRequest) =>
    request<ResourceIgnoreResponse>('/resources/ignore', jsonInit('POST', payload)),
  unignoreResources: (payload: ResourceUnignoreRequest) =>
    request<ResourceUnignoreResponse>('/resources/unignore', jsonInit('POST', payload)),
  rematchResources: (payload: ResourceRematchRequest) =>
    request<ResourceRematchResponse>('/resources/rematch', jsonInit('POST', payload)),
  // Release is a mapping mutation: it returns eligible object mappings to inbox.
  releaseResources: (payload: ResourceReleaseRequest) =>
    request<ResourceReleaseResponse>('/resources/release', jsonInit('POST', payload)),
  // Validates then enqueues server-authorized fingerprints (202). The mapping
  // ETag must be forwarded; a 409 means the reviewed mapping is stale.
  calculateResourceFingerprints: (payload: ResourceFingerprintsRequest) =>
    request<ResourceFingerprintsResponse>('/resources/fingerprints', jsonInit('POST', payload)),

  // ---- background tasks (read-only status) ----
  listTasks: (params: ListTasksParams = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (params.before) query.set('before', params.before);
    if (params.limitDays !== undefined) query.set('limitDays', String(params.limitDays));
    const qs = query.toString();
    return request<TasksPageResponse>(`/tasks${qs ? `?${qs}` : ''}`, signal ? { signal } : undefined);
  },

};
