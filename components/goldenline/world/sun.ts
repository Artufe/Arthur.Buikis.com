import type { Vector3 } from 'three/webgpu';
import { SUN } from './layout';

const DEG = Math.PI / 180;

/** Unit vector toward the sun for an elevation/azimuth (degrees; azimuth 0 = out to sea (-X), + = toward +Z). */
export function sunDirection(out: Vector3, elevationDeg = SUN.elevationDeg, azimuthDeg = SUN.azimuthDeg) {
  const el = elevationDeg * DEG;
  const az = azimuthDeg * DEG;
  return out.set(-Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
}
