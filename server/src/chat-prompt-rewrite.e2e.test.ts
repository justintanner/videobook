import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { isPlaceholderApiKey } from "./api-key.js";
import { createEngineForTest } from "./engine.js";
import { rewriteChatGenerationPrompt } from "./chat-prompt-rewrite.js";

/**
 * Live guide-backed rewrite against OpenAI. Spends tokens, so it is a manual
 * run only: it SKIPS unless a real OPENAI_API_KEY is present (the shared test
 * guard in vitest.setup.ts deletes provider keys and blocks outbound fetch, so
 * this executes only when that guard is deliberately relaxed).
 *
 * It asserts the two properties the chat path depends on rather than any
 * wording: the @ mentions come back byte-for-byte, and the routing language
 * that named the model is gone from the prompt the provider will render.
 */
const KEY = process.env.OPENAI_API_KEY;
const LIVE = !!KEY && !isPlaceholderApiKey(KEY);

const IMAGE_MENTION = "@0199f0e4-9332-7383-b1a9-eb016abd4fdb";
const VIDEO_MENTION = "@0199f0e6-4373-70f0-a5ed-a2f2c64ffccb";
const SPOKEN_PROMPT =
  `Make a sea dance video with the kittens in ${IMAGE_MENTION} `
  + `dancing like the video in ${VIDEO_MENTION}`;

describe.skipIf(!LIVE)("chat prompt rewrite — live", () => {
  let tempDir: string;
  let engine: Engine;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-rewrite-live-"));
    engine = createEngineForTest(tempDir);
  });

  afterEach(async () => {
    await engine.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("keeps the references and drops the spoken model name", async () => {
    const rewritten = await rewriteChatGenerationPrompt(engine, {
      bookId: "test-book",
      tool: "generate_kie_seedance_2_5_video",
      prompt: SPOKEN_PROMPT,
    });
    expect(rewritten).not.toBe(SPOKEN_PROMPT);
    expect(rewritten).toContain(IMAGE_MENTION);
    expect(rewritten).toContain(VIDEO_MENTION);
    expect(rewritten.toLowerCase()).not.toContain("sea dance");
    expect(rewritten.toLowerCase()).not.toContain("seedance");
  });
});
