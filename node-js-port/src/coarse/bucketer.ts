/**
 * `vello_cpu::coarse::bucketer`: the row-strip binning pass.
 *
 * Upstream this exists so that each worker thread owns a horizontal strip of
 * the target and the strips can be filled without synchronization. In a
 * single-threaded port the strips still matter, because they bound the working
 * set: a bin is rendered before the next one is touched, so a tall scene costs
 * one strip at a time rather than one allocation for the whole thing.
 *
 * The one thing that has to be right is the bin **membership** rule. A draw
 * object is assigned to every bin its row range overlaps, and each bin renders
 * only its own rows; an object that were simply pushed into one bin and then
 * rendered whole would composite its pixels twice wherever its rows straddle a
 * bin boundary.
 */

import type { DrawObject } from './cmd.js';

/** A coarse bin: a horizontal strip of draw objects. */
export interface Bin {
  /** The first pixel row the bin covers. */
  readonly y0: number;
  /** One past the last pixel row the bin covers. */
  readonly y1: number;
  readonly objects: DrawObject[];
}

/** How many pixel rows one bin covers. */
export const BIN_HEIGHT = 256;

/**
 * Splits a command list into horizontal bins by bounding box.
 *
 * Bounds are in device space, where y grows **upwards**, so the row range runs
 * from the top edge of the box downwards: a box spanning device `y0..y1`
 * covers screen rows `height - y1 .. height - 1 - y0`.
 */
export function bucketize(objects: readonly DrawObject[], height: number): Bin[] {
  if (objects.length === 0 || height <= 0) return [];

  const binCount = Math.max(1, Math.ceil(height / BIN_HEIGHT));
  const bins: { y0: number; y1: number; objects: DrawObject[] }[] = [];
  for (let i = 0; i < binCount; i++) {
    bins.push({ y0: i * BIN_HEIGHT, y1: Math.min(height, (i + 1) * BIN_HEIGHT), objects: [] });
  }

  for (const o of objects) {
    const firstRow = height - o.bounds.y1;
    const lastRow = height - 1 - o.bounds.y0;
    if (lastRow < 0 || firstRow >= height) continue;
    const first = Math.min(binCount - 1, Math.max(0, Math.floor(firstRow / BIN_HEIGHT)));
    const last = Math.min(binCount - 1, Math.max(0, Math.floor(lastRow / BIN_HEIGHT)));
    for (let b = first; b <= last; b++) bins[b]!.objects.push(o);
  }

  return bins.filter((b) => b.objects.length > 0);
}
