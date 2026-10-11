/**
 * Path primitives for the glyph rasterizer.
 *
 * A `kurbo::BezPath` in every respect, with two additions the rasterizer needs
 * that kurbo does not carry: `bounds()`, which reports the hull of the control
 * points, and `Path.from`, which adopts a bare command list.
 *
 * Deliberately a specialization of the `kurbo` port's `BezPath` rather than a
 * dependency on the `skrifa` port: the two crates are separate upstream
 * projects with separate forks and release cycles, so coupling them would be
 * wrong. The element type is shared with `kurbo` (`PathEl`), so an outline
 * crosses over from either side without conversion.
 *
 * Note that `y` grows **upwards** here, as in font space: this is the
 * rasterizer's own convention, and it is not the convention the vello render
 * pipeline works in. See `render/mod.ts` for the single place the two are
 * reconciled.
 */

import { BezPath } from './kurbo/bezpath.js';
import { bounding_box } from './kurbo/shape.js';
import type { PathEl } from './kurbo/bezpath.js';
import { Point } from './kurbo/point.js';

/** A single path element, as kurbo's `PathEl`. Kept as the glyph side's name. */
export type PathCommand = PathEl;

/** A path of contours. Note `y` grows upwards, as in font space. */
export class Path extends BezPath {
  /**
   * Axis-aligned bounds over all on- and off-curve control points.
   *
   * `Shape::bounding_box` in a different shape: the glyph rasterizer works with
   * `min`/`max` names rather than a `Rect`.
   */
  bounds(): { xMin: number; yMin: number; xMax: number; yMax: number } | undefined {
    if (this.is_empty) return undefined;
    const b = bounding_box(this);
    return { xMin: b.x0, yMin: b.y0, xMax: b.x1, yMax: b.y1 };
  }

  /**
   * Builds a path from a structural shape.
   *
   * `rasterize` takes a `Path` because it uses the builder's own `bounds()`;
   * the render pipeline works with plain command lists so geometry from the
   * other ports needs no conversion. This adapter is the seam between them.
   */
  static from(shape: { readonly commands: readonly PathEl[] }): Path {
    const p = new Path();
    p.extend(shape.commands);
    return p;
  }

  // -- Glyph-side spellings -------------------------------------------------
  //
  // The rasterizer's API predates the kurbo port and names its builder methods
  // `moveTo`, `lineTo`, `quadTo`, `cubicTo`, `close`, so those spellings are
  // kept as aliases for kurbo's. New code should prefer the kurbo names.

  /** `BezPath::move_to`. */
  moveTo(x: number, y: number): this {
    return this.move_to(new Point(x, y));
  }

  /** `BezPath::line_to`. */
  lineTo(x: number, y: number): this {
    return this.line_to(new Point(x, y));
  }

  /** `BezPath::quad_to`. */
  quadTo(cx: number, cy: number, x: number, y: number): this {
    return this.quad_to(new Point(cx, cy), new Point(x, y));
  }

  /** `BezPath::curve_to`. */
  cubicTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): this {
    return this.curve_to(new Point(c1x, c1y), new Point(c2x, c2y), new Point(x, y));
  }

  /** `BezPath::close_path`. */
  close(): this {
    return this.close_path();
  }
}
