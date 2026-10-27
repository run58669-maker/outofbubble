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

/** Express middleware: per-IP limit. Needs `trust proxy` behind Render's proxy so `req.ip` is the client address. */
export function rateLimit(options: RateLimitOptions) {
  const limiter = new SlidingWindowLimiter(options);
  return (request: Request, response: Response, next: NextFunction) => {
    const { allowed, retryAfterSeconds } = limiter.hit(request.ip ?? "unknown");
    if (allowed) return next();
    response.setHeader("Retry-After", String(retryAfterSeconds));
    response.status(429).json({ error: `Too many requests. Try again in ${retryAfterSeconds} s.` });
  };
}
