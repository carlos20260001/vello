/**
 * `kurbo/src/flatten.rs`, partially: the tolerance-based flattening pass.
 *
 * Used by the `Shape` helpers that need to walk a path element by element
 * (`perimeter`, `winding`); the glyph rasterizer does its own flattening in
 * device space, which is why there is no shared entry point between the two.
 */

import type { PathEl } from './bezpath.js';

/** How much a curve deviates from its chord, at most. */
function max_deviation(pts: readonly (readonly [number, number])[]): number {
  // The chord runs from the first to the last point; the deviation is the
  // largest distance any control point reaches away from it, halved because
  // the Bézier reaches at most half of the control-point offset at the middle
  // of the segment.
  let max = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    max = Math.max(max, distance_to_segment(pts[i]!, pts[0]!, pts[pts.length - 1]!));
  }
  return max * 0.5;
}

/** The distance from `p` to the segment `a`–`b`. */
function distance_to_segment(p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(p[0] - (a[0] + t * abx), p[1] - (a[1] + t * aby));
}

/**
 * Reduces every curve in `commands` to line segments, to within `tolerance`.
 *
 * Subdividing a curve into `n` equal pieces reduces its deviation from the
 * chord by `n²`, so the subdivision count is `sqrt(deviation / tolerance)`
 * rounded up — the same estimate kurbo's own `flatten` makes. A non-positive
 * tolerance leaves the path untouched rather than diverging.
 */
export function flatten(commands: readonly PathEl[], tolerance: number): PathEl[] {
  if (!(tolerance > 0)) return [...commands];

  const out: PathEl[] = [];
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;

  const subdivide = (pts: readonly (readonly [number, number])[]): void => {
    const n = Math.max(1, Math.ceil(Math.sqrt(max_deviation(pts) / tolerance)));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      out.push({ kind: 'LineTo', x: eval_bernstein(pts, t, 0), y: eval_bernstein(pts, t, 1) });
    }
  };

  for (const el of commands) {
    switch (el.kind) {
      case 'MoveTo':
        out.push(el);
        cx = el.x;
        cy = el.y;
        startX = el.x;
        startY = el.y;
        break;
      case 'LineTo':
        out.push(el);
        cx = el.x;
        cy = el.y;
        break;
      case 'QuadTo':
        subdivide([[cx, cy], [el.cx, el.cy], [el.x, el.y]]);
        cx = el.x;
        cy = el.y;
        break;
      case 'CubicTo':
        subdivide([[cx, cy], [el.c1x, el.c1y], [el.c2x, el.c2y], [el.x, el.y]]);
        cx = el.x;
        cy = el.y;
        break;
      case 'Close':
        out.push(el);
        cx = startX;
        cy = startY;
        break;
    }
  }
  return out;
}

/** Evaluates the Bézier through `pts` at `t`, on component `comp`. */
function eval_bernstein(pts: readonly (readonly [number, number])[], t: number, comp: 0 | 1): number {
  const n = pts.length - 1;
  let acc = 0;
  for (let i = 0; i <= n; i++) {
    acc += bernstein(n, i, t) * pts[i]![comp];
  }
  return acc;
}

/** The Bernstein basis polynomial `B_{i,n}(t)`. */
function bernstein(n: number, i: number, t: number): number {
  return binomial(n, i) * t ** i * (1 - t) ** (n - i);
}

/** `n` choose `i`. */
function binomial(n: number, i: number): number {
  let acc = 1;
  for (let k = 1; k <= i; k++) {
    acc = (acc * (n - i + k)) / k;
  }
  return acc;
}
