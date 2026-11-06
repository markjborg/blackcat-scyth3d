import { MATERIAL_LABELS, PRICE_CENTS_PER_GRAM, type MaterialId } from "../pricing.js";

export interface BuildVolume {
  xMm: number;
  yMm: number;
  zMm: number;
}

export interface ProcessProfile {
  id: string;
  name: string;
  /** OrcaSlicer process preset name. The profile chain is flattened at slice time. */
  process: string;
  layerHeightMm: number;
  description: string;
}

export interface PrinterMaterial {
  id: MaterialId;
  name: string;
  /** OrcaSlicer filament preset name. Absent for resin, which is not sliced. */
  filament?: string;
}

export interface Printer {
  id: string;
  name: string;
  technology: "fdm" | "resin";
  slicing: "orca" | "estimate";
  nozzleMm: number | null;
  buildVolumeMm: BuildVolume | null;
  /** OrcaSlicer machine preset name. */
  machine: string | null;
  materials: PrinterMaterial[];
  profiles: ProcessProfile[];
  note?: string;
}

const STANDARD_PROFILES = [
  ["0.20mm-standard", "0.20mm Standard", "0.20mm Standard", 0.2, "General-purpose 0.20 mm layers for most parts."],
  ["0.16mm-optimal", "0.16mm Optimal", "0.16mm Optimal", 0.16, "Finer 0.16 mm layers."],
  ["0.24mm-draft", "0.24mm Draft", "0.24mm Draft", 0.24, "Faster 0.24 mm draft."],
] as const;

interface FdmPrinterSpec {
  id: string;
  name: string;
  nozzleMm: number;
  build: BuildVolume;
  machine: string;
  /** Suffix used by OrcaSlicer process presets, for example "A1" or "X1C". */
  processSuffix: string;
  pla: string;
  petg: string;
}

const FDM_PRINTERS: FdmPrinterSpec[] = [
  {
    id: "bambu-a1",
    name: "Bambu Lab A1",
    nozzleMm: 0.4,
    build: { xMm: 256, yMm: 256, zMm: 256 },
    machine: "Bambu Lab A1 0.4 nozzle",
    processSuffix: "A1",
    pla: "Bambu PLA Basic @BBL A1",
    petg: "Bambu PETG Basic @BBL A1",
  },
  {
    id: "bambu-a1-mini",
    name: "Bambu Lab A1 mini",
    nozzleMm: 0.4,
    build: { xMm: 180, yMm: 180, zMm: 180 },
    machine: "Bambu Lab A1 mini 0.4 nozzle",
    processSuffix: "A1M",
    pla: "Bambu PLA Basic @BBL A1M",
    petg: "Bambu PETG Basic @BBL A1M 0.4 nozzle",
  },
  {
    id: "bambu-p1p",
    name: "Bambu Lab P1P",
    nozzleMm: 0.4,
    build: { xMm: 256, yMm: 256, zMm: 256 },
    machine: "Bambu Lab P1P 0.4 nozzle",
    processSuffix: "P1P",
    pla: "Bambu PLA Basic @BBL P1P",
    petg: "Bambu PETG Basic @BBL X1C",
  },
  {
    id: "bambu-p1s",
    name: "Bambu Lab P1S",
    nozzleMm: 0.4,
    build: { xMm: 256, yMm: 256, zMm: 256 },
    machine: "Bambu Lab P1S 0.4 nozzle",
    processSuffix: "X1C",
    pla: "Bambu PLA Basic @BBL X1C",
    petg: "Bambu PETG Basic @BBL X1C",
  },
  {
    id: "bambu-x1c",
    name: "Bambu Lab X1 Carbon",
    nozzleMm: 0.4,
    build: { xMm: 256, yMm: 256, zMm: 256 },
    machine: "Bambu Lab X1 Carbon 0.4 nozzle",
    processSuffix: "X1C",
    pla: "Bambu PLA Basic @BBL X1C",
    petg: "Bambu PETG Basic @BBL X1C",
  },
  {
    id: "bambu-x1e",
    name: "Bambu Lab X1E",
    nozzleMm: 0.4,
    build: { xMm: 256, yMm: 256, zMm: 256 },
    machine: "Bambu Lab X1E 0.4 nozzle",
    processSuffix: "X1C",
    pla: "Bambu PLA Basic @BBL X1C",
    petg: "Bambu PETG Basic @BBL X1C",
  },
];

function processProfiles(suffix: string): ProcessProfile[] {
  return STANDARD_PROFILES.map(([id, name, preset, layerHeightMm, description]) => ({
    id,
    name,
    process: `${preset} @BBL ${suffix}`,
    layerHeightMm,
    description,
  }));
}

const fdmPrinters: Printer[] = FDM_PRINTERS.map((spec) => ({
  id: spec.id,
  name: spec.name,
  technology: "fdm",
  slicing: "orca",
  nozzleMm: spec.nozzleMm,
  buildVolumeMm: spec.build,
  machine: spec.machine,
  materials: [
    { id: "pla", name: "PLA", filament: spec.pla },
    { id: "petg", name: "PETG", filament: spec.petg },
  ],
  profiles: processProfiles(spec.processSuffix),
  note: "Sliced with OrcaSlicer using the bundled Bambu Lab 0.4 mm presets. Bed type is Textured PEI.",
}));

const resinPrinter: Printer = {
  id: "resin-msla",
  name: "Resin (MSLA)",
  technology: "resin",
  slicing: "estimate",
  nozzleMm: null,
  buildVolumeMm: null,
  machine: null,
  materials: [
    { id: "standard-resin", name: "Standard Resin" },
    { id: "high-quality-resin", name: "High Quality Resin" },
  ],
  profiles: [],
  note: "Resin is not sliced. Volume and grams are estimated from the closed mesh. High Quality Resin is ABS-like resin.",
};

export const PRINTERS: Printer[] = [...fdmPrinters, resinPrinter];

export const DEFAULT_PROFILE_ID = "0.20mm-standard";

export interface ResolvedFdm {
  printer: Printer;
  material: PrinterMaterial;
  profile: ProcessProfile;
}

export function listPrinters(): Printer[] {
  return PRINTERS;
}

export function findPrinter(id: string): Printer | undefined {
  return PRINTERS.find((printer) => printer.id === id);
}

export function resolveFdm(printerId: string, materialId: string, profileId: string | undefined): ResolvedFdm {
  const printer = findPrinter(printerId);
  if (!printer) {
    throw new Error(`Unknown printer '${printerId}'.`);
  }
  if (printer.slicing !== "orca" || !printer.machine) {
    throw new Error(`${printer.name} cannot be sliced. Use the resin estimator for resin materials.`);
  }
  const material = printer.materials.find((item) => item.id === materialId);
  if (!material?.filament) {
    throw new Error(
      `${printer.name} has no FDM material '${materialId}'. Available: ${printer.materials.map((item) => item.id).join(", ")}.`,
    );
  }
  const chosen = profileId || DEFAULT_PROFILE_ID;
  const profile = printer.profiles.find((item) => item.id === chosen);
  if (!profile) {
    throw new Error(
      `${printer.name} has no profile '${chosen}'. Available: ${printer.profiles.map((item) => item.id).join(", ")}.`,
    );
  }
  return { printer, material, profile };
}

export interface PublicMaterial {
  id: MaterialId;
  name: string;
  technology: "fdm" | "resin";
  priceEurPerGram: number;
  densityGPerMl: number | null;
}

export function publicMaterials(): PublicMaterial[] {
  return (Object.keys(PRICE_CENTS_PER_GRAM) as MaterialId[]).map((id) => ({
    id,
    name: MATERIAL_LABELS[id],
    technology: id.endsWith("resin") ? "resin" : "fdm",
    priceEurPerGram: PRICE_CENTS_PER_GRAM[id] / 100,
    densityGPerMl: id === "standard-resin" ? 1.1 : id === "high-quality-resin" ? 1.15 : null,
  }));
}

export function publicCatalog(): {
  printers: Printer[];
  materials: PublicMaterial[];
  profiles: Array<ProcessProfile & { printerId: string }>;
  pricing: {
    currency: "EUR";
    vatRate: 0.18;
    lineMinimumEur: 2.5;
    lineMinimumBelowEur: 2;
    minimumOrderEur: 10;
    shipping: "excluded";
  };
} {
  return {
    printers: PRINTERS,
    materials: publicMaterials(),
    profiles: PRINTERS.flatMap((printer) => printer.profiles.map((profile) => ({ ...profile, printerId: printer.id }))),
    pricing: {
      currency: "EUR",
      vatRate: 0.18,
      lineMinimumEur: 2.5,
      lineMinimumBelowEur: 2,
      minimumOrderEur: 10,
      shipping: "excluded",
    },
  };
}
