import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseMcp, startApp, TEST_API_KEY } from "./helpers.js";
import type { SliceRequest, SliceResult, SlicerEngine } from "../src/slicer/orca.js";
import { writeFile } from "node:fs/promises";

const cube = readFileSync(new URL("../samples/cube20.stl", import.meta.url));

describe("MCP", () => {
  it("lists tools and quotes over streamable HTTP", async () => {
    const app = await startApp(new NoopSlicer());
    try {
      const denied = await fetch(`${app.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(denied.status, 401);

      const listed = await callTool(app.baseUrl, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      const names = toolNames(listed);
      for (const name of ["slice_model", "estimate_resin", "list_profiles", "get_job", "quote"]) {
        assert.ok(names.includes(name), `missing tool ${name} in ${names.join(", ")}`);
      }

      const quoted = await callTool(app.baseUrl, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "quote", arguments: { lines: [{ materialId: "pla", grams: 3.67 }] } },
      });
      const text = toolText(quoted);
      assert.match(text, /11\.8/);

      const estimated = await callTool(app.baseUrl, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "estimate_resin",
          arguments: {
            filename: "cube20.stl",
            base64: cube.toString("base64"),
            materialId: "high-quality-resin",
          },
        },
      });
      const resinText = toolText(estimated);
      assert.match(resinText, /9\.2/);
      assert.match(resinText, /High Quality Resin/);
    } finally {
      await app.close();
    }
  });
});

async function callTool(baseUrl: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TEST_API_KEY}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text.slice(0, 500));
  return parseMcp(text);
}

function toolNames(message: unknown): string[] {
  const result = (message as { result?: { tools?: Array<{ name: string }> } }).result;
  return result?.tools?.map((tool) => tool.name) ?? [];
}

function toolText(message: unknown): string {
  const content = (message as { result?: { content?: Array<{ text?: string }> } }).result?.content ?? [];
  return content.map((block) => block.text ?? "").join("\n");
}

class NoopSlicer implements SlicerEngine {
  async slice(_request: SliceRequest): Promise<SliceResult> {
    await writeFile(`${_request.workDir}/plate_1.gcode`, "; noop\n");
    await writeFile(`${_request.workDir}/print.3mf`, "PK");
    throw new Error("not used");
  }
}
