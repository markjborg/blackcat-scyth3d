export interface WorkerPresence {
  id: string;
  lastSeenAt: string;
}

/** In-memory heartbeats. A worker is online while its last heartbeat is fresh. */
export class WorkerRegistry {
  private readonly workers = new Map<string, number>();

  beat(id: string, now = Date.now()): void {
    const clean = id.trim().slice(0, 80);
    if (!clean) return;
    this.workers.set(clean, now);
  }

  online(offlineAfterMs: number, now = Date.now()): boolean {
    for (const seen of this.workers.values()) {
      if (now - seen <= offlineAfterMs) return true;
    }
    return false;
  }

  list(offlineAfterMs: number, now = Date.now()): WorkerPresence[] {
    const present: WorkerPresence[] = [];
    for (const [id, seen] of this.workers) {
      if (now - seen > offlineAfterMs) continue;
      present.push({ id, lastSeenAt: new Date(seen).toISOString() });
    }
    return present.sort((a, b) => a.id.localeCompare(b.id));
  }
}
