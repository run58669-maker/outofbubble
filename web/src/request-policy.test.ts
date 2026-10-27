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

  it("waits the full minute promised by the wake notice, then offers a retry at 65 s", () => {
    expect(REQUEST_TIMEOUT_MS).toBe(65_000);
    expect(requestUiState(REQUEST_TIMEOUT_MS - 1).phase).toBe("waking");
    expect(requestUiState(REQUEST_TIMEOUT_MS)).toMatchObject({ phase: "timed-out", canRetry: true, message: expect.stringContaining("65 seconds") });
  });
});
