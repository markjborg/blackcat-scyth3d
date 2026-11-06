import type { JobRecord } from "./store.js";

export function presentJob(job: JobRecord): JobRecord & {
  downloads?: { gcode?: string; threeMf?: string; archive?: string };
} {
  const downloads =
    job.status === "succeeded"
      ? {
          ...(job.outputs?.gcode
            ? { gcode: `/v1/jobs/${job.id}/gcode`, threeMf: `/v1/jobs/${job.id}/3mf` }
            : {}),
          ...(job.outputs?.archive ? { archive: `/v1/jobs/${job.id}/archive` } : {}),
        }
      : undefined;
  const plates = job.result?.plates?.map((plate) => ({
    ...plate,
    previewUrl: `/v1/jobs/${job.id}/plates/${plate.index}/preview.png`,
    gcodeUrl: plate.gcodeName ? `/v1/jobs/${job.id}/plates/${plate.index}/gcode` : undefined,
    printerFileUrl: plate.printerFile ? `/v1/jobs/${job.id}/plates/${plate.index}/printer` : undefined,
  }));
  return {
    ...job,
    result: job.result ? { ...job.result, plates } : job.result,
    downloads: downloads && Object.keys(downloads).length > 0 ? downloads : undefined,
  };
}
