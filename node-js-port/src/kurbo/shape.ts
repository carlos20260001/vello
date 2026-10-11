/**
 * `kurbo/src/shape.rs`: the `Shape` trait.
 *
 * Upstream this is a trait with a generic associated type, `path_elements`, and
 * required methods `area`, `perimeter`, `winding` and `bounding_box`. TypeScript
 * has no traits, so the port makes the *contract* structural instead: a shape
 * is anything that can express itself as path elements, which is exactly what
 * `{ commands }` means everywhere else in this codebase. The methods of the
 * trait become free functions over that contract, so `BezPath`, `Rect`,
 * `RoundedRect` and the plain command lists the record stage stores all satisfy
 * the same interface with no adapter types in between.
 */

import { BezPath, path_el_points, type PathEl } from './bezpath.js';
import { Point } from './point.js';
import { Rect } from './rect.js';
import { flatten } from './flatten.js';

/** Anything expressible as Bézier path elements, as kurbo's `impl Shape`. */
export interface Shape {
  /** The path elements; kurbo's `path_elements(tolerance)` in structural form. */
  readonly commands: readonly PathEl[];
}

/** The default flattening tolerance, as kurbo's `DEFAULT_ACCURACY`. */
export const DEFAULT_ACCURACY = 0.1;

/** The shape's path elements. Curves are flattened to within `tolerance`. */
export function path_elements(shape: Shape, tolerance: number = DEFAULT_ACCURACY): readonly PathEl[] {
  return flatten(shape.commands, tolerance);
}

/** The shape, as an owned `BezPath`. */
export function to_path(shape: Shape, tolerance: number = DEFAULT_ACCURACY): BezPath {
  const p = new BezPath();
  p.extend(path_elements(shape, tolerance));
  return p;
}

/**
 * The signed area, as `Shape::area`.
 *
 * Positive when y increases as x increases, i.e. clockwise in a y-down space,
 * which is the convention `vello_cpu` assumes for windings. Exact for every
 * element: the integrand is a degree-5 polynomial, so the 16-point
 * Gauss–Legendre rule below evaluates it without error.
 */
export function area(shape: Shape): number {
  // 1/2 ∮ (x dy - y dx), summed over the segments of each closed subpath.
  let total = 0;
  for (const seg of to_segments(shape.commands)) {
    total += segment_area(seg) * 0.5;
  }
  return total;
}

/** Total perimeter length, with `accuracy` as the flattening tolerance. */
export function perimeter(shape: Shape, accuracy: number = DEFAULT_ACCURACY): number {
  let total = 0;
  let start: Point | undefined;
  let prev: Point | undefined;
  for (const el of flatten(shape.commands, accuracy)) {
    switch (el.kind) {
      case 'MoveTo':
        prev = new Point(el.x, el.y);
        start = prev;
        break;
      case 'LineTo': {
        const p = new Point(el.x, el.y);
        if (prev) total += prev.distance(p);
        prev = p;
        break;
      }
      case 'Close':
        // The closing edge runs back to the subpath's start, exactly as a
        // rasterizer would treat it, so the last side is not lost.
        if (prev && start) total += prev.distance(start);
        prev = start;
        break;
      default:
        break;
    }
  }
  return total;
}

/**
 * The winding number of `pt`, as `Shape::winding`.
 *
 * Flattens to `DEFAULT_ACCURACY` first, then counts signed crossings of a ray
 * to the right of the point. The non-zero winding rule (`contains`) is what
 * every fill in this port uses.
 */
export function winding(shape: Shape, pt: Point): number {
  const els = flatten(shape.commands, DEFAULT_ACCURACY);
  let winding = 0;
  let start: Point | undefined;
  let prev: Point | undefined;

  const crossEdge = (p0: Point, p1: Point): void => {
    // Strict on the starting side, inclusive on the ending side, so a vertex
    // shared by two edges is counted exactly once.
    if (p0.y <= pt.y) {
      if (p1.y > pt.y && isLeft(p0, p1, pt) > 0) winding += 1;
    } else if (p1.y <= pt.y && isLeft(p0, p1, pt) < 0) {
      winding -= 1;
    }
  };

  for (const el of els) {
    switch (el.kind) {
      case 'MoveTo':
        if (start && prev) crossEdge(prev, start);
        start = new Point(el.x, el.y);
        prev = start;
        break;
      case 'LineTo': {
        const p = new Point(el.x, el.y);
        if (prev) crossEdge(prev, p);
        prev = p;
        break;
      }
      case 'Close':
        if (start && prev) crossEdge(prev, start);
        prev = start;
        break;
      default:
        break;
    }
  }
  return winding;
}

/** Whether `pt` is inside the shape, under the non-zero winding rule. */
export function contains(shape: Shape, pt: Point): boolean {
  return winding(shape, pt) !== 0;
}

/**
 * The smallest rectangle enclosing the shape, as `Shape::bounding_box`.
 *
 * This is the hull of the path's *control* points, which is exact for lines and
 * a conservative superset for curves (a cubic never leaves the hull of its four
 * points). A conservative hull is what the coarse stage wants — a box that
 * certainly contains the rasterized result — and the glyph rasterizer's
 * `Path::bounds` is built the same way.
 */
export function bounding_box(shape: Shape): Rect {
  let box: Rect | undefined;
  for (const el of shape.commands) {
    for (const p of path_el_points(el)) {
      box = box ? box.union_pt(p) : Rect.from_points(p, p);
    }
  }
  return box ?? Rect.ZERO;
}

/** The shape, when it is a rectangle. */
export function as_rect(shape: Shape): Rect | undefined {
  return shape instanceof Rect ? shape : undefined;
}

/** The sign of `(p1 - p0) × (p2 - p0)`: which side of the segment `p2` is on. */
function isLeft(p0: Point, p1: Point, p2: Point): number {
  return (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
}

/**
 * Splits a command list into self-contained segments, closing each subpath.
 *
 * Deliberately structural rather than a method on `BezPath`: the record stage
 * stores plain command lists, and duplicating the walk for a class would only
 * exist to avoid an allocation.
 */
function to_segments(commands: readonly PathEl[]): { p0: Point; points: Point[] }[] {
  const out: { p0: Point; points: Point[] }[] = [];
  let start = new Point(0, 0);
  let prev = new Point(0, 0);
  let open = false;

  const push = (points: Point[]): void => {
    out.push({ p0: prev, points });
  };

  for (const el of commands) {
    switch (el.kind) {
      case 'MoveTo': {
        if (open) push([start]);
        start = new Point(el.x, el.y);
        prev = start;
        open = true;
        break;
      }
      case 'LineTo':
        push([new Point(el.x, el.y)]);
        prev = new Point(el.x, el.y);
        break;
      case 'QuadTo':
        push([new Point(el.cx, el.cy), new Point(el.x, el.y)]);
        prev = new Point(el.x, el.y);
        break;
      case 'CubicTo':
        push([
          new Point(el.c1x, el.c1y),
          new Point(el.c2x, el.c2y),
          new Point(el.x, el.y),
        ]);
        prev = new Point(el.x, el.y);
        break;
      case 'Close': {
        if (open) push([start]);
        prev = start;
        open = false;
        break;
      }
    }
  }
  if (open) push([start]);
  return out;
}

/**
 * The signed area contribution of one segment, 1/2 ∮ (x dy - y dx) over it.
 *
 * Evaluated with Gauss–Legendre quadrature, which is why this is exact: the
 * integrand has degree `2n - 1` for `n` control points, i.e. 3 for a line and
 * 5 for a cubic, and a 16-point rule is exact to degree 31.
 */
function segment_area(seg: { p0: Point; points: Point[] }): number {
  const pts = [seg.p0, ...seg.points];
  const n = pts.length - 1;
  let sum = 0;
  for (const [w, absX] of GAUSS_LEGENDRE_COEFFS_16_HALF) {
    for (const sign of [1, -1]) {
      const t = 0.5 + 0.5 * sign * absX;
      const [x, y] = eval_bezier(pts, n, t);
      const [dx, dy] = eval_bezier_deriv(pts, n, t);
      sum += w * (x * dy - y * dx);
    }
  }
  // The table is defined on [-1, 1] and each node is visited twice, once per
  // sign, so the rule is over all 16 nodes; the final 1/2 is the Jacobian of
  // the t = (x + 1)/2 substitution.
  return sum * 0.5;
}

/** Evaluates the Bézier through `pts` (degree `n`) at `t`, by de Casteljau. */
function eval_bezier(pts: Point[], n: number, t: number): [number, number] {
  let xs = pts.map((p) => p.x);
  let ys = pts.map((p) => p.y);
  for (let k = 1; k <= n; k++) {
    for (let i = 0; i + k <= n; i++) {
      xs[i] = xs[i]! * (1 - t) + xs[i + 1]! * t;
      ys[i] = ys[i]! * (1 - t) + ys[i + 1]! * t;
    }
  }
  return [xs[0]!, ys[0]!];
}

/** Evaluates the derivative of the Bézier through `pts` at `t`. */
function eval_bezier_deriv(pts: Point[], n: number, t: number): [number, number] {
  if (n === 0) return [0, 0];
  const d: Point[] = [];
  for (let i = 0; i + 1 <= n; i++) {
    d.push(new Point(n * (pts[i + 1]!.x - pts[i]!.x), n * (pts[i + 1]!.y - pts[i]!.y)));
  }
  return eval_bezier(d, n - 1, t);
}

/** Half of kurbo's 16-point Gauss–Legendre table: `[weight, |x|]` pairs. */
const GAUSS_LEGENDRE_COEFFS_16_HALF: readonly (readonly [number, number])[] = [
  [0.1894506104550685, 0.0950125098376374],
  [0.1826034150449236, 0.2816035507792583],
  [0.1691565193950025, 0.4580167776572279],
  [0.1495959888165767, 0.6178762444026434],
  [0.1246289712555332, 0.7554044083554029],
  [0.0951585116824927, 0.8656312023876648],
  [0.0622535239386477, 0.9445750230733258],
  [0.0271524594117541, 0.9894009349916499],
];
