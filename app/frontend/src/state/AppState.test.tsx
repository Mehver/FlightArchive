// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { LanguageProvider } from '../i18n';
import { FeedbackDrawer } from '../tasks/FeedbackDrawer';

vi.mock('../domain/BusinessDataProvider', () => ({
  BusinessDataProvider: ({ children }: { children: ReactNode }) => children,
  useBusinessData: () => ({ data: null }),
}));

import { AppStateProvider, useAppState } from './AppState';

class IntersectionObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0];
}

function Harness({ open = true }: { open?: boolean }) {
  const state = useAppState();
  return <>
    <output data-testid="unread">{String(state.hasUnreadActivity)}</output>
    <output data-testid="observed">{state.observedActivityRevision}</output>
    <output data-testid="read">{state.lastReadActivityRevision}</output>
    <button onClick={() => void state.recheckConnection()}>status</button>
    <FeedbackDrawer open={open} onClose={() => {}} observedActivityRevision={state.observedActivityRevision} onActivityRead={state.markActivityRead} />
  </>;
}

beforeEach(() => {
  localStorage.setItem('flightarchive.ui.language', 'en');
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('badges the first revision, keeps it unread on errors, and acknowledges only the exact successfully read revision', async () => {
  let statusRevision = 'boot';
  let activityRevision = 'boot';
  let failActivity = true;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/status') return { ok: true, status: 200, json: async () => ({ status: {
      persistence: { mode: 'named-json-documents', writable: true, persistenceError: null }, archiveState: 'ready', activityRevision: statusRevision,
    } }) };
    if (url.startsWith('/api/activity')) {
      if (failActivity) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ days: [], nextCursor: null, hasMore: false, revision: activityRevision }) };
    }
    return { ok: true, status: 200, json: async () => ({ days: [], nextCursor: null, hasMore: false }) };
  }));
  render(<LanguageProvider><AppStateProvider><Harness /></AppStateProvider></LanguageProvider>);

  await waitFor(() => expect(screen.getByTestId('observed').textContent).toBe('boot'));
  expect(screen.getByTestId('unread').textContent).toBe('true');
  expect(await screen.findByText('Failed to load saved activity.')).toBeTruthy();
  expect(screen.getByTestId('read').textContent).toBe('');

  failActivity = false;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(screen.getByTestId('unread').textContent).toBe('false'));
  expect(screen.getByTestId('read').textContent).toBe('boot');

  statusRevision = 'newer';
  activityRevision = 'boot';
  fireEvent.click(screen.getByText('status'));
  await waitFor(() => expect(screen.getByTestId('observed').textContent).toBe('newer'));
  expect(screen.getByTestId('unread').textContent).toBe('true');
  await waitFor(() => expect(screen.getByTestId('read').textContent).toBe('boot'));

  activityRevision = 'newer';
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(screen.getByTestId('read').textContent).toBe('newer'));
  expect(screen.getByTestId('unread').textContent).toBe('false');
});
