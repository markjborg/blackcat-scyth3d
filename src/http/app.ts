import { spawnSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { requireApiKey, requireApiKeyOrSession } from "../auth.js";
import type { Config } from "../config.js";
import { ApiError, errorBody } from "../errors.js";
import { registerTools } from "../mcp.js";
import { publicCatalog } from "../profiles/catalog.js";
import { presentJob } from "../present.js";
import { ScythService } from "../service.js";
import {
  clearLoginFailures,
  clearSession,
  clientIp,
  hasValidSession,
  issueSession,
  loginBlocked,
  noteLoginFailure,
  passwordsMatch,
} from "../session.js";
import { assertId, type JobRecord, type ModelRecord } from "../store.js";
import { renderLoginPage, renderUiMissingPage } from "./loginPage.js";
import { readSingleUpload } from "./upload.js";

export interface AppBundle {
  app: express.Express;
  service: ScythService;
}

export function createApp(config: Config, service: ScythService): AppBundle {
  const app = express();
  app.disable("x-powered-by");
  app.use(hostGuard(config));
  app.get("/health", wrap(async (_req, res) => {
    res.json({
      ok: true,
      service: "blackcat-scyth3d",
      version: config.version,
      slicer: await slicerHealth(config),
    });
  }));

  const jsonLimit = Math.max(1024 * 1024, Math.ceil(config.mcpInlineMaxBytes * 1.4) + 256 * 1024);
  app.use(express.json({ limit: jsonLimit }));
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));
  mountLogin(app, config);
  app.use(requireApiKeyOrSession(config));

  app.get("/v1/printers", (_req, res) => {
    res.json({ printers: publicCatalog().printers });
  });
  app.get("/v1/materials", (_req, res) => {
    res.json({ materials: publicCatalog().materials });
  });
  app.get("/v1/profiles", (req, res) => {
    const printerId = typeof req.query.printerId === "string" ? req.query.printerId : undefined;
    const profiles = publicCatalog().profiles.filter((profile) => !printerId || profile.printerId === printerId);
    res.json({ profiles });
  });
  app.get("/v1/catalog", (_req, res) => {
    res.json(publicCatalog());
  });

  app.post("/v1/models", wrap(async (req, res) => {
    const file = await readSingleUpload(req, config.maxUploadBytes);
    const model = await service.upload(file.filename, file.data);
    res.status(201).json(presentModel(model));
  }));
  app.get("/v1/models/:id", wrap(async (req, res) => {
    res.json(presentModel(await service.getModel(routeId(req.params.id))));
  }));

  app.post("/v1/jobs", wrap(async (req, res) => {
    const body = objectBody(req.body);
    const wait = body.wait === true;
    const job = await service.createSlice(
      {
        modelId: requiredString(body.modelId, "modelId"),
        printerId: requiredString(body.printerId, "printerId"),
        materialId: requiredString(body.materialId, "materialId"),
        profileId: optionalString(body.profileId),
        infillPercent: optionalNumber(body.infillPercent, "infillPercent"),
        supports: optionalBoolean(body.supports, "supports"),
      },
      wait,
    );
    res.status(wait ? 200 : 202).json(presentJob(job));
  }));
  app.get("/v1/jobs", wrap(async (req, res) => {
    const limit = clampLimit(req.query.limit);
    const jobs = (await service.store.listJobs())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(presentJob);
    res.json({ jobs });
  }));
  app.get("/v1/jobs/:id", wrap(async (req, res) => {
    res.json(presentJob(await service.getJob(routeId(req.params.id))));
  }));
  app.get("/v1/jobs/:id/gcode", wrap(async (req, res) => {
    const job = await readyFdmJob(service, routeId(req.params.id));
    const model = await service.getModel(job.modelId);
    res.download(service.store.gcodeFile(job.id), downloadName(model.filename, "gcode"));
  }));
  app.get("/v1/jobs/:id/3mf", wrap(async (req, res) => {
    const job = await readyFdmJob(service, routeId(req.params.id));
    const model = await service.getModel(job.modelId);
    res.type("application/vnd.ms-package.3dmanufacturing-3dmodel+xml");
    res.download(service.store.threeMfFile(job.id), downloadName(model.filename, "3mf"));
  }));

  app.post("/v1/estimates/resin", wrap(async (req, res) => {
    const body = objectBody(req.body);
    const job = await service.estimateResin(requiredString(body.modelId, "modelId"), requiredString(body.materialId, "materialId"));
    res.status(201).json(presentJob(job));
  }));
  app.post("/v1/quotes", wrap(async (req, res) => {
    const body = objectBody(req.body);
    const lines = Array.isArray(body.lines)
      ? body.lines.map((line) => {
          const record = objectBody(line);
          return {
            materialId: requiredString(record.materialId, "materialId"),
            grams: requiredNumber(record.grams, "grams"),
            note: optionalString(record.note),
          };
        })
      : undefined;
    res.json(await service.quote({ jobId: optionalString(body.jobId), lines }));
  }));

  const mcp = createMcpHandler(() => {
    const server = new McpServer({ name: "blackcat-scyth3d", version: config.version });
    registerTools(server, service);
    return server;
  }, { responseMode: "auto" });
  const mcpNode = toNodeHandler(mcp, { maxRequestBodySize: jsonLimit });
  app.all("/mcp", requireApiKey(config), (req, res) => {
    void mcpNode(req, res, req.body);
  });

  const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");
  app.get("/", (_req, res) => {
    const index = path.join(uiRoot, "index.html");
    if (!existsSync(index)) {
      res.status(503).type("html").send(renderUiMissingPage());
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(index);
  });
  app.use(express.static(uiRoot, { index: false, fallthrough: true }));

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof ApiError) {
      res.status(error.status).json(errorBody(error));
      return;
    }
    const tooLarge = typeof error === "object" && error !== null && "type" in error && (error as { type?: string }).type === "entity.too.large";
    if (tooLarge) {
      res.status(413).json({ error: { code: "file_too_large", message: "Request body is too large." } });
      return;
    }
    console.error(error);
    res.status(500).json({ error: { code: "internal", message: "Unexpected server error." } });
  });

  return { app, service };
}

function mountLogin(app: express.Express, config: Config): void {
  app.get("/login", (req, res) => {
    if (hasValidSession(req, config)) {
      res.redirect("/");
      return;
    }
    res.type("html").send(renderLoginPage({ failed: false, limited: false, unconfigured: !config.uiPassword }));
  });

  app.post("/login", (req, res) => {
    const json = Boolean(req.is("application/json"));
    const send = (status: number, code: string, message: string, page: { failed: boolean; limited: boolean; unconfigured: boolean }) => {
      if (json) {
        res.status(status).json({ error: { code, message } });
        return;
      }
      res.status(status).type("html").send(renderLoginPage(page));
    };
    if (!config.uiPassword || !config.sessionSecret) {
      send(503, "ui_unconfigured", "Set SCYTH3D_UI_PASSWORD on the server.", { failed: false, limited: false, unconfigured: true });
      return;
    }
    const ip = clientIp(req);
    if (loginBlocked(ip)) {
      send(429, "rate_limited", "Too many attempts. Wait a few minutes and try again.", { failed: false, limited: true, unconfigured: false });
      return;
    }
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!password || !passwordsMatch(password, config.uiPassword)) {
      noteLoginFailure(ip);
      send(401, "unauthorized", "That password is not right.", { failed: true, limited: false, unconfigured: false });
      return;
    }
    clearLoginFailures(ip);
    issueSession(res, config);
    if (json) {
      res.json({ ok: true });
      return;
    }
    res.redirect(303, "/");
  });

  app.post("/logout", (req, res) => {
    clearSession(res, config);
    if (req.is("application/json")) {
      res.json({ ok: true });
      return;
    }
    res.redirect(303, "/login");
  });
}

async function readyFdmJob(service: ScythService, id: string): Promise<JobRecord> {
  const job = await service.getJob(id);
  if (job.type !== "fdm" || job.status !== "succeeded" || !job.outputs?.gcode) {
    throw new ApiError(409, "not_ready", "G-code and 3MF are available after a successful FDM slice.");
  }
  return job;
}

function presentModel(model: ModelRecord): ModelRecord {
  return model;
}

function hostGuard(config: Config) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!config.allowedHosts) {
      next();
      return;
    }
    const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
    if (!config.allowedHosts.includes(host)) {
      res.status(403).json({ error: { code: "forbidden_host", message: "Host is not allowed." } });
      return;
    }
    next();
  };
}

function wrap(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
}

function routeId(value: string | string[]): string {
  return assertId(Array.isArray(value) ? value[0] ?? "" : value);
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_body", "Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(400, "invalid_body", `${name} is required.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ApiError(400, "invalid_body", "Expected a string.");
  return value.trim();
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiError(400, "invalid_body", `${name} must be a number.`);
  }
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ApiError(400, "invalid_body", `${name} must be a boolean.`);
  return value;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiError(400, "invalid_body", `${name} must be a number.`);
  }
  return value;
}

function clampLimit(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : 50;
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(200, Math.floor(parsed));
}

function downloadName(filename: string, extension: string): string {
  const stem = filename.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "print";
  return `${stem}.${extension}`;
}

async function slicerHealth(config: Config): Promise<{ engine: string; available: boolean; binFound: boolean; resourcesFound: boolean; xvfbFound: boolean }> {
  const [binFound, resourcesFound, xvfbFound] = await Promise.all([
    commandExists(config.orcaBin),
    pathExists(path.join(config.orcaResources, "profiles")),
    commandExists("xvfb-run"),
  ]);
  return { engine: "orcaslicer", available: binFound && resourcesFound && xvfbFound, binFound, resourcesFound, xvfbFound };
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function commandExists(command: string): Promise<boolean> {
  if (command.includes("/")) return pathExists(command);
  const result = spawnSync("which", [command], { encoding: "utf8" });
  return result.status === 0;
}
