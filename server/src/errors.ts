/** A request the user can fix (bad or oversized input). The message is shown to the client as is. */
export class InputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "InputError";
    this.status = status;
  }
}

export const QLOO_BUSY_MESSAGE = "Qloo is rate-limiting us, try again in a minute";
export const QLOO_TIMEOUT_MESSAGE = "Qloo took too long to answer, try again in a minute";

/** Qloo is unavailable (429/5xx → 503) or too slow (timeout → 504). The message is fixed and safe to show. */
export class UpstreamError extends Error {
  constructor(message: string, readonly status: 503 | 504) {
    super(message);
    this.name = "UpstreamError";
  }
}

/** AbortSignal.timeout() rejects with a TimeoutError DOMException; a manual abort gives AbortError. */
export function isAbortError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}
