/**
 * The recorded scene, replacing vello's `record.rs` and `coarse/cmd.rs`.
 *
 * ## vello's pipeline, and this port's shape
 *
 * vello_cpu is three stages driven by `RenderContext::flush`:
 *
 *  1. **Record.** `RenderContext` accumulates draw commands into a scene, each
 *     carrying a transform, a paint, a blend mode and an optional clip. It also
 *     maintains a *layer* stack (blend, opacity, clip, mask, filter) that
 *     changes how subsequent commands composite.
 *  2. **Coarse.** Each path is transformed into screen space, its bounding box
 *     computed, and it is allocated into per-row **bins** for cache locality.
 *  3. **Fine.** Each bin is rasterized into antialiased spans and composited
 *     with the blend and compose modes.
 *
 * Two things upstream does that this port deliberately does not, because they
 * have no Node equivalent: it runs stages 2 and 3 in parallel via rayon, and it
 * dispatches SIMD kernels at runtime through `fearless_simd`. Both are
 * performance strategies, not behaviour; the arithmetic is identical scalar.
 * The port follows the **single-threaded** dispatcher's ordering exactly, which
 * is upstream's own reference path.
 *
 * `RenderContext` here records into a flat list with an explicit layer stack,
 * rather than a parent-pointer node tree. Upstream's `Node` tree carries a
 * `parent` index so a layer can be applied to everything recorded after it;
 * this port stores the resolved layer state on each command, which flattens the
 * same information and is simpler to walk in the fine stage.
 *
 * ## Paint and blend types
 *
 * `Brush`, `BlendMode`, `Compose` and `Mix` come from the peniko port rather
 * than being redefined, so the two ports share one definition of what a paint
 * is and one implementation of how it combines.
 */

import { BlendMode } from '@egui-node/peniko-ts';
import type { Brush } from '@egui-node/peniko-ts';
import type { Affine, Shape, RoundedRect } from './transform.js';

export { BlendMode };
export type { Brush, Shape, RoundedRect };

/** A rounded rect carrying a blur, as recorded by `fillBlurredRoundedRect`. */
export interface BlurredRoundedRect extends RoundedRect {
  /** Standard deviation of the blur, in pixels. */
  readonly stdDev: number;
}

/** A single recorded draw command. */
export interface DrawCommand {
  /** The thing being drawn. */
  readonly kind: 'path' | 'rect' | 'rounded-rect' | 'blurred-rounded-rect' | 'glyphs';
  /** The geometry in *local* space, before the transform. */
  readonly geometry: Shape | Rect2 | RoundedRect | BlurredRoundedRect | GlyphRun;
  /** Local-to-screen transform at record time. */
  readonly transform: Affine;
  /** What to fill with. */
  readonly brush: Brush;
  /** How it combines with what is beneath. */
  readonly blend: BlendMode;
  /** An additional alpha multiplier, from an enclosing opacity layer. */
  readonly opacity: number;
  /** The clip in force, if any. */
  readonly clip: Shape | undefined;
  /** Whether the fill rule is even-odd rather than non-zero winding. */
  readonly fillRule: 'non-zero' | 'even-odd';
}

/** A rectangle in local space. */
export interface Rect2 {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** A run of glyphs, positioned in local space. */
export interface GlyphRun {
  /** Glyph outlines, already scaled to their font size. */
  readonly outlines: Shape[];
  /** The glyphs' positions in local space. */
  readonly positions: ReadonlyArray<{ x: number; y: number }>;
  /** A single shared style for the run, as vello's `GlyphRun` carries. */
  readonly style: RunStyle;
}

/** The style of a glyph run. */
export interface RunStyle {
  readonly brush: Brush;
  readonly blend: BlendMode;
}

/** A blur filter, as vello's `Filter`. */
export interface Filter {
  /** The blur's standard deviation, in pixels. */
  readonly stdDev: number;
}

/** A mask, as vello's `Mask`. */
export interface Mask {
  /** The alpha mask itself, one byte per pixel. */
  readonly alpha: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** A clip shape, as vello's `Clip`. */
export type Clip = {
  readonly kind: 'shape';
  readonly shape: Shape;
  readonly fillRule: 'non-zero' | 'even-odd';
};

/** The layer state captured when a command is recorded. */
export interface LayerState {
  readonly blend: BlendMode;
  readonly opacity: number;
  readonly clip: Shape | undefined;
  readonly fillRule: 'non-zero' | 'even-odd';
}

/** The recorded scene: commands plus the layer they were recorded under. */
export interface Scene {
  readonly commands: DrawCommand[];
  readonly layers: LayerState[];
}

/** Creates an empty scene. */
export function emptyScene(): Scene {
  return { commands: [], layers: [] };
}

/** A draw object after the coarse stage. */
export interface DrawObject {
  /** Screen-space geometry. */
  readonly path: Shape;
  readonly brush: Brush;
  readonly blend: BlendMode;
  readonly opacity: number;
  readonly clip: Shape | undefined;
  readonly fillRule: 'non-zero' | 'even-odd';
  /** Screen-space bounding box, expanded to whole pixels. */
  readonly bounds: { x0: number; y0: number; x1: number; y1: number };
}

/** A coarse bin: a horizontal strip of draw objects. */
export interface Bin {
  readonly y0: number;
  readonly y1: number;
  readonly objects: DrawObject[];
}

/** How many pixel rows one bin covers. */
export const BIN_HEIGHT = 256;

/** Splits a command list into horizontal bins by bounding box. */
export function bucketize(objects: readonly DrawObject[], height: number): Bin[] {
  if (objects.length === 0) return [];
  const bins: Bin[] = [];
  const binCount = Math.max(1, Math.ceil(height / BIN_HEIGHT));
  for (let i = 0; i < binCount; i++) {
    const y0 = i * BIN_HEIGHT;
    const y1 = Math.min(height, (i + 1) * BIN_HEIGHT);
    const inBin = objects.filter((o) => o.bounds.y1 > y0 && o.bounds.y0 < y1);
    if (inBin.length > 0) bins.push({ y0, y1, objects: inBin });
  }
  return bins;
}
