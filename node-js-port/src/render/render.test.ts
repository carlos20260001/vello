import { describe, expect, it } from 'vitest';

import { RenderContext, newPixmap } from './context.js';
import { solidBrush } from '@egui-node/peniko-ts';
import { Mix, Compose, BlendMode } from '@egui-node/peniko-ts';
import { Affine } from '../kurbo/mod.js';
// Registers the scene renderer with context.ts.
import './mod.js';

/** Reads a pixel as premultiplied RGBA in 0..255. */
function px(p: ReturnType<typeof newPixmap>, x: number, y: number): [number, number, number, number] {
  const i = (y * p.width + x) * 4;
  return [p.data[i]!, p.data[i + 1]!, p.data[i + 2]!, p.data[i + 3]!];
}

const RED = 0xff0000ff;

describe('RenderContext: recording', () => {
  it('starts with an empty scene and an identity transform', () => {
    const ctx = new RenderContext(64, 64);
    expect(ctx.size).toEqual({ width: 64, height: 64 });
    const t = ctx.get_transform();
    expect(t.a).toBe(1);
    expect(t.d).toBe(1);
    expect(t.e).toBe(0);
    expect(t.f).toBe(0);
  });

  it('resizes', () => {
    const ctx = new RenderContext(8, 8);
    ctx.resize(100, 50);
    expect(ctx.size).toEqual({ width: 100, height: 50 });
  });

  it('composes transforms, and setTransform replaces rather than appends', () => {
    const ctx = new RenderContext(64, 64);
    ctx.set_transform(Affine.translate(10, 0));
    ctx.set_transform(Affine.scale(2));
    // setTransform replaces, so the translation is gone.
    const t = ctx.get_transform();
    expect(t.e).toBe(0);
    expect(t.a).toBe(2);

    ctx.reset();
    ctx.transform_prepend(Affine.translate(10, 0));
    ctx.transform_prepend(Affine.scale(2));
    // prepend composes, so both survive.
    const t2 = ctx.get_transform();
    expect(t2.e).toBe(10);
    expect(t2.a).toBe(2);
  });
});

describe('RenderContext: layers', () => {
  it('balances pushLayer/popLayer', () => {
    const ctx = new RenderContext(32, 32);
    ctx.push_layer({ blend: new BlendMode(Mix.Multiply, Compose.SrcOver) });
    ctx.push_opacity_layer(0.5);
    ctx.pop_layer();
    ctx.pop_layer();
    // One extra pop must be a no-op rather than underflowing.
    expect(() => ctx.pop_layer()).not.toThrow();
  });

  it('multiplies opacity through nested opacity layers', () => {
    const ctx = new RenderContext(32, 32);
    ctx.push_opacity_layer(0.5);
    ctx.push_opacity_layer(0.5);
    ctx.fill_rect({ x0: 0, y0: 0, x1: 8, y1: 8 }, solidBrush(RED));
    ctx.pop_layer();
    ctx.pop_layer();

    const p = newPixmap(32, 32);
    ctx.flush(p);
    const [, , , a] = px(p, 4, 4);
    // 0.5 * 0.5 of a fully opaque source.
    expect(a).toBe(64);
  });

  it('intersects nested clips rather than replacing them', () => {
    const ctx = new RenderContext(32, 32);
    // Clip to a 20x20 box, then to an 8x8 box inside it.
    ctx.push_clip_layer({
      commands: [
        { kind: 'MoveTo', x: 0, y: 0 },
        { kind: 'LineTo', x: 20, y: 0 },
        { kind: 'LineTo', x: 20, y: 20 },
        { kind: 'LineTo', x: 0, y: 20 },
        { kind: 'Close' },
      ],
    });
    ctx.push_clip_layer({
      commands: [
        { kind: 'MoveTo', x: 4, y: 4 },
        { kind: 'LineTo', x: 8, y: 4 },
        { kind: 'LineTo', x: 8, y: 8 },
        { kind: 'LineTo', x: 4, y: 8 },
        { kind: 'Close' },
      ],
    });
    // Filling a wide rect must only paint inside the intersection (4..8).
    ctx.fill_rect({ x0: 0, y0: 0, x1: 20, y1: 20 }, solidBrush(RED));
    ctx.pop_layer();
    ctx.pop_layer();

    const p = newPixmap(32, 32);
    ctx.flush(p);
    expect(px(p, 6, 6)[3]).toBeGreaterThan(200);
    // Outside the inner clip but inside the outer: still clipped away.
    expect(px(p, 15, 15)[3]).toBe(0);
    expect(px(p, 0, 0)[3]).toBe(0);
  });

  it('resolves a clip through the transform in force when it was pushed', () => {
    const ctx = new RenderContext(32, 32);
    // The clip is 0..4 at 4x, so 0..16 on screen, whatever transform is in
    // force afterwards; the fill is 0..8 at identity, so 0..8 on screen. A clip
    // resolved through the *fill's* transform would only cover 0..4 and half
    // the rectangle would go missing.
    ctx.set_transform(Affine.scale(4));
    ctx.push_clip_layer({
      commands: [
        { kind: 'MoveTo', x: 0, y: 0 },
        { kind: 'LineTo', x: 4, y: 0 },
        { kind: 'LineTo', x: 4, y: 4 },
        { kind: 'LineTo', x: 0, y: 4 },
        { kind: 'Close' },
      ],
    });
    ctx.set_transform(Affine.IDENTITY);
    ctx.fill_rect({ x0: 0, y0: 0, x1: 8, y1: 8 }, solidBrush(RED));
    ctx.pop_layer();
    const p = newPixmap(32, 32);
    ctx.flush(p);
    expect(px(p, 7, 7)[3]).toBe(255);
    expect(px(p, 9, 9)[3]).toBe(0);
  });
});

describe('RenderContext: fills', () => {
  it('fills an axis-aligned rectangle', () => {
    const ctx = new RenderContext(32, 32);
    ctx.fill_rect({ x0: 4, y0: 4, x1: 12, y1: 12 }, solidBrush(RED));
    const p = newPixmap(32, 32);
    ctx.flush(p);
    // Interior is fully opaque red; outside is untouched.
    const [r, g, b, a] = px(p, 8, 8);
    expect([r, g, b, a]).toEqual([255, 0, 0, 255]);
    expect(px(p, 0, 0)[3]).toBe(0);
  });

  it('fills a rounded rectangle', () => {
    const ctx = new RenderContext(32, 32);
    ctx.fill_rounded_rect({ x0: 4, y0: 4, x1: 28, y1: 28, radiusX: 6, radiusY: 6 }, solidBrush(RED));
    const p = newPixmap(32, 32);
    ctx.flush(p);
    expect(px(p, 16, 16)[3]).toBe(255);
    // The corner is outside the rounded boundary.
    expect(px(p, 5, 5)[3]).toBe(0);
  });

  it('clamps a rounded rect radius to half its smallest side', () => {
    const ctx = new RenderContext(32, 32);
    // radius far larger than the rect: must not produce a broken outline.
    ctx.fill_rounded_rect({ x0: 10, y0: 10, x1: 20, y1: 20, radiusX: 999, radiusY: 999 }, solidBrush(RED));
    const p = newPixmap(32, 32);
    ctx.flush(p);
    expect(px(p, 15, 15)[3]).toBe(255);
  });

  it('applies a transform to a fill', () => {
    const ctx = new RenderContext(64, 64);
    ctx.set_transform(Affine.scale(2));
    ctx.fill_rect({ x0: 4, y0: 4, x1: 8, y1: 8 }, solidBrush(RED));
    const p = newPixmap(64, 64);
    ctx.flush(p);
    // 4..8 in local space at 2x is 8..16 on screen.
    expect(px(p, 12, 12)[3]).toBe(255);
    expect(px(p, 4, 4)[3]).toBe(0);
    expect(px(p, 18, 18)[3]).toBe(0);
  });

  it('drops geometry outside the viewport', () => {
    const ctx = new RenderContext(32, 32);
    ctx.fill_rect({ x0: -100, y0: -100, x1: -50, y1: -50 }, solidBrush(RED));
    const p = newPixmap(32, 32);
    ctx.flush(p);
    for (let i = 3; i < p.data.length; i += 4) expect(p.data[i]).toBe(0);
  });

  it('lands a one-pixel rect on the pixel it names', () => {
    // The sharpest check of both coordinate conventions at once: a 1x1 rect at
    // the origin must paint pixel (0, 0) and nothing else. A y-flip off by one
    // would paint (0, 1); a bitmap-origin mismatch would paint (1, 0).
    const ctx = new RenderContext(8, 8);
    ctx.fill_rect({ x0: 0, y0: 0, x1: 1, y1: 1 }, solidBrush(RED));
    const p = newPixmap(8, 8);
    ctx.flush(p);
    expect(px(p, 0, 0)).toEqual([255, 0, 0, 255]);
    for (let i = 4; i < p.data.length; i += 4) expect(p.data[i]).toBe(0);
  });

  it('keeps a rect away from the origin in the columns it names', () => {
    // Same two conventions, away from the origin: the coverage bitmap has to be
    // positioned by its bounds, not assumed to start at device 0.
    const ctx = new RenderContext(32, 32);
    ctx.fill_rect({ x0: 20, y0: 20, x1: 28, y1: 28 }, solidBrush(RED));
    const p = newPixmap(32, 32);
    ctx.flush(p);
    expect(px(p, 24, 24)[3]).toBe(255);
    expect(px(p, 19, 19)[3]).toBe(0);
    expect(px(p, 28, 28)[3]).toBe(0);
  });

  it('composites a shape that straddles a bin boundary exactly once', () => {
    // Bins are 256 rows. A shape spanning the boundary is rendered by both bins
    // it overlaps, so each bin must touch only its own rows: compositing twice
    // at half opacity would give 0.75 instead of 0.5.
    const ctx = new RenderContext(260, 260);
    ctx.push_opacity_layer(0.5);
    ctx.fill_rect({ x0: 0, y0: 250, x1: 8, y1: 262 }, solidBrush(RED));
    ctx.pop_layer();
    const p = newPixmap(260, 260);
    ctx.flush(p);
    expect(px(p, 4, 255)[3]).toBe(128);
    expect(px(p, 4, 256)[3]).toBe(128);
    // Row 261 of the rectangle falls outside the target and is clipped.
    expect(px(p, 4, 259)[3]).toBe(128);
  });

  it('clears the target to transparent by default', () => {
    const ctx = new RenderContext(8, 8);
    const p = newPixmap(8, 8);
    p.data.fill(255);
    ctx.fill_rect({ x0: 0, y0: 0, x1: 8, y1: 8 }, solidBrush(RED));
    ctx.flush(p);
    expect(px(p, 4, 4)).toEqual([255, 0, 0, 255]);
  });

  it('keeps the target when targetInit is keep', () => {
    const ctx = new RenderContext(8, 8);
    const p = newPixmap(8, 8);
    p.data.fill(0);
    // Pre-fill with blue.
    for (let i = 0; i < p.data.length; i += 4) {
      p.data[i] = 0; p.data[i + 1] = 0; p.data[i + 2] = 255; p.data[i + 3] = 255;
    }
    ctx.fill_rect({ x0: 0, y0: 0, x1: 4, y1: 8 }, solidBrush(RED));
    ctx.flush(p, { offset: { x: 0, y: 0 }, format: 'rgba8' as never, targetInit: 'keep' });
    // Left half covered red, right half keeps blue.
    expect(px(p, 2, 4)[3]).toBe(255);
    expect(px(p, 6, 4)[2]).toBe(255);
  });
});

describe('RenderContext: reset and flush without render imported', () => {
  it('resets clears commands, layers and transform', () => {
    const ctx = new RenderContext(16, 16);
    ctx.set_transform(Affine.scale(3));
    ctx.push_opacity_layer(0.2);
    ctx.fill_rect({ x0: 0, y0: 0, x1: 4, y1: 4 }, solidBrush(RED));
    ctx.reset();
    expect(ctx.get_transform().a).toBe(1);
    const p = newPixmap(16, 16);
    ctx.flush(p);
    // Nothing recorded after the reset, so the target stays empty.
    expect(p.data[3]).toBe(0);
  });
});
