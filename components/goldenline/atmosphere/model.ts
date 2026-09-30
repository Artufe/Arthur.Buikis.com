// Physically based atmosphere, CPU side (Hillaire 2020, "A Scalable and Production Ready Sky and
// Atmosphere Rendering Technique"). Everything is baked once at boot and again only when the sun
// or the medium params change, so the GPU never pays for the ray marches:
//
// - transmittance LUT T(h, mu)                    (Bruneton parametrisation, 128x48)
// - multiple-scattering LUT Psi_ms(h, mu_s)       (Hillaire's isotropic 2nd-order + geometric series, 24x24)
// - sky-view LUTs, per view direction relative to the sun, with the PHASE FUNCTIONS FACTORED OUT:
//   rayleigh sum, mie sum and multi-scatter sum. The GPU applies the exact phase per pixel, so the
//   aureole around the sun stays sharp at any LUT resolution.
//
// Units: kilometres for the medium, radiance per unit solar irradiance (the GPU scales by
// `sunIntensity`). The scene near the camera (0-100 m) uses the analytic sea-level terms
// (`groundTerms`) for aerial perspective, which match the LUT at the horizon.

export const R_GROUND = 6360;
export const R_TOP = 6460;

export interface Medium {
  /** Rayleigh scattering at sea level (/km) per channel. */
  rayleigh: [number, number, number];
  rayleighH: number;
  /** Background continental/marine aerosol (/km). */
  mieScatter: number;
  mieAbsorb: number;
  mieH: number;
  /** Marine boundary-layer haze (/km at sea level) per channel, and its scale height. */
  haze: [number, number, number];
  hazeAbsorb: number;
  hazeH: number;
  ozone: [number, number, number];
  groundAlbedo: number;
}

export function defaultMedium(): Medium {
  return {
    rayleigh: [5.802e-3, 13.558e-3, 33.1e-3],
    rayleighH: 8,
    mieScatter: 3.996e-3,
    mieAbsorb: 0.444e-3,
    mieH: 1.2,
    haze: [0.1, 0.1, 0.1],
    hazeAbsorb: 0.004,
    hazeH: 0.5,
    ozone: [0.65e-3, 1.881e-3, 0.085e-3],
    groundAlbedo: 0.1,
  };
}

/** Set the haze layer from a density (/km, green) with a mild Angstrom falloff (exponent ~0.5). */
export function setHaze(m: Medium, density: number, scaleHeightKm: number) {
  m.haze[0] = density * 0.9;
  m.haze[1] = density;
  m.haze[2] = density * 1.12;
  m.hazeH = scaleHeightKm;
}

export const T_W = 128;
export const T_H = 48;
export const MS_N = 24;
export const SKY_W = 96; // azimuth (0..pi, sqrt-concentrated toward the sun)
export const SKY_H = 128; // latitude (-pi/2..pi/2, sqrt-concentrated toward the horizon)

export class AtmosphereModel {
  readonly medium: Medium = defaultMedium();
  readonly transmittance = new Float32Array(T_W * T_H * 3);
  readonly ms = new Float32Array(MS_N * MS_N * 3);
  /** RGBA float data for the three sky-view textures (A = rayleigh sum, B = mie sum, C = ms sum). */
  readonly skyR = new Float32Array(SKY_W * SKY_H * 4);
  readonly skyM = new Float32Array(SKY_W * SKY_H * 4);
  readonly skyMS = new Float32Array(SKY_W * SKY_H * 4);
  /** Camera altitude used for the sky-view bake (km). */
  viewH = 0.002;

  private readonly tmp3 = new Float32Array(3);
  private readonly tmpA = new Float32Array(3);
  // bake scratch (the bakes run on param changes; keep them allocation-free anyway)
  private readonly sExt = new Float32Array(3);
  private readonly sDens = new Float32Array(3);
  private readonly sTsun = new Float32Array(3);
  private readonly sMs = new Float32Array(3);
  private readonly sL = new Float32Array(3);
  private readonly sF = new Float32Array(3);
  private readonly sT = new Float32Array(3);
  private readonly sR = new Float32Array(3);
  private readonly sM = new Float32Array(3);

  // ── medium ──

  private density(h: number, out: Float32Array) {
    // out: [rayleigh, mie, haze] density multipliers; ozone handled separately.
    const m = this.medium;
    out[0] = Math.exp(-h / m.rayleighH);
    out[1] = Math.exp(-h / m.mieH);
    out[2] = Math.exp(-h / m.hazeH);
  }

  private ozone(h: number) {
    return Math.max(0, 1 - Math.abs(h - 25) / 15);
  }

  /** Extinction (/km) at altitude h into out[3]. */
  extinction(h: number, out: Float32Array) {
    const m = this.medium;
    const d = this.tmpA;
    this.density(h, d);
    const oz = this.ozone(h);
    const mie = (m.mieScatter + m.mieAbsorb) * d[1];
    for (let c = 0; c < 3; c++) {
      out[c] = m.rayleigh[c] * d[0] + mie + (m.haze[c] + m.hazeAbsorb) * d[2] + m.ozone[c] * oz;
    }
  }

  // ── transmittance LUT ──

  bakeTransmittance() {
    const H = Math.sqrt(R_TOP * R_TOP - R_GROUND * R_GROUND);
    const ext = this.tmp3;
    const STEPS = 48;
    for (let j = 0; j < T_H; j++) {
      const xr = (j + 0.5) / T_H;
      const rho = H * xr;
      const r = Math.sqrt(rho * rho + R_GROUND * R_GROUND);
      for (let i = 0; i < T_W; i++) {
        const xmu = (i + 0.5) / T_W;
        const dmin = R_TOP - r;
        const dmax = rho + H;
        const d = dmin + xmu * (dmax - dmin);
        const mu = d === 0 ? 1 : Math.max(-1, Math.min(1, (H * H - rho * rho - d * d) / (2 * r * d)));
        // integrate along the ray of length d
        let t0 = 0;
        let t1 = 0;
        let t2 = 0;
        const dt = d / STEPS;
        for (let s = 0; s < STEPS; s++) {
          const t = (s + 0.5) * dt;
          const hh = Math.sqrt(r * r + t * t + 2 * r * mu * t) - R_GROUND;
          this.extinction(Math.max(0, hh), ext);
          t0 += ext[0] * dt;
          t1 += ext[1] * dt;
          t2 += ext[2] * dt;
        }
        const k = (j * T_W + i) * 3;
        this.transmittance[k] = Math.exp(-t0);
        this.transmittance[k + 1] = Math.exp(-t1);
        this.transmittance[k + 2] = Math.exp(-t2);
      }
    }
  }

  /** Transmittance from altitude h (km) toward cos-zenith mu, to the top of the atmosphere. 0 if the ray hits the ground. */
  sampleTransmittance(h: number, mu: number, out: Float32Array) {
    const r = Math.max(R_GROUND + 1e-4, Math.min(R_TOP, R_GROUND + h));
    // ground intersection
    const disc = r * r * (mu * mu - 1) + R_GROUND * R_GROUND;
    if (mu < 0 && disc >= 0) {
      out[0] = out[1] = out[2] = 0;
      return out;
    }
    const H = Math.sqrt(R_TOP * R_TOP - R_GROUND * R_GROUND);
    const rho = Math.sqrt(Math.max(0, r * r - R_GROUND * R_GROUND));
    const discT = r * r * (mu * mu - 1) + R_TOP * R_TOP;
    const d = Math.max(0, -r * mu + Math.sqrt(Math.max(0, discT)));
    const dmin = R_TOP - r;
    const dmax = rho + H;
    const xmu = (d - dmin) / Math.max(1e-6, dmax - dmin);
    const xr = rho / H;
    // bilinear
    const fx = Math.max(0, Math.min(T_W - 1, xmu * T_W - 0.5));
    const fy = Math.max(0, Math.min(T_H - 1, xr * T_H - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(T_W - 1, x0 + 1);
    const y1 = Math.min(T_H - 1, y0 + 1);
    const ax = fx - x0;
    const ay = fy - y0;
    const T = this.transmittance;
    for (let c = 0; c < 3; c++) {
      const a = T[(y0 * T_W + x0) * 3 + c];
      const b = T[(y0 * T_W + x1) * 3 + c];
      const e = T[(y1 * T_W + x0) * 3 + c];
      const f = T[(y1 * T_W + x1) * 3 + c];
      out[c] = (a * (1 - ax) + b * ax) * (1 - ay) + (e * (1 - ax) + f * ax) * ay;
    }
    return out;
  }

  // ── multiple scattering LUT ──

  bakeMultiScatter() {
    const m = this.medium;
    const N_DIR = 64;
    const STEPS = 20;
    const ext = this.sExt;
    const dens = this.sDens;
    const tsun = this.sTsun;
    const L = this.sL;
    const F = this.sF;
    const T = this.sT;
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let j = 0; j < MS_N; j++) {
      const h = Math.max(0.001, ((j + 0.5) / MS_N) * (R_TOP - R_GROUND));
      const r0 = R_GROUND + h;
      for (let i = 0; i < MS_N; i++) {
        const muS = ((i + 0.5) / MS_N) * 2 - 1;
        const sx = Math.sqrt(1 - muS * muS);
        const sy = muS;
        L[0] = L[1] = L[2] = 0;
        F[0] = F[1] = F[2] = 0;
        for (let k = 0; k < N_DIR; k++) {
          const dy = 1 - (2 * (k + 0.5)) / N_DIR;
          const rad = Math.sqrt(1 - dy * dy);
          const phi = golden * k;
          const dx = Math.cos(phi) * rad;
          const dz = Math.sin(phi) * rad;
          // ray from (0, r0, 0) along (dx, dy, dz)
          const b = r0 * dy;
          const cG = r0 * r0 - R_GROUND * R_GROUND;
          const discG = b * b - cG;
          let tMax: number;
          let hitGround = false;
          if (discG >= 0 && -b - Math.sqrt(discG) > 0) {
            tMax = -b - Math.sqrt(discG);
            hitGround = true;
          } else {
            tMax = -b + Math.sqrt(b * b - (r0 * r0 - R_TOP * R_TOP));
          }
          T[0] = T[1] = T[2] = 1;
          const dt = tMax / STEPS;
          for (let s = 0; s < STEPS; s++) {
            const t = (s + 0.5) * dt;
            const px = dx * t;
            const py = r0 + dy * t;
            const pz = dz * t;
            const pr = Math.sqrt(px * px + py * py + pz * pz);
            const hh = Math.max(0, pr - R_GROUND);
            this.extinction(hh, ext);
            this.density(hh, dens);
            const mu = (px * sx + py * sy) / pr;
            this.sampleTransmittance(hh, mu, tsun);
            for (let c = 0; c < 3; c++) {
              const scat = m.rayleigh[c] * dens[0] + m.mieScatter * dens[1] + m.haze[c] * dens[2];
              const stepT = Math.exp(-ext[c] * dt);
              const integ = (1 - stepT) / Math.max(1e-9, ext[c]);
              L[c] += T[c] * scat * tsun[c] * integ * (1 / (4 * Math.PI));
              F[c] += T[c] * scat * integ;
              T[c] *= stepT;
            }
          }
          if (hitGround) {
            const px = dx * tMax;
            const py = r0 + dy * tMax;
            const pz = dz * tMax;
            const pr = Math.sqrt(px * px + py * py + pz * pz);
            const mu = (px * sx + py * sy) / pr;
            this.sampleTransmittance(0, mu, tsun);
            const ndl = Math.max(0, mu);
            for (let c = 0; c < 3; c++) L[c] += T[c] * tsun[c] * ndl * (m.groundAlbedo / Math.PI);
          }
        }
        const o = (j * MS_N + i) * 3;
        for (let c = 0; c < 3; c++) {
          // Monte Carlo over the sphere with the isotropic phase: both integrals reduce to means.
          const l2 = L[c] / N_DIR;
          const fms = F[c] / N_DIR;
          this.ms[o + c] = l2 / Math.max(1e-4, 1 - Math.min(0.99, fms));
        }
      }
    }
  }

  sampleMS(h: number, muS: number, out: Float32Array) {
    const fx = Math.max(0, Math.min(MS_N - 1, ((muS + 1) / 2) * MS_N - 0.5));
    const fy = Math.max(0, Math.min(MS_N - 1, (h / (R_TOP - R_GROUND)) * MS_N - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(MS_N - 1, x0 + 1);
    const y1 = Math.min(MS_N - 1, y0 + 1);
    const ax = fx - x0;
    const ay = fy - y0;
    const M = this.ms;
    for (let c = 0; c < 3; c++) {
      const a = M[(y0 * MS_N + x0) * 3 + c];
      const b = M[(y0 * MS_N + x1) * 3 + c];
      const e = M[(y1 * MS_N + x0) * 3 + c];
      const f = M[(y1 * MS_N + x1) * 3 + c];
      out[c] = (a * (1 - ax) + b * ax) * (1 - ay) + (e * (1 - ax) + f * ax) * ay;
    }
    return out;
  }

  // ── sky-view LUTs ──

  /** Sun elevation (rad). Azimuth doesn't matter: the LUT is relative to the sun. */
  bakeSkyView(sunElevation: number) {
    const m = this.medium;
    const STEPS = 40;
    const sx = Math.cos(sunElevation);
    const sy = Math.sin(sunElevation);
    const r0 = R_GROUND + this.viewH;
    const ext = this.sExt;
    const dens = this.sDens;
    const tsun = this.sTsun;
    const ms = this.sMs;
    const T = this.sT;
    const SR = this.sR;
    const SM = this.sM;
    const SS = this.sL;
    for (let j = 0; j < SKY_H; j++) {
      const v = (j + 0.5) / SKY_H;
      const lat = skyViewLatitude(v);
      for (let i = 0; i < SKY_W; i++) {
        const u = (i + 0.5) / SKY_W;
        const az = u * u * Math.PI;
        const dx = Math.cos(lat) * Math.cos(az);
        const dy = Math.sin(lat);
        const dz = Math.cos(lat) * Math.sin(az);
        const b = r0 * dy;
        const discG = b * b - (r0 * r0 - R_GROUND * R_GROUND);
        let tMax: number;
        if (discG >= 0 && -b - Math.sqrt(discG) > 0) tMax = -b - Math.sqrt(discG);
        else tMax = -b + Math.sqrt(b * b - (r0 * r0 - R_TOP * R_TOP));
        T[0] = T[1] = T[2] = 1;
        SR[0] = SR[1] = SR[2] = 0;
        SM[0] = SM[1] = SM[2] = 0;
        SS[0] = SS[1] = SS[2] = 0;
        let tPrev = 0;
        for (let s = 0; s < STEPS; s++) {
          // quadratic distribution: dense near the camera, where the haze lives
          const f = (s + 1) / STEPS;
          const tNew = tMax * f * f;
          const dt = tNew - tPrev;
          const t = tPrev + dt * 0.5;
          tPrev = tNew;
          const px = dx * t;
          const py = r0 + dy * t;
          const pz = dz * t;
          const pr = Math.sqrt(px * px + py * py + pz * pz);
          const hh = Math.max(0, pr - R_GROUND);
          this.extinction(hh, ext);
          this.density(hh, dens);
          const mu = (px * sx + py * sy) / pr;
          this.sampleTransmittance(hh, mu, tsun);
          this.sampleMS(hh, mu, ms);
          for (let c = 0; c < 3; c++) {
            const sr = m.rayleigh[c] * dens[0];
            const sm = m.mieScatter * dens[1] + m.haze[c] * dens[2];
            const stepT = Math.exp(-ext[c] * dt);
            const integ = (T[c] * (1 - stepT)) / Math.max(1e-9, ext[c]);
            SR[c] += sr * tsun[c] * integ;
            SM[c] += sm * tsun[c] * integ;
            SS[c] += (sr + sm) * ms[c] * integ;
            T[c] *= stepT;
          }
        }
        const o = (j * SKY_W + i) * 4;
        for (let c = 0; c < 3; c++) {
          this.skyR[o + c] = SR[c];
          this.skyM[o + c] = SM[c];
          this.skyMS[o + c] = SS[c];
        }
        this.skyR[o + 3] = 1;
        this.skyM[o + 3] = 1;
        this.skyMS[o + 3] = 1;
      }
    }
  }

  /**
   * The sea-level terms for the analytic aerial perspective near the camera: sun transmittance at
   * the ground and the multi-scatter source there. Writes into the given arrays.
   */
  groundTerms(sunElevation: number, sunT: Float32Array, msOut: Float32Array) {
    this.sampleTransmittance(this.viewH, Math.sin(sunElevation), sunT);
    this.sampleMS(this.viewH, Math.sin(sunElevation), msOut);
  }

  /** Sun transmittance at altitude h (km), for cloud lighting. */
  sunTransmittanceAt(h: number, sunElevation: number, out: Float32Array) {
    return this.sampleTransmittance(h, Math.sin(sunElevation), out);
  }
}

/** Latitude (rad) for a sky-view v coordinate. Matches the GPU mapping in sky.ts. */
export function skyViewLatitude(v: number) {
  const x = v * 2 - 1;
  return Math.sign(x) * x * x * (Math.PI / 2);
}
