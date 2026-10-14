// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause
//
// Boarding-pass crop & layout dialog.
// (BSD 3-Clause License, Copyright (c) 2026 Mehver
// (https://github.com/Mehver). All rights reserved.)
//
// Canonical geometry model:
// - Stage 1 ("Detect & crop") owns a source-image rotated rectangle: centre,
//   width, height, and angle in source pixels. Its four drawing points are
//   derived for editing only. The worker samples that rectangle into an upright
//   crop, so the source angle never re-enters Stage 2. Navigation, auto-crop,
//   and saving require the complete rectangle to remain inside the source.
// - Stage 2 ("Place on template") owns only a placement transform of the
//   already-rectified crop in template coordinates: centre/size plus
//   `rotationDegrees`, which starts at 0 after a new crop and never
//   incorporates the source crop angle.
//
// Interactive crop processing runs in the browser against a bounded same-origin
// relay bitmap in the original logical coordinate system. Only portable, image-free paper boarding-pass layout metadata is
// persisted via the normal flight update path; backend previews are disposable.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Slider,
  Switch,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useBusinessData } from '../domain/BusinessDataProvider';
import { assertDecodedLimits, loadStudioSource, type StudioSource } from '../resources/browserImageRenderer';
import type { FlightRecord, PaperBoardingPassLayout } from '../api/types';
import { useAppState } from '../state/AppState';
import { useTranslation, type TranslationKey } from '../i18n';
import { ScanWorkerClient } from './scanWorkerClient';
import { DETECTION_ALGORITHMS, type DetectionAlgorithm } from './scanWorkerProtocol';
import { templateById, templatesForSide, type BoardingPassSide, type BoardingPassTemplate } from './templates';
import {
  clamp,
  defaultQuad,
  isUsableQuad,
  isQuadWithinBounds,
  mapCropRectBetweenBounds,
  normalizeQuadGeometry,
  quadEdgeLength,
  rectFromQuad,
  rectToQuad,
  type Quad,
  type QuadBounds,
} from './cropGeometry';
import { calculateAutoFit } from './placementFit';
import { CropCanvas } from './CropCanvas';
import { scaled, useDialogScale } from '../utils/dialogScale';

export type BoardingPassSlot = 'paperBoardingPassFront' | 'paperBoardingPassBack' | 'electronicBoardingPass';

const TEMPLATE_COLOR_PALETTE = [
  { color: '#ff0000', labelKey: 'studioColorRed' as const },
  { color: '#00ffff', labelKey: 'studioColorCyan' as const },
  { color: '#ffff00', labelKey: 'studioColorYellow' as const },
] as const;

const DEFAULT_TEMPLATE_COLOR = TEMPLATE_COLOR_PALETTE[1].color; // Cyan

const SLOT_ASSET_FIELD: Record<BoardingPassSlot, keyof FlightRecord> = {
  paperBoardingPassFront: 'paperBoardingPassFrontResourcePath',
  paperBoardingPassBack: 'paperBoardingPassBackResourcePath',
  electronicBoardingPass: 'electronicBoardingPassResourcePath',
};

const SLOT_LABEL_KEY: Record<BoardingPassSlot, 'boardingPassFront' | 'boardingPassBack' | 'electronicBoardingPass'> = {
  paperBoardingPassFront: 'boardingPassFront',
  paperBoardingPassBack: 'boardingPassBack',
  electronicBoardingPass: 'electronicBoardingPass',
};

type Stage = 'crop' | 'place';

/** Placement of the rectified crop in template coordinates (Stage 2 only). */
interface Placement {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotationDegrees: number;
}

interface CroppedImage {
  url: string;
  width: number;
  height: number;
  element: HTMLImageElement;
}

function num(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error('crop-image-decode-failed'));
    element.src = url;
  });
}

export function PaperBoardingPassStudio({
  open,
  flight,
  slot,
  onSaved,
  onClose,
}: {
  open: boolean;
  flight: FlightRecord;
  slot: BoardingPassSlot;
  onSaved: (flight: FlightRecord) => void;
  onClose: () => void;
}) {
  const business = useBusinessData();
  const { t } = useTranslation();
  const { notify, reportFailure } = useAppState();
  const dialogScale = useDialogScale();
  const resourcePath = flight[SLOT_ASSET_FIELD[slot]] as string | null;
  const existingLayout: PaperBoardingPassLayout | undefined = flight.paperBoardingPassLayouts?.[slot as 'paperBoardingPassFront' | 'paperBoardingPassBack'];
  const templateSide: BoardingPassSide = slot === 'paperBoardingPassBack' ? 'back' : 'front';
  const templates = useMemo(() => templatesForSide(templateSide), [templateSide]);

  const [stage, setStage] = useState<Stage>(existingLayout ? 'place' : 'crop');
  const [engineReady, setEngineReady] = useState(false);
  const [engineLoading, setEngineLoading] = useState(false);
  const [engineError, setEngineError] = useState(false);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [sourceBounds, setSourceBounds] = useState<QuadBounds | null>(null);
  const [imageError, setImageError] = useState(false);
  const [algorithm, setAlgorithm] = useState<DetectionAlgorithm>(existingLayout?.algorithm ?? 'adaptive');
  const [detecting, setDetecting] = useState(false);
  const [noteKey, setNoteKey] = useState<TranslationKey | null>(null);
  // Stage 1 stores derived drawing points for the canonical rotated rectangle.
  const [quad, setQuad] = useState<Quad | null>(null);
  // True when the rectangle changed after the last successful crop.
  const [cropDirty, setCropDirty] = useState(true);
  const [magnification, setMagnification] = useState(2);
  const [magnifierEnabled, setMagnifierEnabled] = useState(true);
  const [cropping, setCropping] = useState(false);
  const [cropped, setCropped] = useState<CroppedImage | null>(null);
  const [templateId, setTemplateId] = useState<string>(existingLayout?.templateId ?? templates[0].id);
  const [templateImg, setTemplateImg] = useState<HTMLImageElement | null>(null);
  const [templateImgError, setTemplateImgError] = useState(false);
  const [scaleMode, setScaleMode] = useState<'long' | 'short'>('long');
  const [alignment, setAlignment] = useState<'left' | 'center' | 'right'>('center');
  const [templateColor, setTemplateColor] = useState<string>(DEFAULT_TEMPLATE_COLOR);
  // Stage 2: placement transform of the rectified crop (rotation starts at 0).
  const [place, setPlace] = useState<Placement>({ cx: 0, cy: 0, w: 0, h: 0, rotationDegrees: 0 });
  const [saving, setSaving] = useState(false);

  const placeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const placeDragRef = useRef<{ type: 'move' | 'corner'; startX: number; startY: number; orig: Placement } | null>(null);
  const workerRef = useRef<ScanWorkerClient | null>(null);
  const requestGenerationRef = useRef(0);
  const croppedUrlRef = useRef<string | null>(null);
  const cropInFlightRef = useRef(false);
  const placementRestoredRef = useRef(false);
  const autoCropAttemptedRef = useRef(false);

  const template = templateById(templateId, templateSide);
  const croppedAspect = cropped ? cropped.width / cropped.height : 1;
  const imageBounds: QuadBounds | undefined = sourceBounds ?? undefined;
  // Cropping is only meaningful for a rectangle fully inside the source image.
  const quadUsable = quad !== null && imageBounds !== undefined && isUsableQuad(quad) && isQuadWithinBounds(quad, imageBounds);

  const disposeWorker = useCallback(() => {
    workerRef.current?.dispose();
    workerRef.current = null;
  }, []);

  const worker = useCallback(() => {
    workerRef.current ??= new ScanWorkerClient();
    return workerRef.current;
  }, []);

  const bitmapFor = useCallback(async (source: HTMLImageElement) => {
    if (!('createImageBitmap' in window)) throw new Error('image-bitmap-unavailable');
    return createImageBitmap(source);
  }, []);

  // ---- bootstrap: image only (OpenCV is never loaded in this renderer) ----
  useEffect(() => {
    if (!open) return;
    const generation = ++requestGenerationRef.current;
    disposeWorker();
    if (croppedUrlRef.current) URL.revokeObjectURL(croppedUrlRef.current);
    croppedUrlRef.current = null;
    cropInFlightRef.current = false;
    placementRestoredRef.current = false;
    autoCropAttemptedRef.current = false;
    setEngineReady(false);
    setEngineLoading(false);
    setEngineError(false);
    setImage(null);
    setSourceBounds(null);
    setImageError(false);
    setQuad(null);
    setCropDirty(true);
    setCropped(null);
    setNoteKey(null);
    setAlgorithm(existingLayout?.algorithm ?? 'adaptive');
    setTemplateId(existingLayout?.templateId ?? templates[0].id);
    setScaleMode('long');
    setAlignment('center');
    setPlace({ cx: 0, cy: 0, w: 0, h: 0, rotationDegrees: 0 });
    // Existing layouts open directly on the placement stage with their saved
    // rectangle restored — detection is never forced.
    setStage(existingLayout ? 'place' : 'crop');
    let cancelled = false;
    const controller = new AbortController();
    let sourceUrl: string | null = null;
    let loadedSource: StudioSource | null = null;
    if (resourcePath) {
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        const bounds = loadedSource?.sourceWidth && loadedSource.sourceHeight
          ? { width: loadedSource.sourceWidth, height: loadedSource.sourceHeight }
          : { width: img.naturalWidth, height: img.naturalHeight };
        try {
          assertDecodedLimits(img.naturalWidth, img.naturalHeight);
          if (loadedSource?.imageWidth && (img.naturalWidth !== loadedSource.imageWidth || img.naturalHeight !== loadedSource.imageHeight)) throw new Error('thumbnail-dimensions-mismatch');
        } catch { setImageError(true); return; }
        setImage(img);
        setSourceBounds(bounds);
        if (existingLayout) {
          const restoredQuad = rectToQuad(existingLayout.crop);
          setQuad(restoredQuad);
          // An out-of-bounds saved rectangle cannot be repaired in placement.
          if (!isQuadWithinBounds(restoredQuad, bounds)) setStage('crop');
          setCropDirty(true);
          setNoteKey('studioExistingLayout');
        }
      };
      img.onerror = () => {
        if (!cancelled) setImageError(true);
      };
      void loadStudioSource(resourcePath, controller.signal).then((source) => {
        if (cancelled) return;
        loadedSource = source;
        sourceUrl = URL.createObjectURL(source.blob);
        img.src = sourceUrl;
      }, (reason: unknown) => {
        if (!cancelled && !(reason instanceof DOMException && reason.name === 'AbortError')) setImageError(true);
      });
    }
    return () => {
      cancelled = true;
      controller.abort();
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      if (generation === requestGenerationRef.current) {
        requestGenerationRef.current++;
        disposeWorker();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resourcePath, slot]);

  useEffect(() => () => {
    disposeWorker();
    if (croppedUrlRef.current) URL.revokeObjectURL(croppedUrlRef.current);
  }, [disposeWorker]);

  // ---- template image ----
  useEffect(() => {
    let cancelled = false;
    setTemplateImg(null);
    setTemplateImgError(false);
    const img = new Image();
    // SVG templates loaded as images do not need crossOrigin, but setting it
    // defensively avoids tainted-canvas issues if the URL ever changes origin.
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (!cancelled) setTemplateImg(img);
    };
    img.onerror = () => {
      if (!cancelled) setTemplateImgError(true);
    };
    img.src = template.url;
    return () => { cancelled = true; };
  }, [template]);

  /** Apply a Stage 1 edit and mark the upright crop stale. */
  const updateQuad = (next: Quad) => {
    setQuad(next);
    setCropDirty(true);
  };

  // ---- stage 1 pointer interaction (Pointer Events: mouse + touch) ----
  const canvasPoint = (canvas: HTMLCanvasElement, e: { clientX: number; clientY: number }) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const canvasHitScale = (canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return 1;
    return Math.max(1, canvas.width / rect.width, canvas.height / rect.height);
  };



  // ---- detection / crop ----

  const runDetect = () => {
    if (!image || !imageBounds || detecting || engineLoading) return;
    setNoteKey(null);
    void (async () => {
      setDetecting(true);
      setEngineLoading(true);
      setEngineError(false);
      const generation = requestGenerationRef.current;
      try {
        const result = await worker().detect(await bitmapFor(image), algorithm);
        if (generation !== requestGenerationRef.current) return;
        setEngineReady(true);
        if (!result) {
          // Seed an adjustable starting frame so the flow is never blocked.
          updateQuad(defaultQuad(imageBounds));
          setNoteKey('studioDetectNone');
        } else {
          const thumbnailRect = {
                 centerX: result.center.x,
                 centerY: result.center.y,
                 width: result.size.width,
                 height: result.size.height,
                 rotationDegrees: result.rotation,
              };
          updateQuad(rectToQuad(mapCropRectBetweenBounds(
            thumbnailRect,
            { width: image.naturalWidth, height: image.naturalHeight },
            imageBounds,
          )));
          setNoteKey('studioDetectDone');
        }
      } catch (error) {
        if (generation !== requestGenerationRef.current) return;
        if (error instanceof Error && (error.message.includes('opencv-') || error.message.startsWith('scan-worker-'))) setEngineError(true);
        else setNoteKey('studioDetectFailed');
      } finally {
        if (generation === requestGenerationRef.current) {
          setDetecting(false);
          setEngineLoading(false);
        }
      }
    })();
  };

  /** Render the current rotated rectangle into an upright crop. */
  const runCrop = async (): Promise<boolean> => {
    if (!image || !quad || !imageBounds || !isUsableQuad(quad) || !isQuadWithinBounds(quad, imageBounds) || cropInFlightRef.current) return false;
    cropInFlightRef.current = true;
    setNoteKey(null);
    setCropping(true);
    setEngineLoading(true);
    setEngineError(false);
    const generation = requestGenerationRef.current;
    try {
      const rect = normalizeQuadGeometry(quad, imageBounds);
       const warped = await worker().crop(await bitmapFor(image), rect, imageBounds);
      if (generation !== requestGenerationRef.current) return false;
      setEngineReady(true);
      const url = URL.createObjectURL(warped.blob);
      try {
        const element = await loadImageElement(url);
        if (generation !== requestGenerationRef.current) {
          URL.revokeObjectURL(url);
          return false;
        }
        if (croppedUrlRef.current) URL.revokeObjectURL(croppedUrlRef.current);
        croppedUrlRef.current = url;
        const next = { ...warped, url, element };
        setCropped(next);
        setCropDirty(false);
        // A persisted placement restores independently and exactly once; any
        // other fresh crop auto-fits with rotation reset to 0.
        const restorePending = existingLayout !== undefined && existingLayout.templateId === template.id && !placementRestoredRef.current;
        if (!restorePending) autoPlace(template, next);
        return true;
      } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
      }
    } catch (error) {
      if (generation !== requestGenerationRef.current) return false;
      if (error instanceof Error && (error.message.includes('opencv-') || error.message.startsWith('scan-worker-'))) setEngineError(true);
      else setNoteKey('studioCropFailed');
      return false;
    } finally {
      if (generation === requestGenerationRef.current) {
        setCropping(false);
        setEngineLoading(false);
      }
      cropInFlightRef.current = false;
    }
  };

  // ---- wizard navigation ----

  /**
   * Entering Stage 2 requires a rectified crop of the CURRENT quad: a stale
   * or missing crop is produced automatically first, and navigation is
   * blocked (with the error note shown) until it exists.
   */
  const goToStage = async (next: Stage) => {
    if (next === 'crop') {
      setStage('crop');
      return;
    }
    if (!quadUsable) return;
    if (cropDirty || !cropped) {
      const ok = await runCrop();
      if (!ok) return;
    }
    if (!templateId) {
      setTemplateId(templates[0].id);
    }
    setStage('place');
  };

  // An existing layout opens straight on Stage 2: prepare its upright crop
  // once from the restored rectangle. An out-of-bounds rectangle returns the
  // user to Stage 1 instead. The attempt flag is set only after all guards
  // pass so that a premature run (e.g. before the image has decoded) does
  // not block a later retry when the missing prerequisite becomes ready.
  useEffect(() => {
    if (stage !== 'place' || !image || !quadUsable || cropped || !cropDirty || cropping || autoCropAttemptedRef.current) return;
    void (async () => {
      autoCropAttemptedRef.current = true;
      await runCrop();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, image, quad, cropped, cropDirty, cropping]);

  // ---- placement ----
  const autoPlace = (tpl: BoardingPassTemplate, target: CroppedImage | null = cropped) => {
    if (!target) return;
    const aspect = target.width / target.height;
    const tplAspect = tpl.width / tpl.height;
    let w: number;
    let h: number;
    if (aspect > tplAspect) {
      w = tpl.width;
      h = w / aspect;
    } else {
      h = tpl.height;
      w = h * aspect;
    }
    setPlace({ cx: tpl.width / 2, cy: tpl.height / 2, w, h, rotationDegrees: 0 });
  };

  const applyAutoFit = () => {
    if (!cropped) return;
    const placement = calculateAutoFit(
      { width: cropped.width, height: cropped.height },
      { width: template.width, height: template.height },
      scaleMode,
      alignment,
    );
    setPlace(placement);
  };

  // Restore a persisted placement once template + crop are known. Placement
  // rotation remains independent from the source rectangle angle.
  useEffect(() => {
    if (placementRestoredRef.current || !cropped || !existingLayout) return;
    if (existingLayout.templateId !== template.id) return;
    const p = existingLayout.placement;
    const w = clamp(p.scale * template.width * 0.85, 4, template.width * 4);
    const h = w / croppedAspect;
    setPlace({
      cx: template.width / 2 + p.offsetX * template.width,
      cy: template.height / 2 + p.offsetY * template.height,
      w,
      h,
      rotationDegrees: p.rotationDegrees,
    });
    placementRestoredRef.current = true;
  }, [cropped, existingLayout, template, croppedAspect]);

  useEffect(() => {
    const canvas = placeCanvasRef.current;
    if (!canvas || !cropped) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const maxW = 620;
    const scale = Math.min(2.5, maxW / template.width);
    canvas.width = template.width * scale;
    canvas.height = template.height * scale;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#1b1b1b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (place.w > 0) {
      ctx.save();
      ctx.translate(place.cx * scale, place.cy * scale);
      ctx.rotate((place.rotationDegrees * Math.PI) / 180);
      ctx.drawImage(cropped.element, (-place.w / 2) * scale, (-place.h / 2) * scale, place.w * scale, place.h * scale);
      ctx.strokeStyle = '#ffeb3b';
      ctx.lineWidth = 2;
      ctx.strokeRect((-place.w / 2) * scale, (-place.h / 2) * scale, place.w * scale, place.h * scale);
      const colors = ['#f44336', '#00bcd4', '#ff9800', '#e040fb'];
      const hw = (place.w / 2) * scale;
      const hh = (place.h / 2) * scale;
      [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].forEach(([hx, hy], i) => {
        ctx.beginPath();
        ctx.arc(hx, hy, 5, 0, Math.PI * 2);
        ctx.fillStyle = colors[i];
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      });
      ctx.restore();
    }
    if (templateImg) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      // Apply color filter by drawing to offscreen canvas with color overlay
      const colorCanvas = document.createElement('canvas');
      colorCanvas.width = canvas.width;
      colorCanvas.height = canvas.height;
      const colorCtx = colorCanvas.getContext('2d');
      if (colorCtx) {
        // Draw template in black
        colorCtx.drawImage(templateImg, 0, 0, canvas.width, canvas.height);
        // Apply color using multiply blend mode
        colorCtx.globalCompositeOperation = 'source-in';
        colorCtx.fillStyle = templateColor;
        colorCtx.fillRect(0, 0, canvas.width, canvas.height);
        // Draw colored result
        ctx.drawImage(colorCanvas, 0, 0);
      } else {
        ctx.drawImage(templateImg, 0, 0, canvas.width, canvas.height);
      }
      ctx.restore();
    }
  }, [cropped, place, template, templateImg, templateColor]);

  const onPlacePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!cropped || place.w <= 0 || e.button !== 0) return;
    const canvas = e.currentTarget;
    const scale = canvas.width / template.width;
    const point = canvasPoint(canvas, e);
    const templatePoint = { x: point.x / scale, y: point.y / scale };
    const r = (place.rotationDegrees * Math.PI) / 180;
    const corners = [
      { dx: -place.w / 2, dy: -place.h / 2 },
      { dx: place.w / 2, dy: -place.h / 2 },
      { dx: place.w / 2, dy: place.h / 2 },
      { dx: -place.w / 2, dy: place.h / 2 },
    ].map((c) => ({ x: place.cx + c.dx * Math.cos(r) - c.dy * Math.sin(r), y: place.cy + c.dx * Math.sin(r) + c.dy * Math.cos(r) }));
    for (const corner of corners) {
      if (Math.hypot(templatePoint.x - corner.x, templatePoint.y - corner.y) < (12 * canvasHitScale(canvas)) / scale) {
        canvas.setPointerCapture(e.pointerId);
        placeDragRef.current = { type: 'corner', startX: templatePoint.x, startY: templatePoint.y, orig: place };
        return;
      }
    }
    const rr = (-place.rotationDegrees * Math.PI) / 180;
    const dx = templatePoint.x - place.cx;
    const dy = templatePoint.y - place.cy;
    const rx = dx * Math.cos(rr) - dy * Math.sin(rr);
    const ry = dx * Math.sin(rr) + dy * Math.cos(rr);
    if (Math.abs(rx) <= place.w / 2 + 2 && Math.abs(ry) <= place.h / 2 + 2) {
      canvas.setPointerCapture(e.pointerId);
      placeDragRef.current = { type: 'move', startX: templatePoint.x, startY: templatePoint.y, orig: place };
    }
  };

  const onPlacePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = placeDragRef.current;
    if (!drag || !cropped) return;
    const canvas = e.currentTarget;
    const scale = canvas.width / template.width;
    const point = canvasPoint(canvas, e);
    const templatePoint = { x: point.x / scale, y: point.y / scale };
    if (drag.type === 'move') {
      setPlace({ ...drag.orig, cx: drag.orig.cx + (templatePoint.x - drag.startX), cy: drag.orig.cy + (templatePoint.y - drag.startY) });
    } else {
      const dist = Math.max(4, Math.hypot(templatePoint.x - drag.orig.cx, templatePoint.y - drag.orig.cy) * 2);
      const w = clamp(dist, 4, template.width * 4);
      setPlace({ ...drag.orig, w, h: w / croppedAspect });
    }
  };

  const onPlacePointerEnd = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    placeDragRef.current = null;
  };

  // ---- persistence ----
  // A layout is built only from an in-bounds usable rotated rectangle.
  const buildLayout = (): PaperBoardingPassLayout | null => {
    if (!quad || !imageBounds || !isUsableQuad(quad) || !isQuadWithinBounds(quad, imageBounds) || !cropped || place.w <= 0) return null;
    return {
      schemaVersion: 1,
      algorithm,
      crop: normalizeQuadGeometry(quad, imageBounds),
      templateId: template.id,
      placement: {
        scale: clamp(place.w / (template.width * 0.85), 0.01, 10),
        rotationDegrees: clamp(Math.round(place.rotationDegrees * 100) / 100, -360, 360),
        offsetX: clamp((place.cx - template.width / 2) / template.width, -1, 1),
        offsetY: clamp((place.cy - template.height / 2) / template.height, -1, 1),
      },
    };
  };

  const saveLayout = async () => {
    const layout = buildLayout();
    if (!layout) return;
    setSaving(true);
    try {
      const currentFlight = business.data?.flights.find((item) => item.id === flight.id) ?? flight;
      const paperLayouts = { ...(currentFlight.paperBoardingPassLayouts ?? {}) };
      paperLayouts[slot as 'paperBoardingPassFront' | 'paperBoardingPassBack'] = layout;
      const result = business.updateFlight(flight.id, { paperBoardingPassLayouts: paperLayouts });
      await business.saveDocument('flights.json');
      notify(t('studioSaved'), 'success', { action: t('studioSave'), form: t('scanStudioTitle', { slot: t(SLOT_LABEL_KEY[slot]) }) });
      onSaved(result);
      onClose();
    } catch (error) {
      reportFailure(error, { fallback: t('studioSaveFailed'), context: { action: t('studioSave'), form: t('scanStudioTitle', { slot: t(SLOT_LABEL_KEY[slot]) }) } });
    } finally {
      setSaving(false);
    }
  };

  const clearLayout = async () => {
    setSaving(true);
    try {
      const currentFlight = business.data?.flights.find((item) => item.id === flight.id) ?? flight;
      const paperLayouts = { ...(currentFlight.paperBoardingPassLayouts ?? {}) };
      delete paperLayouts[slot as 'paperBoardingPassFront' | 'paperBoardingPassBack'];
      const result = business.updateFlight(flight.id, { paperBoardingPassLayouts: paperLayouts });
      await business.saveDocument('flights.json');
      notify(t('studioLayoutCleared'), 'success', { action: t('studioClearLayout'), form: t('scanStudioTitle', { slot: t(SLOT_LABEL_KEY[slot]) }) });
      onSaved(result);
      onClose();
    } catch (error) {
      reportFailure(error, { fallback: t('studioSaveFailed'), context: { action: t('studioClearLayout'), form: t('scanStudioTitle', { slot: t(SLOT_LABEL_KEY[slot]) }) } });
    } finally {
      setSaving(false);
    }
  };

  const scalePct = Math.round((place.w / (template.width * 0.85)) * 100) || 0;
  const offsetX = place.w > 0 ? (place.cx - template.width / 2) / template.width : 0;
  const offsetY = place.h > 0 ? (place.cy - template.height / 2) / template.height : 0;
  // A loaded image always has an editable crop frame. When detection has not
  // run yet (quad is null), fall back to a full-image starting rectangle so the
  // CropCanvas renders immediately instead of showing a spinner.
  const cropRect = quad
    ? rectFromQuad(quad)
    : imageBounds
      ? rectFromQuad(defaultQuad(imageBounds))
      : null;
  const quadWidth = quad ? Math.round((quadEdgeLength(quad, 0) + quadEdgeLength(quad, 2)) / 2) : 0;
  const quadHeight = quad ? Math.round((quadEdgeLength(quad, 1) + quadEdgeLength(quad, 3)) / 2) : 0;

  const updateCropRect = (field: keyof NonNullable<typeof cropRect>, value: string) => {
    if (!cropRect || !imageBounds) return;
    const nextValue = num(value, cropRect[field]);
    const nextRect = { ...cropRect, [field]: nextValue };
    const nextQuad = rectToQuad(nextRect);
    if (isUsableQuad(nextQuad) && isQuadWithinBounds(nextQuad, imageBounds)) updateQuad(nextQuad);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      aria-labelledby="crop-layout-title"
      slotProps={{ paper: { sx: { width: scaled(1100, dialogScale), height: scaled(700, dialogScale), maxWidth: '95vw', maxHeight: '92vh', overflow: 'hidden' } } }}
    >
      <DialogTitle id="crop-layout-title">
        {t('scanStudioTitle', { slot: t(SLOT_LABEL_KEY[slot]) })}
      </DialogTitle>
      <DialogContent dividers sx={{ minWidth: 0, minHeight: 0, flex: '1 1 auto', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {!resourcePath ? (
          <Alert severity="info">{t('studioNoAsset')}</Alert>
        ) : (
          <Box
            sx={{
              display: 'flex',
              flex: '1 1 auto',
              flexDirection: 'column',
              gap: 2,
              minWidth: 0,
              minHeight: 0,
              overflow: 'hidden',
              '& .scanStudioCropCanvas, & .scanStudioMagnifierCanvas': {
                height: 0,
                flex: '1 1 auto',
                minHeight: 200,
              },
              '& .scanStudioPlaceCanvas': {
                height: 0,
                flex: '1 1 auto',
                minHeight: 200,
              },
            }}
          >
            <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
              <Box sx={{ minHeight: 20, display: 'flex', alignItems: 'center' }}>
                {engineReady ? (
                  <Typography variant="caption" color="success.main" role="status">
                    {t('studioEngineReady')}
                  </Typography>
                ) : engineError ? (
                  <Alert severity="error" sx={{ py: 0 }}>{t('studioEngineFailed')}</Alert>
                ) : engineLoading ? (
                  <Typography variant="caption" color="text.secondary" role="status" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
                    <CircularProgress size={14} /> {t('studioLoadingEngine')}
                  </Typography>
                ) : (
                  <Typography variant="caption" color="text.secondary" role="status">
                    {t('studioEngineIdle')}
                  </Typography>
                )}
              </Box>
              {imageError ? <Alert severity="error" sx={{ py: 0 }}>{t('studioLoadImageFailed')}</Alert> : null}
            </Box>

            <Tabs
              value={stage}
              onChange={(_e, value) => {
                if (value !== stage) setStage(value as Stage);
              }}
              aria-label={t('studioStages')}
            >
              <Tab value="crop" label={t('studioStepDetect')} />
              <Tab value="place" label={t('studioStepPlace')} disabled={!quadUsable && stage !== 'place'} />
            </Tabs>

            <Box sx={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
              <Box sx={{ display: stage === 'crop' ? 'contents' : 'none', flex: '1 1 auto', flexDirection: 'column', gap: 2, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
                <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
                  <TextField
                    select
                    size="small"
                    label={t('studioAlgorithm')}
                    value={algorithm}
                    onChange={(e) => setAlgorithm(e.target.value as DetectionAlgorithm)}
                    sx={{ minWidth: 220 }}
                  >
                    {DETECTION_ALGORITHMS.map((algo) => (
                      <MenuItem key={algo} value={algo}>
                        {t(algo === 'adaptive' ? 'algoAdaptive' : algo === 'canny' ? 'algoCanny' : algo === 'sobel' ? 'algoSobel' : 'algoLaplacian')}
                      </MenuItem>
                    ))}
                  </TextField>
                  <Button variant="contained" onClick={runDetect} disabled={!image || detecting || engineLoading}>
                    {detecting ? t('studioDetecting') : t('studioDetect')}
                  </Button>
                </Box>
                {noteKey ? (
                  <Typography variant="caption" color="text.secondary" role="status">
                    {t(noteKey)}
                  </Typography>
                ) : null}
                <Typography variant="caption" color="text.secondary">
                  {t('studioCropHint')}
                </Typography>
                <Box sx={{ display: 'flex', gap: 2, minWidth: 0, minHeight: 0, flex: '1 1 auto', overflow: 'hidden' }}>
                  <Box sx={{ flex: '1 1 auto', boxSizing: 'border-box', position: 'relative', overflow: 'hidden', minHeight: 300, border: 1, borderColor: 'divider', borderRadius: 1, p: 1, bgcolor: 'action.hover' }}>
                    {image && cropRect ? (
                      <CropCanvas
                        image={image}
                        sourceBounds={imageBounds}
                        crop={cropRect}
                        mode="rotatable"
                        zoom={1}
                        magnification={magnification}
                        magnifierEnabled={magnifierEnabled}
                        fitToContainer
                        onCropChange={(next) => updateQuad(rectToQuad(next))}
                      />
                    ) : (
                      <Box sx={{ display: 'grid', placeItems: 'center', minHeight: 160 }}>
                        <CircularProgress size={24} aria-label={t('loading')} />
                      </Box>
                    )}
                  </Box>
                   <Box sx={{ flex: '1 1 220px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                     <Box>
                       <Typography variant="caption" color="text.secondary">{t('studioMagnifier')}</Typography>
                       <FormControlLabel
                         control={<Switch size="small" checked={magnifierEnabled} onChange={(e) => setMagnifierEnabled(e.target.checked)} />}
                         label={t('studioMagnifierEnable')}
                         sx={{ ml: 0, '& .MuiFormControlLabel-label': { fontSize: '0.75rem' } }}
                       />
                       <Typography variant="caption" color="text.secondary">{t('studioMagnification')}: {magnification}×</Typography>
                       <Slider size="small" min={2} max={12} step={1} value={magnification} onChange={(_e, value) => setMagnification(value as number)} aria-label={t('studioMagnification')} disabled={!magnifierEnabled} />
                     </Box>
                     {quad ? (
                      <Typography variant="caption" color="text.secondary">
                        {t('studioQuadSize', { width: quadWidth, height: quadHeight })}
                      </Typography>
                    ) : null}
                   </Box>
                   <Box sx={{ flex: '1 1 200px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                      <Typography variant="caption" color="text.secondary">{t('studioCropParams')}</Typography>
                     {cropRect ? (
                       <>
                        <TextField size="small" type="number" label={t('studioCenterX')} value={Math.round(cropRect.centerX * 100) / 100} onChange={(e) => updateCropRect('centerX', e.target.value)} slotProps={{ htmlInput: { step: 1 } }} />
                        <TextField size="small" type="number" label={t('studioCenterY')} value={Math.round(cropRect.centerY * 100) / 100} onChange={(e) => updateCropRect('centerY', e.target.value)} slotProps={{ htmlInput: { step: 1 } }} />
                        <TextField size="small" type="number" label={t('studioCropWidth')} value={Math.round(cropRect.width * 100) / 100} onChange={(e) => updateCropRect('width', e.target.value)} slotProps={{ htmlInput: { step: 1, min: 4 } }} />
                        <TextField size="small" type="number" label={t('studioCropHeight')} value={Math.round(cropRect.height * 100) / 100} onChange={(e) => updateCropRect('height', e.target.value)} slotProps={{ htmlInput: { step: 1, min: 4 } }} />
                        <TextField size="small" type="number" label={t('studioRotationDegrees')} value={Math.round(cropRect.rotationDegrees * 100) / 100} onChange={(e) => updateCropRect('rotationDegrees', e.target.value)} slotProps={{ htmlInput: { step: 0.1 } }} />
                       </>
                     ) : (
                        <Typography variant="caption" color="text.disabled">{t('studioNoCropSelected')}</Typography>
                     )}
                   </Box>
                  </Box>
              </Box>
              <Box sx={{ display: stage === 'place' ? 'contents' : 'none', flex: '1 1 auto', flexDirection: 'column', gap: 2, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
                <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
                  <TextField
                    select
                    size="small"
                    label={t('studioTemplate')}
                    value={templateId}
                    onChange={(e) => {
                      setTemplateId(e.target.value);
                      placementRestoredRef.current = false;
                    }}
                    sx={{ minWidth: 240 }}
                  >
                    {templates.map((tpl) => {
                      const idNum = tpl.id.replace(/^bp-/, '').replace(/\.svg$/, '');
                      return (
                        <MenuItem key={tpl.id} value={tpl.id}>
                          {t('studioTemplateLabel', { id: idNum })}
                        </MenuItem>
                      );
                    })}
                  </TextField>
                  <TextField select size="small" label={t('studioScaleMode')} value={scaleMode} onChange={(e) => setScaleMode(e.target.value as 'long' | 'short')}>
                    <MenuItem value="long">{t('studioScaleModeLong')}</MenuItem>
                    <MenuItem value="short">{t('studioScaleModeShort')}</MenuItem>
                  </TextField>
                  <TextField select size="small" label={t('studioAlignment')} value={alignment} onChange={(e) => setAlignment(e.target.value as 'left' | 'center' | 'right')}>
                    <MenuItem value="left">{t('studioAlignLeft')}</MenuItem>
                    <MenuItem value="center">{t('studioAlignCenter')}</MenuItem>
                    <MenuItem value="right">{t('studioAlignRight')}</MenuItem>
                  </TextField>
                  <Button variant="outlined" size="small" onClick={applyAutoFit} disabled={!cropped} aria-label={t('studioAutoFit')}>
                    {t('studioApply')}
                  </Button>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="caption" color="text.secondary">
                      {t('studioTemplateColor')}
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      {TEMPLATE_COLOR_PALETTE.map(({ color, labelKey }) => (
                        <Tooltip key={color} title={t(labelKey)}>
                          <Box
                            onClick={() => setTemplateColor(color)}
                            sx={{
                              width: 20,
                              height: 20,
                              borderRadius: '50%',
                              bgcolor: color,
                              cursor: 'pointer',
                              border: templateColor === color ? '2px solid' : '1px solid',
                              borderColor: templateColor === color ? 'primary.main' : 'divider',
                              '&:hover': { opacity: 0.8 },
                            }}
                            role="button"
                            aria-label={`${t('studioSelectColor')} ${t(labelKey)}`}
                            aria-pressed={templateColor === color}
                          />
                        </Tooltip>
                      ))}
                    </Box>
                  </Box>
                </Box>
                {noteKey ? (
                  <Typography variant="caption" color="text.secondary" role="status">
                    {t(noteKey)}
                  </Typography>
                ) : null}
                {templateImgError ? (
                  <Alert severity="warning" sx={{ py: 0 }}>{t('studioTemplateLoadFailed')}</Alert>
                ) : !templateImg && cropped ? (
                  <Typography variant="caption" color="text.secondary" role="status">
                    {t('studioTemplateLoading')}
                  </Typography>
                ) : null}
                <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 2, minWidth: 0, flex: '1 1 auto', overflow: 'hidden' }}>
                  <Box sx={{ flex: '2 1 480px', minWidth: 0, overflow: 'hidden', border: 1, borderColor: 'divider', borderRadius: 1, p: 1, bgcolor: '#1b1b1b' }}>
                    {cropped ? (
                      <canvas
                        ref={placeCanvasRef}
                        onPointerDown={onPlacePointerDown}
                        onPointerMove={onPlacePointerMove}
                        onPointerUp={onPlacePointerEnd}
                        onPointerCancel={onPlacePointerEnd}
                        role="img"
                        aria-label={t('studioPlaceCanvas')}
                        className="scanStudioPlaceCanvas"
                        style={{ display: 'block', margin: '0 auto', maxWidth: '100%', width: 'auto', height: 'auto', touchAction: 'none', cursor: 'move' }}
                      />
                    ) : cropping ? (
                      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1.5, p: 4 }}>
                        <CircularProgress size={20} aria-label={t('loading')} />
                        <Typography variant="body2" color="text.secondary" role="status">
                          {t('studioCropping')}
                        </Typography>
                      </Box>
                    ) : (
                      <Typography variant="body2" color="text.secondary" sx={{ p: 4, textAlign: 'center' }}>
                        {t('studioPlaceNeedsCrop')}
                      </Typography>
                    )}
                  </Box>
                  <Box sx={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        {t('studioScale')}: {scalePct}%
                      </Typography>
                      <Slider
                        size="small"
                        min={10}
                        max={300}
                        value={clamp(scalePct, 10, 300)}
                        disabled={!cropped}
                        onChange={(_e, value) => {
                          const pct = (value as number) / 100;
                          setPlace((prev) => {
                            const w = template.width * 0.85 * pct;
                            return { ...prev, w, h: w / croppedAspect };
                          });
                        }}
                        aria-label={t('studioScale')}
                      />
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        {t('studioRotation')}: {place.rotationDegrees.toFixed(1)}°
                      </Typography>
                      <Slider
                        size="small"
                        min={-45}
                        max={45}
                        step={0.5}
                        value={clamp(place.rotationDegrees, -45, 45)}
                        disabled={!cropped}
                        onChange={(_e, value) => setPlace((prev) => ({ ...prev, rotationDegrees: value as number }))}
                        aria-label={t('studioRotation')}
                      />
                    </Box>
                    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                      <TextField
                        size="small"
                        type="number"
                        label={t('studioOffsetX')}
                        value={Math.round(offsetX * 1000) / 1000}
                        disabled={!cropped}
                        onChange={(e) => {
                          const next = clamp(num(e.target.value, offsetX), -1, 1);
                          setPlace((prev) => ({ ...prev, cx: template.width / 2 + next * template.width }));
                        }}
                        slotProps={{ htmlInput: { step: 0.01, min: -1, max: 1, 'aria-label': t('studioOffsetX') } }}
                        sx={{ width: 130 }}
                      />
                      <TextField
                        size="small"
                        type="number"
                        label={t('studioOffsetY')}
                        value={Math.round(offsetY * 1000) / 1000}
                        disabled={!cropped}
                        onChange={(e) => {
                          const next = clamp(num(e.target.value, offsetY), -1, 1);
                          setPlace((prev) => ({ ...prev, cy: template.height / 2 + next * template.height }));
                        }}
                        slotProps={{ htmlInput: { step: 0.01, min: -1, max: 1, 'aria-label': t('studioOffsetY') } }}
                        sx={{ width: 130 }}
                      />
                    </Box>
                    <Typography variant="caption" color="text.secondary">
                      {t('studioPlaceHint')}
                    </Typography>
                  </Box>
                </Box>
              </Box>
            </Box>
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', overflow: 'hidden' }}>
        {existingLayout ? (
          <Tooltip title={t('studioClearLayoutTooltip')}>
            <Button color="error" onClick={() => void clearLayout()} disabled={saving}>
              {t('studioClearLayout')}
            </Button>
          </Tooltip>
        ) : null}
        <Box sx={{ flexGrow: 1 }} />
        <Button onClick={onClose}>{t('cancel')}</Button>
        {stage === 'place' ? <Button onClick={() => setStage('crop')}>{t('studioBack')}</Button> : null}
        {stage === 'crop' ? (
          <Button variant="contained" onClick={() => void goToStage('place')} disabled={!quadUsable || cropping || !resourcePath}>
            {cropping ? t('studioCropping') : t('studioNext')}
          </Button>
        ) : (
          <Button variant="contained" onClick={() => void saveLayout()} disabled={!cropped || !quadUsable || saving || cropping || !resourcePath}>
            {saving ? t('saving') : t('studioSave')}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
