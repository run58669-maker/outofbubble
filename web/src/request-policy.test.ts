import { describe, expect, it } from "vitest";
import { REQUEST_TIMEOUT_MS, WAKE_NOTICE_DELAY_MS, requestUiState } from "./request-policy.js";

describe("slow request UI policy", () => {
  it("stays quiet before the three-second threshold", () => {
    expect(requestUiState(WAKE_NOTICE_DELAY_MS - 1)).toEqual({ phase: "waiting", message: "", canRetry: false });
  });

  it("shows the exact Render free-tier wake-up notice at three seconds", () => {
    expect(requestUiState(WAKE_NOTICE_DELAY_MS)).toEqual({
      phase: "waking",
      message: "Waking the server up (free tier, up to a minute)…",
      canRetry: false,
    });
  });

  it("offers a retry when the client timeout is reached", () => {
    expect(requestUiState(REQUEST_TIMEOUT_MS)).toMatchObject({ phase: "timed-out", canRetry: true });
  });
});
