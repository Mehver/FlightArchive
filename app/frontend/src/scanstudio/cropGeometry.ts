// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Geometry for the Stage 1 rotated rectangle. Drawing corners are derived. */
export interface Point {
  x: number;
  y: number;
}

export type Quad = [Point, Point, Point, Point];

export interface QuadBounds {
  width: number;
  height: number;
}

export interface CropRect {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotationDegrees: number;
}

export const CROP_COORD_MIN = 0;
export const CROP_COORD_MAX = 1_000_000;
export const CROP_SIZE_MIN = 0.001;
export const CROP_SIZE_MAX = 1_000_000;
export const CROP_ROTATION_MIN = -360;
export const CROP_ROTATION_MAX = 360;
export const MIN_QUAD_EDGE = 4;
export const QUAD_EDGES: readonly (readonly [number, number])[] = [[0, 1], [1, 2], [2, 3], [3, 0]];

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function point(x: number, y: number): Point {
  return { x, y };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Derive the four drawing points of a rotated rectangle. */
export function rectToQuad(rect: CropRect): Quad {
  const angle = (rect.rotationDegrees * Math.PI) / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;

  return [
    [-halfWidth, -halfHeight],
    [halfWidth, -halfHeight],
    [halfWidth, halfHeight],
    [-halfWidth, halfHeight],
  ].map(([x, y]) => point(rect.centerX + x * cosine - y * sine, rect.centerY + x * sine + y * cosine)) as Quad;
}

export function rectFromQuad(quad: Quad): CropRect {
  const centerX = quad.reduce((total, vertex) => total + vertex.x, 0) / 4;
  const centerY = quad.reduce((total, vertex) => total + vertex.y, 0) / 4;
  const width = (Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y) + Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y)) / 2;
  const height = (Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y) + Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y)) / 2;
  const rotationDegrees = (Math.atan2(quad[1].y - quad[0].y, quad[1].x - quad[0].x) * 180) / Math.PI;

  return { centerX, centerY, width, height, rotationDegrees };
}

export function quadCenter(quad: Quad): Point {
  const rect = rectFromQuad(quad);
  return point(rect.centerX, rect.centerY);
}

export function quadEdgeLength(quad: Quad, edge: number): number {
  const [start, end] = QUAD_EDGES[edge];
  return Math.hypot(quad[end].x - quad[start].x, quad[end].y - quad[start].y);
}

export function quadEdgeMidpoint(quad: Quad, edge: number): Point {
  const [start, end] = QUAD_EDGES[edge];
  return point((quad[start].x + quad[end].x) / 2, (quad[start].y + quad[end].y) / 2);
}

export function quadEdgeOutwardNormal(quad: Quad, edge: number): Point {
  const midpoint = quadEdgeMidpoint(quad, edge);
  const center = quadCenter(quad);
  const [start, end] = QUAD_EDGES[edge];
  const dx = quad[end].x - quad[start].x;
  const dy = quad[end].y - quad[start].y;
  const length = Math.hypot(dx, dy) || 1;
  let normal = point(dy / length, -dx / length);

  if (normal.x * (midpoint.x - center.x) + normal.y * (midpoint.y - center.y) < 0) {
    normal = point(-normal.x, -normal.y);
  }
  return normal;
}

/** Point for the rotation handle extending outward from the rectangle's top edge. */
export function rotationHandlePoint(quad: Quad, offset: number): Point {
  const midpoint = quadEdgeMidpoint(quad, 0);
  const normal = quadEdgeOutwardNormal(quad, 0);
  return point(midpoint.x + normal.x * offset, midpoint.y + normal.y * offset);
}

export function isQuadWithinBounds(quad: Quad, bounds: QuadBounds): boolean {
  return Number.isFinite(bounds.width) && Number.isFinite(bounds.height)
    && quad.every((vertex) => vertex.x >= 0 && vertex.y >= 0 && vertex.x <= bounds.width && vertex.y <= bounds.height);
}

export function isUsableQuad(quad: Quad, minimumEdge = MIN_QUAD_EDGE): boolean {
  const rect = rectFromQuad(quad);
  return quad.every((vertex) => Number.isFinite(vertex.x) && Number.isFinite(vertex.y))
    && rect.width >= minimumEdge
    && rect.height >= minimumEdge;
}

export function quadContains(quad: Quad, target: Point): boolean {
  const rect = rectFromQuad(quad);
  const angle = (-rect.rotationDegrees * Math.PI) / 180;
  const x = (target.x - rect.centerX) * Math.cos(angle) - (target.y - rect.centerY) * Math.sin(angle);
  const y = (target.x - rect.centerX) * Math.sin(angle) + (target.y - rect.centerY) * Math.cos(angle);
  return Math.abs(x) <= rect.width / 2 && Math.abs(y) <= rect.height / 2;
}

export function distanceToSegment(target: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const progress = clamp(((target.x - start.x) * dx + (target.y - start.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(target.x - start.x - progress * dx, target.y - start.y - progress * dy);
}

export function translateQuad(quad: Quad, dx: number, dy: number, bounds?: QuadBounds): Quad {
  const rect = rectFromQuad(quad);
  if (bounds) {
    const xs = quad.map((vertex) => vertex.x);
    const ys = quad.map((vertex) => vertex.y);
    dx = clamp(dx, -Math.min(...xs), bounds.width - Math.max(...xs));
    dy = clamp(dy, -Math.min(...ys), bounds.height - Math.max(...ys));
  }
  return rectToQuad({ ...rect, centerX: rect.centerX + dx, centerY: rect.centerY + dy });
}

/** Resize from a corner while preserving the opposite diagonal and right angles. */
export function moveQuadVertex(quad: Quad, index: number, target: Point, bounds?: QuadBounds): Quad {
  const rect = rectFromQuad(quad);
  const opposite = quad[(index + 2) % 4];
  const inverseAngle = (-rect.rotationDegrees * Math.PI) / 180;
  let width = (target.x - opposite.x) * Math.cos(inverseAngle) - (target.y - opposite.y) * Math.sin(inverseAngle);
  let height = (target.x - opposite.x) * Math.sin(inverseAngle) + (target.y - opposite.y) * Math.cos(inverseAngle);
  width = Math.max(MIN_QUAD_EDGE, Math.abs(width));
  height = Math.max(MIN_QUAD_EDGE, Math.abs(height));

  const widthSign = index === 0 || index === 3 ? -1 : 1;
  const heightSign = index === 0 || index === 1 ? -1 : 1;
  const angle = -inverseAngle;
  const centerX = opposite.x + (widthSign * width / 2) * Math.cos(angle) - (heightSign * height / 2) * Math.sin(angle);
  const centerY = opposite.y + (widthSign * width / 2) * Math.sin(angle) + (heightSign * height / 2) * Math.cos(angle);
  const candidate = rectToQuad({ centerX, centerY, width, height, rotationDegrees: rect.rotationDegrees });
  return !bounds || isQuadWithinBounds(candidate, bounds) ? candidate : quad;
}

export function moveQuadEdge(quad: Quad, edge: number, amount: number, bounds?: QuadBounds): Quad {
  const rect = rectFromQuad(quad);
  const normal = quadEdgeOutwardNormal(quad, edge);
  const next = { ...rect };
  if (edge === 0 || edge === 2) {
    next.height = Math.max(MIN_QUAD_EDGE, rect.height + amount);
  } else {
    next.width = Math.max(MIN_QUAD_EDGE, rect.width + amount);
  }
  next.centerX += normal.x * amount / 2;
  next.centerY += normal.y * amount / 2;
  const candidate = rectToQuad(next);
  return !bounds || isQuadWithinBounds(candidate, bounds) ? candidate : quad;
}

export function rotateQuad(quad: Quad, deltaDegrees: number, pivot: Point = quadCenter(quad)): Quad {
  const rect = rectFromQuad(quad);
  const angle = (deltaDegrees * Math.PI) / 180;
  const x = rect.centerX - pivot.x;
  const y = rect.centerY - pivot.y;
  return rectToQuad({
    ...rect,
    centerX: pivot.x + x * Math.cos(angle) - y * Math.sin(angle),
    centerY: pivot.y + x * Math.sin(angle) + y * Math.cos(angle),
    rotationDegrees: rect.rotationDegrees + deltaDegrees,
  });
}

export function rotateQuadWithinBounds(quad: Quad, deltaDegrees: number, bounds: QuadBounds, pivot?: Point): Quad {
  const candidate = rotateQuad(quad, deltaDegrees, pivot);
  return isQuadWithinBounds(candidate, bounds) ? candidate : quad;
}

export function defaultQuad(bounds: QuadBounds, inset = 0.08): Quad {
  return rectToQuad({
    centerX: bounds.width / 2,
    centerY: bounds.height / 2,
    width: bounds.width * (1 - inset * 2),
    height: bounds.height * (1 - inset * 2),
    rotationDegrees: 0,
  });
}

export function normalizeQuadGeometry(quad: Quad, bounds?: QuadBounds): CropRect {
  const rect = rectFromQuad(quad);
  const normalized = {
    centerX: clamp(round2(rect.centerX), CROP_COORD_MIN, CROP_COORD_MAX),
    centerY: clamp(round2(rect.centerY), CROP_COORD_MIN, CROP_COORD_MAX),
    width: clamp(round2(rect.width), CROP_SIZE_MIN, CROP_SIZE_MAX),
    height: clamp(round2(rect.height), CROP_SIZE_MIN, CROP_SIZE_MAX),
    rotationDegrees: clamp(round2(rect.rotationDegrees), CROP_ROTATION_MIN, CROP_ROTATION_MAX),
  };
  if (!bounds || isQuadWithinBounds(rectToQuad(normalized), bounds)) return normalized;
  // Rounding can move a rectangle resting on an image edge just outside it.
  // Keep the valid source geometry precise rather than crop different pixels.
  return {
    centerX: clamp(rect.centerX, CROP_COORD_MIN, CROP_COORD_MAX),
    centerY: clamp(rect.centerY, CROP_COORD_MIN, CROP_COORD_MAX),
    width: clamp(rect.width, CROP_SIZE_MIN, CROP_SIZE_MAX),
    height: clamp(rect.height, CROP_SIZE_MIN, CROP_SIZE_MAX),
    rotationDegrees: clamp(rect.rotationDegrees, CROP_ROTATION_MIN, CROP_ROTATION_MAX),
  };
}
