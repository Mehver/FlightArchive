// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Typed API client. All endpoints live under /api (proxied in dev). */

import type {
  ListTasksParams,
  TasksPageResponse,
  StatusResponse,
  ActivityPageResponse,
  ActivityRecord,
  ActivitySubmission,
  ArchiveDocumentList,
  ArchiveSummary,
  JsonValue,
  ListActivityParams,
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
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

export const api = {
  // ---- workspace ----
  status: (signal?: AbortSignal) => request<StatusResponse>('/status', { signal }),

  // ---- domain-neutral named JSON documents ----
  getArchive: (appId: string, signal?: AbortSignal) =>
    request<ArchiveSummary>(`/archive/${encodeURIComponent(appId)}`, signal ? { signal } : undefined),
  listArchiveDocuments: (appId: string, signal?: AbortSignal) =>
    request<ArchiveDocumentList>(`/archive/${encodeURIComponent(appId)}/documents`, signal ? { signal } : undefined),
  getArchiveDocument: (appId: string, documentId: string, signal?: AbortSignal) =>
    request<JsonValue>(`/archive/${encodeURIComponent(appId)}/documents/${encodeURIComponent(documentId)}`, signal ? { signal } : undefined),
  putArchiveDocument: (appId: string, documentId: string, document: JsonValue) =>
    request<void>(`/archive/${encodeURIComponent(appId)}/documents/${encodeURIComponent(documentId)}`, jsonInit('PUT', document)),
  deleteArchiveDocument: (appId: string, documentId: string) =>
    request<void>(`/archive/${encodeURIComponent(appId)}/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE' }),

  // ---- generic activity ----
  listActivity: (params: ListActivityParams = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (params.before) query.set('before', params.before);
    if (params.limitDays !== undefined) query.set('limitDays', String(params.limitDays));
    const qs = query.toString();
    return request<ActivityPageResponse>(`/activity${qs ? `?${qs}` : ''}`, signal ? { signal } : undefined);
  },
  reportActivity: (activity: ActivitySubmission) =>
    request<ActivityRecord>('/activity', jsonInit('POST', activity)),

  // ---- background tasks (read-only status) ----
  listTasks: (params: ListTasksParams = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (params.before) query.set('before', params.before);
    if (params.limitDays !== undefined) query.set('limitDays', String(params.limitDays));
    const qs = query.toString();
    return request<TasksPageResponse>(`/tasks${qs ? `?${qs}` : ''}`, signal ? { signal } : undefined);
  },
};
