/**
 * A TypeScript port of `vello_cpu`, the CPU glyph rasterizer.
 *
 * Only the glyph-rasterization part of vello_cpu is ported — that is what egui
 * needs. vello_cpu is a general CPU vector renderer, and the pipeline now exists
 * for it (record → coarse → fine), but strokes, gradients, blend modes, blur
 * and rayon dispatch are deliberately not ported.
 *
 * Output shape mirrors glifo's `RasterMetrics`, which is what egui consumes —
 * see `rasterizer.ts` for the y-down `bearing_y` convention.
 */

export * from './rasterizer.js';
export * from './path.js';
export * from './transform.js';
export * from './scene.js';
export * from './context.js';
export * from './render.js';
