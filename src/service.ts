import { randomUUID } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./errors.js";
import { parseModel } from "./mesh/parse.js";
import { claimJob, extendLease, releaseLease } from "./jobs/lease.js";
import { WorkerRegistry } from "./jobs/registry.js";
import { quoteLines, RESIN_DENSITY_G_PER_ML, type Quote, type QuoteLineInput } from "./pricing.js";
import { findPrinter, resolveFdm, type Printer, type ResolvedFdm } from "./profiles/catalog.js";
import { TaskQueue } from "./queue.js";
import type { Config } from "./config.js";
import { Store, type JobRecord, type JobResult, type ModelRecord } from "./store.js";
import type { SliceRequest, SlicerEngine } from "./slicer/orca.js";
import { sliceFleetPlates, zipJobOutput } from "./slicer/plates.js";
import { sliceSl1s } from "./slicer/resin.js";

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
  readonly workers = new WorkerRegistry();
  private readonly claimLock = new Mutex();
  private queueWaiters: Array<() => void> = [];

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
    if (!this.config.allInOne) return this.enqueue(job, wait);
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
      status: "done",
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

  async preparePlates(
    input: {
      printerId: string;
      materialId: string;
      infillPercent?: number;
      supports?: boolean;
      models: Array<{ modelId: string; quantity: number }>;
    },
    wait: boolean,
  ): Promise<JobRecord> {
    if (input.models.length === 0) throw new ApiError(400, "empty_plate", "Add at least one model.");
    const printer = findPrinterSafe(input.printerId);
    if (!printer.fleet) {
      throw new ApiError(400, "not_in_fleet", `${printer.name} is not part of the plate-preparation fleet.`);
    }
    const expanded = await this.expandModels(input.models);
    const primary = expanded[0];
    if (!primary) throw new ApiError(400, "empty_plate", "Add at least one model.");
    const job: JobRecord = {
      id: randomUUID(),
      type: "plates",
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      modelId: primary.model.id,
      request: {
        printerId: input.printerId,
        materialId: input.materialId,
        infillPercent: input.infillPercent,
        supports: input.supports,
        models: expanded.map((item) => ({ modelId: item.model.id, quantity: item.quantity, filename: item.model.filename })),
      },
    };
    await this.store.saveJob(job);
    if (!this.config.allInOne) return this.enqueue(job, wait);
    const task = this.queue.run(async () => {
      const current = await this.store.readJob(job.id);
      current.status = "slicing";
      current.updatedAt = new Date().toISOString();
      await this.store.saveJob(current);
      try {
        const inputDir = path.join(this.store.jobDir(job.id), "input");
        await mkdir(inputDir, { recursive: true });
        const paths: string[] = [];
        let copyIndex = 0;
        for (const item of expanded) {
          for (let i = 0; i < item.quantity; i += 1) {
            copyIndex += 1;
            const dest = path.join(inputDir, `${copyIndex}-${item.model.filename}`);
            await copyFile(this.store.modelFile(item.model), dest);
            paths.push(dest);
          }
        }
        if (printer.quotingPack && (input.materialId === "pla" || input.materialId === "petg")) {
          const sliced = await sliceFleetPlates({
            orcaBin: this.config.orcaBin,
            printer,
            materialId: input.materialId,
            modelPaths: paths,
            workDir: this.store.jobDir(job.id),
            infillPercent: input.infillPercent,
            supports: input.supports,
            timeoutMs: this.config.sliceTimeoutMs,
          });
          const outputDir = path.join(this.store.jobDir(job.id), "output");
          const first = sliced.plates[0];
          if (!first) throw new ApiError(422, "slice_failed", "OrcaSlicer produced no plates.");
          await copyFile(path.join(outputDir, first.gcodeName), this.store.gcodeFile(job.id));
          await copyFile(path.join(outputDir, sliced.projectName), this.store.threeMfFile(job.id));
          if (sliced.plates.length === 1) {
            await copyFile(path.join(outputDir, sliced.projectName), path.join(outputDir, "plate_1.gcode.3mf"));
          }
          await writeFile(path.join(outputDir, "archive.zip"), await zipJobOutput(outputDir));
          current.status = "done";
          current.result = {
            filamentGrams: sliced.filamentGrams,
            grams: sliced.filamentGrams,
            printTimeSeconds: sliced.printTimeSeconds,
            printTimeText: formatDuration(sliced.printTimeSeconds),
            layerCount: sliced.plates[0]?.layerCount,
            engine: "OrcaSlicer 2.4.2",
            warnings: sliced.warnings,
            plates: sliced.plates.map((plate) => ({
              index: plate.index,
              filamentGrams: plate.filamentGrams,
              resinMl: null,
              printTimeSeconds: plate.printTimeSeconds,
              printTimeText: plate.printTimeText,
              layerCount: plate.layerCount,
              gcodeName: plate.gcodeName,
              previewName: plate.previewName,
              printerFile: sliced.plates.length === 1 ? "plate_1.gcode.3mf" : undefined,
            })),
          };
          current.outputs = { gcode: true, threeMf: true, archive: true };
          current.quote = quoteLines([{ materialId: input.materialId, grams: sliced.filamentGrams, note: `${sliced.plates.length} plate(s)` }]);
        } else if (printer.resinOutput === "sl1s") {
          if (!this.config.prusaBin) {
            throw new ApiError(500, "slicer_missing", "PRUSA_SLICER_BIN is not set, so no .sl1s file was produced.");
          }
          if (input.materialId !== "standard-resin" && input.materialId !== "high-quality-resin") {
            throw new ApiError(400, "unknown_material", "Resin plates use standard-resin or high-quality-resin.");
          }
          const sliced = await sliceSl1s({
            prusaBin: this.config.prusaBin,
            modelPaths: paths,
            workDir: this.store.jobDir(job.id),
            timeoutMs: this.config.sliceTimeoutMs,
          });
          const density = RESIN_DENSITY_G_PER_ML[input.materialId] ?? 1.1;
          const grams = round3(sliced.resinMl * density);
          const outputDir = path.join(this.store.jobDir(job.id), "output");
          await writeFile(path.join(outputDir, "archive.zip"), await zipJobOutput(outputDir));
          current.status = "done";
          current.result = {
            volumeMl: sliced.resinMl,
            grams,
            densityGPerMl: density,
            printTimeSeconds: sliced.printTimeSeconds,
            printTimeText: sliced.printTimeText,
            layerCount: sliced.layerCount,
            engine: "PrusaSlicer 2.8.1 SLA",
            warnings: sliced.warnings,
            plates: [
              {
                index: 1,
                filamentGrams: null,
                resinMl: sliced.resinMl,
                printTimeSeconds: sliced.printTimeSeconds,
                printTimeText: sliced.printTimeText,
                layerCount: sliced.layerCount,
                previewName: sliced.previewName,
                printerFile: sliced.printerFileName,
              },
            ],
          };
          current.outputs = { gcode: false, threeMf: false, archive: true };
          current.quote = quoteLines([{ materialId: input.materialId, grams, note: "sliced resin including supports" }]);
        } else if (printer.technology === "resin") {
          throw new ApiError(
            422,
            "resin_format_unavailable",
            `${printer.note ?? `${printer.name} has no printer-ready output in this build.`} No .goo or .ctb file was written.`,
          );
        } else {
          throw new ApiError(400, "not_in_fleet", `${printer.name} cannot prepare plates.`);
        }
      } catch (error) {
        current.status = "failed";
        current.error =
          error instanceof ApiError
            ? { code: error.code, message: error.message }
            : { code: "slice_failed", message: error instanceof Error ? error.message : "Plate preparation failed." };
      }
      current.updatedAt = new Date().toISOString();
      await this.store.saveJob(current);
      return current;
    });
    if (!wait) {
      task.catch((error: unknown) => console.error("plate job failed", job.id, error instanceof Error ? error.message : error));
      return job;
    }
    return task;
  }

  workerStatus(): { mode: "all-in-one" | "queue"; online: boolean; workers: Array<{ id: string; lastSeenAt: string }> } {
    return {
      mode: this.config.allInOne ? "all-in-one" : "queue",
      online: this.config.allInOne || this.workers.online(this.config.workerOfflineMs),
      workers: this.workers.list(this.config.workerOfflineMs),
    };
  }

  heartbeat(workerId: string, jobId?: string): void {
    this.workers.beat(workerId);
    if (!jobId) return;
    void this.touchLease(workerId, jobId, "slicing");
  }

  async claim(workerId: string, waitMs: number): Promise<JobRecord | null> {
    this.workers.beat(workerId);
    const deadline = Date.now() + Math.max(0, Math.min(waitMs, 25_000));
    for (;;) {
      const claimed = await this.claimLock.run(() => this.tryClaim(workerId));
      if (claimed) return claimed;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await this.waitForWork(Math.min(remaining, 1000));
    }
  }

  async markSlicing(workerId: string, jobId: string): Promise<JobRecord> {
    this.workers.beat(workerId);
    const updated = await this.touchLease(workerId, jobId, "slicing");
    if (!updated) throw new ApiError(409, "lease_lost", "This job is no longer claimed by that worker.");
    return updated;
  }

  async completeJob(workerId: string, jobId: string, manifest: JobResult, files: Array<{ name: string; data: Buffer }>): Promise<JobRecord> {
    this.workers.beat(workerId);
    const job = await this.ownedJob(workerId, jobId);
    const outputDir = path.join(this.store.jobDir(job.id), "output");
    await mkdir(outputDir, { recursive: true });
    for (const file of files) {
      const name = path.basename(file.name);
      if (!name || name !== file.name.replace(/\\/g, "/").split("/").pop()) {
        throw new ApiError(400, "bad_filename", "Result files need a plain filename.");
      }
      await writeFile(path.join(outputDir, name), file.data);
      if (name === "plate_1.gcode") await writeFile(this.store.gcodeFile(job.id), file.data);
      if (name === "print.3mf" || name === "project.gcode.3mf") await writeFile(this.store.threeMfFile(job.id), file.data);
    }
    const density = RESIN_DENSITY_G_PER_ML[job.request.materialId as "standard-resin"];
    const grams =
      manifest.filamentGrams ??
      (manifest.volumeMl && density ? round3(manifest.volumeMl * density) : manifest.grams);
    job.status = "done";
    job.claim = undefined;
    job.result = manifest;
    job.error = undefined;
    job.outputs = {
      gcode: files.some((file) => file.name.endsWith(".gcode")),
      threeMf: files.some((file) => file.name.endsWith(".3mf")),
      archive: files.some((file) => file.name.endsWith(".zip") || file.name.endsWith(".sl1") || file.name.endsWith(".sl1s")),
    };
    if (grams && grams > 0) {
      job.quote = quoteLines([{ materialId: job.request.materialId, grams, note: "sliced by the shop worker" }]);
    }
    job.updatedAt = new Date().toISOString();
    await this.store.saveJob(job);
    return job;
  }

  async failJob(workerId: string, jobId: string, message: string): Promise<JobRecord> {
    const job = await this.ownedJob(workerId, jobId);
    job.status = "failed";
    job.claim = undefined;
    job.error = { code: "slice_failed", message: message.slice(0, 500) };
    job.updatedAt = new Date().toISOString();
    await this.store.saveJob(job);
    return job;
  }

  async reapLeases(now = Date.now()): Promise<number> {
    return this.claimLock.run(async () => {
      let changed = 0;
      for (const job of await this.store.listJobs()) {
        const next = releaseLease(job, now);
        if (next === job || (next.status === job.status && next.claim === job.claim)) continue;
        await this.store.saveJob(next);
        changed += 1;
      }
      if (changed > 0) this.poke();
      return changed;
    });
  }

  private async enqueue(job: JobRecord, wait: boolean): Promise<JobRecord> {
    this.poke();
    if (!wait) return job;
    return this.waitUntilSettled(job.id);
  }

  private async waitUntilSettled(jobId: string): Promise<JobRecord> {
    const deadline = Date.now() + (this.workers.online(this.config.workerOfflineMs) ? this.config.sliceTimeoutMs : this.config.queueWaitMs);
    for (;;) {
      const job = await this.store.readJob(jobId);
      if (job.status === "done" || job.status === "succeeded" || job.status === "failed") return job;
      if (Date.now() >= deadline) return job;
      await this.waitForWork(300);
    }
  }

  private async tryClaim(workerId: string): Promise<JobRecord | null> {
    const now = Date.now();
    const jobs = await this.store.listJobs();
    for (const job of jobs) {
      const released = releaseLease(job, now);
      if (released !== job) await this.store.saveJob(released);
    }
    const waiting = (await this.store.listJobs())
      .filter((job) => job.status === "queued" && (job.type === "fdm" || job.type === "plates"))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const next = waiting[0];
    if (!next) return null;
    const claimed = claimJob(next, workerId, now, this.config.leaseMs);
    await this.store.saveJob(claimed);
    return claimed;
  }

  private async touchLease(workerId: string, jobId: string, status: "claimed" | "slicing"): Promise<JobRecord | null> {
    return this.claimLock.run(async () => {
      const job = await this.store.readJob(jobId);
      const next = extendLease(job, workerId, Date.now(), this.config.leaseMs, status);
      if (!next) return null;
      await this.store.saveJob(next);
      return next;
    });
  }

  private async ownedJob(workerId: string, jobId: string): Promise<JobRecord> {
    const job = await this.store.readJob(jobId);
    if (job.claim?.workerId !== workerId || (job.status !== "claimed" && job.status !== "slicing")) {
      throw new ApiError(409, "lease_lost", "This job is no longer claimed by that worker.");
    }
    return job;
  }

  private poke(): void {
    const waiters = this.queueWaiters;
    this.queueWaiters = [];
    for (const wake of waiters) wake();
  }

  private waitForWork(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const wake = () => {
        clearTimeout(timer);
        this.queueWaiters = this.queueWaiters.filter((item) => item !== wake);
        resolve();
      };
      timer = setTimeout(wake, ms);
      this.queueWaiters.push(wake);
    });
  }

  private async expandModels(models: Array<{ modelId: string; quantity: number }>): Promise<Array<{ model: ModelRecord; quantity: number }>> {
    let total = 0;
    const expanded: Array<{ model: ModelRecord; quantity: number }> = [];
    for (const item of models) {
      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 40) {
        throw new ApiError(400, "invalid_quantity", "Quantity must be a whole number from 1 to 40.");
      }
      total += item.quantity;
      if (total > 40) throw new ApiError(400, "too_many_objects", "A plate job can hold at most 40 objects.");
      expanded.push({ model: await this.store.readModel(item.modelId), quantity: item.quantity });
    }
    return expanded;
  }

  private async executeSlice(jobId: string, model: ModelRecord, selection: ResolvedFdm, input: SliceInput): Promise<JobRecord> {
    const job = await this.store.readJob(jobId);
    job.status = "slicing";
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
      job.status = "done";
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

export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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

function findPrinterSafe(id: string): Printer {
  const printer = findPrinter(id);
  if (!printer) throw new ApiError(400, "unknown_printer", `Unknown printer '${id}'.`);
  return printer;
}

function formatDuration(seconds: number): string {
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${rest}s`;
  return `${minutes}m ${rest}s`;
}

function safeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "model";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
  return cleaned || "model";
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
