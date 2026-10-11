/**
 * `kurbo/src/rect.rs`.
 *
 * `Rect` is a *value* type in kurbo — four public `f64` fields and no interior
 * mutability — and it doubles as a `Shape`, which is what lets `fill_rect`
 * reach the same pipeline as any other path.
 *
 * Two things to know when porting a call site:
 *
 * 1. Nothing normalizes a rectangle. `Rect::new(4, 0, 0, 4)` keeps its negative
 *    width and height, and `width()` is allowed to be negative; `abs()` is what
 *    turns it into the same extents with positive sides. That is why
 *    `from_points` and `from_origin_size` call it and `new` does not.
 * 2. `inset` *grows* the rectangle for positive insets, which is the opposite of
 *    what the CSS word means. Upstream's doc example is the reference:
 *    `Rect::new(0, 0, 10, 10).inset(2.)` is 14 wide and starts at x = -2.
 */

import type { Shape } from './shape.js';
import type { PathEl } from './bezpath.js';
import { Point, type PointInit } from './point.js';
import { expand } from './common.js';

/** A uniform or four-sided inset, as `kurbo::Insets`. */
export interface Insets {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** A rectangle, as kurbo's `Rect`. */
export class Rect implements Shape {
  constructor(
    readonly x0 = 0,
    readonly y0 = 0,
    readonly x1 = 0,
    readonly y1 = 0,
  ) {}

  /** The empty rectangle at the origin. */
  static readonly ZERO = new Rect(0, 0, 0, 0);

  /** A new rectangle from minimum and maximum coordinates, unnormalized. */
  static new(x0: number, y0: number, x1: number, y1: number): Rect {
    return new Rect(x0, y0, x1, y1);
  }

  /** A new rectangle from two points, normalized to non-negative sides. */
  static from_points(p0: PointInit, p1: PointInit): Rect {
    const a = to_point(p0);
    const b = to_point(p1);
    return new Rect(a.x, a.y, b.x, b.y).abs();
  }

  /** A new rectangle from an origin and a size, normalized. */
  static from_origin_size(origin: PointInit, size: { readonly width: number; readonly height: number }): Rect {
    const o = to_point(origin);
    return Rect.from_points(o, new Point(o.x + size.width, o.y + size.height));
  }

  /** A new rectangle from a center and a size. */
  static from_center_size(center: PointInit, size: { readonly width: number; readonly height: number }): Rect {
    const c = to_point(center);
    return new Rect(
      c.x - size.width * 0.5,
      c.y - size.height * 0.5,
      c.x + size.width * 0.5,
      c.y + size.height * 0.5,
    );
  }

  /** The same rectangle, with a new origin. */
  with_origin(origin: PointInit): Rect {
    return Rect.from_origin_size(origin, this.size());
  }

  /** The same rectangle, with a new size. */
  with_size(size: { readonly width: number; readonly height: number }): Rect {
    return Rect.from_origin_size(this.origin(), size);
  }

  /** Applies an inset, growing the rectangle by it. */
  inset(insets: Insets | number): Rect {
    const i = typeof insets === 'number' ? { x0: insets, y0: insets, x1: insets, y1: insets } : insets;
    return new Rect(this.x0 - i.x0, this.y0 - i.y0, this.x1 + i.x1, this.y1 + i.y1);
  }

  /** The width, which may be negative. */
  width(): number {
    return this.x1 - this.x0;
  }

  /** The height, which may be negative. */
  height(): number {
    return this.y1 - this.y0;
  }

  /** The smaller x coordinate. */
  min_x(): number {
    return Math.min(this.x0, this.x1);
  }

  /** The larger x coordinate. */
  max_x(): number {
    return Math.max(this.x0, this.x1);
  }

  /** The smaller y coordinate. */
  min_y(): number {
    return Math.min(this.y0, this.y1);
  }

  /** The larger y coordinate. */
  max_y(): number {
    return Math.max(this.y0, this.y1);
  }

  /** The top-left corner in a y-down space. */
  origin(): Point {
    return new Point(this.x0, this.y0);
  }

  /** The size, with the rectangle's (possibly negative) width and height. */
  size(): { width: number; height: number } {
    return { width: this.width(), height: this.height() };
  }

  /** The area, which may be negative. */
  area(): number {
    return this.width() * this.height();
  }

  /** Whether the area is exactly zero. */
  is_zero_area(): boolean {
    return this.area() === 0;
  }

  /** The center point. */
  center(): Point {
    return new Point(0.5 * (this.x0 + this.x1), 0.5 * (this.y0 + this.y1));
  }

  /** Whether `point` lies inside, treating the far edges as outside. */
  contains(point: PointInit): boolean {
    const p = to_point(point);
    return p.x >= this.x0 && p.x < this.x1 && p.y >= this.y0 && p.y < this.y1;
  }

  /** The same extents, with non-negative width and height. */
  abs(): Rect {
    return new Rect(
      Math.min(this.x0, this.x1),
      Math.min(this.y0, this.y1),
      Math.max(this.x0, this.x1),
      Math.max(this.y0, this.y1),
    );
  }

  /** The smallest rectangle enclosing both, valid only for non-negative sides. */
  union(other: Rect): Rect {
    return new Rect(
      Math.min(this.x0, other.x0),
      Math.min(this.y0, other.y0),
      Math.max(this.x1, other.x1),
      Math.max(this.y1, other.y1),
    );
  }

  /** The smallest rectangle enclosing this one and `pt`. */
  union_pt(pt: PointInit): Rect {
    const p = to_point(pt);
    return new Rect(
      Math.min(this.x0, p.x),
      Math.min(this.y0, p.y),
      Math.max(this.x1, p.x),
      Math.max(this.y1, p.y),
    );
  }

  /**
   * The intersection of the two rectangles.
   *
   * The result never has negative sides: the far edges are clamped to the
   * *near* edges rather than to each other, so an empty intersection collapses
   * to a zero-area rectangle at a coordinate taken from the inputs instead of
   * flipping its orientation.
   */
  intersect(other: Rect): Rect {
    const x0 = Math.max(this.x0, other.x0);
    const y0 = Math.max(this.y0, other.y0);
    const x1 = Math.max(Math.min(this.x1, other.x1), x0);
    const y1 = Math.max(Math.min(this.y1, other.y1), y0);
    return new Rect(x0, y0, x1, y1);
  }

  /** Whether the two rectangles overlap, shared edges included. */
  overlaps(other: Rect): boolean {
    return this.x0 <= other.x1 && this.x1 >= other.x0 && this.y0 <= other.y1 && this.y1 >= other.y0;
  }

  /** Whether this rectangle fully encloses `other`. */
  contains_rect(other: Rect): boolean {
    return this.x0 <= other.x0 && this.y0 <= other.y0 && this.x1 >= other.x1 && this.y1 >= other.y1;
  }

  /** Grows the rectangle by `width` horizontally and `height` vertically. */
  inflate(width: number, height: number): Rect {
    return new Rect(this.x0 - width, this.y0 - height, this.x1 + width, this.y1 + height);
  }

  /** Rounds each coordinate to the nearest integer. */
  round(): Rect {
    return new Rect(
      Math.round(this.x0), Math.round(this.y0), Math.round(this.x1), Math.round(this.y1),
    );
  }

  /** Rounds each coordinate up. */
  ceil(): Rect {
    return new Rect(Math.ceil(this.x0), Math.ceil(this.y0), Math.ceil(this.x1), Math.ceil(this.y1));
  }

  /** Rounds each coordinate down. */
  floor(): Rect {
    return new Rect(Math.floor(this.x0), Math.floor(this.y0), Math.floor(this.x1), Math.floor(this.y1));
  }

  /**
   * Rounds outwards to whole pixels: the smallest integer-coordinate rectangle
   * that contains this one.
   *
   * This is what the coarse stage uses to turn a shape's bounding box into a
   * device-space region, and it must round *out*: rounding in would silently
   * drop the partially covered edge rows.
   */
  expand(): Rect {
    return new Rect(
      expand(this.x0), expand(this.y0), expand(this.x1), expand(this.y1),
    );
  }

  /** Rounds each coordinate towards the center of the rectangle. */
  trunc(): Rect {
    return new Rect(
      this.x0 < this.x1 ? Math.ceil(this.x0) : Math.floor(this.x0),
      this.y0 < this.y1 ? Math.ceil(this.y0) : Math.floor(this.y0),
      this.x0 < this.x1 ? Math.floor(this.x1) : Math.ceil(this.x1),
      this.y0 < this.y1 ? Math.floor(this.y1) : Math.ceil(this.y1),
    );
  }

  /** Scales the rectangle about the origin. */
  scale_from_origin(factor: number): Rect {
    return new Rect(this.x0 * factor, this.y0 * factor, this.x1 * factor, this.y1 * factor);
  }

  /** Whether every coordinate is finite. */
  is_finite(): boolean {
    return [this.x0, this.y0, this.x1, this.y1].every(Number.isFinite);
  }

  /** Whether any coordinate is NaN. */
  is_nan(): boolean {
    return Number.isNaN(this.x0) || Number.isNaN(this.y0) || Number.isNaN(this.x1) || Number.isNaN(this.y1);
  }

  // -- Shape ---------------------------------------------------------------

  /**
   * The path elements: the four corners and a close, in the order
   * `RectPathIter` emits them. Clockwise in a y-down space, which is the
   * positive-area direction.
   */
  get commands(): readonly PathEl[] {
    return [
      { kind: 'MoveTo', x: this.x0, y: this.y0 },
      { kind: 'LineTo', x: this.x1, y: this.y0 },
      { kind: 'LineTo', x: this.x1, y: this.y1 },
      { kind: 'LineTo', x: this.x0, y: this.y1 },
      { kind: 'Close' },
    ];
  }
}

/** Normalizes a coordinate pair to a `Point`. */
export function to_point(v: PointInit): Point {
  return 'x' in v ? v : new Point(v[0]!, v[1]!);
}
