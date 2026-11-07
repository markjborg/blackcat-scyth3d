import { createServer } from "node:http";
import { cleanupExpired, requeueInProgress } from "./cleanup.js";
import { loadConfig } from "./config.js";
import { createApp } from "./http/app.js";
import { OrcaSlicer } from "./slicer/orca.js";
import { ScythService } from "./service.js";
import { Store } from "./store.js";

const config = loadConfig(process.env);
const store = new Store(config.dataDir);
await store.init();
const requeued = await requeueInProgress(store);
if (requeued > 0) {
  console.log(`Returned ${requeued} in-progress job${requeued === 1 ? "" : "s"} to the queue.`);
}

const service = new ScythService(config, store, new OrcaSlicer(config.orcaBin, config.orcaResources));
const { app } = createApp(config, service);
const server = createServer(app);

const timer = setInterval(() => {
  service.reapLeases().catch((error: unknown) => {
    console.error("lease check failed", error instanceof Error ? error.message : error);
  });
  cleanupExpired(store, config.jobTtlMs).catch((error: unknown) => {
    console.error("cleanup failed", error instanceof Error ? error.message : error);
  });
}, Math.min(config.cleanupIntervalMs, 15_000));
timer.unref();

if (config.allInOne) {
  console.log("All-in-one mode: this server slices jobs itself.");
} else if (!config.workerToken) {
  console.log("Shop workers cannot connect until SCYTH3D_WORKER_TOKEN is set.");
}
server.listen(config.port, config.host, () => {
  console.log(`BlackCat MakerLab Slicer ${config.version} listening on ${config.host}:${config.port}`);
});

function shutdown(): void {
  clearInterval(timer);
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
