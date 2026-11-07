import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { writeFile } from "node:fs/promises";
import type { SliceRequest, SliceResult, SlicerEngine } from "../src/slicer/orca.js";
import { api, parseMcp, startApp, TEST_API_KEY } from "./helpers.js";

const UI_PASSWORD = "lab-password-1";

describe("browser session", () => {
  it("does not put the API key in the web sources or the built UI", () => {
    const sources = walk(path.join(process.cwd(), "web"));
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      assert.equal(text.includes("SCYTH3D_API_KEY"), false, file);
      assert.equal(text.includes(TEST_API_KEY), false, file);
    }
    const built = path.join(process.cwd(), "public");
    if (statOrNull(built)?.isDirectory()) {
      for (const file of walk(built)) {
        if (!/\.(html|js|css)$/.test(file)) continue;
        const text = readFileSync(file, "utf8");
        assert.equal(text.includes("SCYTH3D_API_KEY"), false, file);
        assert.equal(text.includes(TEST_API_KEY), false, file);
      }
    }
  });

  it("signs in with the UI password and keeps the API key on MCP", async () => {
    const app = await startApp(new StubSlicer(), { SCYTH3D_UI_PASSWORD: UI_PASSWORD });
    try {
      const loginPage = await fetch(`${app.baseUrl}/login`);
      assert.equal(loginPage.status, 200);
      const loginHtml = await loginPage.text();
      assert.equal(loginHtml.includes(TEST_API_KEY), false);
      assert.match(loginHtml, /BlackCat MakerLab/);
      assert.equal(loginHtml.includes("Scyth3d"), false);

      const wrong = await fetch(`${app.baseUrl}/login`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ password: "not-the-password" }),
      });
      assert.equal(wrong.status, 401);

      const signed = await fetch(`${app.baseUrl}/login`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ password: UI_PASSWORD }),
      });
      assert.equal(signed.status, 200);
      const cookie = sessionCookie(signed);
      assert.match(cookie, /^scyth3d_session=/);

      const printers = await fetch(`${app.baseUrl}/v1/printers`, { headers: { cookie } });
      assert.equal(printers.status, 200);

      const home = await fetch(`${app.baseUrl}/`, {
        headers: { cookie, accept: "text/html" },
        redirect: "manual",
      });
      assert.equal(home.status, 200);
      assert.match(await home.text(), /BlackCat MakerLab/);

      const anonymous = await fetch(`${app.baseUrl}/`, {
        headers: { accept: "text/html" },
        redirect: "manual",
      });
      assert.equal(anonymous.status, 302);
      assert.equal(anonymous.headers.get("location"), "/login");

      const mcp = await fetch(`${app.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(mcp.status, 401);

      const uploaded = await fetch(`${app.baseUrl}/v1/models`, {
        method: "POST",
        headers: { cookie },
        body: stlForm(),
      });
      assert.equal(uploaded.status, 201);
      const model = (await uploaded.json()) as { id: string };
      const sliced = await fetch(`${app.baseUrl}/v1/jobs`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          modelId: model.id,
          printerId: "bambu-a1",
          materialId: "pla",
          profileId: "0.20mm-standard",
          wait: true,
        }),
      });
      assert.equal(sliced.status, 200);
      const job = (await sliced.json()) as { id: string; result: { filamentGrams: number } };

      const viaKey = await api(app.baseUrl, `/v1/jobs/${job.id}`);
      assert.equal(viaKey.status, 200);
      const body = (await viaKey.json()) as { id: string; result: { filamentGrams: number } };
      assert.equal(body.id, job.id);
      assert.equal(body.result.filamentGrams, 3.67);

      const tool = await fetch(`${app.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "get_job", arguments: { jobId: job.id } },
        }),
      });
      assert.equal(tool.status, 200);
      assert.match(toolText(parseMcp(await tool.text())), new RegExp(job.id));
    } finally {
      await app.close();
    }
  });
});

function sessionCookie(response: Response): string {
  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  const raw = cookies[0] ?? response.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

function stlForm(): FormData {
  const form = new FormData();
  form.set("file", new Blob([readFileSync(new URL("../samples/cube20.stl", import.meta.url))]), "cube20.stl");
  return form;
}

function toolText(message: unknown): string {
  const content = (message as { result?: { content?: Array<{ text?: string }> } }).result?.content ?? [];
  return content.map((block) => block.text ?? "").join("\n");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function statOrNull(file: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

class StubSlicer implements SlicerEngine {
  async slice(request: SliceRequest): Promise<SliceResult> {
    await writeFile(`${request.workDir}/plate_1.gcode`, "; total estimated time: 20m 12s\n; total layer number: 100\n; filament used [g] = 3.67\n");
    await writeFile(`${request.workDir}/print.3mf`, Buffer.from([0x50, 0x4b]));
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
