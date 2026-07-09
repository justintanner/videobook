import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleFlowError } from "@apicity/googleflow";
import {
  callGoogleFlowWithCaptchaRetry,
  DEFAULT_GOOGLE_FLOW_CAPTCHA_RETRY,
  formatGoogleFlowJobError,
  isCaptchaQualityGoogleFlowError,
  resolveGoogleFlowCaptchaRetry,
  withGoogleFlowCaptchaDefaults,
} from "./_google-flow.js";

describe("withGoogleFlowCaptchaDefaults", () => {
  const originalRetry = process.env.GOOGLE_FLOW_CAPTCHA_RETRY;
  const originalOrder = process.env.GOOGLE_FLOW_CAPTCHA_ORDER;

  afterEach(() => {
    if (originalRetry === undefined) delete process.env.GOOGLE_FLOW_CAPTCHA_RETRY;
    else process.env.GOOGLE_FLOW_CAPTCHA_RETRY = originalRetry;
    if (originalOrder === undefined) delete process.env.GOOGLE_FLOW_CAPTCHA_ORDER;
    else process.env.GOOGLE_FLOW_CAPTCHA_ORDER = originalOrder;
  });

  it("stamps default captchaRetry when unset", () => {
    delete process.env.GOOGLE_FLOW_CAPTCHA_RETRY;
    delete process.env.GOOGLE_FLOW_CAPTCHA_ORDER;
    expect(withGoogleFlowCaptchaDefaults({ prompt: "hi" })).toEqual({
      prompt: "hi",
      captchaRetry: DEFAULT_GOOGLE_FLOW_CAPTCHA_RETRY,
    });
  });

  it("honors GOOGLE_FLOW_CAPTCHA_RETRY and GOOGLE_FLOW_CAPTCHA_ORDER", () => {
    process.env.GOOGLE_FLOW_CAPTCHA_RETRY = "10";
    process.env.GOOGLE_FLOW_CAPTCHA_ORDER = "AntiCaptcha,CapSolver";
    expect(withGoogleFlowCaptchaDefaults({ prompt: "hi" })).toEqual({
      prompt: "hi",
      captchaRetry: 10,
      captchaOrder: "AntiCaptcha,CapSolver",
    });
  });

  it("clamps captchaRetry to 1..10", () => {
    process.env.GOOGLE_FLOW_CAPTCHA_RETRY = "99";
    expect(resolveGoogleFlowCaptchaRetry()).toBe(10);
    process.env.GOOGLE_FLOW_CAPTCHA_RETRY = "0";
    expect(resolveGoogleFlowCaptchaRetry()).toBe(1);
  });

  it("does not override an explicit captcha field", () => {
    expect(withGoogleFlowCaptchaDefaults({ prompt: "hi", captchaRetry: 3 })).toEqual({
      prompt: "hi",
      captchaRetry: 3,
    });
    expect(withGoogleFlowCaptchaDefaults({ prompt: "hi", captchaOrder: "CapSolver" })).toEqual({
      prompt: "hi",
      captchaOrder: "CapSolver",
    });
  });
});

describe("isCaptchaQualityGoogleFlowError", () => {
  it("detects captcha_quality in the message", () => {
    const err = new GoogleFlowError(
      "Google API error 429: captcha_quality: PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC after 5 attempts",
      429,
    );
    expect(isCaptchaQualityGoogleFlowError(err)).toBe(true);
  });

  it("rejects non-captcha GoogleFlowError and other errors", () => {
    expect(isCaptchaQualityGoogleFlowError(new GoogleFlowError("quota reached", 429))).toBe(false);
    expect(isCaptchaQualityGoogleFlowError(new Error("captcha_quality"))).toBe(false);
  });
});

describe("formatGoogleFlowJobError", () => {
  it("appends nested operation error messages", () => {
    expect(formatGoogleFlowJobError({
      error: "All operations failed",
      response: {
        operations: [
          {
            operation: { name: "op1", error: { code: 3, message: "PUBLIC_ERROR_MINOR" } },
            status: "MEDIA_GENERATION_STATUS_FAILED",
          },
        ],
      },
    })).toBe("All operations failed: PUBLIC_ERROR_MINOR");
  });

  it("appends content-policy reason from response.error.details", () => {
    expect(formatGoogleFlowJobError({
      error: "API error: 400",
      response: {
        error: {
          code: 400,
          message: "Request contains an invalid argument.",
          details: [{ reason: "PUBLIC_ERROR_UNSAFE_GENERATION" }],
        },
      },
    })).toBe("API error: 400: PUBLIC_ERROR_UNSAFE_GENERATION");
  });

  it("falls back when there is no nested detail", () => {
    expect(formatGoogleFlowJobError({ error: "All operations failed" })).toBe("All operations failed");
    expect(formatGoogleFlowJobError({})).toBe("Google Flow job failed");
  });
});

describe("callGoogleFlowWithCaptchaRetry", () => {
  it("retries once after captcha_quality then succeeds", async () => {
    const captchaErr = new GoogleFlowError(
      "Google API error 429: captcha_quality: PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC after 5 attempts",
      429,
    );
    const call = vi.fn()
      .mockRejectedValueOnce(captchaErr)
      .mockResolvedValueOnce({ jobid: "j-ok" });

    const result = await callGoogleFlowWithCaptchaRetry(call, { prompt: "hi" }, { sleepMs: 1 });
    expect(result).toEqual({ jobid: "j-ok" });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0][0]).toMatchObject({
      prompt: "hi",
      captchaRetry: DEFAULT_GOOGLE_FLOW_CAPTCHA_RETRY,
    });
  });

  it("does not retry non-captcha errors", async () => {
    const err = new GoogleFlowError("Google API error 400: bad request", 400);
    const call = vi.fn().mockRejectedValue(err);
    await expect(callGoogleFlowWithCaptchaRetry(call, { prompt: "hi" }, { sleepMs: 1 })).rejects.toBe(err);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
