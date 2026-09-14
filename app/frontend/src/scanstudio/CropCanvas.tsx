// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  QUAD_EDGES,
  clamp,
  distanceToSegment,
  isQuadWithinBounds,
  moveQuadEdge,
  moveQuadVertex,
  quadCenter,
  quadContains,
  quadEdgeOutwardNormal,
  rectFromQuad,
  rectToQuad,
  rotationHandlePoint,
  rotateQuadWithinBounds,
  translateQuad,
  type CropRect,
  type Point,
  type Quad,
  type QuadBounds,
} from './cropGeometry';
import { useTranslation } from '../i18n';

export type CropCanvasMode = 'rotatable' | 'axis-aligned';

export interface CropCanvasProps {
  image: HTMLImageElement | null;
  crop: CropRect;
  mode: CropCanvasMode;
  zoom: number;
  magnification: number;
  onCropChange: (crop: CropRect) => void;
  /** When false the floating magnifier is hidden. Defaults to true. */
  magnifierEnabled?: boolean;
  /**
   * Fit the complete source image into this component's available CSS-pixel
   * workspace. The canvas backing store remains independent of its CSS size.
   */
  fitToContainer?: boolean;
}

const CORNER_HIT_PX = 12;
const EDGE_HIT_PX = 10;
const ROTATION_HANDLE_OFFSET_PX = 28;
const ROTATION_HANDLE_HIT_PX = 22;
const PADDING = ROTATION_HANDLE_OFFSET_PX + ROTATION_HANDLE_HIT_PX + 8;

/**
 * Backing resolution of the magnifier canvas. The CSS display size is much
 * smaller (see `MAGNIFIER_DISPLAY_SIZE`) so the overlay stays compact, while
 * the backing store keeps enough pixels to remain crisp at high zoom.
 */
const MAGNIFIER_BACKING = 320;
/** CSS pixel size of the floating magnifier viewport. */
const MAGNIFIER_DISPLAY_SIZE = 160;
/** Offset from the pointer cursor to the magnifier top-left (CSS px). */
const MAGNIFIER_OFFSET = 8;

export interface ContainCanvasGeometry {
  canvasWidth: number;
  canvasHeight: number;
  sourceScale: number;
  backingScale: number;
}

/**
 * Size a canvas workspace without changing source-image coordinates. Letterbox
 * space is deliberately part of the canvas so an image is never clipped by a
 * CSS max-size rule.
 */
export function containCanvasGeometry(
  imageWidth: number,
  imageHeight: number,
  workspaceWidth: number,
  workspaceHeight: number,
  devicePixelRatio = 1,
  controlInset = 0,
): ContainCanvasGeometry {
  const ratio = Math.max(1, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1);
  const width = Math.max(1, workspaceWidth);
  const height = Math.max(1, workspaceHeight);
  const usableWidth = Math.max(1, width - controlInset * 2);
  const usableHeight = Math.max(1, height - controlInset * 2);
  // This is a CSS-pixel display scale. Do not cap it at 1: a small source must
  // expand to the constrained workspace edge just like a large source shrinks.
  const sourceScale = Math.min(usableWidth / imageWidth, usableHeight / imageHeight);
  return {
    canvasWidth: Math.max(1, Math.round(width * ratio)),
    canvasHeight: Math.max(1, Math.round(height * ratio)),
    sourceScale,
    backingScale: sourceScale * ratio,
  };
}

/**
 * Reserve only the CSS space a current rotated crop needs for its rotation
 * handle. A fixed gutter on all four sides needlessly shrinks ordinary crops.
 */
export function rotationControlInsetForCrop(
  imageWidth: number,
  imageHeight: number,
  workspaceWidth: number,
  workspaceHeight: number,
  crop: CropRect,
): number {
  const sourceScale = containCanvasGeometry(imageWidth, imageHeight, workspaceWidth, workspaceHeight).sourceScale;
  if (!Number.isFinite(sourceScale) || sourceScale <= 0) return 0;
  const handle = rotationHandlePoint(rectToQuad(crop), ROTATION_HANDLE_OFFSET_PX / sourceScale);
  const x = (handle.x - imageWidth / 2) * sourceScale + workspaceWidth / 2;
  const y = (handle.y - imageHeight / 2) * sourceScale + workspaceHeight / 2;
  const clearance = ROTATION_HANDLE_HIT_PX + 8;
  const required = Math.max(0, clearance - Math.min(x, workspaceWidth - x, y, workspaceHeight - y));
  return required === 0 ? 0 : Math.min(PADDING, required + 2);
}

type Hit = { kind: 'rotate' | 'inside' } | { kind: 'corner' | 'edge'; index: number };
type Drag =
  | { kind: 'vertex'; pointerId: number; index: number; orig: Quad }
  | { kind: 'edge'; pointerId: number; index: number; start: Point; orig: Quad }
  | { kind: 'move'; pointerId: number; start: Point; orig: Quad }
  | { kind: 'rotate'; pointerId: number; startAngle: number; orig: Quad };

function hitTest(quad: Quad, point: Point, rotatable: boolean, scale: number): Hit | null {
  if (rotatable) {
    const handle = rotationHandlePoint(quad, ROTATION_HANDLE_OFFSET_PX * scale);
    if (Math.hypot(point.x - handle.x, point.y - handle.y) <= ROTATION_HANDLE_HIT_PX * scale) return { kind: 'rotate' };
  }
  for (let index = 0; index < 4; index++) {
    if (Math.hypot(point.x - quad[index].x, point.y - quad[index].y) <= CORNER_HIT_PX * scale) return { kind: 'corner', index };
  }
  let closest = -1;
  let distance = EDGE_HIT_PX * scale;
  for (let index = 0; index < 4; index++) {
    const [a, b] = QUAD_EDGES[index];
    const next = distanceToSegment(point, quad[a], quad[b]);
    if (next <= distance) { closest = index; distance = next; }
  }
  if (closest >= 0) return { kind: 'edge', index: closest };
  return quadContains(quad, point) ? { kind: 'inside' } : null;
}

function cursorFor(hit: Hit | null, quad: Quad): string {
  if (!hit) return 'default';
  if (hit.kind === 'rotate') return 'grab';
  if (hit.kind === 'inside') return 'move';
  if (hit.kind === 'corner') {
    const center = quadCenter(quad);
    const point = quad[hit.index];
    return (point.x - center.x) * (point.y - center.y) >= 0 ? 'nwse-resize' : 'nesw-resize';
  }
  if (hit.kind === 'edge') {
    const normal = quadEdgeOutwardNormal(quad, hit.index);
    const angle = (Math.round((Math.atan2(normal.y, normal.x) * 180 / Math.PI) / 45) * 45 + 360) % 360;
    return ({ 0: 'e-resize', 45: 'se-resize', 90: 's-resize', 135: 'sw-resize', 180: 'w-resize', 225: 'nw-resize', 270: 'n-resize', 315: 'ne-resize' } as Record<number, string>)[angle];
  }
  return 'default';
}

/** Controlled source-image crop editor with a floating pixel magnifier. */
export function CropCanvas({ image, crop, mode, zoom, magnification, onCropChange, magnifierEnabled = true, fitToContainer = false }: CropCanvasProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const magnifierRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [workspace, setWorkspace] = useState<{ width: number; height: number } | null>(null);
  /** Cursor position relative to the container, used to float the magnifier. */
  const [cursorCss, setCursorCss] = useState<{ x: number; y: number } | null>(null);
  const quad = useMemo(() => rectToQuad(mode === 'axis-aligned' ? { ...crop, rotationDegrees: 0 } : crop), [crop, mode]);
  const bounds: QuadBounds | null = image ? { width: image.naturalWidth, height: image.naturalHeight } : null;
  const fittedGeometry = useMemo(() => {
    if (!image || !fitToContainer || !workspace) return null;
    const controlInset = mode === 'rotatable'
      ? rotationControlInsetForCrop(image.naturalWidth, image.naturalHeight, workspace.width, workspace.height, crop)
      : 0;
    return containCanvasGeometry(
      image.naturalWidth,
      image.naturalHeight,
      workspace.width,
      workspace.height,
      window.devicePixelRatio,
      controlInset,
    );
  }, [crop, fitToContainer, image, mode, workspace]);
  const scale = image ? (fittedGeometry?.backingScale ?? Math.min(1, 760 / image.naturalWidth) * zoom) : 1;

  useEffect(() => {
    const container = containerRef.current;
    if (!fitToContainer || !container || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const { width, height } = container.getBoundingClientRect();
      if (width > 0 && height > 0) setWorkspace({ width, height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [fitToContainer]);

  const toCanvas = useCallback((point: Point) => {
    const canvas = canvasRef.current;
    if (!image || !canvas) return point;
    return { x: (point.x - image.naturalWidth / 2) * scale + canvas.width / 2, y: (point.y - image.naturalHeight / 2) * scale + canvas.height / 2 };
  }, [image, scale]);
  const toImage = useCallback((point: Point) => {
    const canvas = canvasRef.current;
    if (!image || !canvas) return point;
    return { x: (point.x - canvas.width / 2) / scale + image.naturalWidth / 2, y: (point.y - canvas.height / 2) / scale + image.naturalHeight / 2 };
  }, [image, scale]);
  const eventPoint = (canvas: HTMLCanvasElement, event: { clientX: number; clientY: number }) => {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width * canvas.width, y: (event.clientY - rect.top) / rect.height * canvas.height };
  };
  const hitScale = (canvas: HTMLCanvasElement) => Math.max(1, canvas.width / canvas.getBoundingClientRect().width, canvas.height / canvas.getBoundingClientRect().height);
  const emit = (next: Quad) => {
    if (bounds && isQuadWithinBounds(next, bounds)) onCropChange(rectFromQuad(next));
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    canvas.width = fittedGeometry?.canvasWidth ?? Math.max(320, width + (mode === 'rotatable' ? PADDING * 2 : 0));
    canvas.height = fittedGeometry?.canvasHeight ?? Math.max(200, height + (mode === 'rotatable' ? PADDING * 2 : 0));
    context.clearRect(0, 0, canvas.width, canvas.height);
    const origin = toCanvas({ x: 0, y: 0 });
    context.drawImage(image, origin.x, origin.y, width, height);
    const points = quad.map(toCanvas) as Quad;
    context.beginPath(); points.forEach((p, i) => i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y)); context.closePath();
    context.strokeStyle = '#ffeb3b'; context.lineWidth = 2.5; context.stroke();
    context.strokeStyle = 'rgba(0,0,0,0.8)'; context.lineWidth = 1; context.setLineDash([4, 3]); context.stroke(); context.setLineDash([]);
    QUAD_EDGES.forEach(([a, b]) => {
      const x = (points[a].x + points[b].x) / 2; const y = (points[a].y + points[b].y) / 2;
      context.fillStyle = 'rgba(255,255,255,0.9)'; context.fillRect(x - 5, y - 5, 10, 10); context.strokeStyle = 'rgba(0,0,0,0.75)'; context.strokeRect(x - 5, y - 5, 10, 10);
    });
    if (mode === 'rotatable') {
      const controlScale = fittedGeometry && workspace ? fittedGeometry.canvasWidth / workspace.width : 1;
      const handle = rotationHandlePoint(points, ROTATION_HANDLE_OFFSET_PX * controlScale);
      context.beginPath(); context.moveTo((points[0].x + points[1].x) / 2, (points[0].y + points[1].y) / 2); context.lineTo(handle.x, handle.y); context.strokeStyle = '#ffeb3b'; context.stroke();
      context.beginPath(); context.arc(handle.x, handle.y, 7 * controlScale, 0, Math.PI * 2); context.fillStyle = '#fff'; context.fill(); context.strokeStyle = '#222'; context.stroke();
    }
    const controlScale = fittedGeometry && workspace ? fittedGeometry.canvasWidth / workspace.width : 1;
    ['#f44336', '#00bcd4', '#ff9800', '#e040fb'].forEach((color, index) => { const p = points[index]; context.beginPath(); context.arc(p.x, p.y, 6 * controlScale, 0, Math.PI * 2); context.fillStyle = color; context.fill(); context.strokeStyle = '#fff'; context.stroke(); });
  }, [fittedGeometry, image, mode, quad, scale, toCanvas]);

  /** Render the floating magnifier content (source pixels + bold crop overlay). */
  useEffect(() => {
    const canvas = magnifierRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context || !image || !pointer) { context?.clearRect(0, 0, canvas.width, canvas.height); return; }
    canvas.width = MAGNIFIER_BACKING; canvas.height = MAGNIFIER_BACKING;
    const sourceSize = Math.min(canvas.width / magnification, image.naturalWidth, image.naturalHeight);
    const sx = clamp(pointer.x - sourceSize / 2, 0, Math.max(0, image.naturalWidth - sourceSize));
    const sy = clamp(pointer.y - sourceSize / 2, 0, Math.max(0, image.naturalHeight - sourceSize));
    const m = canvas.width / sourceSize;
    context.imageSmoothingEnabled = false;
    context.drawImage(image, sx, sy, sourceSize, sourceSize, 0, 0, canvas.width, canvas.height);
    const points = quad.map(p => ({ x: (p.x - sx) * m, y: (p.y - sy) * m }));
    context.beginPath(); points.forEach((p, i) => i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y)); context.closePath();
    context.strokeStyle = '#ffeb3b'; context.lineWidth = 5; context.stroke();
    ['#f44336', '#00bcd4', '#ff9800', '#e040fb'].forEach((color, index) => {
      const p = points[index];
      context.beginPath(); context.arc(p.x, p.y, 3, 0, Math.PI * 2);
      context.fillStyle = color; context.fill();
      context.strokeStyle = '#fff'; context.lineWidth = 0.8; context.stroke();
    });
  }, [image, magnification, pointer, quad]);

  /** Track the cursor position relative to the container so the magnifier floats. */
  const updateCursorCss = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    setCursorCss({
      x: event.clientX - containerRect.left,
      y: event.clientY - containerRect.top,
    });
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!image || !bounds || event.button !== 0) return;
    const canvas = event.currentTarget; const point = eventPoint(canvas, event); const displayed = quad.map(toCanvas) as Quad;
    const hit = hitTest(displayed, point, mode === 'rotatable', hitScale(canvas)); if (!hit) return;
    canvas.setPointerCapture(event.pointerId);
    updateCursorCss(event);
    if (hit.kind === 'rotate' || (hit.kind === 'corner' && event.shiftKey && mode === 'rotatable')) {
      const origin = toImage(point); const center = quadCenter(quad); dragRef.current = { kind: 'rotate', pointerId: event.pointerId, startAngle: Math.atan2(origin.y - center.y, origin.x - center.x) * 180 / Math.PI, orig: quad }; canvas.style.cursor = 'grabbing'; return;
    }
    if (hit.kind === 'corner') dragRef.current = { kind: 'vertex', pointerId: event.pointerId, index: hit.index, orig: quad };
    else if (hit.kind === 'edge') dragRef.current = { kind: 'edge', pointerId: event.pointerId, index: hit.index, start: point, orig: quad };
    else dragRef.current = { kind: 'move', pointerId: event.pointerId, start: point, orig: quad };
    canvas.style.cursor = cursorFor(hit, displayed);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget; const point = eventPoint(canvas, event); if (image) setPointer(toImage(point));
    updateCursorCss(event);
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !bounds) { const shown = quad.map(toCanvas) as Quad; canvas.style.cursor = cursorFor(hitTest(shown, point, mode === 'rotatable', hitScale(canvas)), shown); return; }
    if (drag.kind === 'vertex') emit(moveQuadVertex(drag.orig, drag.index, toImage(point), bounds));
    else if (drag.kind === 'edge') { const delta = { x: (point.x - drag.start.x) / scale, y: (point.y - drag.start.y) / scale }; const normal = quadEdgeOutwardNormal(drag.orig, drag.index); emit(moveQuadEdge(drag.orig, drag.index, delta.x * normal.x + delta.y * normal.y, bounds)); }
    else if (drag.kind === 'move') emit(translateQuad(drag.orig, (point.x - drag.start.x) / scale, (point.y - drag.start.y) / scale, bounds));
    else { const source = toImage(point); const center = quadCenter(drag.orig); const angle = Math.atan2(source.y - center.y, source.x - center.x) * 180 / Math.PI; emit(rotateQuadWithinBounds(drag.orig, ((angle - drag.startAngle + 540) % 360) - 180, bounds)); }
  };
  const end = (event: React.PointerEvent<HTMLCanvasElement>) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); dragRef.current = null; event.currentTarget.style.cursor = 'default'; };

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
      display: magnifierEnabled && cursorCss && pointer ? 'block' : 'none',
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
  }, [cursorCss, pointer, magnifierEnabled]);

  return (
    <div ref={containerRef} style={{ position: 'relative', width: fitToContainer ? '100%' : undefined, height: fitToContainer ? '100%' : undefined }}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={() => { if (!dragRef.current) { setPointer(null); setCursorCss(null); } }}
        onPointerUp={end}
        onPointerCancel={end}
        role="img"
        aria-label={t('studioCropCanvas')}
        className="scanStudioCropCanvas"
        style={{ display: 'block', margin: '0 auto', maxWidth: '100%', maxHeight: '100%', width: fitToContainer ? '100%' : 'auto', height: fitToContainer ? '100%' : 'auto', touchAction: 'none', cursor: 'default' }}
      />
      <canvas
        ref={magnifierRef}
        width={MAGNIFIER_BACKING}
        height={MAGNIFIER_BACKING}
        role="img"
        aria-label={t('studioMagnifierCanvas')}
        className="scanStudioMagnifierCanvas"
        style={{ ...magnifierStyle, imageRendering: 'pixelated' }}
      />
    </div>
  );
}
