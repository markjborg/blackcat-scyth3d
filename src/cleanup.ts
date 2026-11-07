import { stat } from "node:fs/promises";
import { isActive } from "./jobs/lease.js";
import type { Store } from "./store.js";

export async function cleanupExpired(store: Store, ttlMs: number, now = Date.now()): Promise<number> {
  const jobs = await store.listJobs();
  const protectedModels = new Set(jobs.filter((job) => isActive(job.status)).map((job) => job.modelId));
  let removed = 0;
  for (const job of jobs) {
    if (isActive(job.status)) continue;
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

/** A restart drops in-progress claims. Queued jobs stay queued for the next worker. */
export async function requeueInProgress(store: Store): Promise<number> {
  const jobs = await store.listJobs();
  let changed = 0;
  for (const job of jobs) {
    if (job.status !== "claimed" && job.status !== "slicing" && job.status !== "running") continue;
    job.status = "queued";
    job.claim = undefined;
    job.updatedAt = new Date().toISOString();
    await store.saveJob(job);
    changed += 1;
  }
  return changed;
}

export async function failInterruptedJobs(store: Store): Promise<number> {
  return requeueInProgress(store);
}

async function olderThan(dir: string, ttlMs: number, now: number): Promise<boolean> {
  try {
    const info = await stat(dir);
    return now - info.mtimeMs >= ttlMs;
  } catch {
    return false;
  }
}
