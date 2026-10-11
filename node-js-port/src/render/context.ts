/**
 * `RenderContext`, the public surface of the port: upstream's
 * `vello_cpu::render::RenderContext`.
 *
 * The API matches upstream so that porting a call site is mechanical:
 *
 * ```ts
 * const ctx = new RenderContext(width, height);
 * ctx.fill_rect(Rect.new(10, 10, 100, 100), solidBrush(color));
 * ctx.push_layer({ blend: new BlendMode(Mix.Multiply) });
 * ctx.fill_path(path, gradientBrush(gradient));
 * ctx.pop_layer();
 * ctx.flush(pixmap);
 * ```
 *
 * ## Layers
 *
 * A layer stack where each entry changes how everything recorded after it
 * composites. Push/pop is balanced, an extra pop is a no-op rather than an
 * underflow, and:
 *
 *  - `push_opacity_layer` **multiplies** through, so nesting 0.5 inside 0.5
 *    leaves a quarter of the source's alpha, not the inner value alone;
 *  - `push_clip_layer` **intersects** with any clip already in force, because
 *    nesting two clips must keep both. See `record/mod.ts`.
 *
 * ## What this port does not do
 *
 * It renders into a `Uint8Array` RGBA8 buffer. `RenderMode`, `RenderSettings`
 * (`level`, `num_threads`) and the SIMD `Level` all exist upstream and are
 * omitted here: they select *how* to rasterize (fast/quality, thread count, CPU
 * features) rather than *what* is drawn. There is one rasterizer in this port,
 * so there is nothing to select.
 */

import { BlendMode, Compose, Mix, compose, premultiply, unpremultiply, type Brush } from '@egui-node/peniko-ts';

import { Affine, RoundedRect, type Shape } from '../kurbo/mod.js';
import type {
  BlurredRoundedRectShape,
  Clip,
  DrawCommand,
  Fill,
  GlyphRun,
  LayerState,
  Mask,
  RecordedClip,
  RectShape,
  RoundedRectShape,
  Scene,
} from '../record/mod.js';
import { emptyScene } from '../record/mod.js';
// Type-only, so this import is erased and leaves no runtime cycle.
import type { renderScene as renderSceneFn } from './mod.js';

// The blend vocabulary is peniko's; re-exported so a caller of this package
// gets one import for the whole pipeline.
export { BlendMode, Compose, Mix };
export type { Affine, Shape, Brush, Scene, LayerState, Clip, Fill, Mask };

/** How the buffer is cleared before rendering, as `TargetInit`. */
export type TargetInit = 'transparent' | 'keep';

/** The pixel format of the render target. */
export enum PixelFormat {
  Rgba8 = 'rgba8',
}

/** Per-render settings, as upstream's `RasterizerSettings`. */
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

/** A layer to push, as upstream's `push_layer`'s arguments. */
export interface Layer {
  readonly blend?: BlendMode;
  readonly opacity?: number;
}

/** A render context for CPU-based 2D graphics rendering. */
export class RenderContext {
  private readonly scene: Scene = emptyScene();
  /** The current transform, applied to everything recorded. */
  private transform: Affine = Affine.IDENTITY;
  private readonly layerStack: LayerState[] = [{
    blend: BlendMode.DEFAULT,
    opacity: 1,
    clips: [],
    fillRule: 'non-zero',
  }];
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
    this.transform = transform;
  }

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
  fill_path(path: Shape, brush: Brush, fillRule: Fill = 'non-zero'): void {
    this.record({ kind: 'path', geometry: path, transform: this.transform, brush, blend: this.blend, opacity: this.opacity, clips: this.clips, fillRule });
  }

  /** Fills an axis-aligned rectangle. */
  fill_rect(rect: RectShape, brush: Brush): void {
    this.record({ kind: 'rect', geometry: rect, transform: this.transform, brush, blend: this.blend, opacity: this.opacity, clips: this.clips, fillRule: 'non-zero' });
  }

  /**
   * Fills a rounded rectangle.
   *
   * Takes either the corner radii directly or a `RoundedRect` from the kurbo
   * port, which clamps its radii while it is built.
   */
  fill_rounded_rect(rect: RoundedRectShape | RoundedRect, brush: Brush): void {
    this.record({ kind: 'rounded-rect', geometry: rect, transform: this.transform, brush, blend: this.blend, opacity: this.opacity, clips: this.clips, fillRule: 'non-zero' });
  }

  /**
   * Fills a rounded rectangle and blurs its edges.
   *
   * The blur itself is `vello_common::filter_effects::Blur`, which is not
   * ported; what is drawn is the exact rectangle, without the softness.
   */
  fill_blurred_rounded_rect(rect: BlurredRoundedRectShape, brush: Brush): void {
    this.record({
      kind: 'blurred-rounded-rect',
      geometry: { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1, radiusX: rect.radiusX, radiusY: rect.radiusY },
      transform: this.transform,
      brush,
      blend: this.blend,
      opacity: this.opacity,
      clips: this.clips,
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
      clips: this.clips,
      fillRule: 'non-zero',
    });
  }

  /** Opens a blend layer, optionally with an opacity of its own. */
  push_layer(layer: Layer): void {
    const top = this.layerStack[this.layerStack.length - 1]!;
    this.layerStack.push({
      blend: layer.blend ?? top.blend,
      opacity: (layer.opacity ?? 1) * top.opacity,
      clips: top.clips,
      fillRule: top.fillRule,
    });
  }

  /** Opens a clip layer. */
  push_clip_layer(path: Shape, fillRule: Fill = 'non-zero'): void {
    const top = this.layerStack[this.layerStack.length - 1]!;
    const clip: RecordedClip = { shape: path, fillRule, transform: this.transform };
    // Nests by *intersection*: the clip stack is kept, not replaced, so a draw
    // under two clips sees only the pixels inside both.
    this.layerStack.push({ ...top, clips: [...top.clips, clip] });
  }

  /** Opens an opacity layer. */
  push_opacity_layer(opacity: number): void {
    const top = this.layerStack[this.layerStack.length - 1]!;
    this.layerStack.push({ ...top, opacity: top.opacity * opacity });
  }

  /** Opens a mask layer. */
  push_mask_layer(_mask: Mask): void {
    // Upstream keeps the mask's size check here: a mask that does not match the
    // render target is dropped rather than silently misapplied.
    if (_mask.width !== this.width || _mask.height !== this.height) return;
    const top = this.layerStack[this.layerStack.length - 1]!;
    // The mask itself is rasterized into the clip pass in the fine stage; it is
    // recorded as a clip against the mask's alpha when that path is ported.
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
    this.scene.layers.length = 0;
    this.layerStack.length = 1;
    this.layerStack[0] = { blend: BlendMode.DEFAULT, opacity: 1, clips: [], fillRule: 'non-zero' };
    this.transform = Affine.IDENTITY;
  }

  /** Adds a command under the current layer state. */
  private record(cmd: DrawCommand): void {
    this.scene.commands.push(cmd);
    this.scene.layers.push(this.layerStack[this.layerStack.length - 1]!);
  }

  private get blend(): BlendMode {
    return this.layerStack[this.layerStack.length - 1]!.blend;
  }

  private get opacity(): number {
    return this.layerStack[this.layerStack.length - 1]!.opacity;
  }

  private get clips(): readonly RecordedClip[] {
    return this.layerStack[this.layerStack.length - 1]!.clips;
  }
}

/**
 * The scene renderer, wired in by `render/mod.ts`.
 *
 * `render/mod.ts` imports only types from this module, so the reference is
 * populated by the time `flush` can be called and there is no import cycle at
 * runtime.
 */
let renderSceneImpl: typeof renderSceneFn = () => {
  throw new Error('vello: import render/mod.js before calling flush()');
};

/** Sets the renderer. Called once when `render/mod.ts` is imported. */
export function _setRenderer(fn: typeof renderSceneFn): void {
  renderSceneImpl = fn;
}

// The blend arithmetic lives in the peniko port; re-exported so a caller of
// this package gets one import for the whole pipeline.
export { compose, premultiply, unpremultiply };
