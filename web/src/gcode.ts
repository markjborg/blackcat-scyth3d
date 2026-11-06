export interface ToolSegment {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
}

export interface Toolpath {
  layers: ToolSegment[][];
  truncated: boolean;
}

const MAX_SEGMENTS = 250_000;

/** Extrusion moves only, grouped by Z. Handles absolute and relative extrusion. */
export function parseToolpath(gcode: string): Toolpath {
  let x = 0;
  let y = 0;
  let z = 0;
  let e = 0;
  let absPos = true;
  let absE = true;
  const buckets = new Map<number, ToolSegment[]>();
  let count = 0;
  let truncated = false;

  for (const raw of gcode.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, "").trim();
    if (!line) continue;
    const word = line.split(/\s+/, 1)[0]?.toUpperCase() ?? "";
    if (word === "G90") absPos = true;
    else if (word === "G91") absPos = false;
    else if (word === "M82") absE = true;
    else if (word === "M83") absE = false;
    else if (word === "G0" || word === "G1" || word === "G00" || word === "G01") {
      if (count >= MAX_SEGMENTS) {
        truncated = true;
        break;
      }
      const next = { x, y, z, e, hasE: false };
      for (const match of line.matchAll(/([XYZE])\s*(-?\d*\.?\d+)/gi)) {
        const value = Number(match[2]);
        if (!Number.isFinite(value)) continue;
        const axis = match[1]?.toUpperCase();
        if (axis === "X") next.x = absPos ? value : x + value;
        else if (axis === "Y") next.y = absPos ? value : y + value;
        else if (axis === "Z") next.z = absPos ? value : z + value;
        else if (axis === "E") {
          next.e = absE ? value : e + value;
          next.hasE = true;
        }
      }
      const extruding = next.hasE && (absE ? next.e > e + 1e-6 : next.e > 1e-6);
      const moved = Math.hypot(next.x - x, next.y - y, next.z - z) > 1e-4;
      if (extruding && moved) {
        const key = Math.round(next.z * 100);
        const layer = buckets.get(key) ?? [];
        layer.push({ ax: x, ay: y, az: z, bx: next.x, by: next.y, bz: next.z });
        buckets.set(key, layer);
        count += 1;
      }
      x = next.x;
      y = next.y;
      z = next.z;
      if (next.hasE) e = next.e;
    }
  }

  const layers = [...buckets.keys()].sort((a, b) => a - b).map((key) => buckets.get(key) ?? []);
  return { layers, truncated };
}
