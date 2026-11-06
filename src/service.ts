import { randomUUID } from "node:crypto";
import { ApiError } from "./errors.js";
import { parseModel } from "./mesh/parse.js";
import { quoteLines, RESIN_DENSITY_G_PER_ML, type Quote, type QuoteLineInput } from "./pricing.js";
import { resolveFdm, type ResolvedFdm } from "./profiles/catalog.js";
import { TaskQueue } from "./queue.js";
import type { Config } from "./config.js";
import { Store, type JobRecord, type ModelRecord } from "./store.js";
import type { SliceRequest, SlicerEngine } from "./slicer/orca.js";

export interface SliceInput {
  modelId: string;
  printerId: string;
  materialId: string;
  profileId?: string;
  infillPercent?: number;
  supports?: boolean;
}

export class ScythService {
  private readonly queue: TaskQueue;

  constructor(
    readonly config: Config,
    readonly store: Store,
    private readonly slicer: SlicerEngine,
  ) {
    this.queue = new TaskQueue(config.maxConcurrentSlices);
  }

  async upload(filename: string, bytes: Buffer): Promise<ModelRecord> {
    if (bytes.length > this.config.maxUploadBytes) {
      throw new ApiError(413, "file_too_large", `File exceeds the upload limit of ${this.config.maxUploadBytes} bytes.`);
    }
    const summary = parseModel(filename, bytes);
    const record: ModelRecord = {
      id: randomUUID(),
      filename: safeFilename(filename),
      format: summary.format,
      sizeBytes: bytes.length,
      triangleCount: summary.triangleCount,
      dimensionsMm: summary.dimensionsMm,
      boundingBoxMm: summary.boundingBoxMm,
      volumeMl: summary.volumeMl,
      volumeMm3: summary.volumeMm3,
      createdAt: new Date().toISOString(),
    };
    await this.store.saveModel(record, bytes);
    return record;
  }

  async uploadInline(filename: string, base64: string): Promise<ModelRecord> {
    const bytes = Buffer.from(base64, "base64");
    const limit = Math.min(this.config.maxUploadBytes, this.config.mcpInlineMaxBytes);
    if (bytes.length === 0) {
      throw new ApiError(400, "empty_file", "The inline model was empty.");
    }
    if (bytes.length > limit) {
      throw new ApiError(413, "file_too_large", `Inline models are limited to ${limit} bytes. Upload larger files with POST /v1/models.`);
    }
    return this.upload(filename, bytes);
  }

  async createSlice(input: SliceInput, wait: boolean): Promise<JobRecord> {
    const model = await this.store.readModel(input.modelId);
    const selection = selectFdm(input);
    const job: JobRecord = {
      id: randomUUID(),
      type: "fdm",
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      modelId: model.id,
      request: {
        printerId: input.printerId,
        materialId: input.materialId,
        profileId: selection.profile.id,
        infillPercent: input.infillPercent,
        supports: input.supports,
      },
    };
    await this.store.saveJob(job);
    const task = this.queue.run(() => this.executeSlice(job.id, model, selection, input));
    if (!wait) {
      task.catch((error: unknown) => {
        console.error("slice job failed", job.id, error instanceof Error ? error.message : error);
      });
      return job;
    }
    return task;
  }

  async estimateResin(modelId: string, materialId: string): Promise<JobRecord> {
    if (materialId !== "standard-resin" && materialId !== "high-quality-resin") {
      throw new ApiError(
        400,
        "unknown_material",
        "Resin estimates accept standard-resin or high-quality-resin (ABS-like, labelled High Quality Resin).",
      );
    }
    const model = await this.store.readModel(modelId);
    const density = RESIN_DENSITY_G_PER_ML[materialId];
    if (!density) {
      throw new ApiError(500, "missing_density", "Resin density is not configured.");
    }
    if (!(model.volumeMl > 0)) {
      throw new ApiError(422, "zero_volume", "The mesh volume is zero. Resin estimates need a closed solid.");
    }
    const grams = model.volumeMl * density;
    const job: JobRecord = {
      id: randomUUID(),
      type: "resin",
      status: "succeeded",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      modelId: model.id,
      request: { printerId: "resin-msla", materialId },
      result: {
        volumeMl: round3(model.volumeMl),
        grams: round3(grams),
        densityGPerMl: density,
        dimensionsMm: model.dimensionsMm,
        boundingBoxMm: model.boundingBoxMm,
        meshVolumeMm3: model.volumeMm3,
        warnings: ["Resin figures are a mesh-volume estimate, not a sliced toolpath. Hollows and drain holes count only when they are in the mesh."],
      },
      quote: quoteLines([{ materialId, grams, note: model.filename }]),
      outputs: { gcode: false, threeMf: false },
    };
    await this.store.saveJob(job);
    return job;
  }

  async quote(input: { jobId?: string; lines?: QuoteLineInput[] }): Promise<Quote> {
    if (input.jobId && input.lines) {
      throw new ApiError(400, "ambiguous_quote", "Pass a jobId or lines, not both.");
    }
    if (input.jobId) {
      const job = await this.store.readJob(input.jobId);
      if (job.quote) return job.quote;
      const grams = job.result?.filamentGrams ?? job.result?.grams;
      if (!grams) {
        throw new ApiError(409, "job_not_ready", "That job has no weight to quote yet.");
      }
      return quoteLines([{ materialId: job.request.materialId, grams, note: job.id }]);
    }
    if (!input.lines) {
      throw new ApiError(400, "empty_quote", "Pass a jobId or at least one line.");
    }
    return quoteLines(input.lines);
  }

  getJob(id: string): Promise<JobRecord> {
    return this.store.readJob(id);
  }

  getModel(id: string): Promise<ModelRecord> {
    return this.store.readModel(id);
  }

  private async executeSlice(jobId: string, model: ModelRecord, selection: ResolvedFdm, input: SliceInput): Promise<JobRecord> {
    const job = await this.store.readJob(jobId);
    job.status = "running";
    job.updatedAt = new Date().toISOString();
    await this.store.saveJob(job);
    try {
      const request: SliceRequest = {
        modelPath: this.store.modelFile(model),
        workDir: this.store.jobDir(job.id),
        machineProfile: selection.printer.machine ?? "",
        processProfile: selection.profile.process,
        filamentProfile: selection.material.filament ?? "",
        overrides: { infillPercent: input.infillPercent, supports: input.supports },
        timeoutMs: this.config.sliceTimeoutMs,
      };
      const sliced = await this.slicer.slice(request);
      job.status = "succeeded";
      job.result = {
        filamentGrams: sliced.filamentGrams,
        filamentVolumeCm3: sliced.filamentVolumeCm3,
        filamentLengthMm: sliced.filamentLengthMm,
        printTimeSeconds: sliced.printTimeSeconds,
        printTimeText: sliced.printTimeText,
        modelPrintTimeText: sliced.modelPrintTimeText,
        layerCount: sliced.layerCount,
        dimensionsMm: sliced.dimensionsMm ?? model.dimensionsMm,
        boundingBoxMm: sliced.boundingBoxMm ?? model.boundingBoxMm,
        meshVolumeMm3: sliced.meshVolumeMm3 ?? model.volumeMm3,
        manifold: sliced.manifold,
        engine: sliced.engine,
        bedType: sliced.bedType,
        warnings: sliced.warnings,
        grams: sliced.filamentGrams,
      };
      job.outputs = { gcode: true, threeMf: true };
      job.quote = quoteLines([{ materialId: input.materialId, grams: sliced.filamentGrams, note: model.filename }]);
      job.error = undefined;
    } catch (error) {
      job.status = "failed";
      job.error =
        error instanceof ApiError
          ? { code: error.code, message: error.message }
          : { code: "slice_failed", message: error instanceof Error ? error.message : "Slice failed." };
    }
    job.updatedAt = new Date().toISOString();
    await this.store.saveJob(job);
    return job;
  }
}

function selectFdm(input: SliceInput): ResolvedFdm {
  if (input.infillPercent !== undefined) {
    if (!Number.isInteger(input.infillPercent) || input.infillPercent < 0 || input.infillPercent > 100) {
      throw new ApiError(400, "invalid_infill", "infillPercent must be an integer from 0 to 100.");
    }
  }
  if (input.supports !== undefined && typeof input.supports !== "boolean") {
    throw new ApiError(400, "invalid_supports", "supports must be true or false.");
  }
  try {
    return resolveFdm(input.printerId, input.materialId, input.profileId);
  } catch (error) {
    throw new ApiError(400, "invalid_selection", error instanceof Error ? error.message : "Invalid printer, material, or profile.");
  }
}

function safeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "model";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
  return cleaned || "model";
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
