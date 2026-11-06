import { createServer } from "node:http";
import { failInterruptedJobs, cleanupExpired } from "./cleanup.js";
import { loadConfig } from "./config.js";
import { createApp } from "./http/app.js";
import { OrcaSlicer } from "./slicer/orca.js";
import { ScythService } from "./service.js";
import { Store } from "./store.js";

const config = loadConfig(process.env);
const store = new Store(config.dataDir);
await store.init();
const interrupted = await failInterruptedJobs(store);
if (interrupted > 0) {
  console.log(`Marked ${interrupted} interrupted job${interrupted === 1 ? "" : "s"} as failed.`);
}

const service = new ScythService(config, store, new OrcaSlicer(config.orcaBin, config.orcaResources));
const { app } = createApp(config, service);
const server = createServer(app);

const timer = setInterval(() => {
  cleanupExpired(store, config.jobTtlMs).catch((error: unknown) => {
    console.error("cleanup failed", error instanceof Error ? error.message : error);
  });
}, config.cleanupIntervalMs);
timer.unref();

server.listen(config.port, config.host, () => {
  console.log(`BlackCat Scyth3d ${config.version} listening on ${config.host}:${config.port}`);
});

function shutdown(): void {
  clearInterval(timer);
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
