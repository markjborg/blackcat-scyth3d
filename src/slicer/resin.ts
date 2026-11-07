import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { ApiError } from "../errors.js";

export interface ResinSlice {
  printerFileName: string;
  previewName: string;
  resinMl: number;
  printTimeSeconds: number;
  printTimeText: string;
  layerCount: number;
  warnings: string[];
}

const SLA_INI = `printer_technology = SLA
printer_model = SL1S
printer_variant = default
display_width = 128
display_height = 81
display_pixels_x = 2560
display_pixels_y = 1620
display_orientation = portrait
display_mirror_x = 1
display_mirror_y = 0
max_print_height = 150
bed_shape = 0x0,128x0,128x81,0x81
layer_height = 0.1
initial_layer_height = 0.1
exposure_time = 2.6
initial_exposure_time = 25
faded_layers = 10
supports_enable = 1
pad_enable = 1
hollowing_enable = 1
hollowing_min_thickness = 2
fast_tilt_time = 2.5
slow_tilt_time = 5
`;

export async function sliceSl1s(options: {
  prusaBin: string;
  modelPaths: string[];
  workDir: string;
  timeoutMs: number;
}): Promise<ResinSlice> {
  const outputDir = path.join(options.workDir, "output");
  await mkdir(outputDir, { recursive: true });
  const printerFileName = "plate_1.sl1";
  const destination = path.join(outputDir, printerFileName);
  const iniPath = path.join(options.workDir, "sl1s.ini");
  await writeFile(iniPath, SLA_INI);
  const homeDir = path.join(options.workDir, "home");
  await mkdir(homeDir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, LIBGL_ALWAYS_SOFTWARE: "1" };
  delete env.SCYTH3D_API_KEY;
  delete env.SCYTH3D_UI_PASSWORD;
  if (path.basename(options.prusaBin) === "prusa-slicer") {
    const lib = path.resolve(path.dirname(options.prusaBin), "../lib");
    env.LD_LIBRARY_PATH = [lib, env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  }
  const args = [
    "-a",
    options.prusaBin,
    "--printer-technology",
    "SLA",
    "--load",
    iniPath,
    "--sla-archive-format",
    "SL1",
    "--output",
    destination,
    "--export-sla",
    ...options.modelPaths,
  ];
  const run = await runProcess("xvfb-run", args, { cwd: options.workDir, env, timeoutMs: options.timeoutMs });
  let archive: Buffer;
  try {
    archive = await readFile(destination);
  } catch {
    throw new ApiError(422, "resin_slice_failed", `PrusaSlicer did not write an SL1S file${run.code === null ? " (timed out)" : ` (exit ${run.code})`}. ${tail(run.stderr || run.stdout)}`);
  }
  const parsed = readSl1s(archive);
  const previewName = "plate_1.png";
  await writeFile(path.join(outputDir, previewName), parsed.preview);
  return {
    printerFileName,
    previewName,
    resinMl: parsed.resinMl,
    printTimeSeconds: parsed.printTimeSeconds,
    printTimeText: formatDuration(parsed.printTimeSeconds),
    layerCount: parsed.layerCount,
    warnings: [
      "PrusaSlicer 2.8.1 wrote a real .sl1 archive. Its CLI rejected the .sl1s container (Unknown archive format: SL1S). Confirm the SL1S accepts .sl1 before a production print.",
      "Exposure is 2.6 s normal / 25 s bottom at 0.1 mm, from Prusa's fast preset. It is not calibrated for Mark's resin.",
      "Supports, a pad, and hollowing are in the slice. Drain holes are not added.",
      "Elegoo .goo and Jupiter .ctb files are not produced. Converting this SL1 archive would not match those LCDs.",
    ],
  };
}

function readSl1s(archive: Buffer): { resinMl: number; printTimeSeconds: number; layerCount: number; preview: Uint8Array } {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(archive));
  } catch {
    throw new ApiError(422, "resin_slice_failed", "PrusaSlicer wrote a file that is not an SL1S archive.");
  }
  const configName = Object.keys(entries).find((name) => name.toLowerCase().endsWith("config.ini"));
  if (!configName) throw new ApiError(422, "resin_slice_failed", "The SL1S archive has no config.ini.");
  const config = strFromU8(entries[configName]);
  const resinMl = numberFrom(config, "usedMaterial");
  const printTimeSeconds = numberFrom(config, "printTime");
  const layerCount = numberFrom(config, "numFast") ?? pngLayers(entries).length;
  const preview = entries[pngLayers(entries).at(-1) ?? ""] ?? thumbnail(entries);
  if (resinMl === null || printTimeSeconds === null || !preview || layerCount === 0) {
    throw new ApiError(422, "resin_slice_failed", "The SL1S archive is missing material use, print time, or layer images.");
  }
  return { resinMl, printTimeSeconds, layerCount, preview };
}

function pngLayers(entries: Record<string, Uint8Array>): string[] {
  return Object.keys(entries)
    .filter((name) => name.toLowerCase().endsWith(".png") && !name.toLowerCase().includes("thumbnail"))
    .sort();
}

function thumbnail(entries: Record<string, Uint8Array>): Uint8Array | undefined {
  const name = Object.keys(entries).find((entry) => entry.toLowerCase().endsWith(".png"));
  return name ? entries[name] : undefined;
}

function numberFrom(config: string, key: string): number | null {
  const match = new RegExp(`^${key}\\s*=\\s*([0-9.]+)`, "im").exec(config);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function formatDuration(seconds: number): string {
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${rest}s`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
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
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
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
