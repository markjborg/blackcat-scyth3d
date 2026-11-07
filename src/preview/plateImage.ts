import { encodeRgbPng } from "./png.js";

export interface PlateBounds {
  xMm: number;
  yMm: number;
}

/** Top-down picture of extrusion moves, so a plate has a preview even when the slicer thumbnail is blank. */
export function renderPlatePreview(gcode: string, bed: PlateBounds, size = 480): Buffer {
  const width = size;
  const height = Math.max(64, Math.round(size * (bed.yMm / bed.xMm)));
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = 18;
    rgb[i + 1] = 20;
    rgb[i + 2] = 26;
  }
  const margin = 12;
  const scale = Math.min((width - margin * 2) / bed.xMm, (height - margin * 2) / bed.yMm);
  const ox = margin;
  const oy = height - margin;
  const plot = (x: number, y: number, z: number) => {
    const px = Math.round(ox + x * scale);
    const py = Math.round(oy - y * scale);
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const t = Math.max(0, Math.min(1, z / 40));
    const index = (py * width + px) * 3;
    rgb[index] = 80 + Math.round(150 * t);
    rgb[index + 1] = 70 + Math.round(90 * (1 - t));
    rgb[index + 2] = 40;
  };

  let x = 0;
  let y = 0;
  let z = 0;
  let e = 0;
  let absPos = true;
  let absE = true;
  let drawn = 0;
  for (const raw of gcode.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, "").trim();
    if (!line) continue;
    const word = line.split(/\s+/, 1)[0]?.toUpperCase() ?? "";
    if (word === "G90") absPos = true;
    else if (word === "G91") absPos = false;
    else if (word === "M82") absE = true;
    else if (word === "M83") absE = false;
    else if (word === "G0" || word === "G1" || word === "G00" || word === "G01") {
      let nx = x;
      let ny = y;
      let nz = z;
      let ne = e;
      let hasE = false;
      for (const match of line.matchAll(/([XYZE])\s*(-?\d*\.?\d+)/gi)) {
        const value = Number(match[2]);
        if (!Number.isFinite(value)) continue;
        const axis = match[1]?.toUpperCase();
        if (axis === "X") nx = absPos ? value : x + value;
        else if (axis === "Y") ny = absPos ? value : y + value;
        else if (axis === "Z") nz = absPos ? value : z + value;
        else if (axis === "E") {
          ne = absE ? value : e + value;
          hasE = true;
        }
      }
      const extruding = hasE && (absE ? ne > e + 1e-6 : ne > 1e-6);
      if (extruding && drawn < 250_000) {
        const steps = Math.max(1, Math.ceil(Math.hypot(nx - x, ny - y) * scale));
        for (let step = 0; step <= steps; step += 1) {
          const t = step / steps;
          plot(x + (nx - x) * t, y + (ny - y) * t, nz);
        }
        drawn += 1;
      }
      x = nx;
      y = ny;
      z = nz;
      if (hasE) e = ne;
    }
  }
  strokeRect(rgb, width, height, ox, oy, bed.xMm * scale, bed.yMm * scale);
  return encodeRgbPng(width, height, rgb);
}

function strokeRect(rgb: Uint8Array, width: number, height: number, x: number, y: number, w: number, h: number): void {
  const set = (px: number, py: number) => {
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const index = (py * width + px) * 3;
    rgb[index] = 224;
    rgb[index + 1] = 164;
    rgb[index + 2] = 74;
  };
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  const x1 = Math.round(x + w);
  const y1 = Math.round(y - h);
  for (let px = x0; px <= x1; px += 1) {
    set(px, y0);
    set(px, y1);
  }
  for (let py = y1; py <= y0; py += 1) {
    set(x0, py);
    set(x1, py);
  }
}
