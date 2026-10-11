/** `kurbo/src/size.rs`: a width and height; an extent, not a position. */

// `Rect` is imported for `to_rect`; the cycle is harmless because neither
// module constructs the other's type while it is being evaluated.
import { Rect } from './rect.js';
import { Vec2 } from './vec2.js';

/** An extent, as kurbo's `Size`. */
export class Size {
  constructor(
    readonly width = 0,
    readonly height = 0,
  ) {}

  /** The zero size. */
  static readonly ZERO = new Size(0, 0);

  /** A new size from explicit dimensions. */
  static new(width: number, height: number): Size {
    return new Size(width, height);
  }

  /** The same extent, as a `Vec2`. */
  to_vec2(): Vec2 {
    return new Vec2(this.width, this.height);
  }

  /** The same extent, as a `Rect` at the origin. */
  to_rect(): Rect {
    return new Rect(0, 0, this.width, this.height);
  }

  /** The area, which may be negative. */
  area(): number {
    return this.width * this.height;
  }

  /** Whether either dimension is zero. */
  is_empty(): boolean {
    return this.width === 0 || this.height === 0;
  }

  /** The width divided by the height; 1 is square. */
  aspect_ratio_width(): number {
    return this.width / this.height;
  }
}
