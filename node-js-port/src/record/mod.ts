/**
 * `vello_cpu::record`, which is where a scene is accumulated.
 *
 * ## What the record stage owns
 *
 * `RenderContext` (in `render/context.ts`) pushes a flat list of draw commands,
 * each one stamped with the layer state that was in force when it was recorded:
 * the blend mode, an accumulated opacity, the clip stack, and the fill rule.
 * Upstream keeps a `Node` tree with parent pointers instead; a flat list of
 * (command, resolved state) pairs carries the same information and is far
 * cheaper to walk, which is what the coarse stage does next.
 *
 * ## Clips
 *
 * This is the part that is easiest to get silently wrong, so it is worth being
 * precise: a clip does not *replace* the clip already in force, it **adds** to
 * the stack and the two are **intersected**. Clipping to A and then to B
 * leaves only the pixels inside both, exactly as the clipping example in
 * `vello_cpu/examples/clipping.rs` documents for `push_clip_path`
 * ("the drawing area will be further reduced to the *intersection* of all
 * clip paths that are currently in-place").
 *
 * That is also why the clips are stored as a list rather than a single
 * optional shape, and why they are stored with the transform that was in force
 * when each was pushed: a clip is part of the coordinate system it was drawn
 * in, so it has to be resolved through its own transform rather than
 * whatever transform happens to be current at render time.
 */

import type { BlendMode, Brush } from '@egui-node/peniko-ts';
import type { Affine, Shape } from '../kurbo/mod.js';

/** How a path is filled, as `peniko::Fill`. */
export type Fill = 'non-zero' | 'even-odd';

/** A clipped path in force: the shape, plus the rule it fills by. */
export interface Clip {
  readonly shape: Shape;
  readonly fillRule: Fill;
}

/** A clip as recorded, with the transform in force when it was pushed. */
export interface RecordedClip extends Clip {
  readonly transform: Affine;
}

/** A single recorded draw command. */
export interface DrawCommand {
  /** The thing being drawn. */
  readonly kind: 'path' | 'rect' | 'rounded-rect' | 'blurred-rounded-rect' | 'glyphs';
  /** The geometry in *local* space, before the transform. */
  readonly geometry: FillGeometry;
  /** Local-to-device transform at record time. */
  readonly transform: Affine;
  /** What to fill with. */
  readonly brush: Brush;
  /** How it combines with what is beneath. */
  readonly blend: BlendMode;
  /** An additional alpha multiplier, from an enclosing opacity layer. */
  readonly opacity: number;
  /** The clip stack in force; clips nest by intersection. */
  readonly clips: readonly RecordedClip[];
  /** Whether the fill rule is even-odd rather than non-zero winding. */
  readonly fillRule: Fill;
}

/** A rectangle's four coordinates, which `fill_rect` takes by value. */
export interface RectShape {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** A rounded rect's coordinates and corner radii, which `fill_rounded_rect` takes. */
export interface RoundedRectShape extends RectShape {
  readonly radiusX: number;
  readonly radiusY: number;
}

/** A rectangle carrying a blur, as recorded by `fill_blurred_rounded_rect`. */
export interface BlurredRoundedRectShape extends RoundedRectShape {
  /** Standard deviation of the blur, in pixels. */
  readonly stdDev: number;
}

/**
 * Everything a fill can be drawn with.
 *
 * `Rect` and `RoundedRect` from the `kurbo` port are `Shape`s themselves, so
 * only the bare-coordinate forms need naming separately.
 */
export type FillGeometry = PathGeometry | GlyphRun;

/**
 * The fill geometries that are *shapes* rather than runs.
 *
 * Narrower than `FillGeometry` because the coarse stage resolves each of these
 * by building a `Rect` or `RoundedRect`, which only makes sense for geometry.
 */
export type PathGeometry = Shape | RectShape | RoundedRectShape | BlurredRoundedRectShape;

/** A run of glyphs, positioned in local space. */
export interface GlyphRun {
  /** Glyph outlines, already scaled to their font size. */
  readonly outlines: Shape[];
  /** The glyphs' positions in local space. */
  readonly positions: readonly { readonly x: number; readonly y: number }[];
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

/** The layer state captured when a command is recorded. */
export interface LayerState {
  readonly blend: BlendMode;
  readonly opacity: number;
  readonly clips: readonly RecordedClip[];
  readonly fillRule: Fill;
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
