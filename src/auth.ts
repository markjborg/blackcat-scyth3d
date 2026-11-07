import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Config } from "./config.js";
import { hasValidSession } from "./session.js";

export function requireApiKey(config: Config) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (bearerOk(req, config)) {
      next();
      return;
    }
    unauthorized(res);
  };
}

/** Browser sessions may call the REST API. MCP stays on the API key. */
export function requireApiKeyOrSession(config: Config) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (bearerOk(req, config) || hasValidSession(req, config)) {
      next();
      return;
    }
    if (req.method === "GET" && acceptsHtml(req)) {
      res.redirect("/login");
      return;
    }
    unauthorized(res);
  };
}

export function requireWorker(config: Config) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!config.workerToken) {
      res.status(503).json({ error: { code: "worker_unconfigured", message: "The server has no worker token." } });
      return;
    }
    const provided = tokenFrom(req);
    if (!provided || !tokensMatch(provided, config.workerToken)) {
      res.status(401).json({ error: { code: "unauthorized", message: "A valid worker token is required." } });
      return;
    }
    next();
  };
}

function bearerOk(req: Request, config: Config): boolean {
  const provided = tokenFrom(req);
  return Boolean(provided && tokensMatch(provided, config.apiKey));
}

function unauthorized(res: Response): void {
  res.setHeader("WWW-Authenticate", 'Bearer realm="scyth3d"');
  res.status(401).json({
    error: { code: "unauthorized", message: "A valid API key is required." },
  });
}

function acceptsHtml(req: Request): boolean {
  const accept = req.headers.accept;
  return typeof accept === "string" && accept.includes("text/html");
}

export function tokenFrom(req: { headers: Request["headers"] }): string | null {
  const authorization = header(req.headers.authorization);
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  const apiKey = header(req.headers["x-api-key"]);
  return apiKey?.trim() || null;
}

export function tokensMatch(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
