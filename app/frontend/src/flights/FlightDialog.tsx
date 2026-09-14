// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Create/edit dialog for a flight record, including asset bindings. */

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Autocomplete,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  InputAdornment,
  TextField,
  Typography,
} from '@mui/material';
import { scaled, useDialogScale } from '../utils/dialogScale';
import CloseIcon from '@mui/icons-material/Close';
import CreditCardIcon from '@mui/icons-material/CreditCard';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import type { Airport, Catalogs, ElectronicBoardingPassPresentation, FlightRecord, HexColor } from '../api/types';
import { displayName } from '../utils/format';
import { useTranslation } from '../i18n';
import {
  isAirportCode,
  normalizeAirlineCode,
  normalizeAircraftRegistration,
  normalizeAirportCode,
  normalizeDate,
  normalizeFlightNumber,
  normalizeTime,
  validateFlightInput,
  type FlightValidationField,
} from './flightFormat';
import { ResourceImage } from '../resources/ResourceImage';
import { ResourcePickerDialog } from '../resources/ResourcePickerDialog';
import { ResourceSlotField } from '../resources/ResourceSlotField';
import { ScanStudioDialog, type BoardingPassSlot } from '../scanstudio/ScanStudioDialog';
import { ThemeColorPicker } from '../components/ThemeColorPicker';

export interface FlightFormValues {
  flightNumber: string;
  airlineCode: string;
  departureAirport: string;
  arrivalAirport: string;
  departureTerminal: string;
  arrivalTerminal: string;
  departureDate: string;
  departureTime: string;
  arrivalTime: string;
  aircraftTypeIcao: string;
  registration: string;
  seat: string;
  notes: string;
  paperBoardingPassFrontResourcePath: string | null;
  paperBoardingPassBackResourcePath: string | null;
  electronicBoardingPassResourcePath: string | null;
  boardingPassColor: HexColor | null;
  attachmentResourcePaths: string[];
}

const EMPTY_FORM: FlightFormValues = {
  flightNumber: '',
  airlineCode: '',
  departureAirport: '',
  arrivalAirport: '',
  departureTerminal: '',
  arrivalTerminal: '',
  departureDate: '',
  departureTime: '',
  arrivalTime: '',
  aircraftTypeIcao: '',
  registration: '',
  seat: '',
  notes: '',
  paperBoardingPassFrontResourcePath: null,
  paperBoardingPassBackResourcePath: null,
  electronicBoardingPassResourcePath: null,
  boardingPassColor: null,
  attachmentResourcePaths: [],
};

export function airportTerminalOptions(airports: readonly Airport[], airportCode: string, locale: string): string[] {
  const airport = airports.find((entry) => entry.code === airportCode);
  if (!airport) return [];
  const seen = new Set<string>();
  return airport.terminals
    .filter((terminal) => {
      const key = terminal.trim().toLocaleLowerCase(locale);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(new Intl.Collator(locale, { numeric: true, sensitivity: 'base' }).compare);
}

export function flightToForm(flight: FlightRecord): FlightFormValues {
  return {
    flightNumber: normalizeFlightNumber(flight.flightNumber),
    airlineCode: normalizeAirlineCode(flight.airlineCode),
    departureAirport: normalizeAirportCode(flight.departureAirport),
    arrivalAirport: normalizeAirportCode(flight.arrivalAirport),
    departureTerminal: flight.departureAirport ? flight.departureTerminal ?? '' : '',
    arrivalTerminal: flight.arrivalAirport ? flight.arrivalTerminal ?? '' : '',
    departureDate: normalizeDate(flight.departureDate),
    departureTime: normalizeTime(flight.departureTime ?? ''),
    arrivalTime: normalizeTime(flight.arrivalTime ?? ''),
    aircraftTypeIcao: flight.aircraftTypeIcao?.toUpperCase() ?? '',
    registration: normalizeAircraftRegistration(flight.registration ?? ''),
    seat: flight.seat ?? '',
    notes: flight.notes,
    paperBoardingPassFrontResourcePath: flight.paperBoardingPassFrontResourcePath,
    paperBoardingPassBackResourcePath: flight.paperBoardingPassBackResourcePath,
    electronicBoardingPassResourcePath: flight.electronicBoardingPassResourcePath,
    boardingPassColor: flight.boardingPassColor ?? null,
    attachmentResourcePaths: [...flight.attachmentResourcePaths],
  };
}

type FlightFormPayloadInput = Omit<FlightFormValues, 'boardingPassColor'> &
  Partial<Pick<FlightFormValues, 'boardingPassColor'>>;

export function formToPayload(
  form: FlightFormPayloadInput,
  currentPresentation: ElectronicBoardingPassPresentation | null = null,
): Partial<FlightRecord> {
  const opt = (value: string) => (value.trim() ? value.trim() : null);
  return {
    flightNumber: normalizeFlightNumber(form.flightNumber),
    airlineCode: normalizeAirlineCode(form.airlineCode),
    departureAirport: normalizeAirportCode(form.departureAirport),
    arrivalAirport: normalizeAirportCode(form.arrivalAirport),
    departureTerminal: opt(form.departureTerminal),
    arrivalTerminal: opt(form.arrivalTerminal),
    departureDate: normalizeDate(form.departureDate),
    departureTime: opt(normalizeTime(form.departureTime)),
    arrivalTime: opt(normalizeTime(form.arrivalTime)),
    aircraftTypeIcao: opt(form.aircraftTypeIcao)?.toUpperCase() ?? null,
    registration: normalizeAircraftRegistration(form.registration) || null,
    seat: opt(form.seat)?.toUpperCase() ?? null,
    notes: form.notes.trim(),
    paperBoardingPassFrontResourcePath: form.paperBoardingPassFrontResourcePath,
    paperBoardingPassBackResourcePath: form.paperBoardingPassBackResourcePath,
    electronicBoardingPassResourcePath: form.electronicBoardingPassResourcePath,
    electronicBoardingPass: form.electronicBoardingPassResourcePath
      ? {
          ...currentPresentation,
          schemaVersion: 1,
        }
      : null,
    boardingPassColor: form.boardingPassColor ?? null,
    attachmentResourcePaths: [...new Set(form.attachmentResourcePaths)].slice(0, 32),
  };
}

const SLOT_FIELD: Record<BoardingPassSlot, 'paperBoardingPassFrontResourcePath' | 'paperBoardingPassBackResourcePath' | 'electronicBoardingPassResourcePath'> = {
  paperBoardingPassFront: 'paperBoardingPassFrontResourcePath', paperBoardingPassBack: 'paperBoardingPassBackResourcePath', electronicBoardingPass: 'electronicBoardingPassResourcePath',
};

const SLOT_LABEL: Record<BoardingPassSlot, 'boardingPassFront' | 'boardingPassBack' | 'electronicBoardingPass'> = {
  paperBoardingPassFront: 'boardingPassFront',
  paperBoardingPassBack: 'boardingPassBack',
  electronicBoardingPass: 'electronicBoardingPass',
};

const BP_SLOTS: BoardingPassSlot[] = ['paperBoardingPassFront', 'paperBoardingPassBack', 'electronicBoardingPass'];

export function FlightDialog({
  open,
  initial,
  catalogs,
  saving,
  onSave,
  onClose,
  onRecordChanged,
}: {
  open: boolean;
  initial: FlightRecord | null;
  catalogs: Catalogs | null;
  saving: boolean;
  onSave: (payload: Partial<FlightRecord>) => void;
  onClose: () => void;
  /** Fired when the boarding-pass crop & layout dialog persisted a layout for the edited record. */
  onRecordChanged?: (flight: FlightRecord) => void;
}) {
  const { t, language } = useTranslation();
  const dialogScale = useDialogScale();
  const [form, setForm] = useState<FlightFormValues>(EMPTY_FORM);
  const [record, setRecord] = useState<FlightRecord | null>(null);
  const [studioSlot, setStudioSlot] = useState<BoardingPassSlot | null>(null);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);


  useEffect(() => {
    if (open) {
      setForm(initial ? flightToForm(initial) : EMPTY_FORM);
      setRecord(initial);
      setStudioSlot(null);
      setAttachmentsOpen(false);
      setSubmitAttempted(false);
    }
  }, [open, initial]);

  const set = (key: keyof FlightFormValues) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const setAirport = (
    airportField: 'departureAirport' | 'arrivalAirport',
    terminalField: 'departureTerminal' | 'arrivalTerminal',
  ) => (airportCode: string) => setForm((prev) => (
    prev[airportField] === airportCode
      ? prev
      : { ...prev, [airportField]: airportCode, [terminalField]: '' }
  ));

  const setResource = (key: keyof FlightFormValues) => (resourcePath: string | null) => setForm((prev) => ({ ...prev, [key]: resourcePath }));

  const airlineOptions = useMemo(
    () =>
      (catalogs?.airlines ?? []).map((a) => ({
        code: a.code,
        label: `${a.code} — ${displayName(a.nameZh, a.nameEn, t('notAvailable'))}`,
      })),
    [catalogs, t],
  );
  const airportOptions = useMemo(
    () =>
      (catalogs?.airports ?? []).map((a) => ({
        code: a.code,
        label: `${a.code} — ${displayName(a.nameZh, a.nameEn, t('notAvailable'))} (${a.cityEn || a.cityZh})`,
      })),
    [catalogs, t],
  );
  const aircraftOptions = useMemo(
    () =>
      (catalogs?.aircraftTypes ?? []).map((a) => ({
        code: a.icao,
        label: a.iata
          ? `${a.icao} · ${a.iata} — ${a.displayName}`
          : `${a.icao} — ${a.displayName}`,
      })),
    [catalogs],
  );
  const departureTerminalOptions = useMemo(
    () => airportTerminalOptions(catalogs?.airports ?? [], form.departureAirport, language),
    [catalogs, form.departureAirport, language],
  );
  const arrivalTerminalOptions = useMemo(
    () => airportTerminalOptions(catalogs?.airports ?? [], form.arrivalAirport, language),
    [catalogs, form.arrivalAirport, language],
  );
  const hasDepartureAirport = isAirportCode(form.departureAirport);
  const hasArrivalAirport = isAirportCode(form.arrivalAirport);
  const validationErrors = validateFlightInput(form);
  const visibleError = (field: FlightValidationField) => {
    const error = validationErrors[field];
    return error === 'format' || (error === 'required' && submitAttempted) ? error : undefined;
  };
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitAttempted(true);
    if (Object.keys(validationErrors).length > 0) return;
    onSave(formToPayload(form, record?.electronicBoardingPass ?? null));
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      aria-labelledby="flight-dialog-title"
      slotProps={{ paper: { sx: { maxHeight: '90vh', width: scaled(900, dialogScale), maxWidth: '95vw' } } }}
    >
      <DialogTitle id="flight-dialog-title">{initial ? t('editFlight') : t('addFlight')}</DialogTitle>
      <Box component="form" noValidate onSubmit={handleSubmit}>
      <DialogContent dividers sx={{ overflow: 'auto', maxHeight: 'calc(90vh - 120px)' }}>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, pt: 0.5 }}>
          <Autocomplete
            options={airlineOptions}
            getOptionLabel={(o) => (typeof o === 'string' ? o : o.label)}
            value={airlineOptions.find((o) => o.code === form.airlineCode) ?? null}
            onChange={(_e, option) => set('airlineCode')(normalizeAirlineCode(typeof option === 'string' ? option : option?.code ?? ''))}
            freeSolo
            inputValue={form.airlineCode}
            onInputChange={(_e, value, reason) => {
              if (reason === 'input') set('airlineCode')(normalizeAirlineCode(value));
            }}
            sx={{ flex: '1 1 240px' }}
            renderInput={(params) => {
              const error = visibleError('airlineCode');
              return <TextField {...params} label={t('airline')} required error={Boolean(error)} />;
            }}
          />
          <TextField
            label={t('flightNumber')}
            value={form.flightNumber}
            onChange={(e) => set('flightNumber')(normalizeFlightNumber(e.target.value))}
            required
            error={Boolean(visibleError('flightNumber'))}
            sx={{ flex: '0 1 150px' }}
            slotProps={{
              input: { startAdornment: <InputAdornment position="start">{form.airlineCode.trim().toUpperCase()}</InputAdornment> },
              htmlInput: { inputMode: 'numeric', maxLength: 4, pattern: '[0-9]*', 'aria-label': t('flightNumber') },
            }}
          />
          <TextField
            label={t('date')}
            type="date"
            value={form.departureDate}
            onChange={(e) => set('departureDate')(normalizeDate(e.target.value))}
            required
            error={Boolean(visibleError('departureDate'))}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ flex: '1 1 160px' }}
          />
          <TextField
            label={t('departureTime')}
            type="time"
            value={form.departureTime}
            onChange={(e) => set('departureTime')(normalizeTime(e.target.value))}
            error={Boolean(visibleError('departureTime'))}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ flex: '1 1 140px' }}
          />
          <TextField
            label={t('arrivalTime')}
            type="time"
            value={form.arrivalTime}
            onChange={(e) => set('arrivalTime')(normalizeTime(e.target.value))}
            error={Boolean(visibleError('arrivalTime'))}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ flex: '1 1 140px' }}
          />
          <Autocomplete
            options={airportOptions}
            getOptionLabel={(o) => (typeof o === 'string' ? o : o.label)}
            value={airportOptions.find((o) => o.code === form.departureAirport) ?? null}
            onChange={(_e, option) => setAirport('departureAirport', 'departureTerminal')(normalizeAirportCode(typeof option === 'string' ? option : option?.code ?? ''))}
            freeSolo
            inputValue={form.departureAirport}
            onInputChange={(_e, value, reason) => {
              if (reason === 'input') setAirport('departureAirport', 'departureTerminal')(normalizeAirportCode(value));
            }}
            sx={{ flex: '1 1 260px' }}
            renderInput={(params) => {
              const error = visibleError('departureAirport');
              return <TextField {...params} label={t('originAirport')} required error={Boolean(error)} />;
            }}
          />
          <Autocomplete
            clearOnEscape
            disabled={!hasDepartureAirport || departureTerminalOptions.length === 0}
            options={departureTerminalOptions}
            value={form.departureTerminal}
            isOptionEqualToValue={(option, value) => option === value}
            onChange={(_e, terminal) => set('departureTerminal')(terminal ?? '')}
            onInputChange={(_e, terminal, reason) => {
              if (reason === 'reset') set('departureTerminal')(terminal);
            }}
            sx={{ flex: '0 1 160px' }}
            renderInput={(params) => <TextField {...params} label={t('departureTerminal')} slotProps={{ ...params.slotProps, htmlInput: { ...params.slotProps.htmlInput, maxLength: 16 } }} />}
          />
          <Autocomplete
            options={airportOptions}
            getOptionLabel={(o) => (typeof o === 'string' ? o : o.label)}
            value={airportOptions.find((o) => o.code === form.arrivalAirport) ?? null}
            onChange={(_e, option) => setAirport('arrivalAirport', 'arrivalTerminal')(normalizeAirportCode(typeof option === 'string' ? option : option?.code ?? ''))}
            freeSolo
            inputValue={form.arrivalAirport}
            onInputChange={(_e, value, reason) => {
              if (reason === 'input') setAirport('arrivalAirport', 'arrivalTerminal')(normalizeAirportCode(value));
            }}
            sx={{ flex: '1 1 260px' }}
            renderInput={(params) => {
              const error = visibleError('arrivalAirport');
              return <TextField {...params} label={t('destinationAirport')} required error={Boolean(error)} />;
            }}
          />
          <Autocomplete
            clearOnEscape
            disabled={!hasArrivalAirport || arrivalTerminalOptions.length === 0}
            options={arrivalTerminalOptions}
            value={form.arrivalTerminal}
            isOptionEqualToValue={(option, value) => option === value}
            onChange={(_e, terminal) => set('arrivalTerminal')(terminal ?? '')}
            onInputChange={(_e, terminal, reason) => {
              if (reason === 'reset') set('arrivalTerminal')(terminal);
            }}
            sx={{ flex: '0 1 160px' }}
            renderInput={(params) => <TextField {...params} label={t('arrivalTerminal')} slotProps={{ ...params.slotProps, htmlInput: { ...params.slotProps.htmlInput, maxLength: 16 } }} />}
          />
          <Autocomplete
            options={aircraftOptions}
            getOptionLabel={(o) => (typeof o === 'string' ? o : o.label)}
            value={aircraftOptions.find((o) => o.code === form.aircraftTypeIcao) ?? null}
            onChange={(_e, option) => set('aircraftTypeIcao')(typeof option === 'string' ? option : option?.code ?? '')}
            freeSolo
            inputValue={form.aircraftTypeIcao}
            onInputChange={(_e, value, reason) => {
              if (reason === 'input') set('aircraftTypeIcao')(value.toUpperCase());
            }}
            sx={{ flex: '1 1 200px' }}
            renderInput={(params) => {
              const error = visibleError('aircraftTypeIcao');
              return <TextField
                {...params}
                label={t('aircraftType')}
                error={Boolean(error)}
                slotProps={{
                  ...params.slotProps,
                  htmlInput: { ...params.slotProps.htmlInput, maxLength: 4 },
                }}
              />;
            }}
          />
          <TextField
            label={t('registration')}
            value={form.registration}
            onChange={(e) => set('registration')(normalizeAircraftRegistration(e.target.value))}
            error={Boolean(visibleError('registration'))}
            sx={{ flex: '1 1 140px' }}
            slotProps={{ htmlInput: { maxLength: 16 } }}
            placeholder={t('registrationPlaceholder')}
          />
          <TextField
            label={t('seat')}
            value={form.seat}
            onChange={(e) => set('seat')(e.target.value)}
            sx={{ flex: '0 1 110px' }}
            slotProps={{ htmlInput: { maxLength: 6 } }}
            placeholder={t('seatPlaceholder')}
          />
          <TextField
            label={t('notes')}
            value={form.notes}
            onChange={(e) => set('notes')(e.target.value)}
            multiline
            minRows={2}
            fullWidth
          />
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, width: '100%' }}>
            <ThemeColorPicker
              label={t('boardingPassColor')}
              value={form.boardingPassColor}
              onChange={(color) => setForm((prev) => ({ ...prev, boardingPassColor: color }))}
            />
          </Box>
        </Box>

        <Divider sx={{ my: 2 }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
          <CreditCardIcon sx={{ fontSize: 22, color: 'text.secondary' }} />
          <Typography variant="h6" sx={{ fontWeight: 700, fontSize: '1.15rem' }}>
            {t('boardingPasses')}
          </Typography>
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ display: 'block', mb: 2, pl: 0.5 }}>
          {t('boardingPassesHint')}
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
          {BP_SLOTS.map((slot, idx) => {
            const field = SLOT_FIELD[slot];
            const resourcePath = form[field] as string | null;
            const bindingDirty = record !== null && resourcePath !== (record?.[field] ?? null);
            const hasLayout = slot === 'electronicBoardingPass'
              ? Boolean(record?.electronicBoardingPass?.extraction)
              : Boolean(record?.paperBoardingPassLayouts?.[slot]);
            return (
              <Box key={slot}>
                {idx > 0 && <Divider />}
                <Box sx={{ py: 1, px: 1.5 }}>
                  <ResourceSlotField
                    label={t(SLOT_LABEL[slot])}
                    resourcePath={resourcePath}
                    onChange={setResource(field)}
                    onOpenStudio={record ? () => setStudioSlot(slot) : undefined}
                    studioDisabled={bindingDirty}
                    studioDisabledTooltip={bindingDirty ? t('studioNeedsSavedFlight') : undefined}
                    hasLayout={hasLayout}
                    variant="list"
                  />
                </Box>
              </Box>
            );
          })}
        </Box>
        <Divider sx={{ my: 2.5 }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
          <AttachFileIcon sx={{ fontSize: 22, color: 'text.secondary' }} />
          <Typography variant="h6" sx={{ fontWeight: 700, fontSize: '1.15rem' }}>
            {t('attachments')}
          </Typography>
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ display: 'block', mb: 2, pl: 0.5 }}>
          {t('attachmentsHint')}
        </Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
           {form.attachmentResourcePaths.map((resourcePath) => (
             <Box key={resourcePath} sx={{ position: 'relative' }}>
               <ResourceImage resourcePath={resourcePath} size={56} alt={t('attachments')} />
              <IconButton
                size="small"
                aria-label={t('clearResource')}
                onClick={() =>
                   setForm((prev) => ({ ...prev, attachmentResourcePaths: prev.attachmentResourcePaths.filter((path) => path !== resourcePath) }))
                }
                sx={{
                  position: 'absolute',
                  top: -8,
                  right: -8,
                  bgcolor: 'background.paper',
                  border: 1,
                  borderColor: 'divider',
                  p: 0.25,
                }}
              >
                <CloseIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Box>
          ))}
          <Button size="small" variant="outlined" onClick={() => setAttachmentsOpen(true)}>
             {t('selectResource')}
          </Button>
          <Typography variant="caption" color="text.secondary" aria-live="polite">
             {t('attachmentsCount', { count: form.attachmentResourcePaths.length })}
          </Typography>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('close')}</Button>
          <Button type="submit" variant="contained" disabled={saving}>
            {saving ? t('saving') : t('save')}
          </Button>
      </DialogActions>
      </Box>

       <ResourcePickerDialog
        open={attachmentsOpen}
        title={t('attachments')}
        multiple
         selected={form.attachmentResourcePaths}
          onConfirm={(paths) => {
           setForm((prev) => ({ ...prev, attachmentResourcePaths: [...new Set(paths)].slice(0, 32) }));
          setAttachmentsOpen(false);
        }}
        onClose={() => setAttachmentsOpen(false)}
      />
      {record && studioSlot ? (
        <ScanStudioDialog
          open
          flight={record}
          slot={studioSlot}
          onSaved={(updated) => {
            setRecord(updated);
            setForm((prev) => ({ ...prev, ...pickAssetFields(flightToForm(updated)) }));
            onRecordChanged?.(updated);
            setStudioSlot(null);
          }}
          onClose={() => setStudioSlot(null)}
        />
      ) : null}
    </Dialog>
  );
}

function pickAssetFields(form: FlightFormValues): Partial<FlightFormValues> {
  return {
    paperBoardingPassFrontResourcePath: form.paperBoardingPassFrontResourcePath,
    paperBoardingPassBackResourcePath: form.paperBoardingPassBackResourcePath,
    electronicBoardingPassResourcePath: form.electronicBoardingPassResourcePath,
    boardingPassColor: form.boardingPassColor,
    attachmentResourcePaths: form.attachmentResourcePaths,
  };
}
