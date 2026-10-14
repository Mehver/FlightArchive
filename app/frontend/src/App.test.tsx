// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from './i18n';
import type { BusinessDataContextValue } from './domain/BusinessDataProvider';
import { BusinessDataActions } from './App';
import { useBusinessData } from './domain/BusinessDataProvider';
import { useAppState } from './state/AppState';

vi.mock('./domain/BusinessDataProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./domain/BusinessDataProvider')>();
  return { ...actual, useBusinessData: vi.fn() };
});

vi.mock('./state/AppState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./state/AppState')>();
  return { ...actual, useAppState: vi.fn() };
});

const documentState = () => ({ dirty: false, saving: false, pending: 0, generation: 0, error: null });

function businessValue(): BusinessDataContextValue {
  return {
    phase: 'ready',
    data: { schemaVersion: 1, flights: [], airlines: [], airports: [], aircraftTypes: [], settings: {} },
    loadError: null,
    documents: {
      'flights.json': documentState(),
      'airlines.json': documentState(),
      'airports.json': documentState(),
      'aircraft-types.json': documentState(),
      'settings.json': documentState(),
    },
    saveAllProgress: { status: 'idle', completed: 0, total: 5, failed: [] },
    createFlight: vi.fn(),
    updateFlight: vi.fn(),
    deleteFlight: vi.fn(),
    upsertCatalogEntry: vi.fn(),
    deleteCatalogEntries: vi.fn(),
    updateSettings: vi.fn(),
    prepareCreateFlight: vi.fn(),
    prepareUpdateFlight: vi.fn(),
    prepareDeleteFlight: vi.fn(),
    prepareUpsertCatalogEntry: vi.fn(),
    prepareDeleteCatalogEntries: vi.fn(),
    commitPrepared: vi.fn(),
    retryDocument: vi.fn(),
    saveDocument: vi.fn(),
    saveAll: vi.fn(async () => ({ failed: [] })),
    importBusinessData: vi.fn(async () => ({ failed: [] })),
    exportBusinessData: vi.fn(() => '{}'),
    downloadBusinessData: vi.fn(),
    reload: vi.fn(),
    whenIdle: vi.fn(),
    hasResourceReferences: vi.fn(() => false),
  };
}

let business: BusinessDataContextValue;
const showError = vi.fn();
const reportFailure = vi.fn();

function renderActions() {
  return render(<LanguageProvider><BusinessDataActions /></LanguageProvider>);
}

function openActionsMenu(status = 'Online') {
  const trigger = screen.getByRole('button', { name: `Connection Status: ${status}` });
  fireEvent.click(trigger);
  return trigger;
}

beforeEach(() => {
  localStorage.setItem('flightarchive.ui.language', 'en');
  business = businessValue();
  vi.mocked(useBusinessData).mockImplementation(() => business);
  vi.mocked(useAppState).mockReturnValue({
    connectivity: 'online',
    recheckConnection: vi.fn(),
    catalogs: null,
    refreshAll: vi.fn(),
    notify: vi.fn(),
    showError,
    reportFailure,
    observedActivityRevision: null,
    lastReadActivityRevision: null,
    hasUnreadActivity: false,
    markActivityRead: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  showError.mockReset();
  reportFailure.mockReset();
  vi.clearAllMocks();
});

describe('BusinessDataActions', () => {
  it('keeps data actions inside a single cloud menu and invokes each action', async () => {
    const { container } = renderActions();

    expect(screen.queryByRole('button', { name: 'Save All' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();

    const trigger = openActionsMenu();
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-controls')).toBe('business-data-menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save All' }));
    await waitFor(() => expect(business.saveAll).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    openActionsMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export' }));
    expect(business.downloadBusinessData).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(input, 'click');
    openActionsMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import' }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps local export available offline and applies action enable conditions', () => {
    vi.mocked(useAppState).mockReturnValue({
      ...vi.mocked(useAppState)(),
      connectivity: 'offline',
    });
    business.documents['flights.json'].saving = true;
    renderActions();

    openActionsMenu('Offline');
    expect(screen.getByRole('menuitem', { name: 'Save All' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('menuitem', { name: 'Import' }).getAttribute('aria-disabled')).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Export' }).getAttribute('aria-disabled')).toBeNull();
  });

  it('rechecks only from the explicit menu item and restores focus on Escape', async () => {
    const recheckConnection = vi.fn();
    vi.mocked(useAppState).mockReturnValue({
      ...vi.mocked(useAppState)(),
      recheckConnection,
    });
    renderActions();

    const trigger = openActionsMenu();
    expect(recheckConnection).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(trigger);

    openActionsMenu();
    fireEvent.click(document.querySelector('.MuiBackdrop-root')!);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(trigger);

    openActionsMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Recheck Connection' }));
    expect(recheckConnection).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('surfaces invalid JSON imports through application feedback', async () => {
    const { container } = renderActions();
    const file = new File(['not-json'], 'invalid.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: vi.fn(async () => 'not-json') });

    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });

    await waitFor(() => expect(reportFailure).toHaveBeenCalledTimes(1));
    expect(reportFailure.mock.calls[0][0]).toBeInstanceOf(SyntaxError);
    expect(business.importBusinessData).not.toHaveBeenCalled();
  });

  it('surfaces domain validation failures from an imported document', async () => {
    const validationError = new Error('schemaVersion must equal 1');
    vi.mocked(business.importBusinessData).mockRejectedValueOnce(validationError);
    const { container } = renderActions();
    const file = new File(['{}'], 'invalid-domain.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: vi.fn(async () => '{}') });

    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });

    await waitFor(() => expect(reportFailure).toHaveBeenCalledWith(
      validationError,
      { fallback: 'Could Not Import Business Data', context: { form: 'business-data-import' } },
    ));
  });

  it('shows sequential Save All progress and keeps manifest failure visible and retryable', async () => {
    business.saveAllProgress = { status: 'running', completed: 0, total: 5, failed: [] };
    business.documents['flights.json'].saving = true;
    const view = renderActions();
    openActionsMenu();
    expect(screen.getByText('Saving flights.json (0/5)')).toBeTruthy();

    business.documents['flights.json'].saving = false;
    business.documents['airlines.json'].saving = true;
    business.saveAllProgress = { status: 'running', completed: 1, total: 5, failed: [] };
    view.rerender(<LanguageProvider><BusinessDataActions /></LanguageProvider>);
    expect(screen.getByText('Saving airlines.json (1/5)')).toBeTruthy();

    business.documents['airlines.json'].saving = false;
    business.saveAllProgress = { status: 'running', completed: 5, total: 5, failed: [] };
    view.rerender(<LanguageProvider><BusinessDataActions /></LanguageProvider>);
    expect(screen.getByText('Saving manifest.json (5/5)')).toBeTruthy();

    business.saveAllProgress = { status: 'failed', completed: 5, total: 5, failed: ['manifest.json'] };
    view.rerender(<LanguageProvider><BusinessDataActions /></LanguageProvider>);

    const failure = screen.getByText('Save Failed (5/5)');
    fireEvent.mouseOver(failure);
    expect(await screen.findByText('Failed: manifest.json')).toBeTruthy();
    expect(screen.queryByText(/Unsaved/)).toBeNull();
    expect(screen.queryByText('Saved (5/5)')).toBeNull();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Retry Failed' }));
    await waitFor(() => expect(business.saveAll).toHaveBeenCalledTimes(1));
  });
});
