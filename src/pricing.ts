import { ApiError } from "./errors.js";

/** Mark's approved prices, euros per gram, before VAT. */
export const PRICE_CENTS_PER_GRAM = {
  pla: 20,
  petg: 20,
  "standard-resin": 35,
  "high-quality-resin": 42,
} as const;

export const MATERIAL_LABELS = {
  pla: "PLA",
  petg: "PETG",
  "standard-resin": "Standard Resin",
  "high-quality-resin": "High Quality Resin",
} as const;

export type MaterialId = keyof typeof PRICE_CENTS_PER_GRAM;

/** ABS-like resin is sold as High Quality Resin. Grams come from mesh volume times these densities. */
export const RESIN_DENSITY_G_PER_ML: Partial<Record<MaterialId, number>> = {
  "standard-resin": 1.1,
  "high-quality-resin": 1.15,
};

const LINE_TRIGGER_CENTS = 200;
const LINE_MINIMUM_CENTS = 250;
const ORDER_MINIMUM_CENTS = 1000;
const VAT_PERCENT = 18;

export interface QuoteLineInput {
  materialId: string;
  grams: number;
  note?: string;
}

export interface QuoteLine {
  materialId: MaterialId;
  label: string;
  note?: string;
  grams: number;
  rateEurPerGram: number;
  rawEur: number;
  netEur: number;
  adjustment: "none" | "line_minimum";
}

export interface Quote {
  currency: "EUR";
  vatRate: number;
  pricesAreBeforeVat: true;
  lines: QuoteLine[];
  linesNetEur: number;
  minimumOrderEur: number;
  minimumOrderApplied: boolean;
  subtotalEur: number;
  vatEur: number;
  totalEur: number;
  shipping: { included: false; note: string };
}

export function isMaterialId(value: string): value is MaterialId {
  return Object.prototype.hasOwnProperty.call(PRICE_CENTS_PER_GRAM, value);
}

export function quoteLines(inputs: QuoteLineInput[]): Quote {
  if (inputs.length === 0) {
    throw new ApiError(400, "empty_quote", "A quote needs at least one line.");
  }

  const lines: QuoteLine[] = inputs.map((input) => priceLine(input));
  const linesNetCents = lines.reduce((sum, line) => sum + eurToCents(line.netEur), 0);
  const minimumOrderApplied = linesNetCents < ORDER_MINIMUM_CENTS;
  const subtotalCents = minimumOrderApplied ? ORDER_MINIMUM_CENTS : linesNetCents;
  const vatCents = Math.round((subtotalCents * VAT_PERCENT) / 100);

  return {
    currency: "EUR",
    vatRate: VAT_PERCENT / 100,
    pricesAreBeforeVat: true,
    lines,
    linesNetEur: centsToEur(linesNetCents),
    minimumOrderEur: centsToEur(ORDER_MINIMUM_CENTS),
    minimumOrderApplied,
    subtotalEur: centsToEur(subtotalCents),
    vatEur: centsToEur(vatCents),
    totalEur: centsToEur(subtotalCents + vatCents),
    shipping: {
      included: false,
      note: "Shipping is excluded and added separately.",
    },
  };
}

function priceLine(input: QuoteLineInput): QuoteLine {
  if (!isMaterialId(input.materialId)) {
    throw new ApiError(
      400,
      "unknown_material",
      `Unknown material '${input.materialId}'. Known materials: ${Object.keys(PRICE_CENTS_PER_GRAM).join(", ")}.`,
    );
  }
  if (!Number.isFinite(input.grams) || input.grams <= 0) {
    throw new ApiError(400, "invalid_grams", "Grams must be a positive number.");
  }

  const centsPerGram = PRICE_CENTS_PER_GRAM[input.materialId];
  const rawCents = Math.round(input.grams * centsPerGram);
  const adjustment = rawCents < LINE_TRIGGER_CENTS ? "line_minimum" : "none";
  const netCents = adjustment === "line_minimum" ? LINE_MINIMUM_CENTS : rawCents;

  return {
    materialId: input.materialId,
    label: MATERIAL_LABELS[input.materialId],
    note: input.note,
    grams: roundGrams(input.grams),
    rateEurPerGram: centsPerGram / 100,
    rawEur: centsToEur(rawCents),
    netEur: centsToEur(netCents),
    adjustment,
  };
}

function eurToCents(eur: number): number {
  return Math.round(eur * 100);
}

function centsToEur(cents: number): number {
  return cents / 100;
}

function roundGrams(grams: number): number {
  return Math.round(grams * 1000) / 1000;
}
