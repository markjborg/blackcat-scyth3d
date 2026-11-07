import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { OrcaSlicer } from "../src/slicer/orca.js";
import { api, startApp } from "./helpers.js";

const cube = readFileSync(new URL("../samples/cube20.stl", import.meta.url));
const orcaBin = process.env.ORCA_SLICER_BIN || "/tmp/orcaslicer/squashfs-root/bin/orca-slicer";
const orcaResources = process.env.ORCA_RESOURCES || "/tmp/orcaslicer/squashfs-root/resources";
const required = process.env.SCYTH3D_REQUIRE_SLICER === "1";

const FLEET = ["bambu-p1s", "bambu-p2s", "bambu-x1c", "bambu-h2c", "elegoo-giga"] as const;

describe("fleet plates", () => {
  it("arranges two cubes onto a P1S plate and quotes the sliced grams", async (t) => {
    if (!(await exists(orcaBin))) {
      if (required) assert.fail(`OrcaSlicer is not available at ${orcaBin}`);
      t.skip(`OrcaSlicer is not available at ${orcaBin}`);
      return;
    }
    const app = await startApp(new OrcaSlicer(orcaBin, orcaResources), {
      ORCA_SLICER_BIN: orcaBin,
      ORCA_RESOURCES: orcaResources,
      SCYTH3D_SLICE_TIMEOUT_SEC: "180",
    });
    try {
      const uploaded = await upload(app.baseUrl);
      const response = await api(app.baseUrl, "/v1/plates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          printerId: "bambu-p1s",
          materialId: "pla",
          supports: false,
          models: [{ modelId: uploaded, quantity: 2 }],
          wait: true,
        }),
      });
      const job = await response.json();
      assert.equal(response.status, 200, JSON.stringify(job));
      const body = job as {
        status: string;
        result: { filamentGrams: number; plates: Array<{ index: number; layerCount: number; previewUrl: string }> };
        quote: { totalEur: number; lines: Array<{ rawEur: number }> };
        downloads: { archive: string };
      };
      assert.equal(body.status, "done");
      assert.equal(body.result.plates.length, 1);
      assert.ok(body.result.filamentGrams > 6 && body.result.filamentGrams < 9, `grams ${body.result.filamentGrams}`);
      assert.equal(body.result.plates[0]?.layerCount, 100);
      assert.equal(body.quote.totalEur, 11.8);
      console.log(`PLATE_RESULT p1s ${JSON.stringify({ grams: body.result.filamentGrams, raw: body.quote.lines[0]?.rawEur, total: body.quote.totalEur })}`);
      const preview = await api(app.baseUrl, body.result.plates[0]?.previewUrl ?? "");
      assert.equal(preview.status, 200);
      assert.equal(preview.headers.get("content-type"), "image/png");
      const archive = await api(app.baseUrl, body.downloads.archive);
      const bytes = Buffer.from(await archive.arrayBuffer());
      assert.equal(bytes.subarray(0, 2).toString("utf8"), "PK");

      const h2c = await api(app.baseUrl, "/v1/printers");
      const printers = (await h2c.json()) as { printers: Array<{ id: string; officialProfile?: boolean; note?: string }> };
      const flagged = printers.printers.find((printer) => printer.id === "bambu-h2c");
      assert.equal(flagged?.officialProfile, false);
      assert.match(flagged?.note ?? "", /no official H2C/i);
    } finally {
      await app.close();
    }
  });

  it("slices one cube on every FDM fleet pack", async (t) => {
    if (!(await exists(orcaBin))) {
      if (required) assert.fail(`OrcaSlicer is not available at ${orcaBin}`);
      t.skip(`OrcaSlicer is not available at ${orcaBin}`);
      return;
    }
    const app = await startApp(new OrcaSlicer(orcaBin, orcaResources), {
      ORCA_SLICER_BIN: orcaBin,
      ORCA_RESOURCES: orcaResources,
      SCYTH3D_SLICE_TIMEOUT_SEC: "300",
    });
    try {
      for (const printerId of FLEET) {
        const uploaded = await upload(app.baseUrl);
        const response = await api(app.baseUrl, "/v1/plates", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            printerId,
            materialId: "pla",
            supports: false,
            models: [{ modelId: uploaded, quantity: 1 }],
            wait: true,
          }),
        });
        const job = await response.json();
        assert.equal(response.status, 200, `${printerId} ${JSON.stringify(job)}`);
        const body = job as {
          status: string;
          error?: { message: string };
          result?: { filamentGrams: number; printTimeText: string; layerCount: number; warnings?: string[] };
        };
        assert.equal(body.status, "done", body.error?.message);
        assert.ok((body.result?.filamentGrams ?? 0) > 0);
        console.log(`PLATE_RESULT ${printerId} ${JSON.stringify({ grams: body.result?.filamentGrams, time: body.result?.printTimeText, layers: body.result?.layerCount, warnings: body.result?.warnings })}`);
      }
    } finally {
      await app.close();
    }
  });

  it("writes a real SL1 archive when PrusaSlicer is configured", async (t) => {
    const prusa = process.env.PRUSA_SLICER_BIN;
    if (!prusa) {
      t.skip("PRUSA_SLICER_BIN is not set");
      return;
    }
    const app = await startApp(new OrcaSlicer(orcaBin, orcaResources), { PRUSA_SLICER_BIN: prusa, SCYTH3D_SLICE_TIMEOUT_SEC: "300" });
    try {
      const uploaded = await upload(app.baseUrl);
      const response = await api(app.baseUrl, "/v1/plates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          printerId: "prusa-sl1s",
          materialId: "standard-resin",
          models: [{ modelId: uploaded, quantity: 1 }],
          wait: true,
        }),
      });
      const job = await response.json();
      assert.equal(response.status, 200, JSON.stringify(job));
      const body = job as { status: string; error?: { message: string }; result?: { volumeMl: number; grams: number; printTimeText: string; layerCount: number } };
      assert.equal(body.status, "done", body.error?.message);
      assert.ok((body.result?.volumeMl ?? 0) > 1);
      console.log(`PLATE_RESULT sl1s ${JSON.stringify(body.result)}`);
    } finally {
      await app.close();
    }
  });

  it("refuses to invent an Elegoo resin file", async () => {
    const app = await startApp(new OrcaSlicer(orcaBin, orcaResources));
    try {
      const uploaded = await upload(app.baseUrl);
      const response = await api(app.baseUrl, "/v1/plates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          printerId: "elegoo-saturn-4-ultra-16k",
          materialId: "standard-resin",
          models: [{ modelId: uploaded, quantity: 1 }],
          wait: true,
        }),
      });
      const job = (await response.json()) as { status: string; error?: { code: string; message: string } };
      assert.equal(job.status, "failed");
      assert.equal(job.error?.code, "resin_format_unavailable");
      assert.match(job.error?.message ?? "", /goo/i);
    } finally {
      await app.close();
    }
  });
});

async function upload(baseUrl: string): Promise<string> {
  const form = new FormData();
  form.set("file", new Blob([cube]), "cube20.stl");
  const response = await api(baseUrl, "/v1/models", { method: "POST", body: form });
  assert.equal(response.status, 201);
  const body = (await response.json()) as { id: string };
  return body.id;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
