import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveFdm } from "./profiles/catalog.js";
import { findPrinter } from "./profiles/catalog.js";
import { OrcaSlicer } from "./slicer/orca.js";
import { sliceFleetPlates } from "./slicer/plates.js";
import { sliceSl1s } from "./slicer/resin.js";
import type { JobResult } from "./store.js";

const serverUrl = (process.env.SCYTH3D_SERVER_URL ?? "").replace(/\/$/, "");
const token = (process.env.SCYTH3D_WORKER_TOKEN ?? "").trim();
const workerId = (process.env.SCYTH3D_WORKER_ID ?? "").trim() || `worker-${randomUUID()}`;
const orcaBin = process.env.ORCA_SLICER_BIN?.trim() || "orca-slicer";
const orcaResources = process.env.ORCA_RESOURCES?.trim() || "/opt/orcaslicer/resources";
const prusaBin = process.env.PRUSA_SLICER_BIN?.trim() || "";
const timeoutMs = Number(process.env.SCYTH3D_SLICE_TIMEOUT_SEC ?? "900") * 1000;

if (!serverUrl || !token) {
  console.error("Set SCYTH3D_SERVER_URL and SCYTH3D_WORKER_TOKEN. The token is not printed.");
  process.exit(1);
}

const slicer = new OrcaSlicer(orcaBin, orcaResources);
let stopped = false;
process.on("SIGTERM", () => {
  stopped = true;
});
process.on("SIGINT", () => {
  stopped = true;
});

console.log(`BlackCat MakerLab worker ${workerId} connecting to ${serverUrl}`);
while (!stopped) {
  try {
    await beat();
    const claimed = await claim();
    if (!claimed) {
      await sleep(1000);
      continue;
    }
    await runClaimed(claimed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Worker request failed.";
    console.error(message.includes(token) ? "Worker request failed." : message);
    await sleep(2000);
  }
}

async function runClaimed(claimed: Claimed): Promise<void> {
  const work = await mkdtemp(path.join(tmpdir(), "scyth3d-worker-"));
  const timer = setInterval(() => {
    beat(claimed.job.id).catch(() => undefined);
  }, 10_000);
  try {
    await postJson(`/v1/worker/jobs/${claimed.job.id}/slicing`, { workerId });
    const paths = await downloadModels(claimed, work);
    const { manifest, files } = await sliceClaim(claimed, paths, work);
    await upload(claimed.job.id, manifest, files);
    console.log(`Finished job ${claimed.job.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Slice failed.";
    await postJson(`/v1/worker/jobs/${claimed.job.id}/fail`, { workerId, message: message.slice(0, 500) }).catch(() => undefined);
    console.error(`Job ${claimed.job.id} failed: ${message.includes(token) ? "slice failed" : message}`);
  } finally {
    clearInterval(timer);
    await rm(work, { recursive: true, force: true });
  }
}

async function sliceClaim(claimed: Claimed, modelPaths: string[], work: string): Promise<{ manifest: JobResult; files: Array<{ name: string; data: Buffer }> }> {
  const request = claimed.job.request;
  if (claimed.job.type === "fdm") {
    const selection = resolveFdm(request.printerId, request.materialId, request.profileId);
    const sliced = await slicer.slice({
      modelPath: modelPaths[0] ?? "",
      workDir: work,
      machineProfile: selection.printer.machine ?? "",
      processProfile: selection.profile.process,
      filamentProfile: selection.material.filament ?? "",
      overrides: { infillPercent: request.infillPercent, supports: request.supports },
      timeoutMs,
    });
    const gcode = await readFile(sliced.gcodePath);
    const threeMf = await readFile(sliced.threeMfPath);
    return {
      manifest: {
        filamentGrams: sliced.filamentGrams,
        grams: sliced.filamentGrams,
        filamentVolumeCm3: sliced.filamentVolumeCm3,
        filamentLengthMm: sliced.filamentLengthMm,
        printTimeSeconds: sliced.printTimeSeconds,
        printTimeText: sliced.printTimeText,
        modelPrintTimeText: sliced.modelPrintTimeText,
        layerCount: sliced.layerCount,
        dimensionsMm: sliced.dimensionsMm,
        boundingBoxMm: sliced.boundingBoxMm,
        meshVolumeMm3: sliced.meshVolumeMm3,
        manifold: sliced.manifold,
        engine: sliced.engine,
        bedType: sliced.bedType,
        warnings: sliced.warnings,
      },
      files: [
        { name: "plate_1.gcode", data: gcode },
        { name: "print.3mf", data: threeMf },
      ],
    };
  }
  const printer = findPrinter(request.printerId);
  if (!printer) throw new Error(`Unknown printer ${request.printerId}.`);
  if (printer.quotingPack && (request.materialId === "pla" || request.materialId === "petg")) {
    const sliced = await sliceFleetPlates({
      orcaBin,
      printer,
      materialId: request.materialId,
      modelPaths,
      workDir: work,
      infillPercent: request.infillPercent,
      supports: request.supports,
      timeoutMs,
    });
    const output = path.join(work, "output");
    const files = [
      await named(output, "plate_1.gcode"),
      await named(output, sliced.projectName),
      ...sliced.plates.map((plate) => named(output, plate.previewName)),
      named(output, "archive.zip").catch(() => null),
    ];
    const present = (await Promise.all(files)).filter((file): file is { name: string; data: Buffer } => file !== null);
    return {
      manifest: {
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
        })),
      },
      files: present,
    };
  }
  if (printer.resinOutput === "sl1s") {
    if (!prusaBin) throw new Error("PRUSA_SLICER_BIN is not set on the worker, so no .sl1 file was produced.");
    const sliced = await sliceSl1s({ prusaBin, modelPaths, workDir: work, timeoutMs });
    const output = path.join(work, "output");
    return {
      manifest: {
        volumeMl: sliced.resinMl,
        grams: Math.round(sliced.resinMl * 1.1 * 1000) / 1000,
        densityGPerMl: 1.1,
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
      },
      files: [await named(output, sliced.printerFileName), await named(output, sliced.previewName)],
    };
  }
  throw new Error(printer.note ?? `${printer.name} has no printer-ready output.`);
}

async function named(dir: string, name: string): Promise<{ name: string; data: Buffer }> {
  return { name, data: await readFile(path.join(dir, name)) };
}

async function downloadModels(claimed: Claimed, work: string): Promise<string[]> {
  const paths: string[] = [];
  const copies = claimed.job.request.models?.length
    ? claimed.job.request.models
    : [{ modelId: claimed.job.modelId, quantity: 1, filename: claimed.models[0]?.filename ?? "model.stl" }];
  let index = 0;
  for (const item of copies) {
    const model = claimed.models.find((entry) => entry.id === item.modelId);
    const bytes = await getBytes(`/v1/worker/jobs/${claimed.job.id}/models/${item.modelId}`);
    for (let i = 0; i < item.quantity; i += 1) {
      index += 1;
      const filename = `${index}-${model?.filename ?? item.filename}`;
      const dest = path.join(work, filename);
      await import("node:fs/promises").then((fs) => fs.writeFile(dest, bytes));
      paths.push(dest);
    }
  }
  return paths;
}

interface Claimed {
  job: {
    id: string;
    type: "fdm" | "resin" | "plates";
    modelId: string;
    request: {
      printerId: string;
      materialId: string;
      profileId?: string;
      infillPercent?: number;
      supports?: boolean;
      models?: Array<{ modelId: string; quantity: number; filename: string }>;
    };
  };
  models: Array<{ id: string; filename: string }>;
}

async function claim(): Promise<Claimed | null> {
  const response = await fetch(`${serverUrl}/v1/worker/claim`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ workerId, waitMs: 15000 }),
  });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`Claim failed (${response.status}).`);
  return (await response.json()) as Claimed;
}

async function upload(jobId: string, manifest: JobResult, files: Array<{ name: string; data: Buffer }>): Promise<void> {
  const body = new FormData();
  body.set("manifest", JSON.stringify(manifest));
  for (const file of files) {
    body.append("file", new Blob([new Uint8Array(file.data)]), file.name);
  }
  const response = await fetch(`${serverUrl}/v1/worker/jobs/${jobId}/result`, {
    method: "POST",
    headers: authHeaders({ "x-worker-id": workerId }),
    body,
  });
  if (!response.ok) throw new Error(`Result upload failed (${response.status}).`);
}

async function beat(jobId?: string): Promise<void> {
  await postJson("/v1/worker/heartbeat", { workerId, jobId });
}

async function postJson(pathname: string, payload: unknown): Promise<void> {
  const response = await fetch(`${serverUrl}${pathname}`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Worker request failed (${response.status}).`);
}

async function getBytes(pathname: string): Promise<Buffer> {
  const response = await fetch(`${serverUrl}${pathname}`, { headers: authHeaders({ "x-worker-id": workerId }) });
  if (!response.ok) throw new Error(`Model download failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

function authHeaders(extra: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

function formatDuration(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}m ${rest}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
