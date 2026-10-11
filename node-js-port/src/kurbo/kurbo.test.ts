import { describe, expect, it } from 'vitest';

import {
  Affine,
  Point,
  Rect,
  Size,
  Vec2,
  BezPath,
  RoundedRect,
  RoundedRectRadii,
  area,
  bounding_box,
  contains,
  perimeter,
  path_elements,
  to_path,
  winding,
  FloatFuncs,
  is_nearly_zero,
  is_nearly_zero_within_tolerance,
  expand,
  type Insets,
} from './mod.js';

describe('FloatFuncs', () => {
  it('rounds halves away from zero, not towards +infinity', () => {
    expect(FloatFuncs.round(-2.5)).toBe(-3);
    expect(FloatFuncs.round(-0.5)).toBe(-1);
    expect(FloatFuncs.round(2.5)).toBe(3);
    // `Math.round` gives -2 for the first case; this is the deviation the port
    // makes on purpose, to match Rust's `f64::round`.
    expect(Math.round(-2.5)).toBe(-2);
  });

  it('expands away from zero', () => {
    expect(expand(3.7)).toBe(4);
    expect(expand(3)).toBe(3);
    expect(expand(-3.7)).toBe(-4);
  });

  it('has a tolerance that rejects 1/1000 but accepts 1/4096', () => {
    expect(is_nearly_zero(0)).toBe(true);
    expect(is_nearly_zero(1 / (1 << 12))).toBe(true);
    expect(is_nearly_zero(1 / 1000)).toBe(false);
    expect(is_nearly_zero_within_tolerance(0.5, 1)).toBe(true);
  });

  it('rejects a negative tolerance instead of accepting everything', () => {
    expect(() => is_nearly_zero_within_tolerance(3, -1)).toThrow();
  });

  it('describes insets structurally', () => {
    const i: Insets = { x0: 1, y0: 2, x1: 3, y1: 4 };
    expect(i.x0).toBe(1);
  });
});

describe('Point and Vec2', () => {
  it('round-trips through Vec2', () => {
    const p = new Point(3, 4);
    expect(p.to_vec2().hypot()).toBe(5);
    expect(p.to_vec2().to_point().distance(new Point(3, 4))).toBe(0);
    expect(Vec2.new(1, 0).cross(Vec2.new(0, 1))).toBe(1);
    expect(new Point(0, 0).distance(new Point(3, 4))).toBe(5);
  });
});

describe('Rect', () => {
  it('is not normalized by `new`, but is by `from_points`', () => {
    const flipped = Rect.new(4, 0, 0, 4);
    expect(flipped.width()).toBe(-4);
    expect(flipped.height()).toBe(4);
    const fixed = Rect.from_points([4, 0], [0, 4]);
    expect(fixed.width()).toBe(4);
    expect(fixed.abs()).toEqual(flipped.abs());
  });

  it('expands outwards to whole pixels', () => {
    // The case that silently drops the partially covered edge rows if the
    // rounding goes the other way.
    const r = Rect.new(-3.2, -3.6, 5.6, 4.1).expand();
    expect(r.x0).toBe(-4);
    expect(r.y0).toBe(-4);
    expect(r.x1).toBe(6);
    expect(r.y1).toBe(5);
  });

  it('insets by growing, which is upstream semantics', () => {
    const r = Rect.new(0, 0, 10, 10).inset(2);
    expect(r.width()).toBe(14);
    expect(r.x0).toBe(-2);
    expect(r.x1).toBe(12);
  });

  it('intersects without flipping an empty result', () => {
    // Vertical overlap is empty, so the intersection has zero height rather
    // than a negative one.
    const a = Rect.new(25, 101, 200, 130);
    const b = Rect.new(0, 0, 100, 100);
    const i = a.intersect(b);
    expect(i.x0).toBe(25);
    expect(i.x1).toBe(100);
    expect(i.y0).toBeGreaterThanOrEqual(0);
    expect(i.is_zero_area()).toBe(true);
  });

  it('unions with a point', () => {
    const r = Rect.new(0, 0, 10, 10).union_pt(new Point(-5, 20));
    expect(r.abs()).toEqual(Rect.new(-5, 0, 10, 20));
  });

  it('is a Shape, with a positive area in a y-down space', () => {
    const r = Rect.new(0, 0, 10, 10);
    expect(area(r)).toBeCloseTo(100, 9);
    expect(winding(r, new Point(5, 5))).toBe(1);
    expect(contains(r, new Point(5, 5))).toBe(true);
    expect(contains(r, new Point(10, 5))).toBe(false);
    expect(perimeter(r)).toBe(40);
    expect(bounding_box(r)).toEqual(r);
    expect(path_elements(r).length).toBe(5);
  });
});

describe('Size', () => {
  it('converts to a rect at the origin', () => {
    expect(Size.new(4, 6).to_rect()).toEqual(Rect.new(0, 0, 4, 6));
    expect(Size.new(4, 6).aspect_ratio_width()).toBeCloseTo(4 / 6);
  });
});

describe('BezPath and Shape', () => {
  /** The unit square, y-down. */
  function square(): BezPath {
    return new BezPath()
      .move_to(new Point(0, 0))
      .line_to(new Point(1, 0))
      .line_to(new Point(1, 1))
      .line_to(new Point(0, 1))
      .close_path();
  }

  it('measures area and winding', () => {
    expect(area(square())).toBeCloseTo(1, 9);
    expect(winding(square(), new Point(0.5, 0.5))).toBe(1);
    expect(winding(square(), new Point(2, 2))).toBe(0);
  });

  it('flattens a quadratic to lines', () => {
    const p = new BezPath()
      .move_to(new Point(0, 0))
      .quad_to(new Point(50, 100), new Point(100, 0))
      .close_path();
    const els = path_elements(p, 0.1);
    expect(els.length).toBeGreaterThan(10);
    expect(els.every((e) => e.kind === 'LineTo' || e.kind === 'MoveTo' || e.kind === 'Close')).toBe(true);
    // The region between the quadratic and its chord is 2/3 of the control
    // polygon's, i.e. 2/3 * (100 * 100 / 2). It is *negative*: read in a y-down
    // space the chord runs along the top and the contour is counter-clockwise.
    expect(area(p)).toBeCloseTo(-(2 / 3) * (100 * 50), 6);
    // The hull is over the *control* points, so it reaches the apex of the
    // control polygon (y = 100) rather than the curve's own apex (y = 50).
    expect(bounding_box(p)).toEqual(Rect.new(0, 0, 100, 100));
  });

  it('carries a closed subpath through `to_path`', () => {
    expect(to_path(square(), 0.1).commands.length).toBe(5);
  });

  it('closes an implicitly open subpath', () => {
    const p = new BezPath()
      .move_to(new Point(0, 0))
      .line_to(new Point(2, 0))
      .move_to(new Point(10, 10));
    const segs = p.path_segments();
    // The first subpath is closed by a line back to its own start.
    expect(segs.length).toBe(3);
  });
});

describe('RoundedRect', () => {
  it('clamps the radii to half the smallest side', () => {
    const rr = RoundedRect.new(10, 10, 20, 20, 999, 999);
    expect(rr.radius).toBe(5);
    // The clamped contour stays inside the rect it came from.
    for (const el of rr.commands) {
      if (el.kind === 'LineTo' || el.kind === 'MoveTo') {
        expect(el.x).toBeGreaterThanOrEqual(10);
        expect(el.x).toBeLessThanOrEqual(20);
        expect(el.y).toBeGreaterThanOrEqual(10);
        expect(el.y).toBeLessThanOrEqual(20);
      }
    }
  });

  it('has a positive area smaller than the rect it came from', () => {
    const rr = RoundedRect.new(0, 0, 10, 10, 3);
    expect(area(rr)).toBeGreaterThan(0);
    expect(area(rr)).toBeLessThan(100);
    // 4 - π, times 9, is the area the four cut corners remove. The corner is a
    // cubic, not the true arc, so it deviates from this by ~1e-3.
    expect(area(rr)).toBeCloseTo(100 - 9 * (4 - Math.PI), 1);
    // The same direction `Rect` winds in, so the two agree in sign.
    expect(Math.sign(area(rr))).toBe(Math.sign(area(Rect.new(0, 0, 10, 10))));
    expect(winding(rr, new Point(5, 5))).toBe(1);
    // (1, 1) is still inside: the corner arc is centred at (3, 3) with
    // radius 3, and (1, 1) is only sqrt(8) away from it.
    expect(winding(rr, new Point(1, 1))).toBe(1);
    // The far corner is cut away.
    expect(winding(rr, new Point(0.5, 0.5))).toBe(0);
  });

  it('is exactly a Rect when the radii are zero', () => {
    const rr = RoundedRect.new(0, 0, 10, 10, 0);
    const rect = Rect.new(0, 0, 10, 10);
    expect(area(rr)).toBeCloseTo(area(rect), 6);
    expect(bounding_box(rr)).toEqual(rect);
    expect(rr.commands.filter((e) => e.kind === 'CubicTo').length).toBe(0);
  });

  it('supports elliptical corners, which kurbo does not', () => {
    const rr = RoundedRect.new(0, 0, 10, 10, 4, 2);
    expect(rr.commands.filter((e) => e.kind === 'CubicTo').length).toBe(4);
  });

  it('builds from explicit radii, clamped to fit', () => {
    const rr = RoundedRect.from_rect(Rect.new(0, 0, 10, 10), RoundedRectRadii.uniform(99));
    expect(rr.radius).toBe(5);
  });
});

describe('Affine', () => {
  it('applies `then` in the order it reads least', () => {
    // `then` applies the *argument* first, so the translation gets scaled.
    const t = Affine.translate(10, 0).then(Affine.scale(2));
    expect(t.transform_point(new Point(1, 0))).toEqual(new Point(12, 0));
  });

  it('round-trips through the inverse', () => {
    const a = Affine.translate(5, 7).then(Affine.rotate(0.3));
    const back = a.try_inverse()!;
    const p = back.transform_point(a.transform_point(new Point(3, 4)));
    expect(p.x).toBeCloseTo(3, 12);
    expect(p.y).toBeCloseTo(4, 12);
  });

  it('has no inverse when it is degenerate', () => {
    expect(Affine.scale(0).try_inverse()).toBeUndefined();
  });

  it('maps a rect through its bounding box', () => {
    const r = Rect.new(2, 2, 4, 6);
    expect(Affine.scale(2).transform_rect_bbox(r)).toEqual(Rect.new(4, 4, 8, 12));
    // A rotation is conservative: the rotated corners span a bigger box.
    expect(Affine.rotate(Math.PI / 4).transform_rect_bbox(r).width()).toBeGreaterThan(r.width());
  });

  it('reports coefficients in kurbo storage order', () => {
    expect(Affine.new(1, 2, 3, 4, 5, 6).as_coeffs()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('knows when it keeps axis alignment', () => {
    expect(Affine.scale(2).is_axis_aligned()).toBe(true);
    expect(Affine.translate(3, 4).is_axis_aligned()).toBe(true);
    expect(Affine.rotate(0.3).is_axis_aligned()).toBe(false);
  });
});

describe('RoundedRect as a shape', () => {
  it('is adoptable where a shape is wanted', () => {
    // The coarse stage builds a `RoundedRect` for `fill_rounded_rect` and uses
    // it as a shape, so it has to carry path elements of its own.
    const rr = RoundedRect.new(0, 0, 10, 10, 3);
    expect(rr.commands.length).toBeGreaterThan(4);
    expect(rr.commands.every((e) => e.kind !== 'QuadTo')).toBe(true);
  });

  it('has a hull that only ever over-estimates', () => {
    const rr = RoundedRect.new(0, 0, 10, 10, 3);
    const b = bounding_box(rr);
    // The hull is over the *control* points, which for an arc sit a hair
    // beyond the corner they approximate.
    expect(b.x0).toBeLessThanOrEqual(0);
    expect(b.x1).toBeGreaterThanOrEqual(10);
    expect(b.width()).toBeCloseTo(10, 9);
    expect(b.height()).toBeCloseTo(10, 9);
  });
});
