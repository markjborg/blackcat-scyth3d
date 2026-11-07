export interface Normal {
  x: number;
  y: number;
  z: number;
}

/** Largest face normal. Near-ties prefer the normal already closest to straight down. */
export function dominantFaceNormal(positions: ArrayLike<number>): Normal | null {
  let bestArea = 0;
  let best: Normal | null = null;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const ax = positions[i] ?? 0;
    const ay = positions[i + 1] ?? 0;
    const az = positions[i + 2] ?? 0;
    const bx = positions[i + 3] ?? 0;
    const by = positions[i + 4] ?? 0;
    const bz = positions[i + 5] ?? 0;
    const cx = positions[i + 6] ?? 0;
    const cy = positions[i + 7] ?? 0;
    const cz = positions[i + 8] ?? 0;
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-8) continue;
    const area = length * 0.5;
    const normal = { x: nx / length, y: ny / length, z: nz / length };
    if (!best || area > bestArea * 1.01 || (area >= bestArea * 0.99 && normal.z < best.z)) {
      best = normal;
      bestArea = area;
    }
  }
  return best;
}
