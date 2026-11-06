import { spawn } from "node:child_process";
import { access, mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../errors.js";
import { parseGcodeStats, parseModelInfo } from "./gcode.js";
import { buildSliceProfiles, filamentDensity, ProfileLibrary, type SliceOverrides } from "./library.js";

export interface SliceRequest {
  modelPath: string;
  workDir: string;
  machineProfile: string;
  processProfile: string;
  filamentProfile: string;
  overrides: SliceOverrides;
  timeoutMs: number;
}

export interface SliceResult {
  filamentGrams: number;
  filamentVolumeCm3: number | null;
  filamentLengthMm: number | null;
  printTimeSeconds: number;
  printTimeText: string;
  modelPrintTimeText: string | null;
  layerCount: number;
  dimensionsMm: { x: number; y: number; z: number } | null;
  boundingBoxMm: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  } | null;
  meshVolumeMm3: number | null;
  manifold: boolean | null;
  gcodePath: string;
  threeMfPath: string;
  engine: string;
  bedType: string;
  warnings: string[];
}

export interface SlicerEngine {
  slice(request: SliceRequest): Promise<SliceResult>;
}

const GCODE_NAME = "plate_1.gcode";
const THREEMF_NAME = "print.3mf";

export class OrcaSlicer implements SlicerEngine {
  readonly engine = "orcaslicer";
  private readonly library: ProfileLibrary;

  constructor(
    private readonly bin: string,
    resourcesDir: string,
  ) {
    this.library = new ProfileLibrary(resourcesDir);
  }

  async slice(request: SliceRequest): Promise<SliceResult> {
    await mkdir(request.workDir, { recursive: true });
    const profiles = await buildSliceProfiles(
      this.library,
      {
        machine: request.machineProfile,
        process: request.processProfile,
        filament: request.filamentProfile,
      },
      request.overrides,
    );
    const profileDir = path.join(request.workDir, "profiles");
    await mkdir(profileDir, { recursive: true });
    const machinePath = path.join(profileDir, "machine.json");
    const processPath = path.join(profileDir, "process.json");
    const filamentPath = path.join(profileDir, "filament.json");
    await writeFile(machinePath, JSON.stringify(profiles.machine));
    await writeFile(processPath, JSON.stringify(profiles.process));
    await writeFile(filamentPath, JSON.stringify(profiles.filament));

    const dataDir = path.join(request.workDir, "datadir");
    const homeDir = path.join(request.workDir, "home");
    const runtimeDir = path.join(request.workDir, "runtime");
    await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(homeDir, { recursive: true }), mkdir(runtimeDir, { recursive: true })]);

    const args = [
      "-a",
      this.bin,
      "--datadir",
      dataDir,
      "--ensure-on-bed",
      "--load-settings",
      `${machinePath};${processPath}`,
      "--load-filaments",
      filamentPath,
      "--slice",
      "0",
      "--min-save",
      "--outputdir",
      request.workDir,
      "--export-3mf",
      THREEMF_NAME,
      "--info",
      request.modelPath,
    ];

    const { code, stdout, stderr } = await runProcess("xvfb-run", args, {
      timeoutMs: request.timeoutMs,
      cwd: request.workDir,
      env: {
        ...withoutSecret(process.env),
        HOME: homeDir,
        XDG_RUNTIME_DIR: runtimeDir,
        LIBGL_ALWAYS_SOFTWARE: "1",
      },
    });

    const gcodePath = path.join(request.workDir, GCODE_NAME);
    const threeMfPath = path.join(request.workDir, THREEMF_NAME);
    const gcodeExists = await exists(gcodePath);
    const threeMfExists = await exists(threeMfPath);
    if (code !== 0 || !gcodeExists || !threeMfExists) {
      const detail = tail(stderr || stdout, 1200);
      throw new ApiError(
        422,
        "slice_failed",
        `OrcaSlicer failed${code === null ? " (timed out)" : ` (exit ${code})`}.${detail ? ` ${detail}` : ""}`,
      );
    }

    const gcode = await readHeadAndTail(gcodePath);
    const stats = parseGcodeStats(gcode);
    const info = parseModelInfo(stdout);
    let grams = stats.filamentGrams;
    if ((grams === null || grams <= 0) && stats.filamentVolumeCm3 && stats.filamentVolumeCm3 > 0) {
      const density = filamentDensity(profiles.filament);
      if (density) grams = Math.round(stats.filamentVolumeCm3 * density * 1000) / 1000;
    }
    if (grams === null || grams <= 0 || stats.layerCount === null || stats.printTimeSeconds === null || !stats.printTimeText) {
      throw new ApiError(422, "slice_unparsed", "OrcaSlicer finished, but the G-code did not include filament, time, and layer stats.");
    }

    const warnings: string[] = [];
    if (info.manifold === false) warnings.push("The mesh is not manifold. Filament estimates can be wrong for broken models.");
    return {
      filamentGrams: grams,
      filamentVolumeCm3: stats.filamentVolumeCm3,
      filamentLengthMm: stats.filamentLengthMm,
      printTimeSeconds: stats.printTimeSeconds,
      printTimeText: stats.printTimeText,
      modelPrintTimeText: stats.modelPrintTimeText,
      layerCount: stats.layerCount,
      dimensionsMm: info.sizeMm,
      boundingBoxMm: info.boundingBoxMm,
      meshVolumeMm3: info.volumeMm3,
      manifold: info.manifold,
      gcodePath,
      threeMfPath,
      engine: `OrcaSlicer (${this.bin})`,
      bedType: "Textured PEI Plate",
      warnings,
    };
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function tail(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  return trimmed.length <= max ? trimmed : trimmed.slice(-max);
}

function runProcess(
  command: string,
  args: string[],
  options: { timeoutMs: number; cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= 1_000_000) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 256_000) stderr.push(chunk);
    });
    const timer = setTimeout(() => {
      killGroup(child.pid);
    }, options.timeoutMs);
    child.on("error", (error) => {
      finish(() => {
        reject(new ApiError(500, "slicer_missing", `Could not start the slicer (${command}): ${error.message}`));
      });
    });
    child.on("close", (code) => {
      finish(() => {
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });
  });
}

async function readHeadAndTail(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    const headLen = Math.min(12_000, info.size);
    const tailLen = Math.min(8_000, info.size);
    const head = Buffer.alloc(headLen);
    const tail = Buffer.alloc(tailLen);
    await handle.read(head, 0, headLen, 0);
    await handle.read(tail, 0, tailLen, Math.max(0, info.size - tailLen));
    return `${head.toString("utf8")}\n${tail.toString("utf8")}`;
  } finally {
    await handle.close();
  }
}

function withoutSecret(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy.SCYTH3D_API_KEY;
  return copy;
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}
