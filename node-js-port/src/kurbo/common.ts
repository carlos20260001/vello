/**
 * `kurbo::common` — the floating-point helpers and tolerance predicates.
 *
 * Upstream this module exists because `core` has no `f64` math: kurbo either
 * takes the functions from `std` or from `libm`, selected by feature flags. In
 * TypeScript there is no such split — `Math` is always there — so the port
 * keeps only the parts a caller actually reaches for, and keeps the names so
 * that porting a call site stays mechanical.
 *
 * Two deviations worth knowing about, because they change results:
 *
 * 1. `round` is **not** `Math.round`. `Math.round` rounds halves towards +∞
 *    (`Math.round(-2.5) === -2`), while Rust's `f64::round` rounds halves away
 *    from zero (`(-2.5).round() === -3.0`). Anything that rounds a coordinate
 *    in the negative half-plane would differ.
 * 2. `mul_add` is `a * b + c`. Rust's is a fused multiply-add, which rounds
 *    once instead of twice; JS has no `Math.fma`, so the port cannot match it
 *    bit for bit.
 */

/** `vello_common::math::SCALAR_NEARLY_ZERO`: 1/4096, the "is this zero" tolerance. */
export const SCALAR_NEARLY_ZERO: number = 1 / (1 << 12);

/**
 * `f64::signum`: ±1, never 0.
 *
 * `Math.sign` returns 0 for both zeroes, which is not what the Rust callers
 * that use `signum` as a copysign helper expect.
 */
export function signum(x: number): number {
  return x < 0 || (x === 0 && 1 / x < 0) ? -1 : 1;
}

/** `f64::copysign`: the magnitude of `x` with the sign of `y`. */
export function copysign(x: number, y: number): number {
  return Math.abs(x) * signum(y);
}

/** `f64::rem_euclid`, not the `%` operator, which takes the sign of the dividend. */
export function rem_euclid(x: number, y: number): number {
  const r = x % y;
  return r < 0 ? r + Math.abs(y) : r;
}

/**
 * `FloatExt::expand`: round away from zero, unless already an integer.
 *
 * To `ceil` what `trunc` is to `floor`: `-3.7` becomes `-4`.
 */
export function expand(x: number): number {
  const a = Math.ceil(Math.abs(x));
  return x < 0 ? -a : a;
}

/**
 * The `FloatFuncs` trait, as a value.
 *
 * Kurbo's trait is sealed and implemented for `f32` and `f64` so that `no_std`
 * builds can pull their math from `libm`. TypeScript has neither problem, so
 * this is a plain namespace of the same functions; the `FloatFuncs.` prefix is
 * kept at call sites to make the provenance obvious when comparing against
 * upstream.
 */
export const FloatFuncs = {
  abs: Math.abs,
  acos: Math.acos,
  atan2: Math.atan2,
  cbrt: Math.cbrt,
  ceil: Math.ceil,
  copysign,
  cos: Math.cos,
  floor: Math.floor,
  hypot: Math.hypot,
  ln: Math.log,
  log2: Math.log2,
  mul_add: (x: number, a: number, b: number): number => x * a + b,
  powi: (x: number, n: number): number => Math.pow(x, n),
  powf: Math.pow,
  rem_euclid,
  round: (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x)),
  signum,
  sin: Math.sin,
  sin_cos: (x: number): [number, number] => [Math.sin(x), Math.cos(x)],
  sqrt: Math.sqrt,
  tan: Math.tan,
  trunc: Math.trunc,
} as const;

/** Whether `x` is approximately zero, within `SCALAR_NEARLY_ZERO`. */
export function is_nearly_zero(x: number): boolean {
  return is_nearly_zero_within_tolerance(x, SCALAR_NEARLY_ZERO);
}

/** Whether `x` is approximately zero, within an explicit tolerance. */
export function is_nearly_zero_within_tolerance(x: number, tolerance: number): boolean {
  // Upstream debug-asserts a non-negative tolerance; a negative tolerance
  // makes every number "nearly zero", which is never what a caller means.
  if (tolerance < 0) throw new Error(`tolerance must be positive, got ${tolerance}`);
  return Math.abs(x) <= tolerance;
}
