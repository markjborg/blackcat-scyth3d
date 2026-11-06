import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { Config } from "./config.js";

const COOKIE = "scyth3d_session";
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 8;
const WINDOW_MS = 10 * 60 * 1000;

const failures = new Map<string, { count: number; resetAt: number }>();

export function passwordsMatch(provided: string, expected: string): boolean {
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

export function loginBlocked(ip: string): boolean {
  const row = failures.get(ip);
  if (!row || row.resetAt < Date.now()) return false;
  return row.count >= MAX_FAILURES;
}

export function noteLoginFailure(ip: string): void {
  const now = Date.now();
  const row = failures.get(ip);
  if (!row || row.resetAt < now) {
    failures.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  row.count += 1;
}

export function clearLoginFailures(ip: string): void {
  failures.delete(ip);
}

export function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function issueSession(res: Response, config: Config): void {
  if (!config.sessionSecret) {
    throw new Error("Session secret is not configured.");
  }
  const exp = Date.now() + SESSION_MS;
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  const sig = createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
  res.append("Set-Cookie", cookieValue(`${payload}.${sig}`, config, SESSION_MS / 1000));
}

export function clearSession(res: Response, config: Config): void {
  res.append("Set-Cookie", cookieValue("", config, 0));
}

export function hasValidSession(req: Request, config: Config): boolean {
  if (!config.sessionSecret) return false;
  const token = readCookie(req, COOKIE);
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return typeof parsed.exp === "number" && parsed.exp > Date.now();
  } catch {
    return false;
  }
}

function cookieValue(token: string, config: Config, maxAge: number): string {
  const secure = config.cookieSecure ? "; Secure" : "";
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
