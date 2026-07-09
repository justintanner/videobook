import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleFlowError } from "@apicity/googleflow";
import {
  callGoogleFlowWithCaptchaRetry,
  DEFAULT_GOOGLE_FLOW_CAPTCHA_RETRY,
  describeGoogleFlowJobFailure,
  extractGoogleFlowFailureDetails,
  formatGoogleFlowJobError,
  googleFlowFetch,
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

// Real captured job body from a failed omni-flash generation in projects/pilot:
// Google's PROMINENT_PEOPLE safety filter blocked the character reference photos.
// The actionable failure lives in response.media[].mediaMetadata.mediaStatus,
// NOT in response.operations[] or response.error — the case the original
// extractor missed (cards showed bare "All operations failed").
const PROMINENT_PEOPLE_JOB = {
  status: "failed",
  error: "All operations failed",
  response: {
    media: [
      {
        mediaMetadata: {
          mediaGenerationStatus: "MEDIA_GENERATION_STATUS_FAILED",
          mediaStatus: {
            error: { code: 3, message: "PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED" },
            failureReasons: ["IDENTIFIABLE_PERSON_SAFETY"],
          },
        },
      },
    ],
  },
};

describe("extractGoogleFlowFailureDetails / formatGoogleFlowJobError (mediaStatus path)", () => {
  it("extracts code + reasons from media[].mediaMetadata.mediaStatus", () => {
    expect(formatGoogleFlowJobError(PROMINENT_PEOPLE_JOB)).toBe(
      "All operations failed: PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED (IDENTIFIABLE_PERSON_SAFETY)",
    );
  });

  it("dedups a code that appears in both operations and mediaStatus", () => {
    expect(extractGoogleFlowFailureDetails({
      response: {
        operations: [
          { operation: { error: { message: "PUBLIC_ERROR_MINOR" } } },
        ],
        media: [
          { mediaMetadata: { mediaStatus: { error: { message: "PUBLIC_ERROR_MINOR" } } } },
        ],
      },
    })).toEqual([{ code: "PUBLIC_ERROR_MINOR", reasons: [] }]);
  });

  it("excludes a reason equal to the code", () => {
    const details = extractGoogleFlowFailureDetails({
      response: {
        media: [{
          mediaMetadata: {
            mediaStatus: {
              error: { message: "PUBLIC_ERROR_X" },
              failureReasons: ["PUBLIC_ERROR_X", "EXTRA"],
            },
          },
        }],
      },
    });
    expect(details).toEqual([{ code: "PUBLIC_ERROR_X", reasons: ["EXTRA"] }]);
  });

  it("ignores mediaStatus on a non-failed media item", () => {
    expect(extractGoogleFlowFailureDetails({
      response: {
        media: [{
          mediaMetadata: {
            mediaGenerationStatus: "MEDIA_GENERATION_STATUS_SUCCEEDED",
            mediaStatus: { error: { message: "SHOULD_NOT_APPEAR" } },
          },
        }],
      },
    })).toEqual([]);
  });
});

describe("describeGoogleFlowJobFailure", () => {
  it("appends friendly guidance + sets failCode for the prominent-people case", () => {
    const { message, failCode } = describeGoogleFlowJobFailure(PROMINENT_PEOPLE_JOB);
    expect(failCode).toBe("PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED");
    expect(message).toBe(
      "All operations failed: PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED (IDENTIFIABLE_PERSON_SAFETY) — "
      + "Google blocked this: the character/reference photos appear to contain an identifiable real person. "
      + "Use stylized or AI-generated character images, remove the character refs, or try a different provider.",
    );
  });

  it("matches on the IDENTIFIABLE_PERSON_SAFETY reason too", () => {
    const { message } = describeGoogleFlowJobFailure({
      error: "All operations failed",
      response: {
        media: [{
          mediaMetadata: {
            mediaStatus: {
              error: { message: "SOME_OTHER_CODE" },
              failureReasons: ["IDENTIFIABLE_PERSON_SAFETY"],
            },
          },
        }],
      },
    });
    expect(message).toContain("Google blocked this: the character/reference photos");
  });

  it("degrades to the technical string for unmapped codes", () => {
    const { message, failCode } = describeGoogleFlowJobFailure({
      error: "All operations failed",
      response: { operations: [{ operation: { error: { message: "UNKNOWN_ERROR_CODE" } } }] },
    });
    expect(failCode).toBe("UNKNOWN_ERROR_CODE");
    expect(message).toBe("All operations failed: UNKNOWN_ERROR_CODE");
  });

  it("returns no failCode when there are no details", () => {
    expect(describeGoogleFlowJobFailure({ error: "All operations failed" })).toEqual({
      message: "All operations failed",
    });
  });
});

describe("googleFlowFetch path-ID decode (vc-4e8z)", () => {
  it("decodes percent-encoded : and @ in job/asset path segments before fetch", async () => {
    const seen: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(typeof input === "string" ? input : input instanceof URL ? input.href : String(input));
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    }) as typeof fetch;
    try {
      const encodedJob =
        "https://api.useapi.net/v1/google-flow/jobs/"
        + encodeURIComponent("j0707v-u2935-email:justin@gmail.com-bot:google-flow");
      const encodedAsset =
        "https://api.useapi.net/v1/google-flow/assets/"
        + encodeURIComponent("user:2935-email:abc-image:3ba11e5c-fd2c");
      await googleFlowFetch(encodedJob);
      await googleFlowFetch(encodedAsset);
      expect(seen[0]).toBe(
        "https://api.useapi.net/v1/google-flow/jobs/j0707v-u2935-email:justin@gmail.com-bot:google-flow",
      );
      expect(seen[0]).toContain("email:justin@gmail.com");
      expect(seen[0]).not.toContain("%3A");
      expect(seen[0]).not.toContain("%40");
      expect(seen[1]).toContain("user:2935-email:abc-image:");
      expect(seen[1]).not.toContain("%3A");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("leaves already-raw path IDs unchanged (no-op when package stops over-encoding)", async () => {
    const seen: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(typeof input === "string" ? input : String(input));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const raw = "https://api.useapi.net/v1/google-flow/jobs/j0707v-u2935-email:justin@gmail.com-bot:google-flow";
      await googleFlowFetch(raw);
      expect(seen[0]).toBe(raw);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
