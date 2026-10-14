// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { LanguageProvider } from '../i18n';
import { TasksPage } from '../tasks/TasksPage';
import { FeedbackProvider, useFeedback } from './FeedbackCenter';

function ModuleButton({ module, error = false }: { module: string; error?: boolean }) {
  const { notify, showError } = useFeedback();
  return (
    <button onClick={() => error
      ? showError(new Error('internal'), 'Could not save.', { form: module })
      : notify('Saved.', 'success', { form: module })}
    >
      {module}
    </button>
  );
}

function Inspector() {
  const { records, showError, reportFailure } = useFeedback();
  const important = useRef(new Error('do not expose this detail')).current;
  return (
    <>
      <button onClick={() => showError(new ApiError(503, 'request-failed', 'refresh failed'))}>API</button>
      <button onClick={() => {
        const activity = { source: 'frontend-test', kind: 'test', severity: 'error', state: 'failed', code: 'test-failed', details: { marker: 'one' } };
        reportFailure(important, { fallback: 'Could not complete.', activity });
        reportFailure(important, { fallback: 'Duplicate.', activity });
      }}>important</button>
      <button onClick={() => reportFailure(important, { fallback: 'Local failure.' })}>local</button>
      <button onClick={() => reportFailure(important, {
        fallback: 'Should not replace local.',
        activity: { source: 'frontend-test', kind: 'test', severity: 'error', state: 'failed', code: 'upgraded', details: { marker: 'upgrade' } },
      })}>upgrade</button>
      <output data-testid="records">{JSON.stringify(records)}</output>
    </>
  );
}

function BulkFeedback() {
  const { notify } = useFeedback();
  return <button onClick={() => { for (let index = 0; index < 205; index += 1) notify(`Saved ${index}.`); }}>bulk</button>;
}

function renderFeedback(children: ReactNode) {
  return render(<LanguageProvider><FeedbackProvider>{children}</FeedbackProvider></LanguageProvider>);
}

beforeEach(() => {
  localStorage.setItem('flightarchive.ui.language', 'en');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('FeedbackProvider', () => {
  it('auto-dismisses the hot success prompt but retains its terminal session record', async () => {
    vi.useFakeTimers();
    renderFeedback(<><ModuleButton module="flight-form" /><Inspector /></>);

    fireEvent.click(screen.getByRole('button', { name: 'flight-form' }));
    expect(screen.getByRole('alert').textContent).toContain('Saved.');
    const first = JSON.parse(screen.getByTestId('records').textContent ?? '[]');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ finalState: 'succeeded', context: { form: 'flight-form' } });
    expect(first[0].id.startsWith(first[0].createdAt)).toBe(true);

    act(() => { vi.advanceTimersByTime(4000); });
    act(() => { vi.advanceTimersByTime(500); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(JSON.parse(screen.getByTestId('records').textContent ?? '[]')).toHaveLength(1);
  });

  it('restarts the auto-hide timer for a consecutive toast with the same severity', async () => {
    vi.useFakeTimers();
    renderFeedback(<><ModuleButton module="first" /><ModuleButton module="second" /></>);
    fireEvent.click(screen.getByRole('button', { name: 'first' }));
    act(() => { vi.advanceTimersByTime(3000); });
    fireEvent.click(screen.getByRole('button', { name: 'second' }));

    act(() => { vi.advanceTimersByTime(1500); });
    expect(screen.getByRole('alert')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(3000); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('retains only the most recent 200 session records', () => {
    renderFeedback(<><BulkFeedback /><Inspector /></>);
    fireEvent.click(screen.getByRole('button', { name: 'bulk' }));
    const records = JSON.parse(screen.getByTestId('records').textContent ?? '[]');
    expect(records).toHaveLength(200);
    expect(records[0].message).toBe('Saved 204.');
    expect(records[199].message).toBe('Saved 5.');
  });

  it('records application and API errors without retired endpoint-specific interpretation', () => {
    renderFeedback(<><ModuleButton module="catalog-form" error /><Inspector /></>);
    fireEvent.click(screen.getByRole('button', { name: 'catalog-form' }));
    fireEvent.click(screen.getByRole('button', { name: 'API' }));

    const records = JSON.parse(screen.getByTestId('records').textContent ?? '[]');
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      code: 'request-failed',
      finalState: 'failed',
      message: 'Operation Failed (Request failed with status 503)',
    });
    expect(records[1]).toMatchObject({ finalState: 'failed', context: { form: 'catalog-form' } });
  });

  it('uses one provider stream for calls from different modules without duplicate records', () => {
    renderFeedback(<><ModuleButton module="flights" /><ModuleButton module="resources" /><Inspector /></>);
    fireEvent.click(screen.getByRole('button', { name: 'flights' }));
    fireEvent.click(screen.getByRole('button', { name: 'resources' }));
    const records = JSON.parse(screen.getByTestId('records').textContent ?? '[]');
    expect(records).toHaveLength(2);
    expect(records.map((record: { context: { form: string } }) => record.context.form)).toEqual(['resources', 'flights']);
  });

  it('publishes one toast, record, and optional activity for one reported failure', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => { throw new Error('activity unavailable'); });
    vi.stubGlobal('fetch', fetcher);
    renderFeedback(<Inspector />);
    fireEvent.click(screen.getByRole('button', { name: 'important' }));
    expect(screen.getByRole('alert').textContent).toBe('Could not complete.');
    expect(JSON.parse(screen.getByTestId('records').textContent ?? '[]')).toHaveLength(1);
    await act(async () => { await Promise.resolve(); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ code: 'test-failed', details: { marker: 'one' } });
  });

  it('upgrades an existing local failure to one persistent attempt without another record', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    renderFeedback(<Inspector />);
    fireEvent.click(screen.getByRole('button', { name: 'local' }));
    expect(JSON.parse(screen.getByTestId('records').textContent ?? '[]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'upgrade' }));
    fireEvent.click(screen.getByRole('button', { name: 'upgrade' }));
    await act(async () => { await Promise.resolve(); });
    expect(JSON.parse(screen.getByTestId('records').textContent ?? '[]')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toBe('Local failure.');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('renders retained frontend activity beside an empty backend task stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ days: [], nextCursor: null, hasMore: false }) })));
    renderFeedback(<><ModuleButton module="resources" /><TasksPage /></>);
    fireEvent.click(screen.getByRole('button', { name: 'resources' }));

    expect((await screen.findByTestId('activity-record')).textContent).toContain('Saved.');
    expect(screen.getByTestId('activity-record').textContent).toContain('Completed');
    expect(await screen.findByText('No Legacy Fingerprint Records')).toBeTruthy();
  });
});
