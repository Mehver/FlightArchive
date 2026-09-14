// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Editor shared by the flight-reference catalog rows (airlines, airports, aircraft types). */

import { useEffect, useState } from 'react';
import { Autocomplete, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, TextField, Typography } from '@mui/material';
import type { AircraftType, Airline, Airport } from '../api/types';
import { ResourceSlotField } from '../resources/ResourceSlotField';
import { useTranslation } from '../i18n';
import { isValidHexColor, type HexColor } from '../theme/colors';
import { ThemeColorPicker } from '../components/ThemeColorPicker';
import { scaled, useDialogScale } from '../utils/dialogScale';

const LOGO_SLOTS = [
  { field: 'symbolLogoResourcePath', labelKey: 'logoSymbol' },
  { field: 'horizontalLogoResourcePath', labelKey: 'logoHorizontal' },
  { field: 'horizontalDarkLogoResourcePath', labelKey: 'logoHorizontalDark' },
] as const;

export type CatalogKind = 'airlines' | 'airports' | 'aircraft-types';
export type CatalogEntry = Airline | Airport | AircraftType;

export function catalogEntryKey(kind: CatalogKind, entry: CatalogEntry): string {
  return kind === 'aircraft-types' ? (entry as AircraftType).icao : (entry as Airline | Airport).code;
}

function emptyEntry(kind: CatalogKind): Record<string, unknown> {
  if (kind === 'airlines') return { code: '', icao: '', nameZh: '', nameEn: '', alliance: null, horizontalLogoResourcePath: null, horizontalDarkLogoResourcePath: null, symbolLogoResourcePath: null, brandColors: { primary: null, contrast: null } };
  if (kind === 'airports') return { code: '', icao: '', nameZh: '', nameEn: '', cityZh: '', cityEn: '', countryZh: '', countryEn: '', terminals: [] };
  return { icao: '', iata: '', manufacturer: null, displayName: '' };
}

export function isCatalogEntryFormValid(kind: CatalogKind, form: Record<string, unknown>): boolean {
  const code = String(form.code ?? '').trim();
  const icao = String(form.icao ?? '').trim();
  const nameZh = String(form.nameZh ?? '').trim();
  const nameEn = String(form.nameEn ?? '').trim();
  const displayName = String(form.displayName ?? '').trim();
  if (kind === 'airlines') {
    const colors = form.brandColors as { primary?: unknown; contrast?: unknown } | undefined;
    const colorsValid = [colors?.primary, colors?.contrast].every((color) => color == null || isValidHexColor(color));
    return /^[A-Z0-9]{2,3}$/.test(code) && (!icao || /^[A-Z]{3}$/.test(icao)) && !!(nameZh || nameEn) && colorsValid;
  }
  if (kind === 'airports') return /^[A-Z]{3,4}$/.test(code) && (!icao || /^[A-Z]{4}$/.test(icao)) && !!(nameZh || nameEn);
  const iata = String(form.iata ?? '').trim();
  return /^[A-Z0-9]{2,4}$/.test(icao) && (!iata || /^[A-Z0-9]{3}$/.test(iata)) && displayName.length > 0;
}

export function CatalogEntryDialog({ kind, open, initial, saving, allianceSuggestions, manufacturerSuggestions, onSave, onClose }: { kind: CatalogKind; open: boolean; initial: CatalogEntry | null; saving: boolean; allianceSuggestions: readonly string[]; manufacturerSuggestions: readonly string[]; onSave: (entry: Record<string, unknown>) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const dialogScale = useDialogScale();
  const [form, setForm] = useState<Record<string, unknown>>(emptyEntry(kind));
  const [terminalDraft, setTerminalDraft] = useState('');

  useEffect(() => {
    if (open) { setForm(initial ? ({ ...(initial as unknown as Record<string, unknown>) }) : emptyEntry(kind)); setTerminalDraft(''); }
  }, [open, initial, kind]);

  const text = (key: string, uppercase = false) => ({ value: String(form[key] ?? ''), onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((prev) => ({ ...prev, [key]: uppercase ? e.target.value.toUpperCase() : e.target.value })) });
  const valid = isCatalogEntryFormValid(kind, form);
  const stringValue = (key: string) => typeof form[key] === 'string' ? form[key] : '';
  const terminals = Array.isArray(form.terminals) ? form.terminals as string[] : [];
  const addTerminals = (raw: string) => {
    const additions = raw.split(/[\n,]/).map((value) => value.trim()).filter(Boolean).slice(0, 32);
    setForm((prev) => {
      const current = Array.isArray(prev.terminals) ? prev.terminals as string[] : [];
      const seen = new Set(current.map((value) => value.toLocaleLowerCase()));
      return { ...prev, terminals: [...current, ...additions.filter((value) => !seen.has(value.toLocaleLowerCase()) && !!seen.add(value.toLocaleLowerCase()))].slice(0, 32) };
    });
    setTerminalDraft('');
  };
  const suggestionInput = (key: string, suggestions: readonly string[]) => <Autocomplete
    freeSolo
    clearOnEscape
    options={suggestions}
    value={stringValue(key)}
    onChange={(_event, value) => setForm((prev) => ({ ...prev, [key]: value ?? '' }))}
    onInputChange={(_event, value) => setForm((prev) => ({ ...prev, [key]: value }))}
    renderInput={(params) => <TextField {...params} label={t(key === 'alliance' ? 'alliance' : 'manufacturer')} />}
    sx={{ flex: '1 1 220px' }}
  />;
  const save = () => onSave(kind === 'airlines'
    ? { ...form, alliance: typeof form.alliance === 'string' && form.alliance.trim() ? form.alliance.trim() : null }
    : kind === 'aircraft-types'
      ? { ...form, manufacturer: typeof form.manufacturer === 'string' && form.manufacturer.trim() ? form.manufacturer.trim() : null }
      : form);
  return <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="catalog-dialog-title" slotProps={{ paper: { sx: { width: scaled(600, dialogScale), maxWidth: '95vw' } } }}>
    <DialogTitle id="catalog-dialog-title">{initial ? t('editCatalogEntry', { kind: t(kind === 'aircraft-types' ? 'aircraftTypes' : kind) }) : t('addCatalogEntry', { kind: t(kind === 'aircraft-types' ? 'aircraftTypes' : kind) })}</DialogTitle>
    <DialogContent dividers><Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, pt: 0.5 }}>
      {kind === 'aircraft-types' ? <><TextField label={t('icaoCode')} required {...text('icao', true)} helperText={t('aircraftTypeIcaoHint')} sx={{ flex: '1 1 120px' }} slotProps={{ htmlInput: { maxLength: 4, disabled: initial !== null } }} /><TextField label={t('iataCode')} {...text('iata', true)} helperText={t('aircraftTypeIataHint')} sx={{ flex: '1 1 120px' }} slotProps={{ htmlInput: { maxLength: 3 } }} /><TextField label={t('displayName')} required {...text('displayName')} sx={{ flex: '1 1 200px' }} />{suggestionInput('manufacturer', manufacturerSuggestions)}</> : <><TextField label={t('iataCode')} required {...text('code', true)} sx={{ flex: '1 1 110px' }} slotProps={{ htmlInput: { maxLength: kind === 'airlines' ? 3 : 4, disabled: initial !== null } }} /><TextField label={t('icaoCode')} {...text('icao', true)} helperText={t(kind === 'airlines' ? 'airlineIcaoHint' : 'airportIcaoHint')} sx={{ flex: '1 1 110px' }} slotProps={{ htmlInput: { maxLength: kind === 'airlines' ? 3 : 4 } }} /><TextField label={t('nameChinese')} {...text('nameZh')} sx={{ flex: '1 1 200px' }} /><TextField label={t('nameEnglish')} {...text('nameEn')} sx={{ flex: '1 1 200px' }} />
       {kind === 'airlines' ? <Box sx={{ display: 'flex', gap: 2, flex: '1 1 100%', minWidth: 0 }}>{suggestionInput('alliance', allianceSuggestions)}</Box> : <><TextField label={t('cityChinese')} {...text('cityZh')} sx={{ flex: '1 1 140px' }} /><TextField label={t('cityEnglish')} {...text('cityEn')} sx={{ flex: '1 1 140px' }} /><TextField label={t('countryChinese')} {...text('countryZh')} sx={{ flex: '1 1 140px' }} /><TextField label={t('countryEnglish')} {...text('countryEn')} sx={{ flex: '1 1 140px' }} /><Box sx={{ flex: '1 1 100%', border: 1, borderColor: 'divider', borderRadius: 1.5, p: 1.5, minHeight: 120 }}><Typography variant="subtitle2">{t('terminals')}</Typography><Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, my: 1 }}>{terminals.map((terminal) => <Chip key={terminal} label={terminal} deleteIcon={<span aria-label={`${t('delete')} ${terminal}`}>×</span>} onDelete={() => setForm((prev) => ({ ...prev, terminals: (prev.terminals as string[]).filter((value) => value !== terminal) }))} />)}</Box><Box sx={{ display: 'flex', gap: 1 }}><TextField size="small" label={t('terminalInput')} value={terminalDraft} onChange={(e) => setTerminalDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTerminals(terminalDraft); } }} onPaste={(e) => { const text = e.clipboardData.getData('text'); if (/[\n,]/.test(text)) { e.preventDefault(); addTerminals(text); } }} sx={{ flex: 1 }} /><Button onClick={() => addTerminals(terminalDraft)} disabled={!terminalDraft.trim()}>{t('terminalAdd')}</Button></Box></Box></>}</>}
    </Box>{kind === 'airlines' ? <><Divider sx={{ my: 2.5 }} /><Typography variant="subtitle2" gutterBottom>{t('airlineLogos')}</Typography><Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>{t('airlineLogosHint')}</Typography><Box sx={{ display: 'flex', flexDirection: 'column' }}>{LOGO_SLOTS.map((slot, index) => <Box key={slot.field}>{index > 0 ? <Divider /> : null}<Box sx={{ py: 1, px: 1.5 }}><ResourceSlotField label={t(slot.labelKey)} resourcePath={(form[slot.field] as string | null) ?? null} onChange={(resourcePath) => setForm((prev) => ({ ...prev, [slot.field]: resourcePath }))} variant="list" imageContain /></Box></Box>)}</Box><Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mt: 2 }}><ThemeColorPicker label={t('primaryBrandColor')} value={((form.brandColors as { primary?: HexColor | null } | undefined)?.primary) ?? null} onChange={(color) => setForm((prev) => ({ ...prev, brandColors: { ...(prev.brandColors as object), primary: color } }))} /><ThemeColorPicker label={t('contrastBrandColor')} value={((form.brandColors as { contrast?: HexColor | null } | undefined)?.contrast) ?? null} onChange={(color) => setForm((prev) => ({ ...prev, brandColors: { ...(prev.brandColors as object), contrast: color } }))} /></Box></> : null}</DialogContent>
    <DialogActions><Button onClick={onClose}>{t('cancel')}</Button><Button onClick={save} variant="contained" disabled={saving || !valid}>{saving ? t('saving') : t('save')}</Button></DialogActions>
  </Dialog>;
}
