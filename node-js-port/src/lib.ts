/**
 * The public API of the port: `vello_cpu/src/lib.rs`, partially.
 *
 * Mirrors the Rust crate's module layout:
 *
 * | Rust | Port |
 * |---|---|
 * | `kurbo::*` | `kurbo/` |
 * | `vello_cpu::record` | `record/` |
 * | `vello_cpu::coarse::{cmd, bucketer}` | `coarse/` |
 * | `vello_cpu::render` | `render/` |
 * | (none — glyph-specific) | `rasterizer.ts`, `path.ts` |
 *
 * The glyph rasterizer has no counterpart in `vello_cpu`: it is the one part of
 * the crate `epaint` actually reaches for, and it is kept at the top level so
 * that it stays independently testable.
 */

export * from './kurbo/mod.js';
export * from './record/mod.js';
export * from './coarse/mod.js';
export * from './render/context.js';
export * from './render/mod.js';
export * from './path.js';
export * from './rasterizer.js';
