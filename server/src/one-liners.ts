import type { QlooInsight } from "./types.js";

type ResponsePayload = { output_text?: unknown; output?: unknown };

function extractOutputText(payload: ResponsePayload): string | undefined {
  if (typeof payload.output_text === "string") return payload.output_text;
  if (!Array.isArray(payload.output)) return undefined;
  for (const item of payload.output) {
    if (typeof item !== "object" || item === null || !("content" in item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (typeof content === "object" && content !== null && "text" in content && typeof content.text === "string") {
        return content.text;
      }
    }
  }
  return undefined;
}

export async function generateOneLiners(
  insights: QlooInsight[],
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_MODEL ?? "gpt-5-mini",
): Promise<Map<string, string>> {
  if (!apiKey || insights.length === 0) return new Map();
  const input = insights.map((item) => ({ id: item.id, name: item.name, context: item.description }));
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: `Write one vivid, factual-sounding discovery hook of at most 16 words for each item. Return only a JSON array of objects with id and line. Do not invent awards or popularity. Items: ${JSON.stringify(input)}`,
      }),
    });
    if (!response.ok) return new Map();
    const text = extractOutputText((await response.json()) as ResponsePayload);
    if (!text) return new Map();
    const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")) as Array<{ id?: unknown; line?: unknown }>;
    return new Map(parsed.flatMap((item) => typeof item.id === "string" && typeof item.line === "string" ? [[item.id, item.line]] : []));
  } catch {
    return new Map();
  }
}
