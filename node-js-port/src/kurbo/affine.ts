/**
 * `kurbo/src/affine.rs`.
 *
 * The matrix layout is kurbo's, and it is *not* the layout most other graphics
 * libraries use: the six coefficients are stored as `[a, b, c, d, e, f]` and
 * apply as
 *
 * ```text
 *   x' = a * x + c * y + e
 *   y' = b * x + d * y + f
 * ```
 *
 * so the argument order of `Affine::new(a, b, c, d, e, f)` puts the *y* row
 * before the translation. Anything reading `as_coeffs()` positionally — which
 * `vello_common` does in `is_axis_aligned` and `is_integer_translation` — has
 * to know that.
 *
 * `then` is the other trap. `a.then(b)` applies `b` *first* and `a` second,
 * which is the opposite order from reading it left to right; `pre_translate`
 * and friends are the `then` inverses.
 */

import { Point, type PointInit } from './point.js';
import { Rect } from './rect.js';
import { Vec2 } from './vec2.js';
import { is_nearly_zero } from './common.js';

/** A 2D affine transform, as kurbo's `Affine`. */
export class Affine {
  constructor(
    readonly a = 1,
    readonly b = 0,
    readonly c = 0,
    readonly d = 1,
    readonly e = 0,
    readonly f = 0,
  ) {}

  /** The identity transform. */
  static readonly IDENTITY = new Affine(1, 0, 0, 1, 0, 0);

  /** A new transform from the six coefficients, in kurbo's storage order. */
  static new(a: number, b: number, c: number, d: number, e: number, f: number): Affine {
    return new Affine(a, b, c, d, e, f);
  }

  /** A uniform scale about the origin. */
  static scale(s: number): Affine {
    return new Affine(s, 0, 0, s, 0, 0);
  }

  /** A non-uniform scale about the origin. */
  static scale_non_uniform(sx: number, sy: number): Affine {
    return new Affine(sx, 0, 0, sy, 0, 0);
  }

  /** A translation. */
  static translate(tx: number, ty: number = 0): Affine {
    return new Affine(1, 0, 0, 1, tx, ty);
  }

  /** A rotation by `angle` radians, counter-clockwise. */
  static rotate(angle: number): Affine {
    const s = Math.sin(angle);
    const co = Math.cos(angle);
    return new Affine(co, s, -s, co, 0, 0);
  }

  /** A skew: `x' = x + kx * y`, `y' = y + ky * x`. */
  static skew(kx: number, ky: number): Affine {
    return new Affine(1, ky, kx, 1, 0, 0);
  }

  /** The vertical flip about the origin: `y' = -y`. */
  static flip_y(): Affine {
    return new Affine(1, 0, 0, -1, 0, 0);
  }

  /**
   * Composes: `self` applied *after* `other`.
   *
   * `transform.then(flip)` maps a point by `flip` first and `transform` second.
   * Written the other way round the composition silently becomes the transpose,
   * and every coordinate comes out wrong.
   */
  then(other: Affine): Affine {
    return new Affine(
      this.a * other.a + this.c * other.b,
      this.b * other.a + this.d * other.b,
      this.a * other.c + this.c * other.d,
      this.b * other.c + this.d * other.d,
      this.a * other.e + this.c * other.f + this.e,
      this.b * other.e + this.d * other.f + this.f,
    );
  }

  /** `other.then(self)`: `other` applied after `self`. */
  pre_concat(other: Affine): Affine {
    return other.then(this);
  }

  /** A translation composed *before* this one's rotation and scale. */
  pre_translate(tx: number, ty: number): Affine {
    return Affine.translate(tx, ty).then(this);
  }

  /** A scale composed *before* this one's rotation and scale. */
  pre_scale(sx: number, sy: number = sx): Affine {
    return Affine.scale_non_uniform(sx, sy).then(this);
  }

  /** A rotation composed *before* this one's rotation and scale. */
  pre_rotate(angle: number): Affine {
    return Affine.rotate(angle).then(this);
  }

  /** The determinant; zero means the transform is degenerate. */
  determinant(): number {
    return this.a * this.d - this.b * this.c;
  }

  /**
   * The inverse transform.
   *
   * Mirrors kurbo, which returns a matrix of infinities and NaNs rather than
   * an `Option`: a caller that cares checks `determinant()` first. A singular
   * transform maps the plane onto a line or a point, so `vello_common`'s
   * `invert_paint_transform` is the model for the check.
   */
  inverse(): Affine {
    const det = this.determinant();
    const invDet = 1 / det;
    return new Affine(
      this.d * invDet,
      -this.b * invDet,
      -this.c * invDet,
      this.a * invDet,
      (this.c * this.f - this.d * this.e) * invDet,
      (this.b * this.e - this.a * this.f) * invDet,
    );
  }

  /** The inverse, or `undefined` when the transform is degenerate. */
  try_inverse(): Affine | undefined {
    const det = this.determinant();
    if (!Number.isFinite(det) || det === 0) return undefined;
    return this.inverse();
  }

  /** The six coefficients, in kurbo's storage order. */
  as_coeffs(): [number, number, number, number, number, number] {
    return [this.a, this.b, this.c, this.d, this.e, this.f];
  }

  /** Applies the transform to a point. */
  transform_point(p: PointInit): Point {
    const [x, y] = to_xy(p);
    return new Point(this.a * x + this.c * y + this.e, this.b * x + this.d * y + this.f);
  }

  /** Applies the transform to a vector, ignoring the translation. */
  transform_vector(v: Vec2): Vec2 {
    return new Vec2(this.a * v.x + this.c * v.y, this.b * v.x + this.d * v.y);
  }

  /**
   * The bounding box of a rectangle's four corners under this transform.
   *
   * Conservative by construction: the union of the mapped corners contains the
   * image of the *rectangle* even when the transform rotates it, which is the
   * only useful answer for a bounding box. It is what `vello_common`'s
   * `into_fast_path_rect` uses to reject a rect fill early.
   */
  transform_rect_bbox(rect: Rect): Rect {
    const corners = [
      this.transform_point(new Point(rect.x0, rect.y0)),
      this.transform_point(new Point(rect.x1, rect.y0)),
      this.transform_point(new Point(rect.x1, rect.y1)),
      this.transform_point(new Point(rect.x0, rect.y1)),
    ];
    let box = Rect.from_points(corners[0]!, corners[1]!);
    for (const c of corners.slice(2)) box = box.union_pt(c);
    return box;
  }

  /** Whether the transform is the identity, exactly. */
  is_identity(): boolean {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }

  /** Whether the transform has no rotation or skew, so axis-aligned stays aligned. */
  is_axis_aligned(): boolean {
    return is_nearly_zero(this.b) && is_nearly_zero(this.c);
  }
}

/** Normalizes a coordinate pair to scalars. */
function to_xy(p: PointInit): [number, number] {
  return 'x' in p ? [p.x, p.y] : [p[0]!, p[1]!];
}
