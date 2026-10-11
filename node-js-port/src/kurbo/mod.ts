/**
 * The `kurbo` port: `kurbo/src/lib.rs`, partially.
 *
 * Only the subset `vello_cpu` actually uses is ported, which is the geometry
 * vocabulary: `Affine`, `Point`, `Rect` (+ `Insets`, `Size`), `Vec2`,
 * `RoundedRect` (+ `RoundedRectRadii`), `BezPath`/`PathEl`, the `Shape` trait,
 * the `flatten` pass, and `common`'s float helpers.
 *
 * Deliberately **not** ported, because nothing in `vello_cpu` reaches for them:
 * `Circle`, `Ellipse`, `Line`, `Triangle`, `QuadBez`/`CubicBez` as value types,
 * `QuadSpline`, `Arc`/`SvgArc`, `Stroke` and the stroking machinery, `fit`,
 * `simplify`, `offset`, `mindist`, `param_curve`, `moments` as a public API and
 * `translate_scale`. Adding any of them is a decision, not a gap: `Shape` and
 * `BezPath` are enough to build a path from anything else.
 */

export { Affine } from './affine.js';
export { BezPath, path_el_points, type PathEl, type PathSeg } from './bezpath.js';
export { expand, is_nearly_zero, is_nearly_zero_within_tolerance, SCALAR_NEARLY_ZERO, FloatFuncs } from './common.js';
export { flatten } from './flatten.js';
export { Point, type PointInit } from './point.js';
export { Rect, to_point, type Insets } from './rect.js';
export { RoundedRect } from './rounded_rect.js';
export { RoundedRectRadii, type Radius } from './rounded_rect_radii.js';
export {
  Shape,
  area,
  bounding_box,
  contains,
  DEFAULT_ACCURACY,
  path_elements,
  perimeter,
  to_path,
  winding,
} from './shape.js';
export { Size } from './size.js';
export { Vec2 } from './vec2.js';
