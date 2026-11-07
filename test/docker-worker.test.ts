import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const enabled = process.env.SCYTH3D_DOCKER_E2E === "1";
const cube = readFileSync(new URL("../samples/cube20.stl", import.meta.url));
const apiKey = "test-key-123456";
const workerToken = "worker-token-123456";
const uiPassword = "lab-password-1";

describe("docker worker", () => {
  it("slices the 20 mm cube in a server container and a worker container", async (t) => {
    if (!enabled) {
      t.skip("Set SCYTH3D_DOCKER_E2E=1 to build and run the containers.");
      return;
    }
    const docker = process.env.DOCKER?.split(" ") ?? ["docker"];
    await run(docker, ["build", "-t", "scyth3d-server", "--target", "server", "."], process.cwd());
    await run(docker, ["build", "-t", "scyth3d-worker", "--target", "worker", "."], process.cwd());
    const serverName = "scyth3d-e2e-server";
    const workerName = "scyth3d-e2e-worker";
    await run(docker, ["rm", "-f", serverName, workerName], process.cwd()).catch(() => undefined);
    try {
      await run(
        docker,
        [
          "run", "-d", "--name", serverName, "-p", "18081:8080",
          "-e", `SCYTH3D_API_KEY=${apiKey}`,
          "-e", `SCYTH3D_UI_PASSWORD=${uiPassword}`,
          "-e", `SCYTH3D_WORKER_TOKEN=${workerToken}`,
          "-e", "SCYTH3D_ALL_IN_ONE=0",
          "scyth3d-server",
        ],
        process.cwd(),
      );
      await waitForHealth();
      await run(
        docker,
        [
          "run", "-d", "--name", workerName, "--network", `container:${serverName}`,
          "-e", "SCYTH3D_SERVER_URL=http://127.0.0.1:8080",
          "-e", `SCYTH3D_WORKER_TOKEN=${workerToken}`,
          "-e", "ORCA_SLICER_BIN=/opt/orcaslicer/bin/orca-slicer",
          "-e", "ORCA_RESOURCES=/opt/orcaslicer/resources",
          "-e", "SCYTH3D_WORKER_ID=docker-shop",
          "scyth3d-worker",
        ],
        process.cwd(),
      );
      const uploaded = await fetch("http://127.0.0.1:18081/v1/models", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: form(),
      });
      assert.equal(uploaded.status, 201);
      const model = (await uploaded.json()) as { id: string };
      const response = await fetch("http://127.0.0.1:18081/v1/jobs", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          modelId: model.id,
          printerId: "bambu-a1",
          materialId: "pla",
          supports: false,
          wait: true,
        }),
      });
      const job = (await response.json()) as { status: string; result?: { filamentGrams: number }; error?: { message: string } };
      assert.equal(response.status, 200, JSON.stringify(job));
      assert.equal(job.status, "done", job.error?.message);
      assert.ok((job.result?.filamentGrams ?? 0) > 3);
      const workers = (await (await fetch("http://127.0.0.1:18081/v1/workers", { headers: { authorization: `Bearer ${apiKey}` } })).json()) as { online: boolean };
      assert.equal(workers.online, true);
    } finally {
      await run(docker, ["rm", "-f", serverName, workerName], process.cwd()).catch(() => undefined);
    }
  });
});

function form(): FormData {
  const body = new FormData();
  body.set("file", new Blob([cube]), "cube20.stl");
  return body;
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:18081/health");
      if (response.ok) return;
    } catch {
      // The container is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The server container did not become healthy.");
}

function run(command: string[], args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0] ?? "docker", [...command.slice(1), ...args], { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command.join(" ")} ${args.join(" ")} exited ${code}`));
    });
  });
}
