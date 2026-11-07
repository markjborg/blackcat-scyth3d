import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { ApiError } from "../errors.js";
import { renderPlatePreview } from "../preview/plateImage.js";
import type { Printer } from "../profiles/catalog.js";
import { parseGcodeStats } from "./gcode.js";
import { spawn } from "node:child_process";

export interface PlateFileSet {
  index: number;
  filamentGrams: number;
  filamentVolumeCm3: number | null;
  printTimeSeconds: number;
  printTimeText: string;
  layerCount: number;
  gcodeName: string;
  previewName: string;
}

export interface FdmPlateResult {
  plates: PlateFileSet[];
  projectName: string;
  warnings: string[];
  filamentGrams: number;
  printTimeSeconds: number;
}

export function quotingRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../profiles/quoting");
}

export async function sliceFleetPlates(options: {
  orcaBin: string;
  printer: Printer;
  materialId: "pla" | "petg";
  modelPaths: string[];
  workDir: string;
  infillPercent?: number;
  supports?: boolean;
  timeoutMs: number;
}): Promise<FdmPlateResult> {
  const pack = options.printer.quotingPack;
  if (!pack) {
    throw new ApiError(400, "not_fleet_fdm", `${options.printer.name} has no FDM quoting pack.`);
  }
  const root = path.join(quotingRoot(), pack);
  const materialName = options.materialId === "pla" ? "PLA" : "PETG";
  const machineSrc = path.join(root, "machine.json");
  const processSrc = path.join(root, "process.json");
  const filamentSrc = path.join(root, `filament-${materialName}.json`);
  const profileDir = path.join(options.workDir, "profiles");
  const outputDir = path.join(options.workDir, "output");
  await mkdir(profileDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await copyFile(machineSrc, path.join(profileDir, "machine.json"));
  const processJson = JSON.parse(await readFile(processSrc, "utf8")) as Record<string, unknown>;
  if (options.infillPercent !== undefined) processJson.sparse_infill_density = `${options.infillPercent}%`;
  if (options.supports !== undefined) processJson.enable_support = options.supports ? "1" : "0";
  const processPath = path.join(profileDir, "process.json");
  const filamentPath = path.join(profileDir, "filament.json");
  await writeFile(processPath, JSON.stringify(processJson));
  await copyFile(filamentSrc, filamentPath);

  const dataDir = path.join(options.workDir, "datadir");
  const homeDir = path.join(options.workDir, "home");
  const runtimeDir = path.join(options.workDir, "runtime");
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(homeDir, { recursive: true }), mkdir(runtimeDir, { recursive: true })]);

  const projectName = "project.gcode.3mf";
  const args = [
    "-a",
    options.orcaBin,
    "--datadir",
    dataDir,
    "--ensure-on-bed",
    "--orient",
    "1",
    "--arrange",
    "1",
    "--load-settings",
    `${path.join(profileDir, "machine.json")};${processPath}`,
    "--load-filaments",
    filamentPath,
    "--slice",
    "0",
    "--min-save",
    "--outputdir",
    outputDir,
    "--export-3mf",
    projectName,
    ...options.modelPaths,
  ];
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, XDG_RUNTIME_DIR: runtimeDir, LIBGL_ALWAYS_SOFTWARE: "1" };
  delete env.SCYTH3D_API_KEY;
  delete env.SCYTH3D_UI_PASSWORD;
  const run = await runProcess("xvfb-run", args, { cwd: options.workDir, env, timeoutMs: options.timeoutMs });
  const names = (await readdir(outputDir)).filter((name) => /^plate_\d+\.gcode$/.test(name)).sort();
  if (run.code !== 0 || names.length === 0) {
    throw new ApiError(422, "slice_failed", `OrcaSlicer did not produce a plate${run.code === null ? " (timed out)" : ` (exit ${run.code})`}. ${tail(run.stderr || run.stdout)}`);
  }

  const bed = options.printer.buildVolumeMm ?? { xMm: 256, yMm: 256, zMm: 256 };
  const plates: PlateFileSet[] = [];
  for (const name of names) {
    const index = Number(name.match(/\d+/)?.[0] ?? "0");
    const gcode = await readFile(path.join(outputDir, name), "utf8");
    const stats = parseGcodeStats(gcode);
    if (stats.filamentGrams === null || stats.printTimeSeconds === null || !stats.printTimeText || stats.layerCount === null) {
      throw new ApiError(422, "slice_unparsed", `Plate ${index} is missing filament, time, or layer stats.`);
    }
    const previewName = `plate_${index}.png`;
    await writeFile(path.join(outputDir, previewName), renderPlatePreview(gcode, { xMm: bed.xMm, yMm: bed.yMm }));
    plates.push({
      index,
      filamentGrams: stats.filamentGrams,
      filamentVolumeCm3: stats.filamentVolumeCm3,
      printTimeSeconds: stats.printTimeSeconds,
      printTimeText: stats.printTimeText,
      layerCount: stats.layerCount,
      gcodeName: name,
      previewName,
    });
  }
  const warnings = fleetWarnings(options.printer);
  return {
    plates,
    projectName,
    warnings,
    filamentGrams: round3(plates.reduce((sum, plate) => sum + plate.filamentGrams, 0)),
    printTimeSeconds: plates.reduce((sum, plate) => sum + plate.printTimeSeconds, 0),
  };
}

export async function zipJobOutput(outputDir: string, extra: Record<string, Uint8Array> = {}): Promise<Buffer> {
  const entries: Record<string, Uint8Array> = { ...extra };
  for (const name of await readdir(outputDir)) {
    if (name.endsWith(".gcode") || name.endsWith(".png") || name.endsWith(".3mf") || name.endsWith(".sl1s") || name.endsWith(".ini")) {
      entries[name] = new Uint8Array(await readFile(path.join(outputDir, name)));
    }
  }
  return Buffer.from(zipSync(entries));
}

function fleetWarnings(printer: Printer): string[] {
  const warnings = ["Ann's OrcaSlicer presets are quoting defaults, not production-validated settings."];
  if (printer.officialProfile === false) {
    warnings.push(printer.note ?? `${printer.name} has no official profile in this slicer.`);
  }
  return warnings;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function tail(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length <= 800 ? trimmed : trimmed.slice(-800);
}

function runProcess(
  command: string,
  args: string[],
  options: { timeoutMs: number; cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.reduce((sum, part) => sum + part.length, 0) < 1_000_000) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.reduce((sum, part) => sum + part.length, 0) < 256_000) stderr.push(chunk);
    });
    const timer = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, options.timeoutMs);
    child.on("error", (error) => finish(() => reject(new ApiError(500, "slicer_missing", `Could not start ${command}: ${error.message}`))));
    child.on("close", (code) => finish(() => resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") })));
  });
}
