import type { JobRecord } from "../store.js";

export const MAX_CLAIM_ATTEMPTS = 3;

export function isActive(status: JobRecord["status"]): boolean {
  return status === "queued" || status === "claimed" || status === "slicing" || status === "running";
}

export function isDone(status: JobRecord["status"]): boolean {
  return status === "done" || status === "succeeded";
}

export function leaseExpired(job: JobRecord, now: number): boolean {
  if (job.status !== "claimed" && job.status !== "slicing" && job.status !== "running") return false;
  const expires = job.claim?.leaseExpiresAt;
  if (!expires) return true;
  return Date.parse(expires) <= now;
}

/** Return the job to the queue, or fail it after too many dropped leases. */
export function releaseLease(job: JobRecord, now: number): JobRecord {
  if (!leaseExpired(job, now)) return job;
  const attempts = job.attempts ?? 1;
  if (attempts >= MAX_CLAIM_ATTEMPTS) {
    return {
      ...job,
      status: "failed",
      claim: undefined,
      updatedAt: new Date(now).toISOString(),
      error: { code: "lease_expired", message: "The shop worker stopped before the slice finished." },
    };
  }
  return {
    ...job,
    status: "queued",
    claim: undefined,
    updatedAt: new Date(now).toISOString(),
  };
}

export function claimJob(job: JobRecord, workerId: string, now: number, leaseMs: number): JobRecord {
  const attempts = (job.attempts ?? 0) + 1;
  return {
    ...job,
    status: "claimed",
    attempts,
    claim: {
      workerId,
      claimedAt: new Date(now).toISOString(),
      leaseExpiresAt: new Date(now + leaseMs).toISOString(),
    },
    updatedAt: new Date(now).toISOString(),
    error: undefined,
  };
}

export function extendLease(job: JobRecord, workerId: string, now: number, leaseMs: number, status: "claimed" | "slicing"): JobRecord | null {
  if (job.claim?.workerId !== workerId) return null;
  if (job.status !== "claimed" && job.status !== "slicing" && job.status !== "running") return null;
  return {
    ...job,
    status,
    claim: {
      workerId,
      claimedAt: job.claim.claimedAt,
      leaseExpiresAt: new Date(now + leaseMs).toISOString(),
    },
    updatedAt: new Date(now).toISOString(),
  };
}
