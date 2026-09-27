// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
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
  const { records, showError } = useFeedback();
  return (
    <>
      <button onClick={() => showError(new ApiError(503, 'resource-committed-refresh-failed', 'refresh failed'))}>B4</button>
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

  it('records errors and gives B4 a committed-but-unconfirmed explanation', () => {
    renderFeedback(<><ModuleButton module="catalog-form" error /><Inspector /></>);
    fireEvent.click(screen.getByRole('button', { name: 'catalog-form' }));
    fireEvent.click(screen.getByRole('button', { name: 'B4' }));

    const records = JSON.parse(screen.getByTestId('records').textContent ?? '[]');
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      code: 'resource-committed-refresh-failed',
      finalState: 'failed',
      message: 'The change was submitted, but its latest status could not be confirmed. Refresh before trying again.',
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

  it('renders retained frontend activity beside an empty backend task stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ days: [], nextCursor: null, hasMore: false }) })));
    renderFeedback(<><ModuleButton module="resources" /><TasksPage /></>);
    fireEvent.click(screen.getByRole('button', { name: 'resources' }));

    expect((await screen.findByTestId('activity-record')).textContent).toContain('Saved.');
    expect(screen.getByTestId('activity-record').textContent).toContain('Completed');
    expect(await screen.findByText('No Background Tasks')).toBeTruthy();
  });
});
