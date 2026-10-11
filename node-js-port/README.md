# Node.js port: `vello_cpu` replacement

TypeScript replacement for the glyph-rasterization part of
[`vello_cpu`](https://github.com/linebender/vello/tree/main/vello_cpu), plus the
three-stage render pipeline that surrounds it.

## Why

`epaint` rasterizes glyphs into a font atlas: it takes the outlines from
`skrifa`, fills them, and produces an alpha bitmap that `Glyph::uv_rect`
then points into. Upstream this is `vello_cpu` (a full CPU vector renderer,
backed by the `peniko`/`kurbo` geometry stack).

Porting all of `vello_cpu` is not the goal. Glyph rasterization is a much
smaller problem than general vector rendering: the shapes are tiny, closed,
non-self-intersecting, and filled with a single non-zero-winding fill. A
scanline rasterizer with analytic or supersampled coverage is sufficient and
keeps the port dependency-free.

## Upstream reference

- Crate: `vello_cpu`, in the `vello` monorepo (`vello_cpu/`).
- Version egui pins: `0.2.0`.
- Licence: `Apache-2.0 OR MIT` — identical to egui's own dual licence.

## Modules to port

`src/` mirrors the Rust crate's layout, so a ported call site can be checked
against upstream file by file:

| Rust | Port | Purpose |
|---|---|---|
| `kurbo::{Affine, Point, Rect, Shape, common, …}` | `src/kurbo/` | the geometry vocabulary |
| `vello_cpu::record` | `src/record/` | the recorded scene and layer state |
| `vello_cpu::coarse::{cmd, bucketer}` | `src/coarse/` | transform, bound, bin |
| `vello_cpu::render` | `src/render/` | the driver, plus the fine stage |
| (no counterpart) | `src/rasterizer.ts`, `src/path.ts` | the glyph rasterizer |

`src/rasterizer.ts` and `src/path.ts` stay at the top level because they have
no counterpart in `vello_cpu`: the glyph rasterizer is the one part of the crate
`epaint` actually reaches for, and it is kept independently testable rather than
folded into the render pipeline.

Porting status of the pipeline itself:

| Upstream | Status |
|---|---|
| `record.rs` (layer stack, clip intersection, opacity) | done |
| `coarse/{cmd, bucketer}.rs` (transform, bbox, bins) | done |
| `fine/` (rasterize, composite, blend, clip) | done |

Deliberately **not** ported:
- gradient and image brushes, and the `vello_common::encode` paint encoding
  behind them — only solid colours are rendered;
- stroked paths (`kurbo::Stroke`), and the `kurbo` curve/stroke API beyond the
  geometry vocabulary the pipeline needs;
- blur and other filters (`vello_common::filter_effects`), so
  `fill_blurred_rounded_rect` draws the exact rectangle without the softness;
- masks as anything other than a recorded clip layer;
- SIMD dispatch (`fearless_simd` `Level`), `RenderMode`, thread count and the
  multithreaded dispatcher — they choose *how* to rasterize, and there is one
  rasterizer here;
- the glifo glyph atlas (`vello_cpu::text`), which egui replaces with its own
  font atlas;
- even-odd fills: `rasterize.ts` implements the non-zero winding rule alone.

`epaint` only needs filled glyph coverage; everything else in `vello_cpu` is
used by the vector-graphics side that the headless core does not reproduce.

## Approach

Vertical supersampling with exact horizontal span coverage. Each pixel row is
sampled at 16 sub-scanlines; at each sub-scanline the edge intersections are
sorted and walked with the non-zero winding rule, and each filled span adds
exact fractional coverage to the pixels it touches. Horizontal edges never
cross a scanline, and the half-open `[min_y, max_y)` test means a shared vertex
is counted exactly once.

The bitmap rounds **outward** on all four sides. Rounding the vertical bounds
inward discards the partially covered top and bottom rows, which was a real bug
caught by testing against Ahem: a box spanning -3.2..12.8px must cover pixel
rows -4..13, not -3..12.

`bearing_y` uses the y-down convention (negated distance from the baseline to
the top edge), matching glifo, which negates it again when positioning.

## Output contract

The Rust side produces `RasterMetrics` (bitmap dimensions, origin, `subpixel_offset_px`)
plus an alpha coverage buffer. `epaint`'s `GlyphRasterizerRequest` carries
`cluster`, `FontFamily`, `font_size_px` and `subpixel_offset_px`; the port
must return equivalent metrics and coverage.

## Licence

This port is `MIT OR Apache-2.0`, matching the upstream crate.