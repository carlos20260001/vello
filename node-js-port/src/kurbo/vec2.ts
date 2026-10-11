/** `kurbo/src/vec2.rs`: a 2D vector; a *change* in position, not a position. */

import { Point } from './point.js';

/** The 2D vector, as kurbo's `Vec2`. */
export class Vec2 {
  constructor(
    readonly x = 0,
    readonly y = 0,
  ) {}

  /** The zero vector. */
  static readonly ZERO = new Vec2(0, 0);

  /** A new vector from explicit components. */
  static new(x: number, y: number): Vec2 {
    return new Vec2(x, y);
  }

  /** The same vector, as a `Point`. */
  to_point(): Point {
    return new Point(this.x, this.y);
  }

  /** Linear interpolation towards `other`. */
  lerp(other: Vec2, t: number): Vec2 {
    return new Vec2(this.x + (other.x - this.x) * t, this.y + (other.y - this.y) * t);
  }

  /** Euclidean length. */
  hypot(): number {
    return Math.hypot(this.x, this.y);
  }

  /** Squared Euclidean length, cheaper and enough for comparisons. */
  hypot2(): number {
    return this.x * this.x + this.y * this.y;
  }

  /** The z component of the cross product with `other`. */
  cross(other: Vec2): number {
    return this.x * other.y - this.y * other.x;
  }

  /** The dot product with `other`. */
  dot(other: Vec2): number {
    return this.x * other.x + this.y * other.y;
  }

  /** Uniformly scaled. */
  scale(s: number): Vec2 {
    return new Vec2(this.x * s, this.y * s);
  }
}
