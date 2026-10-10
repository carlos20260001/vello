import { describe, expect, it } from 'vitest';

import { RenderContext, newPixmap } from './context.js';
import { solidBrush } from '@egui-node/peniko-ts';
import { Mix, Compose, BlendMode } from '@egui-node/peniko-ts';
import { Affine } from './transform.js';
// Registers the scene renderer with context.ts.
import './render.js';

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
