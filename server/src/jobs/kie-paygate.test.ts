import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalHash, parseOtp, verifyOtpSignature } from "@apicity/cost";
import { ensurePaygateKeyPaths, KIE_PAYGATE_DOT_PATH, mintKieOtp } from "./kie-paygate.js";

describe("kie paygate", () => {
  let tempDir: string;
  let previousPrivate: string | undefined;
  let previousPublic: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-kie-paygate-test-"));
    previousPrivate = process.env.APICITY_PAYGATE_PRIVATE_KEY_PATH;
    previousPublic = process.env.APICITY_PAYGATE_PUBLIC_KEY_PATH;
    delete process.env.APICITY_PAYGATE_PRIVATE_KEY_PATH;
    delete process.env.APICITY_PAYGATE_PUBLIC_KEY_PATH;
  });

  afterEach(async () => {
    if (previousPrivate === undefined) delete process.env.APICITY_PAYGATE_PRIVATE_KEY_PATH;
    else process.env.APICITY_PAYGATE_PRIVATE_KEY_PATH = previousPrivate;
    if (previousPublic === undefined) delete process.env.APICITY_PAYGATE_PUBLIC_KEY_PATH;
    else process.env.APICITY_PAYGATE_PUBLIC_KEY_PATH = previousPublic;
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("derives a public key next to a configured private key and mints a request-bound OTP", async () => {
    const { privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const privatePath = join(tempDir, "paygate-private.pem");
    await writeFile(privatePath, privateKey, "utf8");
    process.env.APICITY_PAYGATE_PRIVATE_KEY_PATH = privatePath;

    const paths = ensurePaygateKeyPaths();
    expect(paths.privateKeyPath).toBe(privatePath);
    expect(paths.publicKeyPath).toBe(`${privatePath}.pub`);
    expect(process.env.APICITY_PAYGATE_PUBLIC_KEY_PATH).toBe(`${privatePath}.pub`);

    const request = {
      model: "grok-imagine/text-to-image" as const,
      input: { prompt: "paygate test" },
    };
    const otp = mintKieOtp(request, 60);
    const parsed = parseOtp(otp);
    const publicKeyPem = await readFile(paths.publicKeyPath, "utf8");
    const payloadSegment = otp.split(".")[0] ?? "";

    expect(verifyOtpSignature(payloadSegment, parsed.signature, publicKeyPem)).toBe(true);
    expect(parsed.payload).toMatchObject({
      v: 1,
      provider: "kie",
      method: "POST",
      dotPath: KIE_PAYGATE_DOT_PATH,
      requestHash: canonicalHash(request),
    });
    expect(parsed.payload.maxSpendUsd).toBeGreaterThan(0);
    expect(parsed.payload.exp - parsed.payload.iat).toBe(60);
  });

  it("rejects a grok-imagine/extend request with no resolution hint as unbounded", () => {
    // grok-imagine/extend keys its rate off (extend_times, resolution). The kie
    // input schema carries only task_id + extend_times, so without a resolution
    // hint the lookup misses ("variant '6'") and the estimate is unbounded.
    const request = {
      model: "grok-imagine/extend" as const,
      input: {
        task_id: "task-123",
        prompt: "extend it",
        extend_at: "4",
        extend_times: "6" as const,
      },
    };
    expect(() => mintKieOtp(request, 60)).toThrow(/cost estimate is not bounded/);
  });

  it("mints a bounded OTP for a grok-imagine/extend request with a top-level resolution hint", async () => {
    const { privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const privatePath = join(tempDir, "paygate-private.pem");
    await writeFile(privatePath, privateKey, "utf8");
    process.env.APICITY_PAYGATE_PRIVATE_KEY_PATH = privatePath;
    ensurePaygateKeyPaths();

    const request = {
      model: "grok-imagine/extend" as const,
      resolution: "480p" as const,
      input: {
        task_id: "task-123",
        prompt: "extend it",
        extend_at: "4",
        extend_times: "6" as const,
      },
    };
    const otp = mintKieOtp(request, 60);
    const parsed = parseOtp(otp);

    // 6|480p is a flat per-generation rate of $0.05 in the kie rate table.
    expect(parsed.payload.maxSpendUsd).toBe(0.05);
    // The resolution hint must be part of the hashed request so the paygate
    // verifies against the same payload that gets submitted.
    expect(parsed.payload.requestHash).toBe(canonicalHash(request));
  });
});
