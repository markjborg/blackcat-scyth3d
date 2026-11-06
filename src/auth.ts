import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Config } from "./config.js";

export function requireApiKey(config: Config) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === "/health") {
      next();
      return;
    }
    const provided = tokenFrom(req);
    if (!provided || !tokensMatch(provided, config.apiKey)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="scyth3d"');
      res.status(401).json({
        error: { code: "unauthorized", message: "A valid API key is required." },
      });
      return;
    }
    next();
  };
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
