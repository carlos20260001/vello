/**
 * The package entry point: re-exports `lib.ts`, which mirrors the Rust crate's
 * module layout.
 *
 * This module used to list every file directly. It now goes through `lib.ts`
 * so the public surface is declared in one place that corresponds to
 * `vello_cpu/src/lib.rs`.
 */

export * from './lib.js';
