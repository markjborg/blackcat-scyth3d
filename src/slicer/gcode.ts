export interface GcodeStats {
  filamentGrams: number | null;
  filamentVolumeCm3: number | null;
  filamentLengthMm: number | null;
  printTimeSeconds: number | null;
  printTimeText: string | null;
  modelPrintTimeText: string | null;
  layerCount: number | null;
}

export interface ModelInfo {
  sizeMm: { x: number; y: number; z: number } | null;
  boundingBoxMm: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null;
  volumeMm3: number | null;
  manifold: boolean | null;
  facetCount: number | null;
}

export function parseGcodeStats(gcode: string): GcodeStats {
  const head = gcode.slice(0, 12_000);
  const timeMatch =
    /total estimated time:\s*([^;\r\n]+)/i.exec(head) ??
    /estimated printing time \(normal mode\)\s*=\s*([^\r\n]+)/i.exec(gcode);
  const modelTimeMatch = /model printing time:\s*([^;\r\n]+)/i.exec(head) ?? /model printing time:\s*([^;\r\n]+)/i.exec(gcode);
  const layers = /total layer number:\s*(\d+)/i.exec(head);
  return {
    filamentGrams: sumMetric(gcode, "g"),
    filamentVolumeCm3: sumMetric(gcode, "cm3"),
    filamentLengthMm: sumMetric(gcode, "mm"),
    printTimeText: timeMatch?.[1]?.trim() ?? null,
    printTimeSeconds: timeMatch ? parseDuration(timeMatch[1]) : null,
    modelPrintTimeText: modelTimeMatch?.[1]?.trim() ?? null,
    layerCount: layers ? Number(layers[1]) : null,
  };
}

export function parseModelInfo(stdout: string): ModelInfo {
  const num = (name: string): number | null => {
    const match = new RegExp(`^${name}\\s*=\\s*([+-]?[0-9.]+)`, "im").exec(stdout);
    return match ? Number(match[1]) : null;
  };
  const sizeX = num("size_x");
  const sizeY = num("size_y");
  const sizeZ = num("size_z");
  const minX = num("min_x");
  const minY = num("min_y");
  const minZ = num("min_z");
  const maxX = num("max_x");
  const maxY = num("max_y");
  const maxZ = num("max_z");
  const manifold = /^\s*manifold\s*=\s*(yes|no)/im.exec(stdout)?.[1] ?? null;
  return {
    sizeMm: sizeX !== null && sizeY !== null && sizeZ !== null ? { x: sizeX, y: sizeY, z: sizeZ } : null,
    boundingBoxMm:
      minX !== null && minY !== null && minZ !== null && maxX !== null && maxY !== null && maxZ !== null
        ? { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } }
        : null,
    volumeMm3: num("volume"),
    manifold: manifold === null ? null : manifold === "yes",
    facetCount: num("number_of_facets"),
  };
}

export function parseDuration(text: string): number | null {
  const match = /(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i.exec(text.trim());
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function sumMetric(text: string, unit: "g" | "cm3" | "mm"): number | null {
  const match = new RegExp(`filament used \\[${unit}\\]\\s*=\\s*([^\\r\\n]+)`, "i").exec(text);
  if (!match) return null;
  const values = match[1]
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round(total * 1000) / 1000;
}
