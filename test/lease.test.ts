import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claimJob, extendLease, leaseExpired, releaseLease } from "../src/jobs/lease.js";
import type { JobRecord } from "../src/store.js";

const now = Date.parse("2026-11-07T00:00:00.000Z");

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    type: "fdm",
    status: "queued",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    modelId: "22222222-2222-4222-8222-222222222222",
    request: { printerId: "bambu-a1", materialId: "pla" },
    ...overrides,
  };
}

describe("job leases", () => {
  it("claims a queued job and stamps a lease", () => {
    const claimed = claimJob(job(), "shop-mac", now, 60_000);
    assert.equal(claimed.status, "claimed");
    assert.equal(claimed.attempts, 1);
    assert.equal(claimed.claim?.workerId, "shop-mac");
    assert.equal(leaseExpired(claimed, now + 59_000), false);
    assert.equal(leaseExpired(claimed, now + 60_000), true);
  });

  it("requeues a dropped lease and fails after three attempts", () => {
    let current = claimJob(job(), "shop-mac", now, 1_000);
    current = releaseLease(current, now + 1_000);
    assert.equal(current.status, "queued");
    assert.equal(current.attempts, 1);
    current = claimJob(current, "shop-pc", now + 2_000, 1_000);
    current = releaseLease(current, now + 3_000);
    assert.equal(current.status, "queued");
    current = claimJob(current, "shop-pc", now + 4_000, 1_000);
    current = releaseLease(current, now + 5_000);
    assert.equal(current.status, "failed");
    assert.equal(current.error?.code, "lease_expired");
  });

  it("extends a lease only for the worker that holds it", () => {
    const claimed = claimJob(job(), "shop-mac", now, 1_000);
    const extended = extendLease(claimed, "shop-mac", now + 500, 60_000, "slicing");
    assert.equal(extended?.status, "slicing");
    assert.equal(leaseExpired(extended!, now + 30_000), false);
    assert.equal(extendLease(claimed, "other", now, 60_000, "slicing"), null);
  });
});
