import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./errors.js";
import type { MeshSummary } from "./mesh/parse.js";
import type { Quote } from "./pricing.js";

export interface ModelRecord {
  id: string;
  filename: string;
  format: MeshSummary["format"];
  sizeBytes: number;
  triangleCount: number;
  dimensionsMm: MeshSummary["dimensionsMm"];
  boundingBoxMm: MeshSummary["boundingBoxMm"];
  volumeMl: number;
  volumeMm3: number;
  createdAt: string;
}

export interface JobResult {
  filamentGrams?: number;
  filamentVolumeCm3?: number | null;
  filamentLengthMm?: number | null;
  printTimeSeconds?: number;
  printTimeText?: string;
  modelPrintTimeText?: string | null;
  layerCount?: number;
  dimensionsMm?: { x: number; y: number; z: number } | null;
  boundingBoxMm?: MeshSummary["boundingBoxMm"] | null;
  meshVolumeMm3?: number | null;
  volumeMl?: number;
  grams?: number;
  densityGPerMl?: number;
  manifold?: boolean | null;
  engine?: string;
  bedType?: string;
  warnings?: string[];
  plates?: PlateResult[];
}

export interface PlateResult {
  index: number;
  filamentGrams: number | null;
  resinMl: number | null;
  printTimeSeconds: number;
  printTimeText: string;
  layerCount: number;
  gcodeName?: string;
  previewName: string;
  printerFile?: string;
}

export interface JobClaim {
  workerId: string;
  claimedAt: string;
  leaseExpiresAt: string;
}

export interface JobRecord {
  id: string;
  type: "fdm" | "resin" | "plates";
  /** queued and claimed wait on a worker. slicing is in progress. done is finished. running and succeeded are older names. */
  status: "queued" | "claimed" | "slicing" | "running" | "done" | "succeeded" | "failed";
  createdAt: string;
  updatedAt: string;
  attempts?: number;
  claim?: JobClaim;
  modelId: string;
  request: {
    printerId: string;
    materialId: string;
    profileId?: string;
    infillPercent?: number;
    supports?: boolean;
    models?: Array<{ modelId: string; quantity: number; filename: string }>;
  };
  result?: JobResult;
  quote?: Quote;
  error?: { code: string; message: string };
  outputs?: { gcode: boolean; threeMf: boolean; archive?: boolean };
}

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Store {
  constructor(readonly root: string) {}

  async init(): Promise<void> {
    await mkdir(this.modelsDir(), { recursive: true });
    await mkdir(this.jobsDir(), { recursive: true });
  }

  modelDir(id: string): string {
    return path.join(this.modelsDir(), assertId(id));
  }

  jobDir(id: string): string {
    return path.join(this.jobsDir(), assertId(id));
  }

  modelFile(model: ModelRecord): string {
    return path.join(this.modelDir(model.id), `model.${model.format}`);
  }

  gcodeFile(jobId: string): string {
    return path.join(this.jobDir(jobId), "plate_1.gcode");
  }

  threeMfFile(jobId: string): string {
    return path.join(this.jobDir(jobId), "print.3mf");
  }

  async saveModel(record: ModelRecord, bytes: Buffer): Promise<void> {
    const dir = this.modelDir(record.id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `model.${record.format}`), bytes);
    await writeJson(path.join(dir, "meta.json"), record);
  }

  async readModel(id: string): Promise<ModelRecord> {
    try {
      return JSON.parse(await readFile(path.join(this.modelDir(id), "meta.json"), "utf8")) as ModelRecord;
    } catch {
      throw new ApiError(404, "model_not_found", `No model with id ${id}.`);
    }
  }

  async readModelBytes(model: ModelRecord): Promise<Buffer> {
    return readFile(this.modelFile(model));
  }

  async saveJob(job: JobRecord): Promise<void> {
    const dir = this.jobDir(job.id);
    await mkdir(dir, { recursive: true });
    await writeJson(path.join(dir, "job.json"), job);
  }

  async readJob(id: string): Promise<JobRecord> {
    try {
      return JSON.parse(await readFile(path.join(this.jobDir(id), "job.json"), "utf8")) as JobRecord;
    } catch {
      throw new ApiError(404, "job_not_found", `No job with id ${id}.`);
    }
  }

  async listJobs(): Promise<JobRecord[]> {
    return this.readRecords(this.jobsDir(), "job.json");
  }

  async listModels(): Promise<ModelRecord[]> {
    return this.readRecords(this.modelsDir(), "meta.json");
  }

  async removeJob(id: string): Promise<void> {
    await rm(this.jobDir(id), { recursive: true, force: true });
  }

  async removeModel(id: string): Promise<void> {
    await rm(this.modelDir(id), { recursive: true, force: true });
  }

  private modelsDir(): string {
    return path.join(this.root, "models");
  }

  private jobsDir(): string {
    return path.join(this.root, "jobs");
  }

  private async readRecords<T>(dir: string, file: string): Promise<T[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const records: T[] = [];
    for (const name of names) {
      if (!ID_PATTERN.test(name)) continue;
      try {
        records.push(JSON.parse(await readFile(path.join(dir, name, file), "utf8")) as T);
      } catch {
        // Skip a directory that lost its metadata.
      }
    }
    return records;
  }
}

export function assertId(id: string): string {
  if (!ID_PATTERN.test(id)) {
    throw new ApiError(400, "invalid_id", "Ids are UUIDs.");
  }
  return id;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  const { rename } = await import("node:fs/promises");
  await rename(tmp, file);
}
