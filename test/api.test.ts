import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { tokensMatch } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import type { SliceRequest, SliceResult, SlicerEngine } from "../src/slicer/orca.js";
import { api, startApp, TEST_API_KEY } from "./helpers.js";

const cube = readFileSync(new URL("../samples/cube20.stl", import.meta.url));

describe("auth and API", () => {
  it("compares API keys without treating a different length as equal", () => {
    assert.equal(tokensMatch(TEST_API_KEY, TEST_API_KEY), true);
    assert.equal(tokensMatch("nope", TEST_API_KEY), false);
    assert.equal(tokensMatch("test-key-12345", TEST_API_KEY), false);
  });

  it("refuses to start without an API key", () => {
    assert.throws(() => loadConfig({}), /SCYTH3D_API_KEY/);
  });

  it("requires a bearer token and serves catalog, resin, and quote routes", async () => {
    const app = await startApp(new StubSlicer());
    try {
      const open = await fetch(`${app.baseUrl}/health`);
      assert.equal(open.status, 200);
      const health = await open.json() as { ok: boolean };
      assert.equal(health.ok, true);

      const denied = await fetch(`${app.baseUrl}/v1/printers`);
      assert.equal(denied.status, 401);

      const printers = await api(app.baseUrl, "/v1/printers");
      assert.equal(printers.status, 200);
      const printerBody = await printers.json() as { printers: Array<{ id: string }> };
      assert.ok(printerBody.printers.some((printer) => printer.id === "bambu-a1"));

      const materials = await api(app.baseUrl, "/v1/materials");
      const materialBody = await materials.json() as { materials: Array<{ id: string; priceEurPerGram: number }> };
      assert.equal(materialBody.materials.find((material) => material.id === "high-quality-resin")?.priceEurPerGram, 0.42);

      const uploaded = await uploadCube(app.baseUrl);
      const resin = await api(app.baseUrl, "/v1/estimates/resin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelId: uploaded.id, materialId: "standard-resin" }),
      });
      assert.equal(resin.status, 201);
      const resinBody = await resin.json() as { result: { volumeMl: number; grams: number }; quote: { subtotalEur: number; totalEur: number } };
      assert.equal(resinBody.result.volumeMl, 8);
      assert.equal(resinBody.result.grams, 8.8);
      assert.equal(resinBody.quote.subtotalEur, 10);
      assert.equal(resinBody.quote.totalEur, 11.8);

      const quoted = await api(app.baseUrl, "/v1/quotes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lines: [{ materialId: "petg", grams: 60 }] }),
      });
      const quoteBody = await quoted.json() as { totalEur: number };
      assert.equal(quoteBody.totalEur, 14.16);
    } finally {
      await app.close();
    }
  });

  it("slices through the API with a stub engine and returns downloads", async () => {
    const app = await startApp(new StubSlicer());
    try {
      const uploaded = await uploadCube(app.baseUrl);
      const response = await api(app.baseUrl, "/v1/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          modelId: uploaded.id,
          printerId: "bambu-a1",
          materialId: "pla",
          profileId: "0.20mm-standard",
          wait: true,
        }),
      });
      assert.equal(response.status, 200);
      const job = await response.json() as {
        status: string;
        result: { filamentGrams: number; layerCount: number };
        quote: { totalEur: number };
        downloads: { gcode: string };
      };
      assert.equal(job.status, "succeeded");
      assert.equal(job.result.filamentGrams, 3.67);
      assert.equal(job.result.layerCount, 100);
      assert.equal(job.quote.totalEur, 11.8);
      const gcode = await api(app.baseUrl, job.downloads.gcode);
      assert.equal(gcode.status, 200);
      assert.match(await gcode.text(), /filament used \[g\] = 3.67/);
    } finally {
      await app.close();
    }
  });
});

async function uploadCube(baseUrl: string): Promise<{ id: string }> {
  const form = new FormData();
  form.set("file", new Blob([cube]), "cube20.stl");
  const response = await api(baseUrl, "/v1/models", { method: "POST", body: form });
  assert.equal(response.status, 201);
  return response.json() as Promise<{ id: string }>;
}

class StubSlicer implements SlicerEngine {
  async slice(request: SliceRequest): Promise<SliceResult> {
    const gcode = "; total estimated time: 20m 12s\n; total layer number: 100\n; filament used [g] = 3.67\n";
    await writeFile(`${request.workDir}/plate_1.gcode`, gcode);
    await writeFile(`${request.workDir}/print.3mf`, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    return {
      filamentGrams: 3.67,
      filamentVolumeCm3: 2.91,
      filamentLengthMm: 1211.31,
      printTimeSeconds: 1212,
      printTimeText: "20m 12s",
      modelPrintTimeText: "13m 56s",
      layerCount: 100,
      dimensionsMm: { x: 20, y: 20, z: 20 },
      boundingBoxMm: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 20 } },
      meshVolumeMm3: 8000,
      manifold: true,
      gcodePath: `${request.workDir}/plate_1.gcode`,
      threeMfPath: `${request.workDir}/print.3mf`,
      engine: "stub",
      bedType: "Textured PEI Plate",
      warnings: [],
    };
  }
}
