// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskDay, TaskRecord, TasksPageResponse } from '../api/types';
import { FeedbackProvider } from '../feedback/FeedbackCenter';
import { LanguageProvider } from '../i18n';
import { FeedbackDrawer } from './FeedbackDrawer';
import { TasksPage } from './TasksPage';

let intersectionCallback: IntersectionObserverCallback | undefined;

class IntersectionObserverStub {
  constructor(callback: IntersectionObserverCallback) { intersectionCallback = callback; }
  observe() {}
  disconnect() {}
  unobserve() {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0];
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-20260924T100000000000Z-a1b2c3d4',
    kind: 'fingerprints',
    state: 'succeeded',
    createdAt: '2026-09-24T10:00:00.000Z',
    startedAt: '2026-09-24T10:00:01.000Z',
    finishedAt: '2026-09-24T10:00:02.000Z',
    total: 1,
    completed: 1,
    succeeded: 1,
    failed: 0,
    items: [{ virtualPath: 'flight/pass.png', algorithm: 'sha256', state: 'succeeded', code: null, message: null }],
    ...overrides,
  };
}

function page(days: TaskDay[], nextCursor: string | null = null, hasMore = false): TasksPageResponse {
  return { days, nextCursor, hasMore };
}

function response(body: TasksPageResponse) {
  return { ok: true, json: async () => body };
}

function renderWithProviders(node: React.ReactNode) {
  return render(<LanguageProvider><FeedbackProvider>{node}</FeedbackProvider></LanguageProvider>);
}

beforeEach(() => {
  localStorage.setItem('flightarchive.ui.language', 'en');
  intersectionCallback = undefined;
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('FeedbackDrawer task loading', () => {
  it('does not request tasks while closed and loads the newest three log days when opened', async () => {
    const fetchMock = vi.fn(async () => response(page([])));
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = renderWithProviders(<FeedbackDrawer open={false} onClose={() => {}} />);

    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();

    rerender(<LanguageProvider><FeedbackProvider><FeedbackDrawer open onClose={() => {}} /></FeedbackProvider></LanguageProvider>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks?limitDays=3', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('cancels active-task polling when the drawer closes', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => response(page([{
      date: '2026-09-24',
      tasks: [task({ state: 'running', finishedAt: null, completed: 0, succeeded: 0 })],
    }])));
    vi.stubGlobal('fetch', fetchMock);
    const view = renderWithProviders(<FeedbackDrawer open onClose={() => {}} />);

    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    view.rerender(<LanguageProvider><FeedbackProvider><FeedbackDrawer open={false} onClose={() => {}} /></FeedbackProvider></LanguageProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight task request when the drawer closes', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const view = renderWithProviders(<FeedbackDrawer open onClose={() => {}} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const signal = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    view.rerender(<LanguageProvider><FeedbackProvider><FeedbackDrawer open={false} onClose={() => {}} /></FeedbackProvider></LanguageProvider>);
    expect(signal.aborted).toBe(true);
  });
});

describe('TasksPage day pagination', () => {
  it('loads older days with the cursor, de-duplicates days/tasks, and stops at hasMore=false', async () => {
    const newest = task();
    const older = task({ id: 'task-20260922T090000000000Z-b1b2c3d4', createdAt: '2026-09-22T09:00:00.000Z' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(page([{ date: '2026-09-24', tasks: [newest] }], '2026-09-24', true)))
      .mockResolvedValueOnce(response(page([
        { date: '2026-09-22', tasks: [older] },
        { date: '2026-09-22', tasks: [older] },
      ])));
    vi.stubGlobal('fetch', fetchMock);
    renderWithProviders(<TasksPage />);

    expect(await screen.findByRole('heading', { name: /September 24, 2026/i })).toBeTruthy();
    await act(async () => {
      intersectionCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    expect(await screen.findByRole('heading', { name: /September 22, 2026/i })).toBeTruthy();
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/tasks?before=2026-09-24&limitDays=3', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getAllByText(older.id)).toHaveLength(1);
    expect(screen.getByText('No more task history.')).toBeTruthy();

    await act(async () => {
      intersectionCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('TasksPage polling and repaired tasks', () => {
  it('polls the latest page while a task is active, replaces its state, then stops', async () => {
    vi.useFakeTimers();
    const running = task({ state: 'running', finishedAt: null, completed: 0, succeeded: 0 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(page([{ date: '2026-09-24', tasks: [running] }])))
      .mockResolvedValueOnce(response(page([{ date: '2026-09-24', tasks: [task()] }])));
    vi.stubGlobal('fetch', fetchMock);
    renderWithProviders(<TasksPage />);

    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/tasks?limitDays=3', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByText('Succeeded')).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('renders a backend-repaired interrupted task as failed with a localized reason', async () => {
    const interrupted = task({
      state: 'failed',
      finishedAt: '2026-09-24T10:02:00.000Z',
      succeeded: 0,
      failed: 1,
      items: [{
        virtualPath: 'flight/pass.png', algorithm: 'sha256', state: 'failed',
        code: 'task_interrupted', message: 'Task was interrupted before completion',
      }],
    });
    vi.stubGlobal('fetch', vi.fn(async () => response(page([{ date: '2026-09-24', tasks: [interrupted] }]))));
    renderWithProviders(<TasksPage />);

    expect(await screen.findByText('Failed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '1 item(s)' }));
    expect(await screen.findByText(/Task was interrupted before completion/)).toBeTruthy();
  });

  it('localizes task-item resource and infrastructure failure codes', async () => {
    const codes = ['rfg-unavailable', 'resource-conflict', 'resource-not-eligible', 'resource-not-found', 'task_error'];
    const failed = task({
      state: 'failed', succeeded: 0, failed: codes.length, total: codes.length, completed: codes.length,
      items: codes.map((code, index) => ({ virtualPath: `flight/pass-${index}.png`, algorithm: 'sha256' as const, state: 'failed' as const, code, message: null })),
    });
    vi.stubGlobal('fetch', vi.fn(async () => response(page([{ date: '2026-09-24', tasks: [failed] }]))));
    renderWithProviders(<TasksPage />);
    fireEvent.click(await screen.findByRole('button', { name: '5 item(s)' }));

    expect(await screen.findByText(/Resource Service Unavailable/)).toBeTruthy();
    expect(screen.getByText(/Resource mapping changed/)).toBeTruthy();
    expect(screen.getByText(/Resource is not eligible for fingerprinting/)).toBeTruthy();
    expect(screen.getByText(/Resource was not found/)).toBeTruthy();
    expect(screen.getByText(/Task failed unexpectedly/)).toBeTruthy();
  });
});
