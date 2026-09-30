// Placeholder services installed before any system runs, so every system can code against
// the full contract from day one. Each owner replaces its slot in init().

import { Color, DirectionalLight, Vector2, Vector3 } from 'three/webgpu';
import { float, mix, smoothstep, uniform, vec2, vec3, vec4 } from 'three/tsl';
import type {
  AtmosphereService,
  GLContext,
  OceanSample,
  OceanService,
  PierService,
  PlayerService,
  PostService,
  SurfaceStateService,
  TSLNode,
  WaveInfo,
} from './contracts';
import { PIER, SWELL } from '../world/layout';
import { sunDirection } from '../world/sun';

export function stubAtmosphere(): AtmosphereService {
  const sunDir = sunDirection(new Vector3());
  const sunColor = new Color(1.0, 0.72, 0.45);
  const sunLight = new DirectionalLight(sunColor, 3);
  const sunDirNode = uniform(sunDir);
  const sunColorNode = uniform(sunColor);
  const horizon = vec3(1.0, 0.62, 0.38);
  const zenith = vec3(0.18, 0.3, 0.55);
  return {
    sunDir,
    sunColor,
    sunLight,
    sunDirNode,
    sunColorNode,
    applyFog: (color: TSLNode, worldPos: TSLNode) => {
      const d = worldPos.xz.length();
      return mix(color, horizon.mul(0.9), smoothstep(float(150), float(1800), d).mul(0.8));
    },
    skyRadiance: (dir: TSLNode) => mix(horizon, zenith, dir.y.max(0).pow(0.5)),
    envTexture: null,
  };
}

export function stubOcean(): OceanService {
  return {
    sample(_x: number, _z: number, out: OceanSample) {
      out.height = 0;
      out.nx = 0;
      out.ny = 1;
      out.nz = 0;
      out.vx = 0;
      out.vy = 0;
      out.vz = 0;
      out.breaking = 0;
      out.depth = 2;
      return out;
    },
    wave(_x: number, _z: number, out: WaveInfo) {
      out.stage = 0;
      out.dirX = SWELL.dirX;
      out.dirZ = SWELL.dirZ;
      out.peelX = 0;
      out.peelZ = 1;
      out.peelSpeed = 0;
      out.crestDistance = 1e9;
      out.faceHeight = 0;
      out.hollowness = 0;
      return out;
    },
    swellDir: new Vector2(SWELL.dirX, SWELL.dirZ),
    gpu: {},
  };
}

export function stubState(): SurfaceStateService {
  return {
    splat() {},
    foam: () => vec2(0, 0),
    wake: () => vec4(0, 0, 0, 0),
    sand: () => vec4(0, 0, 0, 0),
    center: new Vector2(),
    size: 100,
  };
}

export function stubPlayer(ctx: GLContext): PlayerService {
  const p: PlayerService = {
    mode: 'walk',
    eye: new Vector3(),
    velocity: new Vector3(),
    yaw: 0,
    pitch: 0,
    boardPosition: new Vector3(),
    boardYaw: 0,
    teleport(x, z, yaw, mode) {
      p.eye.set(x, ctx.services.terrain.height(x, z) + 1.7, z);
      p.yaw = yaw;
      if (mode) p.mode = mode;
    },
  };
  return p;
}

export function stubPier(): PierService {
  const n = Math.floor((PIER.rootX - PIER.tipX) / PIER.pilingSpacing) + 1;
  const pilings = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const x = PIER.rootX - i * PIER.pilingSpacing;
    pilings[i * 4] = x;
    pilings[i * 4 + 1] = PIER.z - PIER.width / 2 + 0.1;
    pilings[i * 4 + 2] = x;
    pilings[i * 4 + 3] = PIER.z + PIER.width / 2 - 0.1;
  }
  const half = PIER.width / 2 - 0.35;
  return {
    surfaceAt(x, z, y) {
      if (x > PIER.rootX || x < PIER.tipX || Math.abs(z - PIER.z) > PIER.width / 2) return NaN;
      return y > PIER.deckHeight - 1 ? PIER.deckHeight : NaN;
    },
    clampToDeck(x, z, y, out) {
      out[0] = x;
      out[1] = z;
      if (y < PIER.deckHeight - 0.5 || x > PIER.rootX || x < PIER.tipX) return;
      out[1] = Math.min(PIER.z + half, Math.max(PIER.z - half, z));
    },
    pilings,
    pilingRadius: 0.17,
  };
}

export function stubPost(): PostService {
  return {
    render(ctx) {
      ctx.renderer.render(ctx.scene, ctx.camera);
    },
    rebuild() {},
  };
}
