import express, { type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DiscoveryAgent } from "./agent.js";
import { DiscoverCache, discoverCacheKey } from "./discover-cache.js";
import { InputError, UpstreamError } from "./errors.js";
import { HttpQlooClient, QlooHttpError } from "./http-qloo-client.js";
import { MockQlooClient } from "./mock-qloo-client.js";
import { SlidingWindowLimiter, rateLimit, type RateLimitOptions } from "./rate-limit.js";
import { ENTITY_TYPES, type DiscoverInput, type InterestInput, type TargetType } from "./types.js";

/** Route-layer input caps (checked before anything reaches the agent or Qloo). */
export const LIMITS = { interests: 10, name: 100, id: 64, city: 100, ids: 50 } as const;
export const API_RATE_LIMIT: RateLimitOptions = { max: 20, windowMs: 60_000 };
/** Across ALL clients: Qloo-hitting requests per minute (cache hits do not count). Guards the quota against a spread-out scrape. */
export const GLOBAL_QLOO_LIMIT: RateLimitOptions = { max: 120, windowMs: 60_000 };
export const BUSY_MESSAGE = "The app is busy right now, try again in a minute";

function bodyOf(request: Request): Record<string, unknown> {
  return typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {};
}

/** Interests arrive as plain names or as { name, type?, id? }; anything over the caps is a 400. */
function interestsFrom(value: unknown): Array<string | InterestInput> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new InputError("interests must be a list.");
  if (value.length > LIMITS.interests) throw new InputError(`At most ${LIMITS.interests} interests.`);
  return value.flatMap((item): Array<string | InterestInput> => {
    if (typeof item === "string") {
      if (item.length > LIMITS.name) throw new InputError(`Each interest name must be at most ${LIMITS.name} characters.`);
      return [item];
    }
    if (typeof item !== "object" || item === null) return [];
    const { name, type, id } = item as Record<string, unknown>;
    if (typeof name !== "string") return [];
    if (name.length > LIMITS.name) throw new InputError(`Each interest name must be at most ${LIMITS.name} characters.`);
    if (type !== undefined && (typeof type !== "string" || !(ENTITY_TYPES as readonly string[]).includes(type.trim().toLowerCase()))) {
      throw new InputError("Unknown interest type.");
    }
    if (id !== undefined && (typeof id !== "string" || id.length > LIMITS.id)) throw new InputError(`Each id must be at most ${LIMITS.id} characters.`);
    return [{ name, ...(typeof type === "string" ? { type } : {}), ...(typeof id === "string" ? { id } : {}) }];
  });
}

function idsFrom(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new InputError(`${field} must be a list.`);
  if (value.length > LIMITS.ids) throw new InputError(`At most ${LIMITS.ids} ${field}.`);
  return value.map((item) => {
    if (typeof item !== "string" || item.length > LIMITS.id) throw new InputError(`Each of ${field} must be an id of at most ${LIMITS.id} characters.`);
    return item;
  });
}

function bodyToInput(body: Record<string, unknown>): DiscoverInput {
  if (body.city !== undefined && (typeof body.city !== "string" || body.city.length > LIMITS.city)) {
    throw new InputError(`City must be at most ${LIMITS.city} characters.`);
  }
  return {
    interests: interestsFrom(body.interests),
    targetType: body.targetType as TargetType,
    distance: Number(body.distance) as 0 | 1 | 2,
    city: typeof body.city === "string" ? body.city : undefined,
    excludeIds: idsFrom(body.excludeIds, "excludeIds"),
    limit: typeof body.limit === "number" ? body.limit : undefined,
  };
}

export interface AppOptions {
  rateLimit?: RateLimitOptions & { log?: (line: string) => void };
  globalLimit?: RateLimitOptions;
  cache?: DiscoverCache;
}

export function createApp(
  agent = new DiscoveryAgent(process.env.QLOO_API_KEY ? new HttpQlooClient(process.env.QLOO_API_KEY) : new MockQlooClient()),
  options: AppOptions = {},
) {
  const app = express();
  const cache = options.cache ?? new DiscoverCache();
  const globalLimiter = new SlidingWindowLimiter(options.globalLimit ?? GLOBAL_QLOO_LIMIT);
  /** Call right before work that may reach Qloo. */
  const guardQloo = () => {
    if (!globalLimiter.hit("global").allowed) throw new UpstreamError(BUSY_MESSAGE, 503);
  };
  app.disable("x-powered-by");
  // Render terminates TLS in front of us. The limiter keys on the first X-Forwarded-For entry (see clientKey).
  app.set("trust proxy", 1);
  app.use("/api", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/api/health", (_request, response) => response.json({ ok: true, mode: agent.mode }));
  // Health polling during a cold start is exempt; every other /api request counts toward the per-client limit,
  // including ones that end in 400/413 (the limiter runs before body parsing and validation).
  app.use("/api", rateLimit(options.rateLimit ?? API_RATE_LIMIT));
  app.use(express.json({ limit: "32kb" }));

  app.post("/api/resolve", async (request, response, next) => {
    try {
      const body = bodyOf(request);
      // `alternatives: true` also returns up to three other close matches per input (the type-chip picker).
      const interests = interestsFrom(body.interests);
      guardQloo();
      const { matches } = await agent.resolveMatches(interests, body.alternatives === true);
      response.json({ resolved: matches.flatMap((match) => (match.entity ? [match.entity] : [])), matches });
    } catch (error) { next(error); }
  });

  app.post("/api/discover", async (request, response, next) => {
    try {
      const input = bodyToInput(bodyOf(request));
      const key = discoverCacheKey(input);
      const cached = cache.get(key);
      if (cached) {
        response.json(cached);
        return;
      }
      guardQloo();
      const result = await agent.discover(input);
      cache.set(key, result);
      response.json(result);
    } catch (error) { next(error); }
  });

  app.post("/api/exclude", async (request, response, next) => {
    try {
      const body = bodyOf(request);
      const currentIds = idsFrom(body.currentIds, "currentIds");
      const knownId = body.knownId;
      if (typeof knownId !== "string" || !knownId) throw new InputError("knownId is required.");
      if (knownId.length > LIMITS.id) throw new InputError(`knownId must be at most ${LIMITS.id} characters.`);
      const input = bodyToInput(body);
      guardQloo();
      response.json(await agent.refill(input, currentIds, knownId));
    } catch (error) { next(error); }
  });

  const currentDir = dirname(fileURLToPath(import.meta.url));
  const webDir = resolve(currentDir, "../web");
  app.use(express.static(webDir, { extensions: ["html"] }));
  app.get("*", (_request, response) => response.sendFile(resolve(webDir, "index.html")));

  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    // body-parser: oversized → 413, malformed JSON → 400.
    const parserType = (error as { type?: unknown } | null)?.type;
    if (parserType === "entity.too.large") return void response.status(413).json({ error: "Request body is too large." });
    if (parserType === "entity.parse.failed") return void response.status(400).json({ error: "Request body is not valid JSON." });
    if (error instanceof InputError) return void response.status(error.status).json({ error: error.message });
    if (error instanceof UpstreamError) return void response.status(error.status).json({ error: error.message });
    // Anything else: details go to the server log only (QlooHttpError carries Qloo's 600-char excerpt, never the key).
    console.error(`[${request.method} ${request.path}]`, error instanceof Error ? `${error.name}: ${error.message}` : error);
    const status = error instanceof QlooHttpError ? 502 : 500;
    response.status(status).json({ error: status === 502 ? "Qloo could not answer that request." : "Something went wrong on our side." });
  });
  return app;
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => {
    const mode = process.env.QLOO_API_KEY ? "Qloo HTTP" : "mock";
    console.log(`Out of the Bubble is listening on http://localhost:${port} (${mode} mode)`);
  });
}
