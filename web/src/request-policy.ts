export const WAKE_NOTICE_DELAY_MS = 3_000;
export const REQUEST_TIMEOUT_MS = 25_000;
export const HEALTH_POLL_INTERVAL_MS = 3_000;
export const HEALTH_POLL_TIMEOUT_MS = 2_500;

export interface RequestUiState {
  phase: "waiting" | "waking" | "timed-out";
  message: string;
  canRetry: boolean;
}

export function requestUiState(elapsedMs: number): RequestUiState {
  if (elapsedMs >= REQUEST_TIMEOUT_MS) {
    return {
      phase: "timed-out",
      message: "That took longer than 25 seconds. The server may still be waking up.",
      canRetry: true,
    };
  }
  if (elapsedMs >= WAKE_NOTICE_DELAY_MS) {
    return {
      phase: "waking",
      message: "Waking the server up (free tier, up to a minute)…",
      canRetry: false,
    };
  }
  return { phase: "waiting", message: "", canRetry: false };
}
