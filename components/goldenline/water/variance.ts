// Slope variance each FFT cascade loses to its own mip chain, per mip level. The derivative
// textures are box-filtered down the chain, so a distant pixel sees the *mean* slope of its
// footprint and the facet spread inside it disappears. Adding that lost variance back into the
// sun lobe's roughness (Toksvig/LEAN style) is what keeps the glitter path stable: the lobe widens
// exactly as fast as the resolved normals smooth out, so nothing sparkles in and out under TAA.
//
// Computed on the CPU from the uploaded h0(k): each 2×2 box step of the mip chain multiplies a
// mode's response by cos(kx·Δ/2)·cos(kz·Δ/2) (Δ = texel size at that level).

import { CASCADES, FFT_N, N_CASCADES } from '../ocean/spectrum';

/** Levels 0..8 of the 256² chain, then the cascade total at index 9. */
export const VAR_LEVELS = 10;

/**
 * out[l * 4 + c] = slope variance (E[sx² + sz²]) of cascade c that mip level l has filtered away.
 * `resp` is scratch of (VAR_LEVELS − 1) · FFT_N doubles. Runs at boot and after a spectrum rebake.
 */
export function slopeVarianceTable(h0: Float32Array, out: Float32Array, resp: Float64Array) {
  const N = FFT_N;
  const levels = VAR_LEVELS - 1;
  for (let c = 0; c < N_CASCADES; c++) {
    const L = CASCADES[c].L;
    const dk = (2 * Math.PI) / L;
    const texel = L / N;
    // Separable box-chain responses (same grid on both axes): resp[l·N + n] = Π_{j<l} cos(k_n·Δ·2^j/2).
    for (let n = 0; n < N; n++) {
      const k = (n - N / 2) * dk;
      let r = 1;
      for (let l = 0; l < levels; l++) {
        resp[l * N + n] = r;
        r *= Math.cos((k * texel * (1 << l)) / 2);
      }
    }
    const base = c * N * N;
    let total = 0;
    const kept = new Float64Array(levels);
    for (let m = 0; m < N; m++) {
      const kz = (m - N / 2) * dk;
      for (let n = 0; n < N; n++) {
        const i = m * N + n;
        const o = (base + i) * 4;
        const hr = h0[o];
        const hi = h0[o + 1];
        const e = hr * hr + hi * hi;
        if (e === 0) continue;
        const kx = (n - N / 2) * dk;
        // A mode h0(k) contributes |h0|² at k and again (conjugated) at −k: 2|h0|² of height variance.
        const s = 2 * e * (kx * kx + kz * kz);
        total += s;
        for (let l = 0; l < levels; l++) {
          const hresp = resp[l * N + n] * resp[l * N + m];
          kept[l] += s * hresp * hresp;
        }
      }
    }
    for (let l = 0; l < levels; l++) out[l * 4 + c] = Math.max(0, total - kept[l]);
    out[levels * 4 + c] = total;
  }
}

