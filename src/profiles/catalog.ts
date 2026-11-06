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
  /** How many of this machine are in the MakerLab. */
  fleetCount?: number;
  /** This machine is part of the plate-preparation fleet. */
  fleet?: boolean;
  /** OrcaSlicer ships this machine preset. H2C does not. */
  officialProfile?: boolean;
  /** Directory under profiles/quoting. */
  quotingPack?: "p1s" | "p2s" | "x1c" | "h2c" | "giga";
  /** Resin output this service can actually write. */
  resinOutput?: "sl1s" | "not-produced";
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

const fleetOverlay: Record<string, Partial<Printer>> = {
  "bambu-p1s": {
    fleet: true,
    fleetCount: 9,
    officialProfile: true,
    quotingPack: "p1s",
    note: "9 in the lab. Spec 256×256×256 mm. Ann's Orca 2.4.2 quoting preset caps Z at 250 mm. Quoting defaults, not production-validated.",
  },
  "bambu-x1c": {
    fleet: true,
    fleetCount: 2,
    officialProfile: true,
    quotingPack: "x1c",
    note: "2 in the lab. Spec 256×256×256 mm. The quoting preset caps Z at 250 mm. Quoting defaults, not production-validated.",
  },
};

for (const printer of fdmPrinters) {
  Object.assign(printer, fleetOverlay[printer.id] ?? {});
}

const fleetOnly: Printer[] = [
  {
    id: "bambu-p2s",
    name: "Bambu Lab P2S",
    technology: "fdm",
    slicing: "orca",
    nozzleMm: 0.4,
    buildVolumeMm: { xMm: 256, yMm: 256, zMm: 256 },
    machine: "Bambu Lab P2S 0.4 nozzle",
    fleet: true,
    fleetCount: 2,
    officialProfile: true,
    quotingPack: "p2s",
    materials: [
      { id: "pla", name: "PLA", filament: "Generic PLA @BBL P2S" },
      { id: "petg", name: "PETG", filament: "Generic PETG @BBL P2S" },
    ],
    profiles: [
      {
        id: "0.20mm-standard",
        name: "0.20mm Standard",
        process: "0.20mm Standard @BBL P2S",
        layerHeightMm: 0.2,
        description: "Ann's quoting default for the P2S.",
      },
    ],
    note: "2 in the lab. Official OrcaSlicer 2.4.2 P2S 0.4 mm preset. Quoting defaults, not production-validated.",
  },
  {
    id: "bambu-h2c",
    name: "Bambu Lab H2C",
    technology: "fdm",
    slicing: "orca",
    nozzleMm: 0.4,
    buildVolumeMm: { xMm: 325, yMm: 320, zMm: 320 },
    machine: null,
    fleet: true,
    fleetCount: 2,
    officialProfile: false,
    quotingPack: "h2c",
    materials: [
      { id: "pla", name: "PLA", filament: "Generic PLA @BBL H2D" },
      { id: "petg", name: "PETG", filament: "Generic PETG @BBL H2D" },
    ],
    profiles: [
      {
        id: "0.20mm-standard",
        name: "0.20mm Standard (H2D proxy)",
        process: "0.20mm Standard @BBL H2D",
        layerHeightMm: 0.2,
        description: "Proxy. OrcaSlicer 2.4.2 has no H2C preset.",
      },
    ],
    note: "2 in the lab. No official H2C profile in OrcaSlicer 2.4.2. Slices use Ann's H2D proxy. Left nozzle 325×320×320 mm, right nozzle 305×320×325 mm. Not production-validated.",
  },
  {
    id: "elegoo-giga",
    name: "Elegoo OrangeStorm Giga",
    technology: "fdm",
    slicing: "orca",
    nozzleMm: 0.6,
    buildVolumeMm: { xMm: 800, yMm: 800, zMm: 1000 },
    machine: "Elegoo OrangeStorm Giga 0.6 nozzle",
    fleet: true,
    fleetCount: 1,
    officialProfile: true,
    quotingPack: "giga",
    materials: [
      { id: "pla", name: "PLA", filament: "Elegoo PLA @Elegoo Giga" },
      { id: "petg", name: "PETG", filament: "Elegoo PETG @Elegoo Giga" },
    ],
    profiles: [
      {
        id: "0.30mm-standard",
        name: "0.30mm Standard",
        process: "0.30mm Standard @Elegoo Giga 0.6 nozzle",
        layerHeightMm: 0.3,
        description: "0.6 mm nozzle quoting default.",
      },
    ],
    note: "1 in the lab. Official Elegoo Giga 0.6 mm preset, 0.30 mm layers. Quoting defaults, not production-validated.",
  },
  {
    id: "elegoo-saturn-4-ultra-16k",
    name: "Elegoo Saturn 4 Ultra 16K",
    technology: "resin",
    slicing: "estimate",
    nozzleMm: null,
    buildVolumeMm: { xMm: 211.68, yMm: 118.37, zMm: 220 },
    machine: null,
    fleet: true,
    fleetCount: 3,
    officialProfile: false,
    resinOutput: "not-produced",
    materials: [
      { id: "standard-resin", name: "Standard Resin" },
      { id: "high-quality-resin", name: "High Quality Resin" },
    ],
    profiles: [],
    note: "3 in the lab. Default resin printer. Build 211.68×118.37×220 mm. Printer-ready .goo is not produced: a faithful raster needs the 16K LCD, and converting an SL1S file would be the wrong size. Exposure is not calibrated.",
  },
  {
    id: "elegoo-jupiter-6k",
    name: "Elegoo Jupiter 6K 12.8-inch",
    technology: "resin",
    slicing: "estimate",
    nozzleMm: null,
    buildVolumeMm: { xMm: 277.848, yMm: 156.264, zMm: 300 },
    machine: null,
    fleet: true,
    fleetCount: 1,
    officialProfile: false,
    resinOutput: "not-produced",
    materials: [
      { id: "standard-resin", name: "Standard Resin" },
      { id: "high-quality-resin", name: "High Quality Resin" },
    ],
    profiles: [],
    note: "1 in the lab. Build 277.848×156.264×300 mm. The Jupiter 6K expects CTB. A converted SL1S archive would not match this LCD, so no printer-ready file is emitted. Exposure is not calibrated.",
  },
  {
    id: "prusa-sl1s",
    name: "Original Prusa SL1S SPEED",
    technology: "resin",
    slicing: "estimate",
    nozzleMm: null,
    buildVolumeMm: { xMm: 127, yMm: 80, zMm: 150 },
    machine: null,
    fleet: true,
    fleetCount: 1,
    officialProfile: true,
    resinOutput: "sl1s",
    materials: [
      { id: "standard-resin", name: "Standard Resin" },
      { id: "high-quality-resin", name: "High Quality Resin" },
    ],
    profiles: [
      {
        id: "0.10mm-fast",
        name: "0.10 mm Fast",
        process: "0.1 Fast @SL1S",
        layerHeightMm: 0.1,
        description: "PrusaSlicer SLA profile. Exposure is Prusa's preset, not a shop calibration.",
      },
    ],
    note: "1 in the lab. PrusaSlicer 2.8.1 writes a real .sl1 (it rejects the .sl1s container). Supports, pad, and hollowing are included. Exposure is 2.6 s / 25 s at 0.1 mm and is not a shop calibration. Confirm the SL1S accepts .sl1.",
  },
];

export const PRINTERS: Printer[] = [...fdmPrinters, resinPrinter, ...fleetOnly];

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
