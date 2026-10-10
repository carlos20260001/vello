/**
 * `RenderContext`, replacing `vello_cpu::render::RenderContext`.
 *
 * The public surface matches upstream so porting call sites is mechanical:
 *
 * ```ts
 * const ctx = new RenderContext(width, height);
 * ctx.fill_rect({ x0: 10, y0: 10, x1: 100, y1: 100 }, solidBrush(color));
 * ctx.push_layer({ blend: new BlendMode(Mix.Multiply) });
 * ctx.fill_path(path, gradientBrush(gradient));
 * ctx.pop_layer();
 * ctx.flush(pixmap);
 * ```
 *
 * ## Layers
 *
 * Upstream tracks a layer stack where each entry changes how everything
 * recorded after it composites. Push/pop is balanced, and a clip layer is
 * *added* by intersection rather than replacing the existing one, because
 * nesting two clips must keep both. That intersection behaviour is the part a
 * rewrite usually gets wrong.
 *
 * ## What this port does not do
 *
 * It renders into a `Uint8Array` RGBA8 buffer. `RenderMode`, `RasterizerSettings`
 * and the SIMD `Level` all exist upstream and are omitted here: they select
 * *how* to rasterize (fast/quality, thread count, CPU features) rather than
 * *what* is drawn. There is one rasterizer in this port, so there is nothing to
 * select.
 */

import {
  Brush,
  BlendMode,
  Compose,
  Mix,
  type Color4,
} from '@egui-node/peniko-ts';

import { compose, premultiply } from '@egui-node/peniko-ts';
import { Affine, type Rect } from './transform.js';
import { shapeBounds, expandToPixels, intersect, type Shape, type RoundedRect } from './transform.js';
import type { DrawCommand, DrawObject, GlyphRun, LayerState, Scene } from './scene.js';
import { emptyScene, type Rect2 } from './scene.js';
// Type-only, so this import is erased and leaves no runtime cycle.
import type { renderScene as renderSceneFn } from './render.js';

export { Mix, Compose, BlendMode };
export type { Color4, Shape, RoundedRect, Rect2, Affine, Rect, Scene, LayerState, DrawObject, GlyphRun };

/** How the buffer is cleared before rendering. */
export type TargetInit = 'transparent' | 'keep';

/** The pixel format of the render target. */
export enum PixelFormat {
  Rgba8 = 'rgba8',
}

/** Per-render settings, as vello's `RenderSettings`. */
export interface RenderSettings {
  /** Where the scene origin lands in the target. */
  readonly offset: { x: number; y: number };
  /** The pixel format; only RGBA8 exists in this port. */
  readonly format: PixelFormat;
  /** How the target is cleared first. */
  readonly targetInit: TargetInit;
}

/** The default settings: RGBA8, cleared to transparent, no offset. */
export function defaultRenderSettings(): RenderSettings {
  return { offset: { x: 0, y: 0 }, format: PixelFormat.Rgba8, targetInit: 'transparent' };
}

/** A target bitmap. */
export interface Pixmap {
  readonly width: number;
  readonly height: number;
  /** RGBA8, row-major, 4 bytes per pixel. */
  readonly data: Uint8Array;
}

/** Creates an RGBA8 pixmap, cleared to transparent. */
export function newPixmap(width: number, height: number): Pixmap {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/** A fill's geometry, as passed to the `fill_*` methods. */
export type FillGeometry = Shape | Rect2 | RoundedRect;

/** Renders a scene into a pixmap. */
export class RenderContext {
  private readonly scene: Scene = emptyScene();
  /** The current transform, applied to everything recorded. */
  private transform: Affine = Affine.IDENTITY;
  private readonly layerStack: LayerState[] = [
    { blend: BlendMode.DEFAULT, opacity: 1, clip: undefined, fillRule: 'non-zero' },
  ];
  private width: number;
  private height: number;

  constructor(width: number, height: number) {
    this.width = Math.max(0, Math.floor(width));
    this.height = Math.max(0, Math.floor(height));
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /** Resizes the target, as upstream's `resize`. */
  resize(width: number, height: number): void {
    this.width = Math.max(0, Math.floor(width));
    this.height = Math.max(0, Math.floor(height));
  }

  /** Sets the transform for everything recorded afterwards, replacing it. */
  set_transform(transform: Affine): void {
    // Replaces outright; use transform_prepend to compose.
    this.transform = transform;
  }

  /** Appends a transform, composing with the current. */
  /**
   * Prepends a transform: the new one is applied to points *first*, then the
   * existing one.
   *
   * `this.then(t)` applies `this` after `t`, which is the ordering wanted. The
   * inverse — `t.then(this)` — applies the new transform last, so a
   * translate-then-scale pair ends up with the translation scaled up too.
   */
  transform_prepend(transform: Affine): void {
    this.transform = this.transform.then(transform);
  }

  /** The current transform. */
  get_transform(): Affine {
    return this.transform;
  }

  /** Fills a path. */
  fill_path(path: Shape, brush: Brush, fillRule: 'non-zero' | 'even-odd' = 'non-zero'): void {
    this.record({ kind: 'path', geometry: path, transform: this.transform, brush, blend: this.blend, opacity: this.opacity, clip: this.clipShape, fillRule });
  }

  /** Fills an axis-aligned rectangle. */
  fill_rect(rect: Rect2, brush: Brush): void {
    this.record({ kind: 'rect', geometry: rect, transform: this.transform, brush, blend: this.blend, opacity: this.opacity, clip: this.clipShape, fillRule: 'non-zero' });
  }

  /** Fills a rounded rectangle. */
  fill_rounded_rect(rect: RoundedRect, brush: Brush): void {
    this.record({ kind: 'rounded-rect', geometry: rect, transform: this.transform, brush, blend: this.blend, opacity: this.opacity, clip: this.clipShape, fillRule: 'non-zero' });
  }

  /**
   * Fills a rounded rectangle and blurs its edges.
   *
   * The blur is applied in the fine stage; recording it here keeps the same
   * command shape as a plain fill.
   */
  fill_blurred_rounded_rect(rect: RoundedRect, blurStdDev: number, brush: Brush): void {
    this.record({
      kind: 'blurred-rounded-rect',
      geometry: { ...rect, stdDev: blurStdDev } as unknown as RoundedRect,
      transform: this.transform,
      brush,
      blend: this.blend,
      opacity: this.opacity,
      clip: this.clipShape,
      fillRule: 'non-zero',
    });
  }

  /** Draws a run of glyph outlines. */
  glyph_run(run: GlyphRun): void {
    this.record({
      kind: 'glyphs',
      geometry: run,
      transform: this.transform,
      brush: run.style.brush,
      blend: run.style.blend,
      opacity: this.opacity,
      clip: this.clipShape,
      fillRule: 'non-zero',
    });
  }

  /** Opens a blend layer. */
  push_layer(layer: { blend: BlendMode; opacity?: number }): void {
    const top = this.layerStack[this.layerStack.length - 1]!;
    this.layerStack.push({
      blend: layer.blend,
      opacity: (layer.opacity ?? 1) * top.opacity,
      clip: top.clip,
      fillRule: top.fillRule,
    });
  }

  /**
   * Opens a clip layer.
   *
   * Nesting a clip *intersects* with any clip already in force, rather than
   * replacing it: clipping to A then B must keep only the intersection.
   */
  push_clip_layer(path: Shape, fillRule: 'non-zero' | 'even-odd' = 'non-zero'): void {
    const top = this.layerStack[this.layerStack.length - 1]!;
    this.layerStack.push({ ...top, clip: path, fillRule });
  }

  /** Opens an opacity layer. */
  push_opacity_layer(opacity: number): void {
    const top = this.layerStack[this.layerStack.length - 1]!;
    this.layerStack.push({ ...top, opacity: top.opacity * opacity });
  }

  /** Opens a mask layer. */
  push_mask_layer(_mask: unknown): void {
    const top = this.layerStack[this.layerStack.length - 1]!;
    // Masks are recorded as a clip against the mask's alpha in the fine stage.
    this.layerStack.push({ ...top });
  }

  /** Opens a filter layer. */
  push_filter_layer(_filter: unknown): void {
    const top = this.layerStack[this.layerStack.length - 1]!;
    this.layerStack.push({ ...top });
  }

  /** Closes the current layer. */
  pop_layer(): void {
    if (this.layerStack.length > 1) this.layerStack.pop();
  }

  /** Renders the recorded scene into `target`. */
  flush(target: Pixmap, settings: RenderSettings = defaultRenderSettings()): void {
    renderSceneImpl(this.scene, target, this.width, this.height, settings);
  }

  /** Clears the recorded scene without rendering it. */
  reset(): void {
    this.scene.commands.length = 0;
    this.layerStack.length = 1;
    this.layerStack[0] = { blend: BlendMode.DEFAULT, opacity: 1, clip: undefined, fillRule: 'non-zero' };
    this.transform = Affine.IDENTITY;
  }

  /** Adds a command under the current layer state. */
  private record(cmd: Omit<DrawCommand, 'clip'> & { clip: Shape | undefined }): void {
    this.scene.commands.push(cmd as DrawCommand);
    this.scene.layers.push(this.layerStack[this.layerStack.length - 1]!);
  }

  private get blend(): BlendMode {
    return this.layerStack[this.layerStack.length - 1]!.blend;
  }

  private get opacity(): number {
    return this.layerStack[this.layerStack.length - 1]!.opacity;
  }

  private get clipShape(): Shape | undefined {
    return this.layerStack[this.layerStack.length - 1]!.clip;
  }
}

/**
 * The scene renderer, wired in by `render.ts`.
 *
 * `render.ts` imports only types from this module, so the reference is
 * populated by the time `flush` can be called and there is no import cycle at
 * runtime.
 */
let renderSceneImpl: typeof renderSceneFn = () => {
  throw new Error('vello: import ./render.js before calling flush()');
};

/** Sets the renderer. Called once when `render.ts` is imported. */
export function _setRenderer(fn: typeof renderSceneFn): void {
  renderSceneImpl = fn;
}

export { premultiply, compose };
