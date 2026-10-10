/**
 * Affine transforms, replacing `kurbo::Affine`.
 *
 * vello applies a transform to every draw object at record time and maps its
 * path through it in the coarse stage, so this is on the critical path for
 * everything rendered. The matrix layout is kurbo's, as a row-major
 * `[a, b, c, d, e, f]` pair of `Vec2` columns:
 *
 * ```text
 *   x' = a * x + c * y + e
 *   y' = b * x + d * y + f
 * ```
 *
 * That ordering matters when porting call sites, because the *argument* order
 * of `kurbo::Affine::new(a, b, c, d, e, f)` is not the storage order of most
 * other graphics libraries.
 */

import type { PathCommand } from './path.js';

/**
 * A shape: anything carrying a command list.
 *
 * Deliberately structural rather than nominal, so `Path` from `path.ts` and the
 * path types the other forks emit are all usable without conversion.
 */
export interface Shape {
  readonly commands: readonly PathCommand[];
}

/**
 * A rounded rectangle, matching `kurbo::RoundedRect`.
 *
 * The corner radii are clamped to half the smallest side, as kurbo does, rather
 * than being stored verbatim — a radius larger than the rect would otherwise
 * produce a non-convex outline and silently broken fills.
 */
export interface RoundedRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly radiusX: number;
  readonly radiusY: number;
}

/** Clamps a rounded rect's radii so they always fit inside it. */
export function clampRoundedRect(r: RoundedRect): RoundedRect {
  const maxX = Math.max(0, (r.x1 - r.x0) / 2);
  const maxY = Math.max(0, (r.y1 - r.y0) / 2);
  return {
    ...r,
    radiusX: Math.min(Math.max(0, r.radiusX), maxX),
    radiusY: Math.min(Math.max(0, r.radiusY), maxY),
  };
}

/** A 2D affine transform. */
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
  static readonly IDENTITY = new Affine();

  /** A translation. */
  static translate(tx: number, ty: number): Affine {
    return new Affine(1, 0, 0, 1, tx, ty);
  }

  /** A scale about the origin. */
  static scale(sx: number, sy: number = sx): Affine {
    return new Affine(sx, 0, 0, sy, 0, 0);
  }

  /** A rotation by `angle` radians, counter-clockwise. */
  static rotate(angle: number): Affine {
    const s = Math.sin(angle);
    const co = Math.cos(angle);
    return new Affine(co, s, -s, co, 0, 0);
  }

  /**
   * Applies the transform to a point.
   *
   * Inlined rather than allocating, because the coarse stage maps every
   * control point of every path.
   */
  mapPoint(x: number, y: number): [number, number] {
    return [this.a * x + this.c * y + this.e, this.b * x + this.d * y + this.f];
  }

  /**
   * Composes two transforms: `self` applied after `other`.
   *
   * kurbo's `then` is the same ordering (a.then(b) maps by `a` last), which is
   * where an off-by-one-in-semantics is easy to introduce: this is *not*
   * matrix multiplication in the argument order written.
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

  /** Applies `other` first, then `self`; inverse of `then`. */
  preConcat(other: Affine): Affine {
    return other.then(this);
  }

  /** Scales the transform in place, about the origin. */
  preScale(sx: number, sy: number): Affine {
    return Affine.scale(sx, sy).then(this);
  }

  /** Translates the transform in place, about the origin. */
  preTranslate(tx: number, ty: number): Affine {
    return Affine.translate(tx, ty).then(this);
  }

  /** The transform's determinant; zero means it is degenerate. */
  determinant(): number {
    return this.a * this.d - this.b * this.c;
  }

  /** The inverse transform, or undefined when degenerate. */
  invert(): Affine | undefined {
    const det = this.determinant();
    if (det === 0) return undefined;
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
}

/** An axis-aligned rectangle. */
export interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** The smallest rectangle containing a shape's control points, post-transform. */
export function shapeBounds(shape: Shape, transform: Affine): Rect {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  const acc = (x: number, y: number): void => {
    const [tx, ty] = transform.mapPoint(x, y);
    if (tx < x0) x0 = tx;
    if (ty < y0) y0 = ty;
    if (tx > x1) x1 = tx;
    if (ty > y1) y1 = ty;
  };
  for (const cmd of shape.commands) {
    switch (cmd.kind) {
      case 'MoveTo':
      case 'LineTo':
        acc(cmd.x, cmd.y);
        break;
      case 'QuadTo':
        acc(cmd.cx, cmd.cy);
        acc(cmd.x, cmd.y);
        break;
      case 'CubicTo':
        acc(cmd.c1x, cmd.c1y);
        acc(cmd.c2x, cmd.c2y);
        acc(cmd.x, cmd.y);
        break;
      case 'Close':
        break;
    }
  }
  return { x0, y0, x1, y1 };
}

/** Rounds a rectangle outwards to integer pixel bounds. */
export function expandToPixels(r: Rect): Rect {
  return {
    x0: Math.floor(r.x0),
    y0: Math.floor(r.y0),
    x1: Math.ceil(r.x1),
    y1: Math.ceil(r.y1),
  };
}

/** The intersection of two rectangles, or undefined when empty. */
export function intersect(a: Rect, b: Rect): Rect | undefined {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  return x1 <= x0 || y1 <= y0 ? undefined : { x0, y0, x1, y1 };
}


/**
 * Maps a shape through an affine transform.
 *
 * The coarse stage does this once per command, so every downstream stage works
 * in device pixels and the rasterizer's own scale stays 1. Baking the transform
 * in — rather than threading it through the rasterizer — means there is exactly
 * one place the y-flip happens.
 */
export function mapShape(shape: Shape, t: Affine): Shape {
  const commands: PathCommand[] = [];
  for (const cmd of shape.commands) {
    switch (cmd.kind) {
      case 'MoveTo':
      case 'LineTo': {
        const [x, y] = t.mapPoint(cmd.x, cmd.y);
        commands.push({ kind: cmd.kind, x, y });
        break;
      }
      case 'QuadTo': {
        const [cx, cy] = t.mapPoint(cmd.cx, cmd.cy);
        const [x, y] = t.mapPoint(cmd.x, cmd.y);
        commands.push({ kind: 'QuadTo', cx, cy, x, y });
        break;
      }
      case 'CubicTo': {
        const [c1x, c1y] = t.mapPoint(cmd.c1x, cmd.c1y);
        const [c2x, c2y] = t.mapPoint(cmd.c2x, cmd.c2y);
        const [x, y] = t.mapPoint(cmd.x, cmd.y);
        commands.push({ kind: 'CubicTo', c1x, c1y, c2x, c2y, x, y });
        break;
      }
      case 'Close':
        commands.push({ kind: 'Close' });
        break;
    }
  }
  return { commands };
}
