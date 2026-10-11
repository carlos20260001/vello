/**
 * `kurbo/src/point.rs`: a 2D point.
 *
 * A point is a *position*, not a displacement, so (following kurbo) there is no
 * `Point + Point` and no `number * Point`. Convert with `to_vec2` if that is
 * genuinely what you mean.
 */

import { Vec2 } from './vec2.js';
import { expand } from './common.js';

/** A value accepted anywhere a `Point` is: the point itself, or its two coordinates. */
export type PointInit = Point | readonly [number, number];

/** A 2D point, as kurbo's `Point`. */
export class Point {
  constructor(
    readonly x = 0,
    readonly y = 0,
  ) {}

  /** The point at the origin. */
  static readonly ZERO = new Point(0, 0);

  /** The point at the origin; the other of kurbo's two spellings. */
  static readonly ORIGIN = new Point(0, 0);

  /** A new point from explicit coordinates. */
  static new(x: number, y: number): Point {
    return new Point(x, y);
  }

  /** The same position, as a `Vec2`. */
  to_vec2(): Vec2 {
    return new Vec2(this.x, this.y);
  }

  /** Linear interpolation between this point and `other`. */
  lerp(other: Point, t: number): Point {
    return new Point(this.x + (other.x - this.x) * t, this.y + (other.y - this.y) * t);
  }

  /** The midpoint of the two points. */
  midpoint(other: Point): Point {
    return new Point(0.5 * (this.x + other.x), 0.5 * (this.y + other.y));
  }

  /** Euclidean distance to `other`. */
  distance(other: Point): number {
    return Math.hypot(this.x - other.x, this.y - other.y);
  }

  /** Squared Euclidean distance to `other`. */
  distance_squared(other: Point): number {
    return (this.x - other.x) ** 2 + (this.y - other.y) ** 2;
  }

  /** Rounded to the nearest integer, per component. */
  round(): Point {
    return new Point(Math.round(this.x), Math.round(this.y));
  }

  /** Rounded up to the next integer, per component. */
  ceil(): Point {
    return new Point(Math.ceil(this.x), Math.ceil(this.y));
  }

  /** Rounded down to the previous integer, per component. */
  floor(): Point {
    return new Point(Math.floor(this.x), Math.floor(this.y));
  }

  /** Rounded away from zero to the next integer, per component. */
  expand(): Point {
    return new Point(expand(this.x), expand(this.y));
  }

  /** Rounded towards zero to the next integer, per component. */
  trunc(): Point {
    return new Point(Math.trunc(this.x), Math.trunc(this.y));
  }

  /** Whether both coordinates are finite. */
  is_finite(): boolean {
    return Number.isFinite(this.x) && Number.isFinite(this.y);
  }

  /** Whether either coordinate is NaN. */
  is_nan(): boolean {
    return Number.isNaN(this.x) || Number.isNaN(this.y);
  }
}
