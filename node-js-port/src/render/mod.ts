/**
 * `vello_cpu::render`: the pipeline driver, plus the two stages it runs.
 *
 * ## The pipeline this implements
 *
 * `flush` runs the same three stages upstream's single-threaded dispatcher
 * does, in the same order:
 *
 * 1. **Record** (`record/`): `RenderContext` accumulates draw commands, each
 *    stamped with the layer state in force.
 * 2. **Coarse** (here): every command is transformed into device space, its
 *    bounding box expanded to whole pixels, its clips resolved, and it is
 *    binned into horizontal strips. A command that misses the viewport is
 *    dropped here and costs nothing downstream.
 * 3. **Fine** (here): each bin's rows are rasterized and composited, front to
 *    back, honouring blend mode, opacity and clip.
 *
 * ## Coordinate conventions
 *
 * This is where the three of them meet, and it is the most delicate part of
 * the port:
 *
 *  - the scene is **y-down**, as vello's scenes and the web's canvases are;
 *  - the glyph rasterizer (`rasterizer.ts`) works in **y-up font space**, which
 *    is what makes it correct for glyphs and what its `bearing_y` convention
 *    assumes;
 *  - the target is a bitmap whose rows run **downwards**.
 *
 * So every path is mapped through one transform, `device`, which takes scene
 * coordinates into the rasterizer's space: `(x, y) -> (x, height - y)`, with
 * the scene's origin placed at the render offset. The fine stage then flips
 * each rasterized row back on write. The two flips are paired here rather than
 * threaded through the stages, because getting either of them wrong renders
 * text upside down and nothing else in the pipeline can detect it.
 *
 * A second, subtler property of `rasterizer.ts` is accounted for here too: its
 * coverage columns are indexed by the device x they cover, not by their offset
 * within the bitmap. Every rasterization therefore goes through
 * `rasterize_device`, which shifts the path so that its floored minimum lands
 * on the origin, so that the bitmap's column 0 is the leftmost device column
 * the path covers and the two can be reconciled by the bounding box.
 *
 * ## Level and threading
 *
 * `RenderMode`, `Level`, `num_threads` and the multithreaded dispatcher are
 * absent, as is upstream's SIMD `Level` dispatch: they choose *how* to
 * rasterize, and there is one rasterizer here, so there is nothing to select.
 * The arithmetic is identical scalar.
 */

import {
  compose,
  unpremultiply,
  type BlendMode,
  type Brush,
  type Color4,
} from '@egui-node/peniko-ts';

import { _setRenderer } from './context.js';
import type { Pixmap, RenderSettings } from './context.js';
import type {
  Clip,
  DrawCommand,
  GlyphRun,
  LayerState,
  PathGeometry,
  RecordedClip,
  Scene,
} from '../record/mod.js';
import type { DrawObject } from '../coarse/cmd.js';
import { bucketize } from '../coarse/bucketer.js';
import { Affine, Point, Rect, RoundedRect, bounding_box, type PathEl, type Shape } from '../kurbo/mod.js';
import { Path } from '../path.js';
import { rasterize } from '../rasterizer.js';

export type { Color4, Brush, Rect, Shape };

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

  const device = deviceTransform(target.height, settings.offset);
  // The scene's extent, mapped into device space. Anything outside it is
  // dropped in the coarse stage; the target itself clips the rest.
  const viewport = device.transform_rect_bbox(Rect.new(0, 0, sceneWidth, sceneHeight));

  // Stage 2: coarse. Transform and bound every command.
  const clips = new Map<RecordedClip, Clip>();
  const objects: DrawObject[] = [];
  for (let i = 0; i < scene.commands.length; i++) {
    const cmd = scene.commands[i]!;
    const layer = scene.layers[i]!;
    objects.push(...coarsen(cmd, layer, viewport, device, clips));
  }

  // Stage 3: fine. Bin by bin, and within a bin front to back.
  const masks = new Map<Shape, CoverageMask>();
  for (const bin of bucketize(objects, target.height)) {
    for (const o of bin.objects) renderDrawObject(o, target, masks, bin.y0, bin.y1);
  }
}

_setRenderer(renderScene);

/**
 * Maps scene coordinates into the rasterizer's space: `(x, y) -> (x, h - y)`,
 * with the scene's origin placed at the render offset.
 *
 * The order matters and is easy to invert. `A.then(B)` applies `B` first and
 * `A` second, so the flip must come first in the chain to be applied first:
 * `translate(origin).then(flip)`. Written the other way round the translation
 * is negated as well, and nothing lands where it should.
 */
function deviceTransform(height: number, offset: { x: number; y: number }): Affine {
  return Affine.translate(offset.x, height - offset.y).then(Affine.flip_y());
}

/**
 * Turns one recorded command into draw objects in device space.
 *
 * A command whose transformed bounds miss the viewport entirely is dropped
 * here, which is the coarse stage's whole purpose.
 */
function coarsen(
  cmd: DrawCommand,
  layer: LayerState,
  viewport: Rect,
  device: Affine,
  clips: Map<RecordedClip, Clip>,
): DrawObject[] {
  const out: DrawObject[] = [];

  /** Resolves recorded geometry into something with path elements. */
  const toShape = (geometry: PathGeometry): Shape => {
    // `Rect` and `RoundedRect` from the kurbo port are already shapes; only
    // their bare-coordinate forms need building. Note that a rounded rect's
    // radii are clamped while being built, which is what keeps a corner from
    // crossing the rectangle's own edges.
    if ('commands' in geometry) return geometry;
    if ('radiusX' in geometry) {
      return RoundedRect.new(geometry.x0, geometry.y0, geometry.x1, geometry.y1, geometry.radiusX, geometry.radiusY);
    }
    return Rect.new(geometry.x0, geometry.y0, geometry.x1, geometry.y1);
  };

  /** Emits one draw object for `geometry`, placed by a local-to-scene transform. */
  const push = (geometry: PathGeometry, local: Affine): void => {
    const path = mapShape(toShape(geometry), device.then(local));
    const bounds = bounding_box(path).expand();
    if (bounds.intersect(viewport).is_zero_area()) return;
    out.push({
      path,
      brush: cmd.brush,
      blend: cmd.blend,
      opacity: layer.opacity,
      clips: layer.clips.map((c) => resolveClip(c, device, clips)),
      fillRule: cmd.fillRule,
      bounds,
    });
  };

  switch (cmd.kind) {
    case 'path':
    case 'rect':
    case 'rounded-rect':
    case 'blurred-rounded-rect':
      // A blurred rounded rect is drawn as the rounded rect itself: the
      // Gaussian blur (`vello_common::filter_effects`) is not ported, so the
      // extent is exact and the softness is missing. The `kind` discriminator
      // rules out a glyph run, but the command type is not a discriminated
      // union, so the geometry is narrowed by hand.
      push(cmd.geometry as PathGeometry, cmd.transform);
      break;
    case 'glyphs': {
      const run = cmd.geometry as GlyphRun;
      // Each glyph is its own draw object so it can be binned independently.
      run.outlines.forEach((outline, gi) => {
        const pos = run.positions[gi];
        if (!pos) return;
        push(outline, cmd.transform.then(Affine.translate(pos.x, pos.y)));
      });
      break;
    }
  }
  return out;
}

/**
 * Resolves a recorded clip into device space, once per clip.
 *
 * The transform is the one in force when the clip was *pushed*, not the
 * command's: a clip belongs to the coordinate system it was drawn in. Cached by
 * the recorded clip's identity, because every command under a layer shares the
 * same object.
 */
function resolveClip(c: RecordedClip, device: Affine, cache: Map<RecordedClip, Clip>): Clip {
  let r = cache.get(c);
  if (!r) {
    r = { shape: mapShape(c.shape, device.then(c.transform)), fillRule: c.fillRule };
    cache.set(c, r);
  }
  return r;
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
  const commands: PathEl[] = shape.commands.map((cmd): PathEl => {
    switch (cmd.kind) {
      case 'MoveTo':
      case 'LineTo': {
        const p = t.transform_point(new Point(cmd.x, cmd.y));
        return { kind: cmd.kind, x: p.x, y: p.y };
      }
      case 'QuadTo': {
        const c = t.transform_point(new Point(cmd.cx, cmd.cy));
        const p = t.transform_point(new Point(cmd.x, cmd.y));
        return { kind: 'QuadTo', cx: c.x, cy: c.y, x: p.x, y: p.y };
      }
      case 'CubicTo': {
        const c1 = t.transform_point(new Point(cmd.c1x, cmd.c1y));
        const c2 = t.transform_point(new Point(cmd.c2x, cmd.c2y));
        const p = t.transform_point(new Point(cmd.x, cmd.y));
        return {
          kind: 'CubicTo',
          c1x: c1.x,
          c1y: c1.y,
          c2x: c2.x,
          c2y: c2.y,
          x: p.x,
          y: p.y,
        };
      }
      case 'Close':
        return { kind: 'Close' };
    }
  });
  return { commands };
}

/**
 * A rasterized coverage mask, placed in device space.
 *
 * Row `r` covers device `y` in `[y0 + r, y0 + r + 1)` and column `c` covers
 * device `x` in `[x0 + c, x0 + c + 1)`: the same unit squares the rasterizer
 * distributes its sub-scanlines over.
 */
interface CoverageMask {
  readonly x0: number;
  readonly y0: number;
  readonly width: number;
  readonly height: number;
  readonly coverage: Uint8Array;
}

/**
 * Rasterizes a device-space path into a coverage mask.
 *
 * The path is first shifted so that its floored minimum lands on the origin.
 * That is not cosmetic: the rasterizer's coverage columns are indexed by the
 * device x they cover, so a path starting at x = 40 would otherwise have its
 * coverage written past the end of a bitmap only as wide as the path, and
 * every pixel would read as uncovered. Shifting by the floored bounds keeps the
 * shift a whole number of pixels, so the antialiased edges are unchanged.
 *
 * The winding rule is always non-zero: `rasterize` does not implement even-odd,
 * so a clip pushed with that rule is filled as non-zero. The two agree for any
 * simple clip shape, which is what clips are in practice.
 */
function rasterize_device(path: Shape): CoverageMask {
  const bounds = bounding_box(path).expand();
  const x0 = bounds.x0;
  const y0 = bounds.y0;
  const glyph = rasterize(Path.from(mapShape(path, Affine.translate(-x0, -y0))), { scale: 1 });
  return { x0, y0, width: glyph.metrics.width, height: glyph.metrics.height, coverage: glyph.coverage };
}

/** The mask for a clip, rasterized once and shared by everything it clips. */
function clipMask(shape: Shape, cache: Map<Shape, CoverageMask>): CoverageMask | undefined {
  let m = cache.get(shape);
  if (!m) {
    m = rasterize_device(shape);
    cache.set(shape, m);
  }
  return m.width === 0 || m.height === 0 ? undefined : m;
}

/** Samples a mask at a screen pixel, as coverage in 0..1. */
function maskCoverage(m: CoverageMask | undefined, x: number, y: number, height: number): number {
  if (!m) return 0;
  // Device space is y-up and the target's rows run downwards.
  const col = x - m.x0;
  const row = height - 1 - y - m.y0;
  if (col < 0 || col >= m.width || row < 0 || row >= m.height) return 0;
  return (m.coverage[row * m.width + col] ?? 0) / 255;
}

/**
 * Rasterizes one draw object and composites it, over the rows `y0..y1` only.
 *
 * The outline is rasterized by the already-tested `rasterize`, then each
 * pixel's coverage is multiplied by every clip in force — that product is the
 * antialiased area the paint is allowed to touch — and composited with the
 * paint.
 */
function renderDrawObject(
  o: DrawObject,
  target: Pixmap,
  cache: Map<Shape, CoverageMask>,
  y0: number,
  y1: number,
): void {
  const paint = resolvePaint(o.brush);
  if (!paint) return;

  const mask = rasterize_device(o.path);
  const clips = o.clips.map((c) => clipMask(c.shape, cache));

  // The mask covers device rows y0..y0+height-1, which are the screen rows
  // `height-1-rowMask`; restrict to the bin's rows so an object that straddles
  // two bins is composited once per bin, over that bin's rows only.
  const firstRow = Math.max(0, target.height - mask.y0 - y1);
  const lastRow = Math.min(mask.height - 1, target.height - 1 - mask.y0 - y0);
  if (lastRow < firstRow) return;

  for (let row = firstRow; row <= lastRow; row++) {
    const y = target.height - 1 - (mask.y0 + row);
    if (y < 0 || y >= target.height) continue;
    const base = row * mask.width;
    for (let col = 0; col < mask.width; col++) {
      const x = mask.x0 + col;
      if (x < 0 || x >= target.width) continue;
      // Coverage is a 0..255 byte; compositing wants 0..1.
      const coverage = ((mask.coverage[base + col] ?? 0) / 255) * clipProduct(clips, x, y, target.height);
      if (coverage === 0) continue;
      composite(target, x, y, paint, o.blend, coverage, o.opacity);
    }
  }
}

/** The product of every clip's coverage: the intersection of them all. */
function clipProduct(clips: readonly (CoverageMask | undefined)[], x: number, y: number, height: number): number {
  let acc = 1;
  for (const m of clips) {
    acc *= maskCoverage(m, x, y, height);
    if (acc === 0) return 0;
  }
  return acc;
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
  // The pixmap is premultiplied, and peniko's compose takes straight colour,
  // so the destination is unpremultiplied on the way in.
  const bg = unpremultiply({
    r: target.data[i]! / 255,
    g: target.data[i + 1]! / 255,
    b: target.data[i + 2]! / 255,
    a: target.data[i + 3]! / 255,
  });

  // Coverage and opacity both narrow the source's alpha; multiply them once.
  const src: Color4 = {
    r: paint.r,
    g: paint.g,
    b: paint.b,
    a: paint.a * coverage * opacity,
  };

  const mixed = compose(src, bg, { mix: blend.mix, compose: blend.compose });

  target.data[i] = Math.round(Math.min(1, mixed.r) * 255);
  target.data[i + 1] = Math.round(Math.min(1, mixed.g) * 255);
  target.data[i + 2] = Math.round(Math.min(1, mixed.b) * 255);
  target.data[i + 3] = Math.round(Math.min(1, mixed.a) * 255);
}
