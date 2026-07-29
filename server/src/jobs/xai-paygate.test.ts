import { afterEach, describe, expect, it } from "vitest";
import { canonicalHash, verifyOtp } from "@apicity/cost";
import {
  callXaiPaid,
  mintXaiOtp,
  XAI_IMAGE_GENERATIONS_DOT_PATH,
  XAI_VIDEO_GENERATIONS_DOT_PATH,
} from "./xai-paygate.js";

describe("xai paygate", () => {
  const previousSecret = process.env.APICITY_PAYGATE_SECRET;
  const previousSecretPath = process.env.APICITY_PAYGATE_SECRET_PATH;

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.APICITY_PAYGATE_SECRET;
    else process.env.APICITY_PAYGATE_SECRET = previousSecret;
    if (previousSecretPath === undefined) delete process.env.APICITY_PAYGATE_SECRET_PATH;
    else process.env.APICITY_PAYGATE_SECRET_PATH = previousSecretPath;
  });

  it("mints request-bound xAI OTPs", () => {
    const secret = "test-secret";
    process.env.APICITY_PAYGATE_SECRET = secret;
    delete process.env.APICITY_PAYGATE_SECRET_PATH;

    const request = {
      prompt: "paygate test",
      n: 1,
      response_format: "url",
    };
    const otp = mintXaiOtp(XAI_IMAGE_GENERATIONS_DOT_PATH, request, 60);
    const result = verifyOtp({
      nowSeconds: Math.floor(Date.now() / 1000),
      secret,
      expected: {
        provider: "xai",
        method: "POST",
        dotPath: XAI_IMAGE_GENERATIONS_DOT_PATH,
      },
      payloadHash: canonicalHash(request),
      otp,
      isJtiConsumed: () => false,
    });

    expect(result.ok).toBe(true);
  });

  it("passes a minted approval to paid xAI methods", async () => {
    const secret = "test-secret";
    process.env.APICITY_PAYGATE_SECRET = secret;
    delete process.env.APICITY_PAYGATE_SECRET_PATH;

    const request = {
      prompt: "paygate video",
      duration: 6,
      resolution: "720p",
    };

    const method = async (_request: typeof request, approval?: { otp: string }) => {
      expect(approval?.otp).toEqual(expect.any(String));
      const result = verifyOtp({
        nowSeconds: Math.floor(Date.now() / 1000),
        secret,
        expected: {
          provider: "xai",
          method: "POST",
          dotPath: XAI_VIDEO_GENERATIONS_DOT_PATH,
        },
        payloadHash: canonicalHash(request),
        otp: approval?.otp ?? "",
        isJtiConsumed: () => false,
      });
      expect(result.ok).toBe(true);
      return { request_id: "req-1" };
    };

    await expect(callXaiPaid(method, XAI_VIDEO_GENERATIONS_DOT_PATH, request)).resolves.toEqual({
      request_id: "req-1",
    });
  });
});
