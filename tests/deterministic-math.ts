// Vitest setup: the same Math results on every machine.
//
// V8's Math.sin, cos, tan, asin, acos, atan, atan2, exp, log, pow (and log10, log1p, expm1, sinh,
// cosh, asinh, acosh, atanh) differ in the last bits between x86-64 and arm64, and pow between
// Node majors on one machine. (sqrt, hypot, cbrt, tanh, log2 and plain arithmetic agree.) The
// LITTLEBIG traffic and people sims are chaotic: one last-bit difference sends them down another
// path within minutes of sim time, so a long spec that passed on an arm64 Mac could fail on CI's
// x86-64 runners, and the other way round, with nothing to reproduce locally. Every spec therefore
// runs on these replacements, which use only + − × ÷ and sqrt (correctly rounded on every IEEE 754
// machine, and JS never fuses a multiply-add), so a spec computes the same numbers everywhere.
// They are Cephes' double-precision algorithms (S. L. Moshier), accurate to a few ulp. The game
// itself keeps the native functions: this file only runs under vitest (vitest.config.mts setupFiles).

type MathFn = (...a: number[]) => number;
const KEY = Symbol.for('lb.nativeMath');
const host = globalThis as unknown as Record<symbol, Record<string, MathFn> | undefined>;
/** The engine's own functions, captured before the first install (tests compare against them). */
export const nativeMath: Record<string, MathFn> = (host[KEY] ??= Object.fromEntries(
  ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'exp', 'log', 'pow', 'log10', 'log1p', 'expm1', 'sinh', 'cosh', 'asinh', 'acosh', 'atanh'].map((k) => [k, (Math as unknown as Record<string, MathFn>)[k]]),
));

const PI = 3.14159265358979323846;
const PIO2 = 1.57079632679489661923;
const PIO4 = 7.85398163397448309616e-1;
const MOREBITS = 6.123233995736765886130e-17;

const polevl = (x: number, c: readonly number[]) => {
  let a = c[0];
  for (let i = 1; i < c.length; i++) a = a * x + c[i];
  return a;
};
/** polevl with an implied leading coefficient of 1. */
const p1evl = (x: number, c: readonly number[]) => {
  let a = x + c[0];
  for (let i = 1; i < c.length; i++) a = a * x + c[i];
  return a;
};

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
const HI = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0; // the high word's index
/** 2^n exactly, for −1022 ≤ n ≤ 1023. */
function pow2(n: number): number {
  u32[HI] = (n + 1023) << 20;
  u32[1 - HI] = 0;
  return f64[0];
}
/** x · 2^n (exact unless it under- or overflows). */
function ldexp(x: number, n: number): number {
  while (n > 1023) (x *= pow2(1023)), (n -= 1023);
  while (n < -1022) (x *= pow2(-1022)), (n += 1022);
  return x * pow2(n);
}
/** x = m · 2^e with m in [0.5, 1) (x finite, > 0). */
function frexp(x: number): [number, number] {
  let e = 0;
  if (x < 2.2250738585072014e-308) (x *= pow2(54)), (e = -54);
  f64[0] = x;
  const hi = u32[HI];
  e += ((hi >>> 20) & 0x7ff) - 1022;
  u32[HI] = (hi & 0x800fffff) | (1022 << 20);
  return [f64[0], e];
}

// ── sin, cos, tan (Cephes sin.c) ──
const SINCOF = [1.5896230157654656806e-10, -2.50507477628578072866e-8, 2.75573136213857245213e-6, -1.98412698295895385996e-4, 8.33333333332211858878e-3, -1.66666666666666307295e-1];
const COSCOF = [-1.135853652138768173e-11, 2.08757008419747316778e-9, -2.75573141792967388112e-7, 2.48015872888517045348e-5, -1.38888888888730564116e-3, 4.16666666666665929218e-2];
const DP1 = 7.85398125648498535156e-1;
const DP2 = 3.77489470793079817668e-8;
const DP3 = 2.69515142907905952645e-15;

/** Octant reduction: [z, j] with x = (y·π/4) + z, j = y mod 8 made even. */
function reduce(x: number): [number, number] {
  let y = Math.floor(x / PIO4);
  let j = y % 8;
  if (j % 2 === 1) (j += 1), (y += 1);
  return [((x - y * DP1) - y * DP2) - y * DP3, j % 8];
}

function sin(x: number): number {
  if (x === 0 || x !== x) return x;
  if (x === Infinity || x === -Infinity) return NaN;
  let sign = 1;
  if (x < 0) (x = -x), (sign = -1);
  let [z, j] = reduce(x);
  if (j > 3) (sign = -sign), (j -= 4);
  const zz = z * z;
  const y = j === 1 || j === 2 ? 1 - 0.5 * zz + zz * zz * polevl(zz, COSCOF) : z + z * (zz * polevl(zz, SINCOF));
  return sign < 0 ? -y : y;
}

function cos(x: number): number {
  if (x !== x || x === Infinity || x === -Infinity) return NaN;
  if (x < 0) x = -x;
  let [z, j] = reduce(x);
  let sign = 1;
  if (j > 3) (j -= 4), (sign = -sign);
  if (j > 1) sign = -sign;
  const zz = z * z;
  const y = j === 1 || j === 2 ? z + z * (zz * polevl(zz, SINCOF)) : 1 - 0.5 * zz + zz * zz * polevl(zz, COSCOF);
  return sign < 0 ? -y : y;
}

const tan = (x: number) => (x === 0 || x !== x ? x : sin(x) / cos(x));

// ── atan, atan2 (Cephes atan.c) ──
const ATP = [-8.750608600031904122785e-1, -1.615753718733365076637e1, -7.500855792314704667340e1, -1.228866684490136173410e2, -6.485021904942025371773e1];
const ATQ = [2.485846490142306297962e1, 1.650270098316988542046e2, 4.328810604912902668951e2, 4.853903996359136964868e2, 1.945506571482613964425e2];
const T3P8 = 2.41421356237309504880;

function atan(x: number): number {
  if (x === 0 || x !== x) return x;
  if (x === Infinity) return PIO2;
  if (x === -Infinity) return -PIO2;
  let sign = 1;
  if (x < 0) (sign = -1), (x = -x);
  let y: number;
  let flag = 0;
  if (x > T3P8) (y = PIO2), (flag = 1), (x = -1 / x);
  else if (x <= 0.66) y = 0;
  else (y = PIO4), (flag = 2), (x = (x - 1) / (x + 1));
  let z = x * x;
  z = (z * polevl(z, ATP)) / p1evl(z, ATQ);
  z = x * z + x;
  if (flag === 2) z += 0.5 * MOREBITS;
  else if (flag === 1) z += MOREBITS;
  y = y + z;
  return sign < 0 ? -y : y;
}

function atan2(y: number, x: number): number {
  // zeros, infinities, NaN: the engine's exact special values (constants, the same everywhere)
  if (y === 0 || x === 0 || y !== y || x !== x || !Number.isFinite(x) || !Number.isFinite(y)) return nativeMath.atan2(y, x);
  const w = x < 0 ? (y < 0 ? -PI : PI) : 0;
  const z = w + atan(y / x);
  return z === 0 && y < 0 ? -0 : z;
}

// ── asin, acos (Cephes asin.c) ──
const ASP = [4.253011369004428248960e-3, -6.019598008014123785661e-1, 5.444622390564711410273, -1.626247967210700244449e1, 1.956261983317594739197e1, -8.198089802484824371615];
const ASQ = [-1.474091372988853791896e1, 7.049610280856842141659e1, -1.471791292232726029859e2, 1.395105614657485689735e2, -4.918853881490881290097e1];
const ASR = [2.967721961301243206100e-3, -5.634242780008963776856e-1, 6.968710824104713396794, -2.556901049652824852289e1, 2.853665548261061424989e1];
const ASS = [-2.194779531642920639778e1, 1.470656354026814941758e2, -3.838770957603691357202e2, 3.424398657913078477438e2];

function asin(x: number): number {
  if (x !== x) return x;
  let sign = 1;
  let a = x;
  if (a < 0) (sign = -1), (a = -a);
  if (a > 1) return NaN;
  let z: number;
  if (a > 0.625) {
    let zz = 1 - a;
    const p = (zz * polevl(zz, ASR)) / p1evl(zz, ASS);
    zz = Math.sqrt(zz + zz);
    z = PIO4 - zz;
    zz = zz * p - MOREBITS;
    z = z - zz;
    z = z + PIO4;
  } else {
    if (a < 1e-8) return x;
    const zz = a * a;
    z = (zz * polevl(zz, ASP)) / p1evl(zz, ASQ);
    z = a * z + a;
  }
  return sign < 0 ? -z : z;
}

function acos(x: number): number {
  if (x !== x || x < -1 || x > 1) return NaN;
  if (x > 0.5) return 2 * asin(Math.sqrt(0.5 - 0.5 * x));
  let z = PIO4 - asin(x);
  z = z + MOREBITS;
  return z + PIO4;
}

// ── exp (Cephes exp.c) ──
const EXP_P = [1.26177193074810590878e-4, 3.02994407707441961300e-2, 9.99999999999999999910e-1];
const EXP_Q = [3.00198505138664455042e-6, 2.52448340349684104192e-3, 2.27265548208155028766e-1, 2.00000000000000000009];
const LOG2E = 1.4426950408889634073599;

function exp(x: number): number {
  if (x !== x || x === Infinity) return x;
  if (x === -Infinity) return 0;
  if (x > 709.782712893384) return Infinity;
  if (x < -745.1332191019412) return 0;
  const n = Math.floor(LOG2E * x + 0.5);
  x -= n * 6.93145751953125e-1;
  x -= n * 1.42860682030941723212e-6;
  const xx = x * x;
  const px = x * polevl(xx, EXP_P);
  x = px / (polevl(xx, EXP_Q) - px);
  return ldexp(1 + 2 * x, n);
}

// ── log (Cephes log.c) ──
const LOG_P = [1.01875663804580931796e-4, 4.97494994976747001425e-1, 4.70579119878881725854, 1.44989225341610930846e1, 1.79368678507819816313e1, 7.70838733755885391666];
const LOG_Q = [1.12873587189167450590e1, 4.52279145837532221105e1, 8.29875266912776603211e1, 7.11544750618563894466e1, 2.31251620126765340583e1];
const LOG_R = [-7.89580278884799154124e-1, 1.63866645699558079767e1, -6.41409952958715622951e1];
const LOG_S = [-3.56722798256324312549e1, 3.12093766372244180303e2, -7.69691943550460008604e2];
const SQRTH = 0.70710678118654752440;

function log(x: number): number {
  if (x !== x || x === Infinity) return x;
  if (x <= 0) return x === 0 ? -Infinity : NaN;
  let [m, e] = frexp(x);
  let y: number;
  let z: number;
  if (e > 2 || e < -2) {
    if (m < SQRTH) (e -= 1), (z = m - 0.5), (y = 0.5 * z + 0.5);
    else (z = m - 0.5), (z -= 0.5), (y = 0.5 * m + 0.5);
    m = z / y;
    z = m * m;
    z = m * ((z * polevl(z, LOG_R)) / p1evl(z, LOG_S));
    z = z - e * 2.121944400546905827679e-4;
    z = z + m;
    return z + e * 0.693359375;
  }
  if (m < SQRTH) (e -= 1), (m = 2 * m - 1);
  else m = m - 1;
  z = m * m;
  y = m * ((z * polevl(m, LOG_P)) / p1evl(m, LOG_Q));
  if (e !== 0) y = y - e * 2.121944400546905827679e-4;
  y = y - 0.5 * z;
  z = m + y;
  if (e !== 0) z = z + e * 0.693359375;
  return z;
}

// ── pow and the rest, from the above ──
function pow(x: number, y: number): number {
  // zeros, ones, infinities, NaN: the engine's exact special values
  if (y === 0 || x === 0 || x === 1 || x !== x || y !== y || !Number.isFinite(x) || !Number.isFinite(y)) return nativeMath.pow(x, y);
  if (y === 1) return x;
  if (Number.isInteger(y) && Math.abs(y) <= 2 ** 31) {
    let n = Math.abs(y);
    let b = x;
    let r = 1;
    while (n > 0) {
      if (n % 2 === 1) r *= b;
      n = Math.floor(n / 2);
      if (n > 0) b *= b;
    }
    return y < 0 ? 1 / r : r;
  }
  if (x < 0) return NaN;
  if (y === 0.5) return Math.sqrt(x);
  return exp(y * log(x));
}

const LN10 = 2.302585092994045684;
function log10(x: number): number {
  const r = log(x) / LN10;
  const k = Math.round(r);
  return Number.isFinite(r) && Math.abs(r - k) < 1e-9 && pow(10, k) === x ? k : r;
}
function log1p(x: number): number {
  if (x === 0 || x !== x || x === Infinity) return x;
  const u = 1 + x;
  return u === 1 ? x : (log(u) * x) / (u - 1);
}
function expm1(x: number): number {
  if (x === 0 || x !== x || x === Infinity) return x;
  if (x === -Infinity) return -1;
  const u = exp(x);
  if (u === 1) return x;
  const um1 = u - 1;
  return um1 === -1 ? -1 : u === Infinity ? Infinity : (um1 * x) / log(u);
}
const sinh = (x: number) => (x === 0 || x !== x ? x : Math.abs(x) < 1e-5 ? x + (x * x * x) / 6 : (expm1(x) - expm1(-x)) / 2);
const cosh = (x: number) => (exp(x) + exp(-x)) / 2;
const asinh = (x: number): number => (x === 0 || x !== x || !Number.isFinite(x) ? x : x < 0 ? -asinh(-x) : log1p(x + (x * x) / (1 + Math.sqrt(1 + x * x))));
const acosh = (x: number) => (x < 1 || x !== x ? NaN : log(x + Math.sqrt(x * x - 1)));
const atanh = (x: number) => (x === 0 || x !== x ? x : 0.5 * log1p((2 * x) / (1 - x)));

export const deterministicMath: Record<string, MathFn> = { sin, cos, tan, asin, acos, atan, atan2, exp, log, pow, log10, log1p, expm1, sinh, cosh, asinh, acosh, atanh };

/** Runs `fn` on the engine's own functions: for a spec timing what the game will pay. */
export function withNativeMath<T>(fn: () => T): T {
  Object.assign(Math, nativeMath);
  try {
    return fn();
  } finally {
    Object.assign(Math, deterministicMath);
  }
}

Object.assign(Math, deterministicMath);
