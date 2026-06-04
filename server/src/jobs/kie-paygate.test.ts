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
});
