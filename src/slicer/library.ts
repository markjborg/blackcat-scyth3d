import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface SliceOverrides {
  infillPercent?: number;
  supports?: boolean;
}

const BED_TYPE = "Textured PEI Plate";

/**
 * OrcaSlicer's CLI loads the JSON files it is given, but it does not resolve
 * their `inherits` chain. Flattening produces one preset each for the machine,
 * process, and filament, which is what a headless slice actually uses.
 */
export class ProfileLibrary {
  private readonly index = new Map<string, string[]>();
  private readonly cache = new Map<string, Record<string, unknown>>();
  private loaded = false;

  constructor(private readonly resourcesDir: string) {}

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const root = path.join(this.resourcesDir, "profiles");
    const entries = await readdir(root, { recursive: true });
    for (const entry of entries) {
      const rel = String(entry);
      if (!rel.endsWith(".json")) continue;
      const full = path.join(root, rel);
      const name = path.basename(rel, ".json");
      const existing = this.index.get(name);
      if (existing) existing.push(full);
      else this.index.set(name, [full]);
    }
    this.loaded = true;
  }

  async flatten(name: string): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    const cached = this.cache.get(name);
    if (cached) return structuredClone(cached);
    const flat = await this.flattenFile(this.pick(name, null), []);
    this.cache.set(name, flat);
    return structuredClone(flat);
  }

  private pick(name: string, hint: string | null): string {
    const candidates = this.index.get(name);
    if (!candidates || candidates.length === 0) {
      throw new Error(`OrcaSlicer profile not found: ${name}`);
    }
    const vendor = hint ? vendorOf(hint) : "BBL";
    return [...candidates].sort((a, b) => score(b, vendor, hint) - score(a, vendor, hint))[0];
  }

  private async flattenFile(file: string, seen: string[]): Promise<Record<string, unknown>> {
    if (seen.includes(file)) {
      throw new Error(`Profile inheritance cycle at ${file}`);
    }
    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const parent = typeof parsed.inherits === "string" ? parsed.inherits.trim() : "";
    delete parsed.inherits;
    if (!parent) return parsed;
    const base = await this.flattenFile(this.pick(parent, file), [...seen, file]);
    return { ...base, ...parsed };
  }
}

export async function buildSliceProfiles(
  library: ProfileLibrary,
  selection: { machine: string; process: string; filament: string },
  overrides: SliceOverrides,
): Promise<{ machine: Record<string, unknown>; process: Record<string, unknown>; filament: Record<string, unknown> }> {
  const [machine, processProfile, filament] = await Promise.all([
    library.flatten(selection.machine),
    library.flatten(selection.process),
    library.flatten(selection.filament),
  ]);
  applyOverrides(machine, processProfile, overrides);
  return { machine, process: processProfile, filament };
}

export function applyOverrides(
  machine: Record<string, unknown>,
  processProfile: Record<string, unknown>,
  overrides: SliceOverrides,
): void {
  setSetting(machine, "curr_bed_type", BED_TYPE);
  setSetting(machine, "default_bed_type", BED_TYPE);
  if (overrides.infillPercent !== undefined) {
    setSetting(processProfile, "sparse_infill_density", `${overrides.infillPercent}%`);
  }
  if (overrides.supports !== undefined) {
    setSetting(processProfile, "enable_support", overrides.supports ? "1" : "0");
  }
}

export function filamentDensity(filament: Record<string, unknown>): number | null {
  const raw = filament.filament_density;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const density = Number(value);
  return Number.isFinite(density) && density > 0 ? density : null;
}

function setSetting(target: Record<string, unknown>, key: string, value: string): void {
  target[key] = Array.isArray(target[key]) ? [value] : value;
}

function vendorOf(file: string): string {
  const parts = file.split(path.sep);
  const index = parts.indexOf("profiles");
  return index >= 0 && parts[index + 1] ? parts[index + 1] : "";
}

function score(file: string, vendor: string, hint: string | null): number {
  let value = 0;
  if (vendor && vendorOf(file) === vendor) value += 100;
  if (hint && path.dirname(file) === path.dirname(hint)) value += 20;
  if (vendorOf(file) === "BBL") value += 5;
  return value;
}
