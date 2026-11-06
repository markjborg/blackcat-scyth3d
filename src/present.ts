import type { JobRecord } from "./store.js";

export function presentJob(job: JobRecord): JobRecord & { downloads?: { gcode: string; threeMf: string } } {
  const downloads =
    job.status === "succeeded" && job.outputs?.gcode
      ? { gcode: `/v1/jobs/${job.id}/gcode`, threeMf: `/v1/jobs/${job.id}/3mf` }
      : undefined;
  return { ...job, downloads };
}
