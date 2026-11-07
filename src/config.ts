import { createHash, timingSafeEqual } from "node:crypto";
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
  prusaBin: string | null;
  /** When true, this process slices jobs itself. The shop default is a queue plus a worker. */
  allInOne: boolean;
  workerToken: string | null;
  leaseMs: number;
  workerOfflineMs: number;
  queueWaitMs: number;
  allowedHosts: string[] | null;
  uiPassword: string | null;
  sessionSecret: string | null;
  cookieSecure: boolean;
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
  const uiPassword = env.SCYTH3D_UI_PASSWORD?.trim() || null;
  if (uiPassword && uiPassword.length < MIN_API_KEY_LENGTH) {
    throw new Error(`SCYTH3D_UI_PASSWORD must be at least ${MIN_API_KEY_LENGTH} characters.`);
  }
  const sessionSecret = resolveSessionSecret(env.SCYTH3D_SESSION_SECRET, uiPassword);
  const workerToken = optionalSecret(env.SCYTH3D_WORKER_TOKEN, "SCYTH3D_WORKER_TOKEN");
  if (workerToken && sameSecret(workerToken, apiKey)) {
    throw new Error("SCYTH3D_WORKER_TOKEN must be different from SCYTH3D_API_KEY.");
  }
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
    prusaBin: env.PRUSA_SLICER_BIN?.trim() || null,
    allInOne: env.SCYTH3D_ALL_IN_ONE === "1" || env.SCYTH3D_ALL_IN_ONE === "true",
    workerToken,
    leaseMs: positiveInt(env.SCYTH3D_LEASE_SEC, 120) * 1000,
    workerOfflineMs: positiveInt(env.SCYTH3D_WORKER_OFFLINE_SEC, 20) * 1000,
    queueWaitMs: positiveInt(env.SCYTH3D_QUEUE_WAIT_SEC, 20) * 1000,
    allowedHosts: allowed ? allowed.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean) : null,
    uiPassword,
    sessionSecret,
    cookieSecure: env.SCYTH3D_COOKIE_SECURE === "1" || env.SCYTH3D_COOKIE_SECURE === "true",
    version: readPackageVersion(),
  };
}

function resolveSessionSecret(explicit: string | undefined, uiPassword: string | null): string | null {
  const trimmed = explicit?.trim() || "";
  if (trimmed) {
    if (trimmed.length < 16) {
      throw new Error("SCYTH3D_SESSION_SECRET must be at least 16 characters.");
    }
    return trimmed;
  }
  if (!uiPassword) return null;
  return createHash("sha256").update(`scyth3d-session-v1\0${uiPassword}`).digest("base64url");
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function optionalSecret(value: string | undefined, name: string): string | null {
  const trimmed = value?.trim() || "";
  if (!trimmed) return null;
  if (trimmed.length < MIN_API_KEY_LENGTH) {
    throw new Error(`${name} must be at least ${MIN_API_KEY_LENGTH} characters.`);
  }
  return trimmed;
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
