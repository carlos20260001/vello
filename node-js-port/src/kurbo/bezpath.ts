/**
 * `kurbo/src/bezpath.rs`, partially: `PathEl`, `BezPath` and the segment
 * machinery the port needs.
 *
 * Path elements are a discriminated union rather than kurbo's enum of
 * `Point`-tuples, which is the one structural deviation in this file: it lets
 * the glyph rasterizer (which was written before `kurbo` was ported) consume a
 * `BezPath` without conversion, because every element already carries its
 * coordinates inline.
 */

import { Point } from './point.js';

/** A single path element, as kurbo's `PathEl`. */
export type PathEl =
  | { readonly kind: 'MoveTo'; readonly x: number; readonly y: number }
  | { readonly kind: 'LineTo'; readonly x: number; readonly y: number }
  | { readonly kind: 'QuadTo'; readonly cx: number; readonly cy: number; readonly x: number; readonly y: number }
  | {
      readonly kind: 'CubicTo';
      readonly c1x: number;
      readonly c1y: number;
      readonly c2x: number;
      readonly c2y: number;
      readonly x: number;
      readonly y: number;
    }
  | { readonly kind: 'Close' };

/** A path segment: an element plus the point it starts from. */
export type PathSeg =
  | { readonly kind: 'Line'; readonly p0: Point; readonly p1: Point }
  | { readonly kind: 'Quad'; readonly p0: Point; readonly p1: Point; readonly p2: Point }
  | { readonly kind: 'Cubic'; readonly p0: Point; readonly p1: Point; readonly p2: Point; readonly p3: Point };

/** The points a `PathEl` contributes to the hull of the path. */
export function path_el_points(el: PathEl): Point[] {
  switch (el.kind) {
    case 'MoveTo':
    case 'LineTo':
      return [new Point(el.x, el.y)];
    case 'QuadTo':
      return [new Point(el.cx, el.cy), new Point(el.x, el.y)];
    case 'CubicTo':
      return [new Point(el.c1x, el.c1y), new Point(el.c2x, el.c2y), new Point(el.x, el.y)];
    case 'Close':
      return [];
  }
}

/** A Bézier path, as kurbo's `BezPath`. */
export class BezPath {
  /** The elements, in order. `commands` names the same field the rest of the port uses. */
  readonly commands: PathEl[] = [];

  /** The elements, as kurbo's `BezPath::elements`. */
  elements(): readonly PathEl[] {
    return this.commands;
  }

  /** Whether the path has no elements. */
  get is_empty(): boolean {
    return this.commands.length === 0;
  }

  /** Starts a new subpath at `p`. */
  move_to(p: Point): this {
    this.commands.push({ kind: 'MoveTo', x: p.x, y: p.y });
    return this;
  }

  /** Adds a line from the current point to `p`. */
  line_to(p: Point): this {
    this.commands.push({ kind: 'LineTo', x: p.x, y: p.y });
    return this;
  }

  /** Adds a quadratic Bézier, control point first. */
  quad_to(p1: Point, p2: Point): this {
    this.commands.push({ kind: 'QuadTo', cx: p1.x, cy: p1.y, x: p2.x, y: p2.y });
    return this;
  }

  /** Adds a cubic Bézier, control points in order. */
  curve_to(p1: Point, p2: Point, p3: Point): this {
    this.commands.push({
      kind: 'CubicTo',
      c1x: p1.x,
      c1y: p1.y,
      c2x: p2.x,
      c2y: p2.y,
      x: p3.x,
      y: p3.y,
    });
    return this;
  }

  /** Closes the current subpath. */
  close_path(): this {
    this.commands.push({ kind: 'Close' });
    return this;
  }

  /** Appends another path's elements. */
  extend(other: readonly PathEl[]): this {
    this.commands.push(...other);
    return this;
  }

  /**
   * Flattens every element into `PathSeg`s, keeping the point each one starts
   * from so that segments are self-contained.
   *
   * Implicit closes are emitted: a `MoveTo` that interrupts an open subpath
   * contributes a closing line back to that subpath's start, which is what
   * kurbo's `path_segments` guarantees to callers that just walk a path.
   */
  path_segments(): PathSeg[] {
    const out: PathSeg[] = [];
    let start = new Point(0, 0);
    let prev = new Point(0, 0);
    let open = false;

    const line = (p0: Point, p1: Point): void => {
      out.push({ kind: 'Line', p0, p1 });
    };

    for (const el of this.commands) {
      switch (el.kind) {
        case 'MoveTo': {
          if (open) line(prev, start);
          const p = new Point(el.x, el.y);
          start = p;
          prev = p;
          open = true;
          break;
        }
        case 'LineTo': {
          const p = new Point(el.x, el.y);
          line(prev, p);
          prev = p;
          break;
        }
        case 'QuadTo': {
          const p = new Point(el.x, el.y);
          const c = new Point(el.cx, el.cy);
          out.push({ kind: 'Quad', p0: prev, p1: c, p2: p });
          prev = p;
          break;
        }
        case 'CubicTo': {
          const p = new Point(el.x, el.y);
          const c1 = new Point(el.c1x, el.c1y);
          const c2 = new Point(el.c2x, el.c2y);
          out.push({ kind: 'Cubic', p0: prev, p1: c1, p2: c2, p3: p });
          prev = p;
          break;
        }
        case 'Close': {
          if (open) line(prev, start);
          prev = start;
          open = false;
          break;
        }
      }
    }
    if (open) line(prev, start);
    return out;
  }
}
