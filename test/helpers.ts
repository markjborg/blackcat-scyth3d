import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../src/config.js";
import { createApp } from "../src/http/app.js";
import { ScythService } from "../src/service.js";
import type { SlicerEngine } from "../src/slicer/orca.js";
import { OrcaSlicer } from "../src/slicer/orca.js";
import { Store } from "../src/store.js";

export const TEST_API_KEY = "test-key-123456";

export async function tempConfig(overrides: NodeJS.ProcessEnv = {}): Promise<{ config: Config; cleanup: () => Promise<void> }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "scyth3d-"));
  const config = loadConfig({
    SCYTH3D_API_KEY: TEST_API_KEY,
    SCYTH3D_DATA_DIR: dataDir,
    SCYTH3D_JOB_TTL_HOURS: "48",
    SCYTH3D_MAX_UPLOAD_MB: "20",
    ...overrides,
  });
  return { config, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

export async function startApp(slicer?: SlicerEngine, overrides: NodeJS.ProcessEnv = {}): Promise<{
  baseUrl: string;
  config: Config;
  service: ScythService;
  close: () => Promise<void>;
}> {
  const { config, cleanup } = await tempConfig(overrides);
  const store = new Store(config.dataDir);
  await store.init();
  const service = new ScythService(
    config,
    store,
    slicer ?? new OrcaSlicer(config.orcaBin, config.orcaResources),
  );
  const { app } = createApp(config, service);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    config,
    service,
    close: async () => {
      await closeServer(server);
      await cleanup();
    },
  };
}

export async function api(baseUrl: string, pathName: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${TEST_API_KEY}`);
  return fetch(`${baseUrl}${pathName}`, { ...init, headers });
}

export function parseMcp(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  const lines = [...trimmed.matchAll(/^data:\s*(.*)$/gm)].map((match) => match[1]).filter((line) => line && line !== "[DONE]");
  const last = lines.at(-1);
  if (!last) throw new Error(`Unparsed MCP response: ${trimmed.slice(0, 500)}`);
  return JSON.parse(last);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
