/**
 * `kurbo/src/rounded_rect_radii.rs`: the four corner radii of a rounded rect.
 *
 * Kurbo holds one scalar radius per corner. The port holds a *pair*, because
 * the API this serves (`fill_rounded_rect`) takes `radiusX`/`radiusY` and a
 * corner may legitimately be an ellipse rather than an arc. Everything else —
 * the field order (counter-clockwise from the top left), the clamp — is as
 * upstream.
 */

/** One corner's radii, in x and y. */
export interface Radius {
  readonly rx: number;
  readonly ry: number;
}

/** The four corner radii, as kurbo's `RoundedRectRadii`. */
export class RoundedRectRadii {
  constructor(
    readonly top_left: Radius = { rx: 0, ry: 0 },
    readonly top_right: Radius = { rx: 0, ry: 0 },
    readonly bottom_right: Radius = { rx: 0, ry: 0 },
    readonly bottom_left: Radius = { rx: 0, ry: 0 },
  ) {}

  /** The same radius on all four corners. */
  static uniform(rx: number, ry: number = rx): RoundedRectRadii {
    return new RoundedRectRadii({ rx, ry }, { rx, ry }, { rx, ry }, { rx, ry });
  }

  /** Clamps every corner into `0..=maxX` by `0..=maxY`. */
  clamp(maxX: number, maxY: number): RoundedRectRadii {
    const c = (r: Radius): Radius => ({
      rx: Math.min(Math.max(0, r.rx), Math.max(0, maxX)),
      ry: Math.min(Math.max(0, r.ry), Math.max(0, maxY)),
    });
    return new RoundedRectRadii(
      c(this.top_left),
      c(this.top_right),
      c(this.bottom_right),
      c(this.bottom_left),
    );
  }

  /** The largest x radius of the four corners. */
  max_x(): number {
    return Math.max(this.top_left.rx, this.top_right.rx, this.bottom_right.rx, this.bottom_left.rx);
  }
}
