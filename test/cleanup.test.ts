import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { describe, it } from "node:test";
import { cleanupExpired, failInterruptedJobs } from "../src/cleanup.js";
import { ScythService } from "../src/service.js";
import type { SliceRequest, SliceResult, SlicerEngine } from "../src/slicer/orca.js";
import { Store } from "../src/store.js";
import { tempConfig } from "./helpers.js";

const cube = readFileSync(new URL("../samples/cube20.stl", import.meta.url));

describe("cleanup", () => {
  it("deletes expired models and keeps fresh ones", async () => {
    const { config, cleanup } = await tempConfig();
    try {
      const store = new Store(config.dataDir);
      await store.init();
      const service = new ScythService(config, store, new UnusedSlicer());
      const oldModel = await service.upload("old.stl", cube);
      const freshModel = await service.upload("fresh.stl", cube);
      const oldSeconds = Math.floor(Date.now() / 1000) - 10 * 24 * 60 * 60;
      await utimes(store.modelDir(oldModel.id), oldSeconds, oldSeconds);
      const removed = await cleanupExpired(store, 48 * 60 * 60 * 1000);
      assert.equal(removed, 1);
      await assert.rejects(() => store.readModel(oldModel.id));
      assert.equal((await store.readModel(freshModel.id)).filename, "fresh.stl");
    } finally {
      await cleanup();
    }
  });

  it("returns a claimed job to the queue after a restart", async () => {
    const { config, cleanup } = await tempConfig();
    try {
      const store = new Store(config.dataDir);
      await store.init();
      await store.saveJob({
        id: "11111111-1111-4111-8111-111111111111",
        type: "fdm",
        status: "slicing",
        attempts: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        modelId: "22222222-2222-4222-8222-222222222222",
        request: { printerId: "bambu-a1", materialId: "pla" },
      });
      assert.equal(await failInterruptedJobs(store), 1);
      const job = await store.readJob("11111111-1111-4111-8111-111111111111");
      assert.equal(job.status, "queued");
      assert.equal(job.attempts, 1);
    } finally {
      await cleanup();
    }
  });
});

class UnusedSlicer implements SlicerEngine {
  async slice(_request: SliceRequest): Promise<SliceResult> {
    throw new Error("unused");
  }
}
