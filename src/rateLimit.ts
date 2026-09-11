/**
 * Minimal in-memory per-IP rate limiter. No external dependency, no distributed state — this
 * service is meant to run as a single small process, so a Map that resets on restart is the
 * right amount of complexity. Purpose is specifically to survive being forked/found and hit
 * hard by unexpected traffic without falling over or burning through the Helius quota (proof
 * serving itself doesn't call Helius per-request — see indexer.ts — but this still protects the
 * process's own CPU/memory/socket budget).
 */
import type { Request, Response, NextFunction } from "express";
import { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from "./config";

const hits = new Map<string, { count: number; windowStart: number }>();

// Prevent unbounded growth from a flood of distinct/spoofed source IPs.
const MAX_TRACKED_IPS = 50_000;

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) hits.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  let entry = hits.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    if (hits.size < MAX_TRACKED_IPS) hits.set(ip, entry);
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX) {
    res.status(429).json({ error: "rate limit exceeded — slow down" });
    return;
  }
  next();
}
