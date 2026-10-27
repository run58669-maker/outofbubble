import type { NextFunction, Request, Response } from "express";

export interface RateLimitOptions {
  /** Requests allowed per key inside one window. */
  max: number;
  windowMs: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Upper bound on tracked keys; the least recently seen are evicted first. */
  maxKeys?: number;
}

/** In-memory sliding-window limiter: each key keeps the timestamps of its hits inside the last `windowMs`. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(private readonly options: RateLimitOptions) {
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  /** Records a hit; returns whether it is allowed and, if not, seconds until the oldest hit leaves the window. */
  hit(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.now();
    const since = now - this.options.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((time) => time > since);
    this.hits.delete(key);
    if (recent.length >= this.options.max) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0]! + this.options.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value!);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/**
 * Client key: the FIRST `X-Forwarded-For` entry (the original client as Render's edge saw it), else the socket address.
 * `req.ip` with `trust proxy=1` is the LAST hop, which on Render can be a rotating edge/proxy address, so every request
 * got a fresh key and nothing was ever limited. XFF can be spoofed by the caller; the global cap in index.ts covers that.
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return (first || request.socket.remoteAddress || "unknown").slice(0, 64);
}

/** Express middleware: per-client limit (one store for the app's lifetime), counting every request that reaches it. */
export function rateLimit(options: RateLimitOptions & { log?: (line: string) => void }) {
  const limiter = new SlidingWindowLimiter(options);
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));
  let lastLog = -Infinity;
  return (request: Request, response: Response, next: NextFunction) => {
    const key = clientKey(request);
    // At most one log line per minute, so Render logs show which key the limiter actually sees.
    if (now() - lastLog >= 60_000) {
      lastLog = now();
      const hops = String(request.headers["x-forwarded-for"] ?? "").split(",").filter(Boolean).length;
      log(`[rate-limit] key=${key} xff-hops=${hops} req.ip=${request.ip ?? "?"}`);
    }
    const { allowed, retryAfterSeconds } = limiter.hit(key);
    if (allowed) return next();
    response.setHeader("Retry-After", String(retryAfterSeconds));
    response.status(429).json({ error: `Too many requests. Try again in ${retryAfterSeconds} s.` });
  };
}
