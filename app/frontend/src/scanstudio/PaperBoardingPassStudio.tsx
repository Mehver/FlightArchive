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
// Interactive crop processing runs in the browser against the same-origin safe
// RFG resource URL. Only portable, image-free paper boarding-pass layout metadata is
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
import { api } from '../api/client';
import { resourceUrl } from '../rfg/api';
import type { FlightRecord, PaperBoardingPassLayout } from '../api/types';
import { useAppState } from '../state/AppState';
import { useTranslation, type TranslationKey } from '../i18n';
import { ScanWorkerClient } from './scanWorkerClient';
import { DETECTION_ALGORITHMS, type DetectionAlgorithm } from './scanWorkerProtocol';
import { templateById, templatesForSide, type BoardingPassSide, type BoardingPassTemplate } from './templates';
import {
  QUAD_EDGES,
  clamp,
  defaultQuad,
  isUsableQuad,
  isQuadWithinBounds,
  normalizeQuadGeometry,
  quadCenter,
  quadEdgeLength,
  rectFromQuad,
  rectToQuad,
  rotationHandlePoint,
  type Point,
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

const ROTATION_HANDLE_OFFSET_PX = 28;
const ROTATION_HANDLE_HIT_PX = 22;
const CROP_CANVAS_PADDING_PX = ROTATION_HANDLE_OFFSET_PX + ROTATION_HANDLE_HIT_PX + 8;
export const MAGNIFIER_SIZE = 560;
type QuadGesture = { kind: 'vertex' | 'edge' | 'move'; index: number } | { kind: 'rotate'; index: number; deltaDeg: number };

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
  const { t } = useTranslation();
  const { notify, showError } = useAppState();
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
  const [magnifierPoint] = useState<Point | null>(null);
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
  const [gesture] = useState<QuadGesture | null>(null);

  const cropCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const magnifierCanvasRef = useRef<HTMLCanvasElement | null>(null);
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
  const imageBounds: QuadBounds | undefined = image ? { width: image.naturalWidth, height: image.naturalHeight } : undefined;
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
    if (resourcePath) {
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        setImage(img);
        if (existingLayout) {
          const restoredQuad = rectToQuad(existingLayout.crop);
          setQuad(restoredQuad);
          // An out-of-bounds saved rectangle cannot be repaired in placement.
          if (!isQuadWithinBounds(restoredQuad, { width: img.naturalWidth, height: img.naturalHeight })) setStage('crop');
          setCropDirty(true);
          setNoteKey('studioExistingLayout');
        }
      };
      img.onerror = () => {
        if (!cancelled) setImageError(true);
      };
      img.src = resourceUrl(resourcePath);
    }
    return () => {
      cancelled = true;
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

  // ---- stage 1 canvas geometry ----
  const cropScale = useMemo(() => {
    if (!image) return 1;
    const panelWidth = 760;
    return Math.min(1, panelWidth / image.naturalWidth);
  }, [image]);

  const imgToCanvas = useCallback(
    (p: Point) => {
      if (!image) return p;
      const canvas = cropCanvasRef.current;
      return {
        x: (p.x - image.naturalWidth / 2) * cropScale + (canvas?.width ?? 0) / 2,
        y: (p.y - image.naturalHeight / 2) * cropScale + (canvas?.height ?? 0) / 2,
      };
    },
    [image, cropScale],
  );
  /** Apply a Stage 1 edit and mark the upright crop stale. */
  const updateQuad = (next: Quad) => {
    setQuad(next);
    setCropDirty(true);
  };

  // ---- stage 1 canvas rendering: rotated rectangle and edit handles ----
  useEffect(() => {
    const canvas = cropCanvasRef.current;
    if (!canvas || !image) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = image.naturalWidth * cropScale;
    const h = image.naturalHeight * cropScale;
    // The padded backing canvas keeps the external rotation handle visible even
    // when the crop rectangle reaches a source-image edge.
    canvas.width = Math.max(320, w + CROP_CANVAS_PADDING_PX * 2);
    canvas.height = Math.max(200, h + CROP_CANVAS_PADDING_PX * 2);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const topLeft = imgToCanvas({ x: 0, y: 0 });
    ctx.drawImage(image, topLeft.x, topLeft.y, w, h);
    if (!quad) return;
    const corners = quad.map(imgToCanvas) as Quad;
    // Dashed rectangle outline (bright underlay + dark dashes for contrast).
    ctx.beginPath();
    corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.strokeStyle = '#ffeb3b';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    // Edge handles: squares at edge midpoints; the active edge is highlighted.
    for (let edge = 0; edge < 4; edge++) {
      const [a, b] = QUAD_EDGES[edge];
      const midX = (corners[a].x + corners[b].x) / 2;
      const midY = (corners[a].y + corners[b].y) / 2;
      const active = gesture?.kind === 'edge' && gesture.index === edge;
      ctx.save();
      ctx.translate(midX, midY);
      ctx.rotate(Math.atan2(corners[b].y - corners[a].y, corners[b].x - corners[a].x));
      ctx.beginPath();
      ctx.rect(-6, -6, 12, 12);
      ctx.fillStyle = active ? '#ffeb3b' : 'rgba(255,255,255,0.9)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
    }
    // Visible external rotation handle: it follows the top edge and remains
    // inside the padded canvas rather than relying on a hidden hold gesture.
    const rotationHandle = rotationHandlePoint(corners, ROTATION_HANDLE_OFFSET_PX);
    const topMidpoint = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
    const rotating = gesture?.kind === 'rotate';
    ctx.beginPath();
    ctx.moveTo(topMidpoint.x, topMidpoint.y);
    ctx.lineTo(rotationHandle.x, rotationHandle.y);
    ctx.strokeStyle = '#ffeb3b';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rotationHandle.x, rotationHandle.y, rotating ? 8 : 7, 0, Math.PI * 2);
    ctx.fillStyle = rotating ? '#ffeb3b' : 'rgba(255,255,255,0.95)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Corner handles.
    const colors = ['#f44336', '#00bcd4', '#ff9800', '#e040fb'];
    corners.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = colors[i];
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
    // Rotation state: pivot dot, orbit guide and a live angle badge.
    if (gesture?.kind === 'rotate') {
      const centre = imgToCanvas(quadCenter(quad));
      const held = rotationHandle;
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, Math.hypot(held.x - centre.x, held.y - centre.y), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,235,59,0.6)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffeb3b';
      ctx.fill();
      const label = `${gesture.deltaDeg >= 0 ? '+' : ''}${gesture.deltaDeg.toFixed(1)}°`;
      ctx.font = '12px sans-serif';
      const labelWidth = ctx.measureText(label).width + 10;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(centre.x + 10, centre.y - 24, labelWidth, 18);
      ctx.fillStyle = '#ffeb3b';
      ctx.fillText(label, centre.x + 15, centre.y - 11);
    }
    // `stage` re-runs this effect when the canvas is (re)mounted after
    // navigating back to the crop stage, so an existing layout's frame is
    // drawn and the canvas backing size is correct for hit-testing.
  }, [image, quad, cropScale, imgToCanvas, gesture, stage, magnifierPoint]);

  // Independent pixel magnifier retained for the legacy renderer path.
  useEffect(() => {
    const canvas = magnifierCanvasRef.current;
    if (!canvas) return;
    if (!image || !magnifierPoint) {
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    canvas.width = MAGNIFIER_SIZE; canvas.height = MAGNIFIER_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // A tiny source cannot fill the requested sampling square. Sample its
    // shortest side instead so the magnifier remains fully populated.
    const sourceSize = Math.min(canvas.width / magnification, image.naturalWidth, image.naturalHeight);
    const sx = clamp(magnifierPoint.x - sourceSize / 2, 0, Math.max(0, image.naturalWidth - sourceSize));
    const sy = clamp(magnifierPoint.y - sourceSize / 2, 0, Math.max(0, image.naturalHeight - sourceSize));
    const magnifierScale = canvas.width / sourceSize;
    // Map a source-image coordinate into the magnifier viewport.
    const toMagnifier = (p: Point): Point => ({ x: (p.x - sx) * magnifierScale, y: (p.y - sy) * magnifierScale });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, sx, sy, sourceSize, sourceSize, 0, 0, canvas.width, canvas.height);
    if (quad) {
      const corners = quad.map(toMagnifier) as Quad;
      // Dashed rectangle outline (bright underlay + dark dashes for contrast),
      // matching the main crop overlay. Corners outside the viewport are
      // clipped naturally by the canvas.
      ctx.beginPath();
      corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.strokeStyle = '#ffeb3b';
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      // Corner handles coloured to match the main overlay.
      const colors = ['#f44336', '#00bcd4', '#ff9800', '#e040fb'];
      corners.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = colors[i];
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      });
    }
  }, [image, magnifierPoint, magnification, quad]);

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
          updateQuad(
              rectToQuad({
                centerX: result.center.x,
                centerY: result.center.y,
                width: result.size.width,
                height: result.size.height,
                rotationDegrees: result.rotation,
              }),
          );
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
      const warped = await worker().crop(await bitmapFor(image), rect);
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
    const sp = { x: point.x / scale, y: point.y / scale };
    const r = (place.rotationDegrees * Math.PI) / 180;
    const corners = [
      { dx: -place.w / 2, dy: -place.h / 2 },
      { dx: place.w / 2, dy: -place.h / 2 },
      { dx: place.w / 2, dy: place.h / 2 },
      { dx: -place.w / 2, dy: place.h / 2 },
    ].map((c) => ({ x: place.cx + c.dx * Math.cos(r) - c.dy * Math.sin(r), y: place.cy + c.dx * Math.sin(r) + c.dy * Math.cos(r) }));
    for (const corner of corners) {
      if (Math.hypot(sp.x - corner.x, sp.y - corner.y) < (12 * canvasHitScale(canvas)) / scale) {
        canvas.setPointerCapture(e.pointerId);
        placeDragRef.current = { type: 'corner', startX: sp.x, startY: sp.y, orig: place };
        return;
      }
    }
    const rr = (-place.rotationDegrees * Math.PI) / 180;
    const dx = sp.x - place.cx;
    const dy = sp.y - place.cy;
    const rx = dx * Math.cos(rr) - dy * Math.sin(rr);
    const ry = dx * Math.sin(rr) + dy * Math.cos(rr);
    if (Math.abs(rx) <= place.w / 2 + 2 && Math.abs(ry) <= place.h / 2 + 2) {
      canvas.setPointerCapture(e.pointerId);
      placeDragRef.current = { type: 'move', startX: sp.x, startY: sp.y, orig: place };
    }
  };

  const onPlacePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = placeDragRef.current;
    if (!drag || !cropped) return;
    const canvas = e.currentTarget;
    const scale = canvas.width / template.width;
    const point = canvasPoint(canvas, e);
    const sp = { x: point.x / scale, y: point.y / scale };
    if (drag.type === 'move') {
      setPlace({ ...drag.orig, cx: drag.orig.cx + (sp.x - drag.startX), cy: drag.orig.cy + (sp.y - drag.startY) });
    } else {
      const dist = Math.max(4, Math.hypot(sp.x - drag.orig.cx, sp.y - drag.orig.cy) * 2);
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
      const paperLayouts = { ...(flight.paperBoardingPassLayouts ?? {}) };
      paperLayouts[slot as 'paperBoardingPassFront' | 'paperBoardingPassBack'] = layout;
      const result = await api.updateFlight(flight.id, { paperBoardingPassLayouts: paperLayouts });
      notify(t('studioSaved'));
      onSaved(result.flight);
      onClose();
    } catch (error) {
      showError(error, t('studioSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const clearLayout = async () => {
    setSaving(true);
    try {
      const paperLayouts = { ...(flight.paperBoardingPassLayouts ?? {}) };
      delete paperLayouts[slot as 'paperBoardingPassFront' | 'paperBoardingPassBack'];
      const result = await api.updateFlight(flight.id, { paperBoardingPassLayouts: paperLayouts });
      notify(t('studioLayoutCleared'));
      onSaved(result.flight);
      onClose();
    } catch (error) {
      showError(error, t('studioSaveFailed'));
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
                {gesture?.kind === 'rotate' ? (
                  <Typography variant="caption" color="primary" role="status">
                    {t('studioRotateActive', { degrees: gesture.deltaDeg.toFixed(1) })}
                  </Typography>
                ) : null}

                <Box sx={{ display: 'flex', gap: 2, minWidth: 0, minHeight: 0, flex: '1 1 auto', overflow: 'hidden' }}>
                  <Box sx={{ flex: '1 1 auto', boxSizing: 'border-box', position: 'relative', overflow: 'hidden', minHeight: 300, border: 1, borderColor: 'divider', borderRadius: 1, p: 1, bgcolor: 'action.hover' }}>
                    {image && cropRect ? (
                      <CropCanvas
                        image={image}
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
