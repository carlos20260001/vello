/**
 * Anti-aliased scanline glyph rasterizer.
 *
 * TypeScript replacement for the glyph-rasterization part of `vello_cpu`.
 *
 * `vello_cpu` is a general CPU vector renderer (strokes, gradients, blend
 * modes, filters, multi-threaded dispatch). `epaint` only ever needs one
 * thing from it: fill a small, closed, non-self-intersecting glyph outline with
 * a single non-zero-winding solid fill. That is a far smaller problem than
 * general vector rendering, so this implements just that.
 *
 * ## Approach
 *
 * Vertical supersampling with exact horizontal span coverage:
 *
 * - Each pixel row is sampled at `SUBSAMPLES` sub-scanlines.
 * - At each sub-scanline, edge intersections are sorted by x and walked with
 *   the non-zero winding rule to find filled spans.
 * - Each span contributes exact fractional coverage to the pixels it touches,
 *   so left/right edges are anti-aliased without blurring the interior.
 *
 * For glyph-sized bitmaps this is fast enough and, unlike an accumulator with
 * a coarse grid, it produces stable, artefact-free edges at small sizes.
 *
 * ## Not ported
 *
 * Strokes, gradients, image brushes, blend modes, blur filters, and the
 * `rayon` dispatch. See the README's "Not ported" section.
 */

import type { Path, PathCommand } from './path.js';

/**
 * Metadata for a rasterized glyph, without pixel data.
 *
 * Mirrors `glifo::atlas::RasterMetrics`, which is the struct `epaint` consumes.
 */
export class RasterMetrics {
  /** Width of the rasterized glyph in pixels. */
  width: number;
  /** Height of the rasterized glyph in pixels. */
  height: number;
  /** Horizontal bearing: offset from the glyph origin to the bitmap's left edge. */
  bearingX: number;
  /** Vertical bearing: offset from the glyph origin to the bitmap's top edge. */
  bearingY: number;

  constructor(width: number, height: number, bearingX: number, bearingY: number) {
    this.width = width;
    this.height = height;
    this.bearingX = bearingX;
    this.bearingY = bearingY;
  }
}

/** A rasterized glyph: alpha coverage plus its placement. */
export class RasterizedGlyph {
  readonly metrics: RasterMetrics;
  /** Row-major alpha coverage, `width * height`, values 0-255. */
  readonly coverage: Uint8Array;

  constructor(metrics: RasterMetrics, coverage: Uint8Array) {
    this.metrics = metrics;
    this.coverage = coverage;
  }

  /** Coverage at a pixel, or 0 if out of range. */
  at(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.metrics.width || y >= this.metrics.height) return 0;
    return this.coverage[y * this.metrics.width + x]!;
  }
}

/** Vertical sub-scanlines per pixel row. */
export const SUBSAMPLES = 16;

/** Input to a rasterization request. */
export interface RasterizeOptions {
  /**
   * Horizontal offset from the pixel grid, in pixels. Used to keep the glyph
   * crisp when scrolling by non-integer amounts.
   */
  subpixelOffsetX?: number;
  /** Vertical offset from the pixel grid, in pixels. */
  subpixelOffsetY?: number;
  /** Device scale, i.e. pixels per unit of outline space. */
  scale: number;
}

/** A device-space line segment. */
interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** +1 or -1 depending on the direction of travel. */
  dir: number;
}

/**
 * Flatten a path into device-space line segments.
 *
 * Quadratic Béziers are subdivided until they are flat enough to be invisible
 * at the requested scale.
 */
export function flattenPath(path: Path, scale: number, offsetX: number, offsetY: number): Edge[] {
  const edges: Edge[] = [];

  const sx = (x: number) => x * scale + offsetX;
  const sy = (y: number) => y * scale + offsetY;

  // Current point in device space.
  let cx = 0;
  let cy = 0;
  // Start of the current contour, so `Close` can return to it.
  let startX = 0;
  let startY = 0;

  const pushEdge = (x0: number, y0: number, x1: number, y1: number) => {
    if (x0 === x1 && y0 === y1) return; // skip degenerate
    // Skip horizontal edges: they never cross a scanline.
    if (y0 === y1) return;
    edges.push({ x0, y0, x1, y1, dir: y1 > y0 ? 1 : -1 });
  };

  const flattenQuad = (qx0: number, qy0: number, cx1: number, cy1: number, x1: number, y1: number) => {
    // The number of segments scales with the curve's device-space size.
    // A flatness tolerance of 0.1px is visually indistinguishable.
    const devSize = Math.abs(x1 - qx0) + Math.abs(y1 - qy0) + Math.abs(cx1 - qx0) + Math.abs(cy1 - qy0);
    const steps = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(devSize * 8))));
    let px = qx0;
    let py = qy0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      // de Casteljau
      const nx = mt * mt * qx0 + 2 * mt * t * cx1 + t * t * x1;
      const ny = mt * mt * qy0 + 2 * mt * t * cy1 + t * t * y1;
      pushEdge(px, py, nx, ny);
      px = nx;
      py = ny;
    }
  };

  for (const cmd of path.commands as PathCommand[]) {
    switch (cmd.kind) {
      case 'MoveTo':
        cx = sx(cmd.x);
        cy = sy(cmd.y);
        startX = cx;
        startY = cy;
        break;
      case 'LineTo': {
        const nx = sx(cmd.x);
        const ny = sy(cmd.y);
        pushEdge(cx, cy, nx, ny);
        cx = nx;
        cy = ny;
        break;
      }
      case 'QuadTo': {
        const qx = sx(cmd.cx);
        const qy = sy(cmd.cy);
        const nx = sx(cmd.x);
        const ny = sy(cmd.y);
        flattenQuad(cx, cy, qx, qy, nx, ny);
        cx = nx;
        cy = ny;
        break;
      }
      case 'Close':
        pushEdge(cx, cy, startX, startY);
        cx = startX;
        cy = startY;
        break;
    }
  }
  return edges;
}

/**
 * Rasterize a filled path.
 *
 * @param path    Outline in font units (y up).
 * @param opts    Scale and sub-pixel offsets.
 */
export function rasterize(path: Path, opts: RasterizeOptions): RasterizedGlyph {
  const scale = opts.scale;
  const offX = opts.subpixelOffsetX ?? 0;
  const offY = opts.subpixelOffsetY ?? 0;

  if (path.is_empty || scale <= 0) {
    return new RasterizedGlyph(new RasterMetrics(0, 0, 0, 0), new Uint8Array(0));
  }

  // Bounds in device space.
  const bounds = path.bounds();
  if (!bounds) {
    return new RasterizedGlyph(new RasterMetrics(0, 0, 0, 0), new Uint8Array(0));
  }

  // Round outward on all four sides so partially covered edge pixels are kept.
// Rounding the vertical bounds inward (floor of the top, ceil of the bottom)
// would silently discard them: a shape spanning -3.2..12.8 must cover the
// 17 pixel rows from -4 to 13, not the 15 from -3 to 12.
  const left = Math.floor(bounds.xMin * scale + offX);
  const right = Math.ceil(bounds.xMax * scale + offX);
  const bottom = Math.floor(bounds.yMin * scale + offY);
  const top = Math.ceil(bounds.yMax * scale + offY);

  const width = Math.max(0, right - left);
  const height = Math.max(0, top - bottom);
  if (width === 0 || height === 0) {
    return new RasterizedGlyph(new RasterMetrics(0, 0, left, top === 0 ? 0 : -top), new Uint8Array(0));
  }

  const edges = flattenPath(path, scale, offX, offY);
  const coverage = new Uint8Array(width * height);
  const acc = new Float32Array(width);

  // Walk each pixel row, sampling SUBSAMPLES sub-scanlines.
  for (let row = 0; row < height; row++) {
    acc.fill(0);
    const rowTop = bottom + row; // device-space y, increasing downward

    for (let sub = 0; sub < SUBSAMPLES; sub++) {
      const yc = rowTop + (sub + 0.5) / SUBSAMPLES;
      const crossings = collectCrossings(edges, yc);
      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a.x - b.x);
      fillRow(acc, crossings, width, 1 / SUBSAMPLES);
    }

    const base = row * width;
    for (let i = 0; i < width; i++) {
      const c = acc[i]!;
      if (c <= 0) continue;
      coverage[base + i] = Math.min(255, Math.round(c * 255));
    }
  }

  // Bearings are from the glyph origin (device 0,0) to the bitmap's top-left.
  // `bearingY` is the y-down convention: negated distance from the baseline up
  // to the top edge, matching glifo, which negates it again when positioning.
  // `-0` is normalized to `0` so equality comparisons behave.
  const bearingY = top === 0 ? 0 : -top;
  return new RasterizedGlyph(new RasterMetrics(width, height, left, bearingY), coverage);
}

/** x-intercepts of `edges` crossing the scanline `yc`, as `[x, windingDir]`. */
function collectCrossings(edges: Edge[], yc: number): { x: number; dir: number }[] {
  const out: { x: number; dir: number }[] = [];
  for (const e of edges) {
    // Half-open test: an edge covers the scanline if min(y) <= yc < max(y).
    // This makes shared vertices count exactly once.
    if (e.y0 < e.y1) {
      if (yc < e.y0 || yc >= e.y1) continue;
    } else {
      if (yc < e.y1 || yc >= e.y0) continue;
    }
    const t = (yc - e.y0) / (e.y1 - e.y0);
    out.push({ x: e.x0 + t * (e.x1 - e.x0), dir: e.dir });
  }
  return out;
}

/**
 * Walk sorted crossings with the non-zero winding rule and add fractional
 * coverage for each filled span.
 *
 * Coordinates here are relative to the bitmap's left edge; spans outside
 * `[0, width)` are clipped.
 */
function fillRow(acc: Float32Array, crossings: { x: number; dir: number }[], width: number, weight: number): void {
  let winding = 0;
  for (let i = 0; i + 1 <= crossings.length - 1; i++) {
    const a = crossings[i]!;
    const b = crossings[i + 1]!;
    winding += a.dir;
    if (winding === 0) continue;
    addSpan(acc, a.x, b.x, width, weight);
  }
}

/** Add coverage for the horizontal span `[x0, x1)`, clipped to `[0, width)`. */
function addSpan(acc: Float32Array, x0: number, x1: number, width: number, weight: number): void {
  const lo = Math.max(0, x0);
  const hi = Math.min(width, x1);
  if (hi <= lo) return;

  const first = Math.floor(lo);
  // The last pixel actually touched. The epsilon avoids treating an `hi` that
  // lands exactly on a pixel boundary as spilling into the next pixel.
  const last = Math.floor(hi - 1e-9);
  if (first === last) {
    acc[first] = acc[first]! + (hi - lo) * weight;
    return;
  }

  // Leading partial pixel (or a full one if `lo` is integral).
  acc[first] = acc[first]! + (lo > first ? first + 1 - lo : 1) * weight;

  // Fully covered interior.
  for (let x = first + 1; x < last; x++) {
    acc[x] = acc[x]! + weight;
  }

  // Trailing partial pixel (full if `hi` is integral).
  acc[last] = acc[last]! + (hi > last ? hi - last : 1) * weight;
}