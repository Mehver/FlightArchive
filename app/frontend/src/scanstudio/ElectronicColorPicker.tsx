// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, InputAdornment, Stack, TextField, Typography } from '@mui/material';
import { useTranslation } from '../i18n';
import { hexToCss, isValidHexColor, rgbToHex, type HexColor } from '../theme/colors';
import { sampleColorAtCenter, type PixelRect } from './colorExtraction';
import type { ElectronicCropRegion } from './electronicCropPresets';

interface ElectronicColorPickerProps {
  image: HTMLImageElement;
  crop: ElectronicCropRegion;
  color: HexColor | null;
  onColorChange: (color: HexColor) => void;
  /** When false the floating magnifier is hidden. Defaults to true. */
  magnifierEnabled?: boolean;
  /** Magnification level for the floating magnifier. Defaults to 2. */
  magnification?: number;
}

const HEX_COLOR_RE = /^#[0-9A-F]{6}$/;

/** Backing resolution of the magnifier canvas. */
const MAGNIFIER_BACKING = 320;
/** CSS pixel size of the floating magnifier viewport. */
const MAGNIFIER_DISPLAY_SIZE = 160;
/** Offset from the pointer cursor to the magnifier top-left (CSS px). */
const MAGNIFIER_OFFSET = 8;

/**
 * Colour stage of the electronic studio. The crop-centre average is the default
 * boarding-pass color; clicking a source pixel or typing a value explicitly
 * replaces it.
 */
export function ElectronicColorPicker({
  image,
  crop,
  color,
  onColorChange,
  magnifierEnabled = true,
  magnification = 2,
}: ElectronicColorPickerProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const magnifierRef = useRef<HTMLCanvasElement>(null);
  const [pixels, setPixels] = useState<ImageData | null>(null);
  /** Cursor position relative to the container for the floating magnifier. */
  const [cursorCss, setCursorCss] = useState<{ x: number; y: number } | null>(null);
  /** Image-space coordinate under the cursor. */
  const [imagePointer, setImagePointer] = useState<{ x: number; y: number } | null>(null);
  const pixelCrop: PixelRect = {
    x: crop.centerX - crop.width / 2,
    y: crop.centerY - crop.height / 2,
    width: crop.width,
    height: crop.height,
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(image, 0, 0);
    setPixels(context.getImageData(0, 0, canvas.width, canvas.height));
  }, [image]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    context.strokeStyle = '#ffeb3b';
    context.lineWidth = 2;
    context.strokeRect(pixelCrop.x, pixelCrop.y, pixelCrop.width, pixelCrop.height);
  }, [image, pixelCrop.x, pixelCrop.y, pixelCrop.width, pixelCrop.height]);

  useEffect(() => {
    if (!pixels) return;
    const sampled = sampleColorAtCenter(pixels, pixelCrop);
    if (sampled && !color) onColorChange(rgbToHex(sampled));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pixels]);

  const extract = () => {
    if (!pixels) return;
    const sampled = sampleColorAtCenter(pixels, pixelCrop);
    if (sampled) onColorChange(rgbToHex(sampled));
  };

  /** Convert a mouse event to image-space coordinates. */
  const toImagePoint = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * canvas.width,
      y: ((event.clientY - bounds.top) / bounds.height) * canvas.height,
    };
  }, []);

  const pickAtCanvasPoint = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!pixels) return;
    const point = toImagePoint(event);
    if (!point) return;
    const x = Math.floor(point.x);
    const y = Math.floor(point.y);
    const color = sampleColorAtCenter(pixels, { x, y, width: 1, height: 1 }, 1);
    if (color) {
      const hex = rgbToHex(color);
      onColorChange(hex);
    }
  };

  const onCanvasMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    setCursorCss({
      x: event.clientX - containerRect.left,
      y: event.clientY - containerRect.top,
    });
    setImagePointer(toImagePoint(event));
  };

  const onCanvasMouseLeave = () => {
    setCursorCss(null);
    setImagePointer(null);
  };

  /** Render source pixels and the bold crop boundary around the cursor. */
  useEffect(() => {
    const canvas = magnifierRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context || !imagePointer) {
      context?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    canvas.width = MAGNIFIER_BACKING;
    canvas.height = MAGNIFIER_BACKING;
    const sourceSize = Math.min(canvas.width / magnification, image.naturalWidth, image.naturalHeight);
    const sx = Math.max(0, Math.min(imagePointer.x - sourceSize / 2, image.naturalWidth - sourceSize));
    const sy = Math.max(0, Math.min(imagePointer.y - sourceSize / 2, image.naturalHeight - sourceSize));
    const m = canvas.width / sourceSize;
    context.imageSmoothingEnabled = false;
    context.drawImage(image, sx, sy, sourceSize, sourceSize, 0, 0, canvas.width, canvas.height);
    // Draw crop rectangle outline inside the magnifier
    const rx = (pixelCrop.x - sx) * m;
    const ry = (pixelCrop.y - sy) * m;
    const rw = pixelCrop.width * m;
    const rh = pixelCrop.height * m;
    context.strokeStyle = '#ffeb3b';
    context.lineWidth = 5;
    context.strokeRect(rx, ry, rw, rh);
  }, [image, imagePointer, magnification, pixelCrop.x, pixelCrop.y, pixelCrop.width, pixelCrop.height]);

  /** Position the magnifier to the bottom-right of the cursor, clamped inside the container. */
  const magnifierStyle = useMemo<React.CSSProperties>(() => {
    const container = containerRef.current;
    const base: React.CSSProperties = {
      position: 'absolute',
      width: MAGNIFIER_DISPLAY_SIZE,
      height: MAGNIFIER_DISPLAY_SIZE,
      pointerEvents: 'none',
      zIndex: 10,
      borderRadius: 6,
      border: '2px solid rgba(255,255,255,0.85)',
      boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
      display: magnifierEnabled && cursorCss && imagePointer ? 'block' : 'none',
    };
    if (!cursorCss || !container) return base;
    const cRect = container.getBoundingClientRect();
    let left = cursorCss.x + MAGNIFIER_OFFSET;
    let top = cursorCss.y + MAGNIFIER_OFFSET;
    if (left + MAGNIFIER_DISPLAY_SIZE > cRect.width) left = cursorCss.x - MAGNIFIER_DISPLAY_SIZE - MAGNIFIER_OFFSET;
    if (top + MAGNIFIER_DISPLAY_SIZE > cRect.height) top = cursorCss.y - MAGNIFIER_DISPLAY_SIZE - MAGNIFIER_OFFSET;
    left = Math.max(0, left);
    top = Math.max(0, top);
    return { ...base, left, top };
  }, [cursorCss, imagePointer, magnifierEnabled]);

  const updateHex = (raw: string) => {
    const cleaned = raw.replace(/[^0-9A-Fa-f]/g, '').toUpperCase().slice(0, 6);
    if (cleaned.length === 6) {
      const candidate = `#${cleaned}` as HexColor;
      if (HEX_COLOR_RE.test(candidate)) {
        onColorChange(candidate);
      }
    }
  };

  return (
    <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
      <Box ref={containerRef} sx={{ flex: '2 1 480px', minWidth: 0, position: 'relative' }}>
        <canvas
          ref={canvasRef}
          onClick={pickAtCanvasPoint}
          onMouseMove={onCanvasMouseMove}
          onMouseLeave={onCanvasMouseLeave}
          role="img"
          aria-label={t('studioEyedropperCanvas')}
          style={{ cursor: 'crosshair', display: 'block', maxWidth: '100%', height: 'auto', border: '1px solid #999' }}
        />
        <canvas
          ref={magnifierRef}
          width={MAGNIFIER_BACKING}
          height={MAGNIFIER_BACKING}
          role="img"
          aria-label={t('studioMagnifierCanvas')}
          style={{ ...magnifierStyle, imageRendering: 'pixelated' }}
        />
      </Box>
      <Stack spacing={2} sx={{ flex: '1 1 280px', minWidth: 0 }}>
        <Typography variant="caption" color="text.secondary">
          {t('studioColorPickHint')}
        </Typography>
        <Button variant="outlined" onClick={extract} disabled={!pixels}>
          {t('studioExtractColor')}
        </Button>
        <HexColorControl label={t('boardingPassColor')} value={color} onChange={updateHex} />
      </Stack>
    </Box>
  );
}

function HexColorControl({ label, value, onChange }: { label: string; value: HexColor | null; onChange: (raw: string) => void }) {
  const [inputValue, setInputValue] = useState(value ? value.slice(1) : '');

  useEffect(() => {
    setInputValue(value ? value.slice(1) : '');
  }, [value]);

  const handleChange = (raw: string) => {
    const cleaned = raw.replace(/[^0-9A-Fa-f]/g, '').toUpperCase().slice(0, 6);
    setInputValue(cleaned);
    if (cleaned.length === 6) {
      const candidate = `#${cleaned}`;
      if (isValidHexColor(candidate)) onChange(candidate);
    }
  };

  const isComplete = inputValue.length === 6;
  const isValid = !isComplete || isValidHexColor(`#${inputValue}` as HexColor);
  const previewColor = isComplete && isValid && value ? hexToCss(value) : 'transparent';

  return (
    <Box role="group" aria-label={label} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
      <Box aria-label={`${label} preview`} sx={{ width: 32, height: 32, border: '1px solid', borderColor: 'divider', bgcolor: previewColor }} />
      <Typography variant="body2">{label}</Typography>
      <TextField
        value={inputValue}
        onChange={(event) => handleChange(event.target.value)}
        error={!isValid}
        placeholder="RRGGBB"
        size="small"
        sx={{ flex: '1 1 120px', minWidth: 110 }}
        slotProps={{
          input: {
            startAdornment: <InputAdornment position="start">#</InputAdornment>,
          },
          htmlInput: { maxLength: 6, inputMode: 'text', autoCapitalize: 'characters', style: { textTransform: 'uppercase', letterSpacing: '0.1em', fontFamily: 'monospace' } },
        }}
      />
    </Box>
  );
}
