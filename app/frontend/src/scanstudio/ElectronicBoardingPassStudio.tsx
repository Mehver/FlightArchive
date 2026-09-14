// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Slider,
  Switch,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { api } from '../api/client';
import { resourceUrl } from '../rfg/api';
import { useTranslation } from '../i18n';
import { useAppState } from '../state/AppState';
import { isValidHexColor, type HexColor } from '../theme/colors';
import { CropCanvas } from './CropCanvas';
import { ElectronicColorPicker } from './ElectronicColorPicker';
import {
  DEFAULT_PRESET_NAME,
  PRESET_NAME_MAX_LENGTH,
  clampElectronicCropToBounds,
  clearLegacyElectronicCropPresetCache,
  electronicCropPresetsFromFlights,
  loadElectronicLastCrop,
  normalizeElectronicCrop,
  saveElectronicLastCrop,
  type ElectronicCropPreset,
  type ElectronicCropRegion,
} from './electronicCropPresets';
import type { ScanStudioDialogProps } from './ScanStudioDialog';
import { scaled, useDialogScale } from '../utils/dialogScale';

type Stage = 'crop' | 'colors';

function validHexOrNull(color: unknown): HexColor | null {
  return isValidHexColor(color) ? color : null;
}

/**
 * Two-stage extraction editor for electronic boarding-pass screenshots.
 * Stage 1 owns an axis-aligned source crop (no rotation) with an optional
 * horizontal mirror symmetry about the image centre; stage 2 extracts one
 * boarding-pass color. Only portable metadata is persisted via the flight update.
 */
export function ElectronicBoardingPassStudio({ open, flight, onSaved, onClose }: ScanStudioDialogProps) {
  const { t } = useTranslation();
  const { notify, showError } = useAppState();
  const dialogScale = useDialogScale();
  const resourcePath = flight.electronicBoardingPassResourcePath;
  const savedCrop = flight.electronicBoardingPass?.extraction?.crop;

  const [stage, setStage] = useState<Stage>('crop');
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageError, setImageError] = useState(false);
  const [magnification, setMagnification] = useState(2);
  const [magnifierEnabled, setMagnifierEnabled] = useState(true);
  const [crop, setCrop] = useState<ElectronicCropRegion>({
    centerX: savedCrop?.centerX ?? 0,
    centerY: savedCrop?.centerY ?? 0,
    width: savedCrop?.width ?? 0,
    height: savedCrop?.height ?? 0,
  });
  const [mirror, setMirror] = useState(savedCrop?.mirrorAcrossImageCenterX ?? false);
  const [presetName, setPresetName] = useState(flight.electronicBoardingPass?.extraction?.presetName ?? '');
  const [presets, setPresets] = useState<ElectronicCropPreset[]>([]);
  const [boardingPassColor, setBoardingPassColor] = useState<HexColor | null>(validHexOrNull(flight.boardingPassColor));
  const [saving, setSaving] = useState(false);

  const cropPreviewRef = useRef<HTMLCanvasElement>(null);
  /**
   * Set once the initial crop has been resolved (local storage → saved
   * presentation → full-image default). Prevents the autosave effect from
   * writing the pre-restoration zero crop back to local storage.
   */
  const initialCropRestoredRef = useRef(false);

  const imageBounds = image ? { width: image.naturalWidth, height: image.naturalHeight } : null;
  const cropUsable = crop.width > 0 && crop.height > 0;

  // The dialog is mounted per editing session; load the bound image once it
  // opens, then restore the crop in priority order: locally persisted region
  // (UI state, independent from any flight record), then the saved
  // presentation attached to the flight, then the full image as a fallback.
  useEffect(() => {
    if (!open || !resourcePath) return;
    initialCropRestoredRef.current = false;
    let cancelled = false;
    const element = new Image();
    element.crossOrigin = 'anonymous';
    element.onload = () => {
      if (cancelled) return;
      setImage(element);
      const bounds = { width: element.naturalWidth, height: element.naturalHeight };
      const local = loadElectronicLastCrop();
      const preferred = local?.crop ?? savedCrop;
      const preferredMirror = local?.mirrorAcrossImageCenterX ?? savedCrop?.mirrorAcrossImageCenterX ?? false;
      setCrop((current) => {
        const restored = preferred && (local?.crop || (savedCrop && current.width > 0 && current.height > 0))
          ? { centerX: preferred.centerX, centerY: preferred.centerY, width: preferred.width, height: preferred.height }
          : { centerX: bounds.width / 2, centerY: bounds.height / 2, width: bounds.width, height: bounds.height };
        const pinned = preferredMirror ? { ...restored, centerX: bounds.width / 2 } : restored;
        return clampElectronicCropToBounds(pinned, bounds);
      });
      setMirror(preferredMirror);
      initialCropRestoredRef.current = true;
    };
    element.onerror = () => {
      if (!cancelled) setImageError(true);
    };
    element.src = resourceUrl(resourcePath);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resourcePath]);

  // Picker entries are rebuilt from current business data rather than the
  // retired browser-only preset cache, so released resources cannot linger.
  useEffect(() => {
    if (!open) return;
    clearLegacyElectronicCropPresetCache();
    let cancelled = false;
    setPresets([]);
    void api.listFlights()
      .then(({ flights }) => {
        if (!cancelled) setPresets(electronicCropPresetsFromFlights(flights));
      })
      .catch(() => {
        if (!cancelled) setPresets([]);
      });
    return () => { cancelled = true; };
  }, [open]);

  /** Apply a crop edit, keeping the region in bounds and pinned when mirroring. */
  const applyCrop = (next: ElectronicCropRegion, mirrorOverride = mirror) => {
    if (!imageBounds) {
      setCrop(next);
      return;
    }
    const pinned = mirrorOverride ? { ...next, centerX: imageBounds.width / 2 } : next;
    setCrop(clampElectronicCropToBounds(pinned, imageBounds));
  };

  const updateCropField = (field: keyof ElectronicCropRegion, value: string) => {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return;
    applyCrop({ ...crop, [field]: parsed });
  };

  const toggleMirror = (checked: boolean) => {
    setMirror(checked);
    if (checked && imageBounds) {
      setCrop((current) => clampElectronicCropToBounds({ ...current, centerX: imageBounds.width / 2 }, imageBounds));
    }
  };

  const applyPresetByName = (name: string) => {
    const preset = presets.find((entry) => entry.name === name);
    if (!preset) return;
    setMirror(preset.mirrorAcrossImageCenterX);
    applyCrop({ ...preset.crop }, preset.mirrorAcrossImageCenterX);
  };

  // Persist the current crop to localStorage so the next editing session can
  // restore it independently from any flight record. The initial restore runs
  // synchronously inside the image-load callback, so the flag is already true
  // by the time this effect fires for the first time.
  useEffect(() => {
    if (!initialCropRestoredRef.current || !cropUsable) return;
    saveElectronicLastCrop({ crop, mirrorAcrossImageCenterX: mirror });
  }, [crop, mirror, cropUsable]);

  // Render a live axis-aligned crop preview from the source image. The
  // electronic studio does not run a worker crop (no rotation), so a canvas
  // drawImage is sufficient.
  useEffect(() => {
    const canvas = cropPreviewRef.current;
    if (!canvas || !image || !cropUsable) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const sourceX = crop.centerX - crop.width / 2;
    const sourceY = crop.centerY - crop.height / 2;
    const maxPreviewWidth = 320;
    const previewScale = Math.min(1, maxPreviewWidth / crop.width);
    const displayWidth = Math.max(1, Math.round(crop.width * previewScale));
    const displayHeight = Math.max(1, Math.round(crop.height * previewScale));
    canvas.width = displayWidth;
    canvas.height = displayHeight;
    context.drawImage(
      image,
      sourceX,
      sourceY,
      crop.width,
      crop.height,
      0,
      0,
      displayWidth,
      displayHeight,
    );
  }, [image, crop, cropUsable]);

  const save = async () => {
    if (!imageBounds || !cropUsable) return;
    setSaving(true);
    // The backend requires a nonempty presetName whenever extraction data is
    // persisted, and strict RGB-or-null colours (never undefined).
    const name = presetName.trim().slice(0, PRESET_NAME_MAX_LENGTH) || DEFAULT_PRESET_NAME;
    const normalized = normalizeElectronicCrop(crop, imageBounds);
    try {
      const result = await api.updateFlight(flight.id, {
        electronicBoardingPass: {
          schemaVersion: 1,
          extraction: {
            crop: { ...normalized, mirrorAcrossImageCenterX: mirror },
            presetName: name,
          },
        },
        boardingPassColor: boardingPassColor ?? null,
      });
      notify(t('studioSaved'));
      onSaved(result.flight);
      onClose();
    } catch (error) {
      showError(error, t('studioSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} aria-labelledby="electronic-studio-title" slotProps={{ paper: { sx: { width: scaled(1100, dialogScale), height: scaled(700, dialogScale), maxWidth: '95vw', maxHeight: '92vh', overflow: 'hidden' } } }}>
      <DialogTitle id="electronic-studio-title">{t('scanStudioTitle', { slot: t('electronicBoardingPass') })}</DialogTitle>
      <DialogContent dividers sx={{ flex: '1 1 auto', minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {!resourcePath ? (
          <Alert severity="info">{t('studioNoAsset')}</Alert>
        ) : imageError ? (
          <Alert severity="error">{t('studioLoadImageFailed')}</Alert>
        ) : !image ? (
          <Box sx={{ display: 'grid', placeItems: 'center', minHeight: 200 }}>
            <CircularProgress aria-label={t('loading')} />
          </Box>
        ) : (
          <Box sx={{ display: 'flex', flex: '1 1 auto', flexDirection: 'column', gap: 2, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
            <Tabs value={stage} onChange={(_event, value) => setStage(value as Stage)} aria-label={t('studioStages')}>
              <Tab value="crop" label={t('studioStepCrop')} />
              <Tab value="colors" label={t('studioStepColors')} disabled={!cropUsable} />
            </Tabs>
            {stage === 'crop' ? (
              <Box sx={{ flex: '1 1 auto', overflow: { xs: 'auto', sm: 'hidden' }, display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 1, minWidth: 0, minHeight: 0 }}>
                <Box sx={{ flex: '1 1 0', height: { xs: 300, sm: 'auto' }, minHeight: { sm: 0 }, minWidth: 0, position: 'relative' }}>
                  <CropCanvas
                    image={image}
                    crop={{ ...crop, rotationDegrees: 0 }}
                    mode="axis-aligned"
                    zoom={1}
                    magnification={magnification}
                    magnifierEnabled={magnifierEnabled}
                    fitToContainer
                    onCropChange={(rect) => applyCrop({ centerX: rect.centerX, centerY: rect.centerY, width: rect.width, height: rect.height })}
                  />
                </Box>
                  <Box sx={{ width: { xs: '100%', sm: 320, md: 380 }, maxWidth: '100%', overflow: 'auto', flex: '0 1 380px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                  <Box>
                    <FormControlLabel
                      control={<Switch size="small" checked={magnifierEnabled} onChange={(e) => setMagnifierEnabled(e.target.checked)} />}
                      label={t('studioMagnifierEnable')}
                      sx={{ ml: 0, '& .MuiFormControlLabel-label': { fontSize: '0.75rem' } }}
                    />
                    <Typography variant="caption" color="text.secondary">
                      {t('studioMagnification')}: {magnification}×
                    </Typography>
                    <Slider size="small" min={2} max={12} step={1} value={magnification} onChange={(_event, value) => setMagnification(value as number)} aria-label={t('studioMagnification')} disabled={!magnifierEnabled} />
                  </Box>
                  <Autocomplete
                    freeSolo
                    size="small"
                    options={presets.map((preset) => preset.name)}
                    inputValue={presetName}
                    onInputChange={(_event, value) => setPresetName(value)}
                    onChange={(_event, value) => {
                      if (typeof value === 'string') applyPresetByName(value);
                    }}
                    renderInput={(params) => <TextField {...params} label={t('studioCropPreset')} helperText={t('studioCropPresetHint')} />}
                  />
                  <Typography variant="caption" color="text.secondary">
                    {t('studioCropParams')}
                  </Typography>
                  <TextField
                    size="small"
                    type="number"
                    label={t('studioCenterX')}
                    value={Math.round(crop.centerX * 100) / 100}
                    disabled={mirror}
                    onChange={(event) => updateCropField('centerX', event.target.value)}
                    slotProps={{ htmlInput: { step: 1 } }}
                  />
                  <TextField
                    size="small"
                    type="number"
                    label={t('studioCenterY')}
                    value={Math.round(crop.centerY * 100) / 100}
                    onChange={(event) => updateCropField('centerY', event.target.value)}
                    slotProps={{ htmlInput: { step: 1 } }}
                  />
                  <TextField
                    size="small"
                    type="number"
                    label={t('studioCropWidth')}
                    value={Math.round(crop.width * 100) / 100}
                    onChange={(event) => updateCropField('width', event.target.value)}
                    slotProps={{ htmlInput: { step: 1, min: 1 } }}
                  />
                  <TextField
                    size="small"
                    type="number"
                    label={t('studioCropHeight')}
                    value={Math.round(crop.height * 100) / 100}
                    onChange={(event) => updateCropField('height', event.target.value)}
                    slotProps={{ htmlInput: { step: 1, min: 1 } }}
                  />
                  <FormControlLabel control={<Switch checked={mirror} onChange={(event) => toggleMirror(event.target.checked)} />} label={t('studioMirrorCenterX')} />
                  {cropUsable ? (
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        {t('studioCropPreview')}
                      </Typography>
                      <canvas
                        ref={cropPreviewRef}
                        role="img"
                        aria-label={t('studioCropPreviewAlt')}
                        style={{ display: 'block', maxWidth: '100%', height: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 4, marginTop: 4, background: '#000' }}
                      />
                    </Box>
                  ) : null}
                </Box>
              </Box>
            ) : (
              <Box sx={{ flex: '1 1 auto', maxWidth: '100%', position: 'relative', overflow: 'auto', minHeight: 0 }}>
                <ElectronicColorPicker
                  image={image}
                  crop={crop}
                  color={boardingPassColor}
                  onColorChange={setBoardingPassColor}
                  magnifierEnabled={magnifierEnabled}
                  magnification={magnification}
                />
              </Box>
            )}
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        {stage === 'crop' ? (
          <Button variant="contained" disabled={!image || !cropUsable} onClick={() => setStage('colors')}>
            {t('studioNextColors')}
          </Button>
        ) : (
          <>
            <Button onClick={() => setStage('crop')}>{t('studioBack')}</Button>
            <Button variant="contained" disabled={!image || saving || !cropUsable} onClick={() => void save()}>
              {saving ? t('saving') : t('studioSave')}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
