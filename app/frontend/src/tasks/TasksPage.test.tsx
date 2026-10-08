// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityPageResponse, ActivityRecord, TaskDay, TaskRecord, TasksPageResponse } from '../api/types';
import { FeedbackProvider, useFeedback } from '../feedback/FeedbackCenter';
import { LanguageProvider } from '../i18n';
import { FeedbackDrawer } from './FeedbackDrawer';
import { TasksPage } from './TasksPage';

const intersectionCallbacks: IntersectionObserverCallback[] = [];

class IntersectionObserverStub {
  constructor(callback: IntersectionObserverCallback) { intersectionCallbacks.push(callback); }
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
    id: 'task-legacy', kind: 'fingerprints', state: 'succeeded',
    createdAt: '2026-09-24T10:00:00.000Z', startedAt: '2026-09-24T10:00:01.000Z', finishedAt: '2026-09-24T10:00:02.000Z',
    total: 1, completed: 1, succeeded: 1, failed: 0,
    items: [{ virtualPath: 'flight/pass.png', algorithm: 'sha256', state: 'succeeded', code: null, message: null }],
    ...overrides,
  };
}

function activity(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    id: 'activity-one', createdAt: '2026-09-24T11:00:00.000Z', source: 'startup', kind: 'migration',
    severity: 'warning', state: 'succeeded', code: 'v1-to-v2-committed', details: { attempts: 1 }, ...overrides,
  };
}

const tasksPage = (days: TaskDay[] = [], nextCursor: string | null = null, hasMore = false): TasksPageResponse => ({ days, nextCursor, hasMore });
const activityPage = (activities: ActivityRecord[] = [], nextCursor: string | null = null, hasMore = false, revision: string | null = activities[0]?.id ?? null): ActivityPageResponse => ({
  days: activities.length ? [{ date: '2026-09-24', activities }] : [], nextCursor, hasMore, revision,
});
const response = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });

function SessionButton() {
  const { notify } = useFeedback();
  return <button onClick={() => notify('Saved in this session.')}>session</button>;
}

function renderWithProviders(node: React.ReactNode) {
  return render(<LanguageProvider><FeedbackProvider>{node}</FeedbackProvider></LanguageProvider>);
}

beforeEach(() => {
  localStorage.setItem('flightarchive.ui.language', 'en');
  intersectionCallbacks.length = 0;
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('FeedbackDrawer history loading', () => {
  it('does not read history while closed, then loads generic activity and static legacy fingerprints on open', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).startsWith('/api/activity')
      ? response(activityPage([activity()]))
      : response(tasksPage([{ date: '2026-09-24', tasks: [task()] }])));
    vi.stubGlobal('fetch', fetchMock);
    const onActivityRead = vi.fn();
    const view = renderWithProviders(<><SessionButton /><FeedbackDrawer open={false} onClose={() => {}} onActivityRead={onActivityRead} /></>);
    fireEvent.click(screen.getByRole('button', { name: 'session' }));
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();

    view.rerender(<LanguageProvider><FeedbackProvider><FeedbackDrawer open onClose={() => {}} onActivityRead={onActivityRead} /></FeedbackProvider></LanguageProvider>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledWith('/api/activity?limitDays=3', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks?limitDays=3', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(await screen.findByText('Session Activity')).toBeTruthy();
    expect(screen.getAllByText('Saved in this session.')).toHaveLength(2);
    expect(screen.getByText('Saved Activity')).toBeTruthy();
    expect(screen.getByText('Legacy Fingerprint Records')).toBeTruthy();
    expect(onActivityRead).toHaveBeenCalledWith('activity-one');
  });

  it('keeps a recorded running legacy task static without one-second polling or a progress spinner', async () => {
    vi.useFakeTimers();
    const running = task({ state: 'running', finishedAt: null, completed: 0, succeeded: 0 });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).startsWith('/api/activity')
      ? response(activityPage()) : response(tasksPage([{ date: '2026-09-24', tasks: [running] }])));
    vi.stubGlobal('fetch', fetchMock);
    renderWithProviders(<TasksPage />);
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('independent source state', () => {
  it('paginates activity and legacy dates with separate cursors', async () => {
    const olderActivity = activity({ id: 'activity-old', createdAt: '2026-09-20T11:00:00Z', code: 'older-activity' });
    const olderTask = task({ id: 'task-old', createdAt: '2026-09-19T10:00:00Z' });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/activity?limitDays=3') return response(activityPage([activity()], '2026-09-24', true));
      if (url === '/api/tasks?limitDays=3') return response(tasksPage([{ date: '2026-09-24', tasks: [task()] }], '2026-09-24', true));
      if (url.includes('/activity?before=')) return response({ ...activityPage([olderActivity]), days: [{ date: '2026-09-20', activities: [olderActivity] }] });
      return response(tasksPage([{ date: '2026-09-19', tasks: [olderTask] }]));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderWithProviders(<TasksPage />);
    await waitFor(() => expect(intersectionCallbacks).toHaveLength(2));
    for (const callback of [...intersectionCallbacks]) {
      await act(async () => { callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver); });
    }
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock).toHaveBeenCalledWith('/api/activity?before=2026-09-24&limitDays=3', expect.anything());
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks?before=2026-09-24&limitDays=3', expect.anything());
    expect(screen.getAllByText('older-activity')).toHaveLength(2);
    expect(screen.getByText('task-old')).toBeTruthy();
  });

  it('shows working sources when activity fails, and activity when legacy fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).startsWith('/api/activity')
      ? response({}, false)
      : response(tasksPage([{ date: '2026-09-24', tasks: [task()] }])));
    vi.stubGlobal('fetch', fetchMock);
    renderWithProviders(<TasksPage />);
    expect(await screen.findByText('task-legacy')).toBeTruthy();
    expect(screen.getByText('Failed to load saved activity.')).toBeTruthy();

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => String(input).startsWith('/api/activity')
      ? response(activityPage([activity()])) : response({}, false));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('v1-to-v2-committed')).toBeTruthy();
    expect(screen.getByText('Failed to load legacy fingerprint records.')).toBeTruthy();
  });

  it('renders the migration fallback seed as a strong localized no-flights warning with readable details', async () => {
    const seeded = activity({
      severity: 'error', state: 'failed', code: 'v1-to-v2-failed-fallback-seeded',
      details: { attempts: 2, error: 'invalid legacy archive', importedFlights: 0 },
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).startsWith('/api/activity')
      ? response(activityPage([seeded])) : response(tasksPage())));
    renderWithProviders(<TasksPage />);
    expect(await screen.findByText(/NO flights were imported/i)).toBeTruthy();
    expect(screen.getByText('startup')).toBeTruthy();
    expect(screen.getByText('migration')).toBeTruthy();
    fireEvent.click(screen.getByText('Details'));
    expect(screen.getByText(/invalid legacy archive/)).toBeTruthy();
  });
});
