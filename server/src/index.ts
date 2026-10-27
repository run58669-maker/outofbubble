import express, { type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DiscoveryAgent } from "./agent.js";
import { HttpQlooClient } from "./http-qloo-client.js";
import { MockQlooClient } from "./mock-qloo-client.js";
import type { DiscoverInput, InterestInput, TargetType } from "./types.js";

/** Interests arrive as plain names or as { name, type?, id? }; anything else is dropped. */
function interestsFrom(value: unknown): Array<string | InterestInput> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Array<string | InterestInput> => {
    if (typeof item === "string") return [item];
    if (typeof item !== "object" || item === null) return [];
    const { name, type, id } = item as Record<string, unknown>;
    if (typeof name !== "string") return [];
    return [{ name, ...(typeof type === "string" ? { type } : {}), ...(typeof id === "string" ? { id } : {}) }];
  });
}

function bodyToInput(body: unknown): DiscoverInput {
  const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  return {
    interests: interestsFrom(value.interests),
    targetType: value.targetType as TargetType,
    distance: Number(value.distance) as 0 | 1 | 2,
    city: typeof value.city === "string" ? value.city : undefined,
    excludeIds: Array.isArray(value.excludeIds) ? value.excludeIds.filter((item): item is string => typeof item === "string") : [],
    limit: typeof value.limit === "number" ? value.limit : undefined,
  };
}

export function createApp(agent = new DiscoveryAgent(process.env.QLOO_API_KEY ? new HttpQlooClient(process.env.QLOO_API_KEY) : new MockQlooClient())) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.post("/api/resolve", async (request, response, next) => {
    try {
      const value = typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {};
      // `alternatives: true` also returns up to three other close matches per input (the type-chip picker).
      const { matches } = await agent.resolveMatches(interestsFrom(value.interests), value.alternatives === true);
      response.json({ resolved: matches.flatMap((match) => (match.entity ? [match.entity] : [])), matches });
    } catch (error) { next(error); }
  });

  app.post("/api/discover", async (request, response, next) => {
    try {
      response.json(await agent.discover(bodyToInput(request.body)));
    } catch (error) { next(error); }
  });

  app.post("/api/exclude", async (request, response, next) => {
    try {
      const value = typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {};
      const currentIds = Array.isArray(value.currentIds) ? value.currentIds.filter((item): item is string => typeof item === "string") : [];
      const knownId = typeof value.knownId === "string" ? value.knownId : "";
      if (!knownId) throw new Error("knownId is required.");
      response.json(await agent.refill(bodyToInput(request.body), currentIds, knownId));
    } catch (error) { next(error); }
  });

  app.get("/api/health", (_request, response) => response.json({ ok: true, mode: agent.mode }));

  const currentDir = dirname(fileURLToPath(import.meta.url));
  const webDir = resolve(currentDir, "../web");
  app.use(express.static(webDir, { extensions: ["html"] }));
  app.get("*", (_request, response) => response.sendFile(resolve(webDir, "index.html")));

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    response.status(400).json({ error: message });
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
