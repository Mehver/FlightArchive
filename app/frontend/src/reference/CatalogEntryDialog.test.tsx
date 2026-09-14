// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '../i18n';
import { AppStateProvider } from '../state/AppState';
import { CatalogEntryDialog, isCatalogEntryFormValid } from './CatalogEntryDialog';

afterEach(cleanup);

function renderDialog(onSave = vi.fn()) {
  render(<LanguageProvider><AppStateProvider><CatalogEntryDialog kind="airlines" open initial={null} saving={false} allianceSuggestions={['oneworld', 'SkyTeam', 'Star Alliance']} manufacturerSuggestions={[]} onSave={onSave} onClose={vi.fn()} /></AppStateProvider></LanguageProvider>);
  const fields = screen.getAllByRole('textbox');
  fireEvent.change(fields[0], { target: { value: 'ZZ' } });
  fireEvent.change(fields[3], { target: { value: 'Zulu Air' } });
  return onSave;
}

describe('CatalogEntryDialog alliance editor', () => {
  it('saves a blank alliance as null and accepts an arbitrary typed name', () => {
    const onSave = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({
      alliance: null,
      brandColors: { primary: null, contrast: null },
    }));

    fireEvent.change(screen.getByRole('combobox', { name: 'Alliance' }), { target: { value: 'Regional Connect' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ alliance: 'Regional Connect' }));
  });

  it('offers supplied alliance suggestions without restricting the input', () => {
    renderDialog();
    const input = screen.getByRole('combobox', { name: 'Alliance' });
    fireEvent.mouseDown(input);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['oneworld', 'SkyTeam', 'Star Alliance']);
  });
});

describe('CatalogEntryDialog aircraft type identifiers', () => {
  it('uppercases the ICAO input and exposes its four-character maximum', () => {
    render(<LanguageProvider><AppStateProvider><CatalogEntryDialog kind="aircraft-types" open initial={null} saving={false} allianceSuggestions={[]} manufacturerSuggestions={[]} onSave={vi.fn()} onClose={vi.fn()} /></AppStateProvider></LanguageProvider>);
    const icao = screen.getAllByRole('textbox')[0] as HTMLInputElement;
    expect(icao.maxLength).toBe(4);
    fireEvent.change(icao, { target: { value: 'a3b' } });
    expect(icao.value).toBe('A3B');
  });

  it('accepts 2–4 character ICAO designators and keeps IATA aircraft codes at three characters', () => {
    for (const icao of ['AT', 'A3B', 'A320']) {
      expect(isCatalogEntryFormValid('aircraft-types', { icao, iata: '320', displayName: 'Test type' })).toBe(true);
    }
    for (const icao of ['A', 'A3200']) {
      expect(isCatalogEntryFormValid('aircraft-types', { icao, iata: '320', displayName: 'Test type' })).toBe(false);
    }
    expect(isCatalogEntryFormValid('aircraft-types', { icao: 'A320', iata: '32', displayName: 'Test type' })).toBe(false);
  });

  it('does not loosen airline or airport ICAO designators', () => {
    expect(isCatalogEntryFormValid('airlines', { code: 'ZZ', icao: 'ZZZ', nameEn: 'Zulu Air' })).toBe(true);
    expect(isCatalogEntryFormValid('airlines', { code: 'ZZ', icao: 'ZZZZ', nameEn: 'Zulu Air' })).toBe(false);
    expect(isCatalogEntryFormValid('airports', { code: 'ZZZ', icao: 'ZZZZ', nameEn: 'Zulu Airport' })).toBe(true);
    expect(isCatalogEntryFormValid('airports', { code: 'ZZZ', icao: 'ZZZ', nameEn: 'Zulu Airport' })).toBe(false);
  });

  it('normalizes a blank manufacturer to null in the single manufacturer field', () => {
    const onSave = vi.fn();
    render(<LanguageProvider><AppStateProvider><CatalogEntryDialog kind="aircraft-types" open initial={{ icao: 'TEST', iata: 'TST', manufacturer: '  ', displayName: 'Test type' }} saving={false} allianceSuggestions={[]} manufacturerSuggestions={[]} onSave={onSave} onClose={vi.fn()} /></AppStateProvider></LanguageProvider>);
    expect(screen.getAllByRole('textbox')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ manufacturer: null }));
  });

  it('offers manufacturer suggestions while saving an arbitrary typed manufacturer', () => {
    const onSave = vi.fn();
    render(<LanguageProvider><AppStateProvider><CatalogEntryDialog kind="aircraft-types" open initial={{ icao: 'TEST', iata: 'TST', manufacturer: null, displayName: 'Test type' }} saving={false} allianceSuggestions={[]} manufacturerSuggestions={['Airbus', 'Boeing']} onSave={onSave} onClose={vi.fn()} /></AppStateProvider></LanguageProvider>);
    const input = screen.getByRole('combobox', { name: 'Manufacturer' });
    fireEvent.mouseDown(input);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Airbus', 'Boeing']);
    fireEvent.change(input, { target: { value: 'Custom Works' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ manufacturer: 'Custom Works' }));
  });
});

describe('CatalogEntryDialog airport terminals', () => {
  it('adds, deduplicates, and removes terminal tags before saving', () => {
    const onSave = vi.fn();
    render(<LanguageProvider><AppStateProvider><CatalogEntryDialog kind="airports" open initial={{ code: 'PEK', icao: 'ZBAA', nameZh: '', nameEn: 'Beijing', cityZh: '', cityEn: '', countryZh: '', countryEn: '', terminals: ['T1'] }} saving={false} allianceSuggestions={[]} manufacturerSuggestions={[]} onSave={onSave} onClose={vi.fn()} /></AppStateProvider></LanguageProvider>);
    const input = screen.getByRole('textbox', { name: 'Add Terminal' });
    fireEvent.change(input, { target: { value: 'T2, t2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('T2')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Delete T1'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ terminals: ['T2'] }));
  });
});
