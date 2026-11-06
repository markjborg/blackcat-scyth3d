import { stat } from "node:fs/promises";
import type { Store } from "./store.js";

export async function cleanupExpired(store: Store, ttlMs: number, now = Date.now()): Promise<number> {
  const jobs = await store.listJobs();
  const protectedModels = new Set(
    jobs.filter((job) => job.status === "queued" || job.status === "running").map((job) => job.modelId),
  );
  let removed = 0;
  for (const job of jobs) {
    if (job.status === "queued" || job.status === "running") continue;
    if (await olderThan(store.jobDir(job.id), ttlMs, now)) {
      await store.removeJob(job.id);
      removed += 1;
    }
  }
  for (const model of await store.listModels()) {
    if (protectedModels.has(model.id)) continue;
    if (await olderThan(store.modelDir(model.id), ttlMs, now)) {
      await store.removeModel(model.id);
      removed += 1;
    }
  }
  return removed;
}

export async function failInterruptedJobs(store: Store): Promise<number> {
  const jobs = await store.listJobs();
  let changed = 0;
  for (const job of jobs) {
    if (job.status !== "queued" && job.status !== "running") continue;
    job.status = "failed";
    job.updatedAt = new Date().toISOString();
    job.error = { code: "interrupted", message: "The service restarted before this job finished." };
    await store.saveJob(job);
    changed += 1;
  }
  return changed;
}

async function olderThan(dir: string, ttlMs: number, now: number): Promise<boolean> {
  try {
    const info = await stat(dir);
    return now - info.mtimeMs >= ttlMs;
  } catch {
    return false;
  }
}
