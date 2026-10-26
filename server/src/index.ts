import express, { type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DiscoveryAgent } from "./agent.js";
import { HttpQlooClient } from "./http-qloo-client.js";
import { MockQlooClient } from "./mock-qloo-client.js";
import type { DiscoverInput, TargetType } from "./types.js";

function bodyToInput(body: unknown): DiscoverInput {
  const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  return {
    interests: Array.isArray(value.interests) ? value.interests.filter((item): item is string => typeof item === "string") : [],
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
      const interests = Array.isArray(value.interests) ? value.interests.filter((item): item is string => typeof item === "string") : [];
      response.json({ resolved: await agent.resolve(interests) });
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

  app.get("/api/health", (_request, response) => response.json({ ok: true }));

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
