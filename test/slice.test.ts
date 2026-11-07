import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ProfileLibrary } from "../src/slicer/library.js";
import { OrcaSlicer } from "../src/slicer/orca.js";
import { api, startApp } from "./helpers.js";

const cube = readFileSync(new URL("../samples/cube20.stl", import.meta.url));
const orcaBin = process.env.ORCA_SLICER_BIN || "/tmp/orcaslicer/squashfs-root/bin/orca-slicer";
const orcaResources = process.env.ORCA_RESOURCES || "/tmp/orcaslicer/squashfs-root/resources";
const required = process.env.SCYTH3D_REQUIRE_SLICER === "1";

describe("OrcaSlicer", () => {
  it("slices the 20 mm cube for the A1 in PLA and the A1 mini in PETG", async (t) => {
    const ready = await slicerReady();
    if (!ready) {
      if (required) assert.fail(`OrcaSlicer is not available at ${orcaBin}`);
      t.skip(`OrcaSlicer is not available at ${orcaBin}`);
      return;
    }

    const library = new ProfileLibrary(orcaResources);
    const filament = await library.flatten("Bambu PLA Basic @BBL A1");
    const density = Array.isArray(filament.filament_density) ? filament.filament_density[0] : filament.filament_density;
    assert.equal(density, "1.26");

    const app = await startApp(new OrcaSlicer(orcaBin, orcaResources), {
      ORCA_SLICER_BIN: orcaBin,
      ORCA_RESOURCES: orcaResources,
      SCYTH3D_SLICE_TIMEOUT_SEC: "180",
    });
    try {
      const pla = await slice(app.baseUrl, "bambu-a1", "pla");
      console.log(`SLICE_RESULT pla-a1 ${JSON.stringify({
        grams: pla.result.filamentGrams,
        time: pla.result.printTimeText,
        seconds: pla.result.printTimeSeconds,
        layers: pla.result.layerCount,
        dimensions: pla.result.dimensionsMm,
        quote: pla.quote,
      })}`);
      assert.equal(pla.status, "done");
      assert.ok(pla.result.filamentGrams >= 3.5 && pla.result.filamentGrams <= 3.85, `grams ${pla.result.filamentGrams}`);
      assert.equal(pla.result.layerCount, 100);
      assert.ok(pla.result.printTimeSeconds >= 1000 && pla.result.printTimeSeconds <= 1500, `time ${pla.result.printTimeSeconds}`);
      assert.equal(pla.result.dimensionsMm.x, 20);
      assert.equal(pla.quote.subtotalEur, 10);
      assert.equal(pla.quote.totalEur, 11.8);
      const gcode = await api(app.baseUrl, pla.downloads.gcode);
      assert.match(await gcode.text(), /filament used \[g\]/);
      const threeMf = await api(app.baseUrl, pla.downloads.threeMf);
      const body = Buffer.from(await threeMf.arrayBuffer());
      assert.equal(body.subarray(0, 2).toString("utf8"), "PK");

      const petg = await slice(app.baseUrl, "bambu-a1-mini", "petg");
      console.log(`SLICE_RESULT petg-a1-mini ${JSON.stringify({
        grams: petg.result.filamentGrams,
        time: petg.result.printTimeText,
        seconds: petg.result.printTimeSeconds,
        layers: petg.result.layerCount,
        quote: petg.quote,
      })}`);
      assert.equal(petg.status, "done", petg.error?.message);
      assert.ok(petg.result.filamentGrams >= 3.2 && petg.result.filamentGrams <= 3.9, `petg grams ${petg.result.filamentGrams}`);
      assert.equal(petg.result.layerCount, 100);
      assert.ok(petg.result.printTimeSeconds >= 1400 && petg.result.printTimeSeconds <= 2200, `petg time ${petg.result.printTimeSeconds}`);
    } finally {
      await app.close();
    }
  });
});

async function slicerReady(): Promise<boolean> {
  try {
    await access(orcaBin);
    await access(`${orcaResources}/profiles`);
    return true;
  } catch {
    return false;
  }
}

async function slice(baseUrl: string, printerId: string, materialId: string): Promise<{
  status: string;
  error?: { message: string };
  result: { filamentGrams: number; printTimeText: string; printTimeSeconds: number; layerCount: number; dimensionsMm: { x: number; y: number; z: number } };
  quote: { subtotalEur: number; totalEur: number; vatEur: number; lines: Array<{ rawEur: number; netEur: number }> };
  downloads: { gcode: string; threeMf: string };
}> {
  const form = new FormData();
  form.set("file", new Blob([cube]), "cube20.stl");
  const uploaded = await api(baseUrl, "/v1/models", { method: "POST", body: form });
  assert.equal(uploaded.status, 201);
  const model = await uploaded.json() as { id: string };
  const response = await api(baseUrl, "/v1/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ modelId: model.id, printerId, materialId, profileId: "0.20mm-standard", wait: true }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body as Awaited<ReturnType<typeof slice>>;
}
