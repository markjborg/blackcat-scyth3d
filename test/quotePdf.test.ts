import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { quoteLines } from "../src/pricing.js";
import { renderQuotePdf } from "../src/quotePdf.js";
import { api, startApp } from "./helpers.js";

describe("quote pdf", () => {
  it("names the lab and the euro totals", () => {
    const pdf = renderQuotePdf(quoteLines([{ materialId: "pla", grams: 3.67 }]), { jobId: "job-1" });
    const text = pdf.toString("latin1");
    assert.match(text, /^%PDF-1.4/);
    assert.match(text, /BLACKCAT MAKERLAB/);
    assert.match(text, /EUR 11.80/);
    assert.match(text, /VAT MT31422627/);
  });

  it("downloads from a finished resin job", async () => {
    const app = await startApp();
    try {
      const uploaded = await api(app.baseUrl, "/v1/models", {
        method: "POST",
        body: form(),
      });
      const model = (await uploaded.json()) as { id: string };
      const jobResponse = await api(app.baseUrl, "/v1/estimates/resin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelId: model.id, materialId: "standard-resin" }),
      });
      const job = (await jobResponse.json()) as { id: string; downloads?: { quotePdf?: string } };
      assert.equal(jobResponse.status, 201);
      assert.ok(job.downloads?.quotePdf);
      const pdf = await api(app.baseUrl, job.downloads?.quotePdf ?? "");
      assert.equal(pdf.headers.get("content-type"), "application/pdf");
      assert.match(pdf.headers.get("content-disposition") ?? "", /BlackCat-MakerLab-quote.pdf/);
      assert.match(Buffer.from(await pdf.arrayBuffer()).toString("latin1"), /BLACKCAT MAKERLAB/);
    } finally {
      await app.close();
    }
  });
});

function form(): FormData {
  const bytes = readFileSync(new URL("../samples/cube20.stl", import.meta.url));
  const body = new FormData();
  body.set("file", new Blob([bytes]), "cube20.stl");
  return body;
}
