# Node.js port: `vello_cpu` replacement

TypeScript replacement for the glyph-rasterization part of
[`vello_cpu`](https://github.com/linebender/vello/tree/main/vello_cpu).

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

| Rust module | Purpose | TS status |
|---|---|---|
| `text.rs` (`CpuGlyphRunBackend`) | glyph -> raster metrics + coverage bitmap | TODO |
| `render.rs` / `fine/` | the coverage rasterizer we need to reimplement | TODO |
| `span.rs`, `region.rs` | span/region tracking | not needed for glyphs |

Deliberately **not** ported: gradients, image brushes, blend modes, blur
filters, stroked paths, and the multithreaded `rayon` dispatch. `epaint`
only needs filled glyph coverage; everything else in `vello_cpu` is used by
the vector-graphics side that the headless core does not reproduce.

The geometry itself (path building, transforms) is not needed here: the
skrifa port hands over paths directly.

## Output contract

The Rust side produces `RasterMetrics` (bitmap dimensions, origin, `subpixel_offset_px`)
plus an alpha coverage buffer. `epaint`'s `GlyphRasterizerRequest` carries
`cluster`, `FontFamily`, `font_size_px` and `subpixel_offset_px`; the port
must return equivalent metrics and coverage.

## Licence

This port is `MIT OR Apache-2.0`, matching the upstream crate.