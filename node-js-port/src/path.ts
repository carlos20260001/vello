/**
 * Path primitives for the rasterizer.
 *
 * Deliberately a standalone copy rather than a dependency on the `skrifa`
 * port: the two crates are separate upstream projects with separate forks and
 * release cycles, so coupling them would be wrong. The shape of this type
 * matches `skrifa`'s `Path` so an outline crosses over without conversion.
 */

export type PathCommand =
  | { kind: 'MoveTo'; x: number; y: number }
  | { kind: 'LineTo'; x: number; y: number }
  | { kind: 'QuadTo'; cx: number; cy: number; x: number; y: number }
  | { kind: 'CubicTo'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }
  | { kind: 'Close' };

/** A path of contours. Note `y` grows upwards, as in font space. */
export class Path {
  readonly commands: PathCommand[] = [];

  moveTo(x: number, y: number): this {
    this.commands.push({ kind: 'MoveTo', x, y });
    return this;
  }

  lineTo(x: number, y: number): this {
    this.commands.push({ kind: 'LineTo', x, y });
    return this;
  }

  quadTo(cx: number, cy: number, x: number, y: number): this {
    this.commands.push({ kind: 'QuadTo', cx, cy, x, y });
    return this;
  }

  cubicTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): this {
    this.commands.push({ kind: 'CubicTo', c1x, c1y, c2x, c2y, x, y });
    return this;
  }

  close(): this {
    this.commands.push({ kind: 'Close' });
    return this;
  }

  /** Append another path's commands. */
  extend(other: Path): this {
    this.commands.push(...other.commands);
    return this;
  }

  get is_empty(): boolean {
    return this.commands.length === 0;
  }

  /** Axis-aligned bounds over all on- and off-curve control points. */
  bounds(): { xMin: number; yMin: number; xMax: number; yMax: number } | undefined {
    let xMin = Number.POSITIVE_INFINITY;
    let yMin = Number.POSITIVE_INFINITY;
    let xMax = Number.NEGATIVE_INFINITY;
    let yMax = Number.NEGATIVE_INFINITY;
    let any = false;

    const acc = (x: number, y: number) => {
      any = true;
      if (x < xMin) xMin = x;
      if (y < yMin) yMin = y;
      if (x > xMax) xMax = x;
      if (y > yMax) yMax = y;
    };

    for (const c of this.commands) {
      switch (c.kind) {
        case 'MoveTo':
        case 'LineTo':
          acc(c.x, c.y);
          break;
        case 'QuadTo':
          acc(c.cx, c.cy);
          acc(c.x, c.y);
          break;
        case 'CubicTo':
          acc(c.c1x, c.c1y);
          acc(c.c2x, c.c2y);
          acc(c.x, c.y);
          break;
        case 'Close':
          break;
      }
    }
    return any ? { xMin, yMin, xMax, yMax } : undefined;
  }

  /**
   * Signed area, doubled. Positive means counter-clockwise in a y-up space.
   * Used to normalise winding direction if a consumer needs consistent fills.
   */
  approximate_area(): number {
    let area = 0;
    let cx = 0;
    let cy = 0;
    let startX = 0;
    let startY = 0;
    for (const c of this.commands) {
      switch (c.kind) {
        case 'MoveTo':
          cx = startX = c.x;
          cy = startY = c.y;
          break;
        case 'LineTo':
          area += cx * c.y - c.x * cy;
          cx = c.x;
          cy = c.y;
          break;
        case 'Close':
          area += cx * startY - startX * cy;
          cx = startX;
          cy = startY;
          break;
        default:
          // Curves contribute their endpoints for a coarse estimate.
          cx = c.x;
          cy = c.y;
          break;
      }
    }
    return area;
  }

  /**
   * Builds a path from a structural shape.
   *
   * `rasterize` takes a `Path` because it uses the builder's own `bounds()`;
   * the render pipeline works with plain command lists so geometry from the
   * other ports needs no conversion. This adapter is the seam between them.
   */
  static from(shape: { readonly commands: readonly PathCommand[] }): Path {
    const p = new Path();
    for (const cmd of shape.commands) {
      switch (cmd.kind) {
        case 'MoveTo': p.moveTo(cmd.x, cmd.y); break;
        case 'LineTo': p.lineTo(cmd.x, cmd.y); break;
        case 'QuadTo': p.quadTo(cmd.cx, cmd.cy, cmd.x, cmd.y); break;
        case 'CubicTo': p.cubicTo(cmd.c1x, cmd.c1y, cmd.c2x, cmd.c2y, cmd.x, cmd.y); break;
        case 'Close': p.close(); break;
      }
    }
    return p;
  }
}
