import { describe, expect, it } from 'vitest';

import { Path } from './path.js';
import { RasterizedGlyph, SUBSAMPLES, flattenPath, rasterize } from './rasterizer.js';

/** A unit square from (0,0) to (1,1), y up. */
function unitSquare(): Path {
  return new Path()
    .moveTo(0, 0)
    .lineTo(1, 0)
    .lineTo(1, 1)
    .lineTo(0, 1)
    .close();
}

function totalCoverage(g: RasterizedGlyph): number {
  let t = 0;
  for (const v of g.coverage) t += v;
  return t / 255;
}

describe('Path', () => {
  it('reports bounds including control points', () => {
    const p = new Path().moveTo(1, 2).quadTo(5, 5, 3, 3);
    expect(p.bounds()).toEqual({ xMin: 1, yMin: 2, xMax: 5, yMax: 5 });
  });

  it('is empty with no commands', () => {
    expect(new Path().is_empty).toBe(true);
    expect(new Path().bounds()).toBeUndefined();
  });
});

describe('rasterize: axis-aligned square', () => {
  it('fills a solid square at integer scale', () => {
    // 10x10 square at scale 10 -> 100x100 px, fully covered.
    const g = rasterize(unitSquare(), { scale: 10 });
    expect(g.metrics.width).toBe(10);
    expect(g.metrics.height).toBe(10);
    expect(g.metrics.bearingX).toBe(0);
    // Every pixel fully covered.
    for (let i = 0; i < g.coverage.length; i++) {
      expect(g.coverage[i]).toBe(255);
    }
  });

  it('produces coverage equal to the area', () => {
    const g = rasterize(unitSquare(), { scale: 16 });
    // 16x16 px, fully covered => 256 px of coverage.
    expect(totalCoverage(g)).toBeCloseTo(256, 1);
  });

  it('anti-aliases a half-pixel offset edge', () => {
    // Shifting by half a pixel should make one edge column ~50% covered.
    const g = rasterize(unitSquare(), { scale: 16, subpixelOffsetX: 0.5 });
    const leftCol = g.at(0, 8);
    expect(leftCol).toBeGreaterThan(80);
    expect(leftCol).toBeLessThan(180);
    // The interior is still solid.
    expect(g.at(8, 8)).toBe(255);
  });

  it('reports bearings relative to the glyph origin', () => {
    // Square from (10,20) to (20,30) at scale 1.
    const p = new Path().moveTo(10, 20).lineTo(20, 20).lineTo(20, 30).lineTo(10, 30).close();
    const g = rasterize(p, { scale: 1 });
    expect(g.metrics.bearingX).toBe(10);
    // `bearing_y` uses the y-down bitmap convention: it is the negated
    // distance from the baseline up to the bitmap's top edge, so a shape
    // entirely above the baseline is negative. glifo negates it again when
    // positioning (`-f64::from(bitmap_glyph.bearing_y * ...)`).
    expect(g.metrics.bearingY).toBe(-30);
    expect(g.metrics.width).toBe(10);
    expect(g.metrics.height).toBe(10);
  });

  it('reports a negative bearing for a descender', () => {
    // A shape below the baseline, e.g. the tail of a 'g'.
    const p = new Path().moveTo(0, -200).lineTo(100, -200).lineTo(100, 0).lineTo(0, 0).close();
    const g = rasterize(p, { scale: 1 });
    // Top edge is on the baseline, so the bearing is zero.
    expect(g.metrics.bearingY).toBe(0);
  });
});

describe('rasterize: degenerate input', () => {
  it('handles an empty path', () => {
    const g = rasterize(new Path(), { scale: 10 });
    expect(g.metrics.width).toBe(0);
    expect(g.coverage.length).toBe(0);
  });

  it('handles a zero scale', () => {
    const g = rasterize(unitSquare(), { scale: 0 });
    expect(g.metrics.width).toBe(0);
  });

  it('handles a sub-pixel shape', () => {
    const p = new Path().moveTo(0, 0).lineTo(0.1, 0).lineTo(0.1, 0.1).lineTo(0, 0.1).close();
    const g = rasterize(p, { scale: 1 });
    expect(g.metrics.width).toBeLessThanOrEqual(1);
  });

  it('clips geometry that starts off-canvas', () => {
    const p = new Path().moveTo(-50, -50).lineTo(50, -50).lineTo(50, 50).lineTo(-50, 50).close();
    const g = rasterize(p, { scale: 1 });
    // Bounded by the path, and every covered pixel is inside the bitmap.
    expect(g.metrics.width).toBe(100);
    expect(g.coverage.length).toBe(g.metrics.width * g.metrics.height);
  });
});

describe('rasterize: curves', () => {
  it('flattens a quadratic into line segments', () => {
    const p = new Path().moveTo(0, 0).quadTo(50, 100, 100, 0);
    const edges = flattenPath(p, 1, 0, 0);
    expect(edges.length).toBeGreaterThan(4);
  });

  it('fills a curved shape', () => {
    // A dome: flat bottom, quadratic arch on top.
    const p = new Path().moveTo(0, 0).lineTo(100, 0).quadTo(50, 100, 0, 0).close();
    const g = rasterize(p, { scale: 1 });
    expect(g.metrics.width).toBeGreaterThan(90);
    // Coverage is positive and bounded by the bounding box area.
    const cov = totalCoverage(g);
    expect(cov).toBeGreaterThan(1000);
    expect(cov).toBeLessThanOrEqual(g.metrics.width * g.metrics.height);
  });
});

describe('rasterize: winding', () => {
  it('fills a self-overlapping path under non-zero winding', () => {
    // Two overlapping squares wound the same way: the overlap stays filled.
    const p = new Path()
      .moveTo(0, 0).lineTo(10, 0).lineTo(10, 10).lineTo(0, 10).close()
      .moveTo(5, 5).lineTo(15, 5).lineTo(15, 15).lineTo(5, 15).close();
    const g = rasterize(p, { scale: 1 });
    // The overlap region (5..10, 5..10) must be covered, not punched out.
    expect(g.at(7, 7)).toBe(255);
    // A region covered by only one square is also covered.
    expect(g.at(2, 2)).toBe(255);
  });
});

describe('rasterize: sampling quality', () => {
  it('uses a reasonable number of sub-scanlines', () => {
    expect(SUBSAMPLES).toBeGreaterThanOrEqual(8);
    expect(SUBSAMPLES % 1).toBe(0);
  });

  it('produces a 1px-wide antialiased bar with mid coverage at the edges', () => {
    // A 1px-tall bar, 10px wide, positioned so edges land mid-pixel.
    const p = new Path().moveTo(0.25, 0).lineTo(10.25, 0).lineTo(10.25, 1).lineTo(0.25, 1).close();
    const g = rasterize(p, { scale: 1 });
    // Left edge pixel should be partially covered.
    const left = g.at(0, 0);
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(255);
    // Middle is solid.
    expect(g.at(5, 0)).toBe(255);
  });
});
/**
 * End-to-end check on real glyph geometry.
 *
 * Ahem's 'A' is a solid square spanning x 0..1000, y -200..800 in a 1000-unit
 * em, so at a 16px em the rasterized bitmap is exactly 16x16 and fully
 * covered. That makes the expected coverage checkable without reimplementing
 * font parsing here (which lives in the skrifa port).
 */
describe('rasterize: a real glyph at text sizes', () => {
  const UPEM = 1000;

  function ahemA(): Path {
    return new Path()
      .moveTo(0, -200)
      .lineTo(1000, -200)
      .lineTo(1000, 800)
      .lineTo(0, 800)
      .close();
  }

  it('covers the whole glyph area at a 16px em', () => {
    const g = rasterize(ahemA(), { scale: 16 / UPEM });
    // The bitmap rounds outward on all four sides, so it is one pixel larger
    // than the 16px span whenever the edges land mid-pixel: Ahem's box is
    // y -200..800, i.e. -3.2..12.8px, which spans pixel rows -4..13.
    expect(g.metrics.width).toBe(16);
    expect(g.metrics.height).toBe(17);
    expect(g.metrics.bearingX).toBe(0);
    // bearing_y is the y-down convention: negated distance to the top edge.
    expect(g.metrics.bearingY).toBe(-13);

    // Total coverage equals the true area of a 1000x1000 box at 16px.
    expect(totalCoverage(g)).toBeCloseTo(256, 0);

    // Interior pixels are solid; only the edge rows are partial.
    expect(g.at(8, 8)).toBe(255);
    expect(g.at(0, 0)).toBeLessThan(255);
  });

  it('covers the right area across the usual UI text sizes', () => {
    for (const px of [8, 9, 10, 11, 12, 13, 14, 16, 20, 32]) {
      const s = px / UPEM;
      const g = rasterize(ahemA(), { scale: s });
      // Dimensions follow from rounding outward on every side.
      const w = Math.ceil(1000 * s) - Math.floor(0);
      const h = Math.ceil(800 * s) - Math.floor(-200 * s);
      expect(g.metrics.width, `width at ${px}px`).toBe(w);
      expect(g.metrics.height, `height at ${px}px`).toBe(h);
      // Coverage is the glyph area, independent of bitmap size.
      expect(totalCoverage(g), `coverage at ${px}px`).toBeCloseTo(px * px, 0);
      // A pixel well inside the square is always fully covered.
      expect(g.at(Math.floor(w / 2), Math.floor(h / 2)), `solid interior at ${px}px`).toBe(255);
    }
  });

  it('antialiases smoothly when scrolled by a sub-pixel amount', () => {
    const base = rasterize(ahemA(), { scale: 16 / UPEM });
    const shifted = rasterize(ahemA(), { scale: 16 / UPEM, subpixelOffsetX: 0.5 });
    // Shifting half a pixel keeps the same area but spreads edge coverage.
    expect(totalCoverage(shifted)).toBeCloseTo(totalCoverage(base), 0);
    const hasPartial = shifted.coverage.some((c) => c > 0 && c < 255);
    expect(hasPartial).toBe(true);
  });
});
