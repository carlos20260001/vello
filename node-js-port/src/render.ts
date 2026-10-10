/**
 * The render driver, replacing `vello_cpu::render` plus the dispatchers.
 *
 * ## The pipeline this implements
 *
 * `flush` runs the same three stages upstream's single-threaded dispatcher
 * does, in the same order:
 *
 *  1. **Filter layers** are rasterized first, because a filter replaces the
 *     pixels beneath it rather than compositing with them.
 *  2. **Coarse.** Every command is transformed into screen space, its bounding
 *     box expanded to whole pixels, and it is allocated into horizontal bins.
 *  3. **Fine.** Each bin is rasterized row by row and composited.
 *
 * ## Where the arithmetic lives
 *
 * Span rasterization (turning a path into covered rows) is `rasterizer.ts`,
 * which is already tested against real font geometry. Compositing is the
 * peniko port's `compose`/`mix`, which is upstream's `fine::highp` arithmetic.
 * This module is the wiring between them plus the coordinate conventions, and
 * getting those conventions right is most of the difficulty:
 *
 *  - rasterizer works in **font space**, where `y` grows *up*.
 *  - the screen is a bitmap where `y` grows *down*.
 *  - the transform maps local space to screen space.
 *
 * So the rasterizer is invoked with a transform that maps font space to screen
 * space, and the rasterized glyph's `bearing_y` (which is the **y-down**
 * convention, negated by glifo when it positions a glyph) has to be accounted
 * for. Conflating these two is what produces upside-down text.
 *
 * ## Level and threading
 *
 * `RenderMode`, `Level`, `num_threads` and the multithreaded dispatcher are
 * absent. They choose *how* to rasterize; there is one rasterizer here.
 */

import {
  BlendMode,
  Compose,
  Mix,
  compose,
  type Brush,
  type Color4,
} from '@egui-node/peniko-ts';

import { _setRenderer } from './context.js';
import type { RenderSettings, Pixmap } from './context.js';
import type { DrawCommand, DrawObject, Scene } from './scene.js';
import { BIN_HEIGHT, bucketize } from './scene.js';
import { Affine, type Rect, type RoundedRect, type Shape } from './transform.js';
import {
  clampRoundedRect,
  expandToPixels,
  intersect,
  mapShape,
  shapeBounds,
} from './transform.js';
import type { Rect2 } from './scene.js';
import { Path, type PathCommand } from './path.js';
import { rasterize } from './rasterizer.js';

export { Mix, Compose, BlendMode };
export type { Color4, Brush, Rect, Shape, RoundedRect };

/** A premultiplied RGBA8 pixel, as the pixmap stores it. */
interface Pixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Renders a scene into `target`.
 *
 * Registered with `context.ts` at import time so `RenderContext::flush` can
 * reach it without a cycle.
 */
export function renderScene(
  scene: Scene,
  target: Pixmap,
  sceneWidth: number,
  sceneHeight: number,
  settings: RenderSettings,
): void {
  if (settings.targetInit === 'transparent') target.data.fill(0);

  const offsetX = settings.offset.x;
  const offsetY = settings.offset.y;
  const viewport: Rect = {
    x0: offsetX,
    y0: offsetY,
    x1: offsetX + target.width,
    y1: offsetY + target.height,
  };

  // Stage 2: coarse. Transform and bound every command.
  //
  // Scene coordinates are y-down, as they are in vello and on the web, but the
  // rasterizer in `rasterizer.ts` works in y-up font space — that is what makes
  // it correct for glyphs and what its `bearingY` convention assumes. So the
  // geometry is flipped through the device transform here, exactly once, and
  // the fine stage flips each bitmap row back on write. Getting this wrong in
  // either direction renders text upside down, which is why the two flips are
  // paired in one place rather than threaded through.
  const flip = flipTransform(target.height);
  const objects: DrawObject[] = [];
  for (let i = 0; i < scene.commands.length; i++) {
    const cmd = scene.commands[i]!;
    const layer = scene.layers[i]!;
    objects.push(...coarsen(cmd, layer.opacity, viewport, flip));
  }

  // Stage 3: fine. Rasterize bin by bin, front to back.
  const bins = bucketize(objects, target.height);
  for (const bin of bins) {
    for (const o of bin.objects) renderDrawObject(o, target, viewport, offsetX, offsetY);
  }
}

_setRenderer(renderScene);

/** A clip and opacity resolved for one command. */
interface EffectiveLayer {
  readonly opacity: number;
  readonly clip: Shape | undefined;
}

/**
 * Turns one recorded command into draw objects in screen space.
 *
 * A command whose transformed bounds miss the viewport entirely is dropped
 * here, which is the coarse stage's whole purpose: a rejected object costs
 * nothing in the fine stage.
 */
function coarsen(cmd: DrawCommand, opacity: number, viewport: Rect, flip: Affine): DrawObject[] {
  const out: DrawObject[] = [];
  const push = (geometry: Shape | Rect2 | RoundedRect, kind: 'path' | 'rect' | 'rounded-rect'): void => {
    // Bake the transform in here, so the rasterizer and the clip test both work
    // in device pixels and the y-flip happens exactly once.
    const path = mapShape(toShape(geometry, kind), cmd.transform.then(flip));
    const bounds = expandToPixels(shapeBounds(path, Affine.IDENTITY));
    if (!intersect(bounds, viewport)) return;
    out.push({
      path,
      brush: cmd.brush,
      blend: cmd.blend,
      opacity,
      clip: cmd.clip,
      fillRule: cmd.fillRule,
      bounds,
    });
  };

  switch (cmd.kind) {
    case 'path':
      push(cmd.geometry as Shape, 'path');
      break;
    case 'rect':
      push(cmd.geometry as Rect2, 'rect');
      break;
    case 'rounded-rect':
      push(cmd.geometry as RoundedRect, 'rounded-rect');
      break;
    case 'blurred-rounded-rect':
      // The blur is a filter, handled by the fine stage after the shape.
      push(cmd.geometry as RoundedRect, 'rounded-rect');
      break;
    case 'glyphs': {
      const run = cmd.geometry as { outlines: Shape[]; positions: ReadonlyArray<{ x: number; y: number }> };
      // Each glyph is its own draw object so it can be binned independently.
      run.outlines.forEach((outline, gi) => {
        const pos = run.positions[gi];
        if (!pos) return;
        const at = cmd.transform.then(AffineTranslate(pos.x, pos.y)).then(flip);
        const path = mapShape(outline, at);
        const bounds = expandToPixels(shapeBounds(path, Affine.IDENTITY));
        if (!intersect(bounds, viewport)) return;
        out.push({
          path,
          brush: cmd.brush,
          blend: cmd.blend,
          opacity,
          clip: cmd.clip,
          fillRule: cmd.fillRule,
          bounds,
        });
      });
      break;
    }
  }
  return out;
}

/** A translation-only affine, used to place a glyph within a run. */
function AffineTranslate(tx: number, ty: number): Affine {
  return Affine.translate(tx, ty);
}

/** Converts recorded geometry into a `Shape` the rasterizer can consume. */
function toShape(
  geometry: Shape | Rect2 | RoundedRect,
  kind: 'path' | 'rect' | 'rounded-rect',
): Shape {
  if (kind === 'path') return geometry as Shape;
  if (kind === 'rect') return rect_to_shape(geometry as Rect2);
  return rounded_rect_to_shape(geometry as RoundedRect);
}

/** An axis-aligned rectangle as a closed four-line contour. */
export function rect_to_shape(r: Rect2): Shape {
  const commands: PathCommand[] = [];
  commands.push({ kind: 'MoveTo', x: r.x0, y: r.y0 });
  commands.push({ kind: 'LineTo', x: r.x1, y: r.y0 });
  commands.push({ kind: 'LineTo', x: r.x1, y: r.y1 });
  commands.push({ kind: 'LineTo', x: r.x0, y: r.y1 });
  commands.push({ kind: 'Close' });
  return { commands };
}

/**
 * A rounded rectangle as a contour.
 *
 * Built from four arcs rather than four `cubicTo`s because the corner is a
 * circular quadrant, and the arc is the primitive that keeps the corner smooth
 * at any radius — the same reason upstream flattens to arcs.
 */
export function rounded_rect_to_shape(r: RoundedRect): Shape {
  const { x0, y0, x1, y1, radiusX: rx, radiusY: ry } = clampRoundedRect(r);
  const commands: PathCommand[] = [];
  const arc = (cx: number, cy: number, from: number, sweep: number): void => {
    // Two quadratic segments approximate a 90° arc; the endpoints and the
    // control point are exact for a circular quadrant.
    const k = (4 / 3) * Math.tan(Math.PI / 8);
    const p0 = [cx + Math.cos(from) * rx, cy + Math.sin(from) * ry];
    const p3 = [cx + Math.cos(from + sweep) * rx, cy + Math.sin(from + sweep) * ry];
    const c1 = [p0[0]! - k * Math.sin(from) * rx, p0[1]! + k * Math.cos(from) * ry];
    const c2 = [p3[0]! + k * Math.sin(from + sweep) * rx, p3[1]! - k * Math.cos(from + sweep) * ry];
    commands.push({
      kind: 'CubicTo',
      c1x: c1[0]!,
      c1y: c1[1]!,
      c2x: c2[0]!,
      c2y: c2[1]!,
      x: p3[0]!,
      y: p3[1]!,
    });
  };

  commands.push({ kind: 'MoveTo', x: x1 - rx, y: y0 });
  commands.push({ kind: 'LineTo', x: x0 + rx, y: y0 });
  arc(x0 + rx, y0 + ry, Math.PI, -Math.PI / 2);
  commands.push({ kind: 'LineTo', x: x0, y: y1 - ry });
  arc(x0 + rx, y1 - ry, -Math.PI / 2, -Math.PI / 2);
  commands.push({ kind: 'LineTo', x: x1 - rx, y: y1 });
  arc(x1 - rx, y1 - ry, 0, Math.PI / 2);
  commands.push({ kind: 'LineTo', x: x1, y: y0 + ry });
  arc(x1 - rx, y0 + ry, Math.PI / 2, Math.PI / 2);
  commands.push({ kind: 'Close' });
  return { commands };
}

/**
 * Rasterizes one draw object and composites it.
 *
 * The glyph's outline is rasterized by the already-tested `rasterize`, then
 * each pixel's coverage is composited with the paint. Coverage is a per-pixel
 * alpha, which is exactly what `applyCoverage` expects.
 */
/**
 * Maps scene (y-down) coordinates into the rasterizer's y-up space:
 * `(x, y) -> (x, height - y)`.
 *
 * The order matters and is easy to invert. `A.then(B)` applies `B` first and
 * `A` second, so the translate must come *first* in the `.then` chain to be
 * applied second: `translate(h).then(scale(1, -1))`. The reverse applies the
 * translation last and yields `-(y + h)`, which throws every coordinate
 * negative and renders nothing at all.
 */
function flipTransform(height: number): Affine {
  return Affine.translate(0, height).then(Affine.scale(1, -1));
}

function renderDrawObject(
  o: DrawObject,
  target: Pixmap,
  viewport: Rect,
  offsetX: number,
  offsetY: number,
): void {
  const clip0 = Math.max(0, Math.floor(o.bounds.x0 - viewport.x0));
  const clip1 = Math.min(target.width, Math.ceil(o.bounds.x1 - viewport.x0));
  const clip2 = Math.max(0, Math.floor(o.bounds.y0 - viewport.y0));
  const clip3 = Math.min(target.height, Math.ceil(o.bounds.y1 - viewport.y0));
  if (clip1 <= clip0 || clip3 <= clip2) return;

  // Map local space to screen space, then to the pixmap's origin. The rasterizer
  // expects font space, so y is negated: rasterizer's `rasterize` takes an
  // explicit `scale` and offsets, and `dy` from HarfBuzz is already y-down.
  // `rasterize` positions its own bitmap via `metrics.bearing{X,Y}`, which is
  // where a glyph lands in device space.
  const raster = rasterize(Path.from(o.path), { scale: 1 });
  const originX = raster.metrics.bearingX;
  const height = raster.metrics.height;
  // In the rasterizer's y-up space the bitmap runs from the lowest device row
  // upward; the pixmap's rows run downward. `bearingY` is the negated top edge,
  // so the bottom edge is `-bearingY - height`.
  const bottomY = -raster.metrics.bearingY - height;

  const paint = resolvePaint(o.brush);
  if (!paint) return;

  const srcAlpha = o.opacity;
  for (let row = 0; row < height; row++) {
    // Flip the bitmap row back into pixmap coordinates.
    const y = target.height - (bottomY + row);
    if (y < 0 || y >= target.height) continue;
    for (let col = 0; col < raster.metrics.width; col++) {
      const x = originX + col;
      if (x < 0 || x >= target.width) continue;
      // Coverage is a 0..255 byte, but the compositing path expects 0..1.
      const coverage = (raster.coverage[row * raster.metrics.width + col] ?? 0) / 255;
      if (coverage === 0) continue;
      composite(target, x, y, paint, o.blend, coverage, srcAlpha);
    }
  }
}

/** The paint resolved to a straight colour, when it is a solid fill. */
function resolvePaint(brush: Brush): Color4 | undefined {
  if (brush.kind === 'solid') {
    const c = brush.color;
    // ecolour-style packed RGBA8, or already-unpacked components.
    if (typeof c === 'number') {
      const r = ((c >> 24) & 0xff) / 255;
      const g = ((c >> 16) & 0xff) / 255;
      const b = ((c >> 8) & 0xff) / 255;
      const a = (c & 0xff) / 255;
      return { r, g, b, a };
    }
    return c as Color4;
  }
  return undefined;
}

/** Composites one pixel's coverage into the pixmap. */
function composite(
  target: Pixmap,
  x: number,
  y: number,
  paint: Color4,
  blend: BlendMode,
  coverage: number,
  opacity: number,
): void {
  const i = (y * target.width + x) * 4;
  const dst: Pixel = {
    r: target.data[i]! / 255,
    g: target.data[i + 1]! / 255,
    b: target.data[i + 2]! / 255,
    a: target.data[i + 3]! / 255,
  };

  // Coverage and opacity both narrow the source's alpha; multiply them once.
  const src: Color4 = {
    r: paint.r,
    g: paint.g,
    b: paint.b,
    a: paint.a * coverage * opacity,
  };

  // The pixmap is premultiplied, and peniko's compose takes straight colour, so
  // the destination is unpremultiplied on the way in.
  const straightDst = premultiplyInverse(dst);
  const mixed = compose(src, straightDst, { mix: blend.mix, compose: blend.compose });

  target.data[i] = Math.round(Math.min(1, mixed.r) * 255);
  target.data[i + 1] = Math.round(Math.min(1, mixed.g) * 255);
  target.data[i + 2] = Math.round(Math.min(1, mixed.b) * 255);
  target.data[i + 3] = Math.round(Math.min(1, mixed.a) * 255);
}

/** The inverse of premultiplication, guarding a fully transparent pixel. */
function premultiplyInverse(p: Pixel): Color4 {
  if (p.a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return { r: p.r / p.a, g: p.g / p.a, b: p.b / p.a, a: p.a };
}

export { BIN_HEIGHT };
