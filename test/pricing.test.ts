import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError } from "../src/errors.js";
import { quoteLines } from "../src/pricing.js";

describe("quote", () => {
  it("lifts a cheap PLA line to €2.50 and the order to €10 before VAT", () => {
    const quote = quoteLines([{ materialId: "pla", grams: 3.67 }]);
    assert.equal(quote.lines[0]?.rawEur, 0.73);
    assert.equal(quote.lines[0]?.netEur, 2.5);
    assert.equal(quote.lines[0]?.adjustment, "line_minimum");
    assert.equal(quote.minimumOrderApplied, true);
    assert.equal(quote.subtotalEur, 10);
    assert.equal(quote.vatEur, 1.8);
    assert.equal(quote.totalEur, 11.8);
    assert.equal(quote.shipping.included, false);
  });

  it("keeps a line of exactly €2 and still applies the order minimum", () => {
    const quote = quoteLines([{ materialId: "pla", grams: 10 }]);
    assert.equal(quote.lines[0]?.rawEur, 2);
    assert.equal(quote.lines[0]?.adjustment, "none");
    assert.equal(quote.subtotalEur, 10);
    assert.equal(quote.totalEur, 11.8);
  });

  it("does not change a line that is already at least €2 when the order clears €10", () => {
    const quote = quoteLines([{ materialId: "pla", grams: 100 }]);
    assert.equal(quote.lines[0]?.netEur, 20);
    assert.equal(quote.minimumOrderApplied, false);
    assert.equal(quote.subtotalEur, 20);
    assert.equal(quote.vatEur, 3.6);
    assert.equal(quote.totalEur, 23.6);
  });

  it("applies the line minimum per line, then the order minimum", () => {
    const quote = quoteLines([
      { materialId: "pla", grams: 1 },
      { materialId: "standard-resin", grams: 1 },
    ]);
    assert.equal(quote.lines[0]?.netEur, 2.5);
    assert.equal(quote.lines[1]?.label, "Standard Resin");
    assert.equal(quote.lines[1]?.netEur, 2.5);
    assert.equal(quote.linesNetEur, 5);
    assert.equal(quote.subtotalEur, 10);
    assert.equal(quote.totalEur, 11.8);
  });

  it("prices high quality resin at €0.42/g", () => {
    const quote = quoteLines([{ materialId: "high-quality-resin", grams: 50 }]);
    assert.equal(quote.lines[0]?.label, "High Quality Resin");
    assert.equal(quote.lines[0]?.rawEur, 21);
    assert.equal(quote.lines[0]?.adjustment, "none");
    assert.equal(quote.subtotalEur, 21);
    assert.equal(quote.vatEur, 3.78);
    assert.equal(quote.totalEur, 24.78);
  });

  it("prices PETG the same as PLA", () => {
    const quote = quoteLines([{ materialId: "petg", grams: 60 }]);
    assert.equal(quote.lines[0]?.rateEurPerGram, 0.2);
    assert.equal(quote.subtotalEur, 12);
    assert.equal(quote.vatEur, 2.16);
    assert.equal(quote.totalEur, 14.16);
  });

  it("rejects unknown materials and non-positive weights", () => {
    assert.throws(() => quoteLines([{ materialId: "abs", grams: 10 }]), (error: unknown) => error instanceof ApiError && error.code === "unknown_material");
    assert.throws(() => quoteLines([{ materialId: "pla", grams: 0 }]), (error: unknown) => error instanceof ApiError && error.code === "invalid_grams");
    assert.throws(() => quoteLines([]), (error: unknown) => error instanceof ApiError && error.code === "empty_quote");
  });
});
