import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, it } from "node:test";
import { api, startApp, TEST_API_KEY } from "./helpers.js";

const cube = readFileSync(new URL("../samples/cube20.stl", import.meta.url));
const workerToken = "worker-token-123456";
const orcaBin = process.env.ORCA_SLICER_BIN || "/tmp/orcaslicer/squashfs-root/bin/orca-slicer";
const orcaResources = process.env.ORCA_RESOURCES || "/tmp/orcaslicer/squashfs-root/resources";

describe("worker queue", () => {
  it("rejects the API key on the worker route and queues until a worker finishes", async (t) => {
    const { access } = await import("node:fs/promises");
    try {
      await access(orcaBin);
    } catch {
      t.skip("OrcaSlicer is not available");
      return;
    }
    const app = await startApp(undefined, {
      SCYTH3D_ALL_IN_ONE: "0",
      SCYTH3D_WORKER_TOKEN: workerToken,
      SCYTH3D_LEASE_SEC: "120",
      SCYTH3D_QUEUE_WAIT_SEC: "2",
      SCYTH3D_SLICE_TIMEOUT_SEC: "180",
      ORCA_SLICER_BIN: orcaBin,
      ORCA_RESOURCES: orcaResources,
    });
    const worker = startWorker(app.baseUrl);
    try {
      const denied = await fetch(`${app.baseUrl}/v1/worker/claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${TEST_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ workerId: "intruder", waitMs: 0 }),
      });
      assert.equal(denied.status, 401);

      const status = await api(app.baseUrl, "/v1/workers");
      assert.equal(status.status, 200);

      const uploaded = await upload(app.baseUrl);
      const response = await api(app.baseUrl, "/v1/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          modelId: uploaded,
          printerId: "bambu-a1",
          materialId: "pla",
          profileId: "0.20mm-standard",
          supports: false,
          wait: true,
        }),
      });
      const job = (await response.json()) as { status: string; result?: { filamentGrams: number }; error?: { message: string } };
      assert.equal(response.status, 200, JSON.stringify(job));
      assert.equal(job.status, "done", job.error?.message);
      assert.ok((job.result?.filamentGrams ?? 0) > 3 && (job.result?.filamentGrams ?? 0) < 5);

      const workers = (await (await api(app.baseUrl, "/v1/workers")).json()) as { online: boolean; mode: string };
      assert.equal(workers.mode, "queue");
      assert.equal(workers.online, true);
    } finally {
      worker.kill("SIGTERM");
      await app.close();
    }
  });

  it("returns a queued job when no worker is connected", async () => {
    const app = await startApp(undefined, {
      SCYTH3D_ALL_IN_ONE: "0",
      SCYTH3D_WORKER_TOKEN: workerToken,
      SCYTH3D_QUEUE_WAIT_SEC: "1",
    });
    try {
      const uploaded = await upload(app.baseUrl);
      const response = await api(app.baseUrl, "/v1/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          modelId: uploaded,
          printerId: "bambu-a1",
          materialId: "pla",
          wait: true,
        }),
      });
      const job = (await response.json()) as { status: string };
      assert.equal(job.status, "queued");
      const workers = (await (await api(app.baseUrl, "/v1/workers")).json()) as { online: boolean; mode: string };
      assert.equal(workers.online, false);
      assert.equal(workers.mode, "queue");
    } finally {
      await app.close();
    }
  });
});

function startWorker(serverUrl: string): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
    env: {
      ...process.env,
      SCYTH3D_SERVER_URL: serverUrl,
      SCYTH3D_WORKER_TOKEN: workerToken,
      SCYTH3D_WORKER_ID: "shop-test",
      ORCA_SLICER_BIN: orcaBin,
      ORCA_RESOURCES: orcaResources,
    },
    stdio: "ignore",
  });
}

async function upload(baseUrl: string): Promise<string> {
  const form = new FormData();
  form.set("file", new Blob([cube]), "cube20.stl");
  const response = await api(baseUrl, "/v1/models", { method: "POST", body: form });
  assert.equal(response.status, 201);
  const body = (await response.json()) as { id: string };
  return body.id;
}
