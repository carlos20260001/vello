/**
 * `vello_cpu::coarse::cmd`: a draw object after the coarse stage.
 *
 * By the time a command reaches this type everything geometric has been
 * resolved: the transform is baked in, the bounding box is pixel-aligned, and
 * the clips have been mapped through the same device transform as the geometry
 * they clip. The fine stage can then work in one coordinate system and never
 * has to think about layers again.
 */

import type { BlendMode, Brush } from '@egui-node/peniko-ts';
import type { Rect, Shape } from '../kurbo/mod.js';
import type { Clip, Fill } from '../record/mod.js';

/** A draw object, in device space. */
export interface DrawObject {
  /** Screen-space geometry. */
  readonly path: Shape;
  readonly brush: Brush;
  readonly blend: BlendMode;
  readonly opacity: number;
  /**
   * The clips in force, in device space.
   *
   * Nested clips are *intersected*: a pixel is drawn only where every clip
   * covers it. See `record/mod.ts` for why the stack is a list.
   */
  readonly clips: readonly Clip[];
  readonly fillRule: Fill;
  /** Device-space bounding box, expanded to whole pixels. */
  readonly bounds: Rect;
}
