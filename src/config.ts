import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  apiKey: string;
  host: string;
  port: number;
  dataDir: string;
  maxUploadBytes: number;
  mcpInlineMaxBytes: number;
  jobTtlMs: number;
  maxConcurrentSlices: number;
  sliceTimeoutMs: number;
  cleanupIntervalMs: number;
  orcaBin: string;
  orcaResources: string;
  allowedHosts: string[] | null;
  version: string;
}

const MIN_API_KEY_LENGTH = 8;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const apiKey = (env.SCYTH3D_API_KEY ?? "").trim();
  if (apiKey.length < MIN_API_KEY_LENGTH) {
    throw new Error(
      `SCYTH3D_API_KEY is required and must be at least ${MIN_API_KEY_LENGTH} characters. ` +
        "Generate one with: openssl rand -hex 32",
    );
  }

  const allowed = (env.SCYTH3D_ALLOWED_HOSTS ?? "").trim();
  return {
    apiKey,
    host: env.HOST?.trim() || "0.0.0.0",
    port: positiveInt(env.PORT, 8080),
    dataDir: path.resolve(env.SCYTH3D_DATA_DIR?.trim() || "data"),
    maxUploadBytes: Math.floor(positiveNumber(env.SCYTH3D_MAX_UPLOAD_MB, 100) * 1024 * 1024),
    mcpInlineMaxBytes: Math.floor(positiveNumber(env.SCYTH3D_MCP_INLINE_MAX_MB, 8) * 1024 * 1024),
    jobTtlMs: positiveNumber(env.SCYTH3D_JOB_TTL_HOURS, 48) * 60 * 60 * 1000,
    maxConcurrentSlices: positiveInt(env.SCYTH3D_MAX_CONCURRENT_SLICES, 1),
    sliceTimeoutMs: positiveInt(env.SCYTH3D_SLICE_TIMEOUT_SEC, 900) * 1000,
    cleanupIntervalMs: positiveInt(env.SCYTH3D_CLEANUP_INTERVAL_SEC, 3600) * 1000,
    orcaBin: env.ORCA_SLICER_BIN?.trim() || "orca-slicer",
    orcaResources: env.ORCA_RESOURCES?.trim() || "/opt/orcaslicer/resources",
    allowedHosts: allowed ? allowed.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean) : null,
    version: readPackageVersion(),
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  return Math.floor(positiveNumber(value, fallback));
}

function positiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive number, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function readPackageVersion(): string {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
