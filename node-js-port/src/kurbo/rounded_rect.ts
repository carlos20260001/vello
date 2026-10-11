/**
 * `kurbo/src/rounded_rect.rs`.
 *
 * The radii are clamped to fit inside the rectangle at construction, which is
 * the difference between a rounded rect and a broken one: a radius larger than
 * half the shortest side would make the corner arcs cross each other and
 * produce a self-intersecting outline that fills as an hourglass rather than a
 * blob.
 */

import type { Shape } from './shape.js';
import type { PathEl } from './bezpath.js';
import { Point } from './point.js';
import { Rect } from './rect.js';
import { RoundedRectRadii } from './rounded_rect_radii.js';

/** The arc control-point factor for a 90° arc: `4/3 * tan(π/8)`. */
const KAPPA = (4 / 3) * Math.tan(Math.PI / 8);

/** A quarter turn. */
const QUARTER = Math.PI / 2;

/** A rectangle with rounded corners, as kurbo's `RoundedRect`. */
export class RoundedRect implements Shape {
  constructor(
    readonly rect: Rect,
    readonly radii: RoundedRectRadii,
  ) {}

  /**
   * A rounded rect with one radius on every corner, clamped to fit.
   *
   * `radiusX`/`radiusY` are the port's spelling of kurbo's single per-corner
   * radius: the two axes are what the draw API takes, so they are kept.
   */
  static new(x0: number, y0: number, x1: number, y1: number, radiusX: number, radiusY = radiusX): RoundedRect {
    return RoundedRect.from_rect(Rect.new(x0, y0, x1, y1), RoundedRectRadii.uniform(radiusX, radiusY));
  }

  /** Builds from an existing rectangle, clamping the radii into it. */
  static from_rect(rect: Rect, radii: RoundedRectRadii): RoundedRect {
    const r = rect.abs();
    return new RoundedRect(r, radii.clamp(r.width() * 0.5, r.height() * 0.5));
  }

  /** The rectangle the corners are rounded within. */
  to_rect(): Rect {
    return this.rect;
  }

  /** The largest radius of the four corners, in x. */
  get radius(): number {
    return this.radii.max_x();
  }

  width(): number {
    return this.rect.width();
  }

  height(): number {
    return this.rect.height();
  }

  center(): Point {
    return this.rect.center();
  }

  is_zero_area(): boolean {
    return this.rect.is_zero_area();
  }

  // -- Shape ---------------------------------------------------------------

  /**
   * The outline: four straight edges joined by four 90° arcs, each arc a single
   * cubic that is exact at both endpoints.
   *
   * The element order is `RoundedRectPathIter`'s: a `MoveTo` on the left edge,
   * then the top-left, top-right, bottom-right and bottom-left arcs with the
   * top, right and bottom edges between them, and the left edge as the closing
   * line. That walks clockwise in a y-down space for positive area, which is
   * the direction `Rect`'s own elements take.
   */
  get commands(): readonly PathEl[] {
    const { x0, y0, x1, y1 } = this.rect;
    const { top_left: tl, top_right: tr, bottom_right: br, bottom_left: bl } = this.radii;
    const out: PathEl[] = [];

    /** Emits the 90° arc centred at `(cx, cy)`, sweeping from angle `from`. */
    const corner = ({ rx, ry }: { readonly rx: number; readonly ry: number }, cx: number, cy: number, from: number): void => {
      if (rx === 0 || ry === 0) return;
      const to = from + QUARTER;
      const p0 = [cx + Math.cos(from) * rx, cy + Math.sin(from) * ry] as const;
      const p3 = [cx + Math.cos(to) * rx, cy + Math.sin(to) * ry] as const;
      // The tangent at angle θ is (-sin θ, cos θ); the control points sit one
      // kappa along it from each endpoint.
      const c1 = [p0[0] - KAPPA * Math.sin(from) * rx, p0[1] + KAPPA * Math.cos(from) * ry] as const;
      const c2 = [p3[0] + KAPPA * Math.sin(to) * rx, p3[1] - KAPPA * Math.cos(to) * ry] as const;
      out.push({
        kind: 'CubicTo',
        c1x: c1[0],
        c1y: c1[1],
        c2x: c2[0],
        c2y: c2[1],
        x: p3[0],
        y: p3[1],
      });
    };

    out.push({ kind: 'MoveTo', x: x0, y: y0 + tl.ry });
    corner(tl, x0 + tl.rx, y0 + tl.ry, Math.PI);
    out.push({ kind: 'LineTo', x: x1 - tr.rx, y: y0 });
    corner(tr, x1 - tr.rx, y0 + tr.ry, 1.5 * Math.PI);
    out.push({ kind: 'LineTo', x: x1, y: y1 - br.ry });
    corner(br, x1 - br.rx, y1 - br.ry, 0);
    out.push({ kind: 'LineTo', x: x0 + bl.rx, y: y1 });
    corner(bl, x0 + bl.rx, y1 - bl.ry, 0.5 * Math.PI);
    out.push({ kind: 'Close' });
    return out;
  }
}
