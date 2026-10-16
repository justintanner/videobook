import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { createEngineForTest } from "./engine.js";
import {
  CHAT_REWRITE_INSTRUCTION,
  rewriteChatGenerationPrompt,
  rewriteGuideForModel,
  usableRewrite,
} from "./chat-prompt-rewrite.js";
import { rewritePromptDef } from "./tools/rewrite-prompt.js";

const IMAGE_MENTION = "@0199f0e4-9332-7383-b1a9-eb016abd4fdb";
const VIDEO_MENTION = "@0199f0e6-4373-70f0-a5ed-a2f2c64ffccb";

// The utterance that started this: speech-to-text renders "Seedance" as "sea
// dance", and without a rewrite the model name becomes the subject.
const SPOKEN_PROMPT =
  `Make a sea dance video with the kittens in ${IMAGE_MENTION} `
  + `dancing like the video in ${VIDEO_MENTION}`;

describe("CHAT_REWRITE_INSTRUCTION", () => {
  it("fits the custom_prompt limit rewrite_prompt enforces", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "videobook-rewrite-schema-"));
    const engine = createEngineForTest(tempDir);
    try {
      expect(rewritePromptDef(engine).schema.custom_prompt).toBeDefined();
      expect(CHAT_REWRITE_INSTRUCTION.length).toBeLessThanOrEqual(500);
    } finally {
      await engine.close();
      await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe("rewriteGuideForModel", () => {
  it("maps each guided catalog model to its prompting guide", () => {
    expect(rewriteGuideForModel("kie:bytedance/seedance-2-5")).toBe("seedance25");
    expect(rewriteGuideForModel("kie:kling-3.0-omni/reference-to-video")).toBe("kling30");
    expect(rewriteGuideForModel("kie:nano-banana-pro")).toBe("nano_banana");
    expect(rewriteGuideForModel("kie:gpt-image-2-5-flare-text-to-image")).toBe("gpt_image");
    expect(rewriteGuideForModel("kie:gpt-image-2-5-sunburst-image-to-image")).toBe("gpt_image");
    expect(rewriteGuideForModel("xai:grok-imagine-video")).toBe("grok_imagine");
    expect(rewriteGuideForModel("kie:grok-imagine/text-to-image")).toBe("grok_image");
  });

  it("returns null for a model with no guide or an unknown id", () => {
    expect(rewriteGuideForModel("elevenlabs:text-to-speech")).toBeNull();
    expect(rewriteGuideForModel("kie:veo3")).toBeNull();
    expect(rewriteGuideForModel("generate_kie_seedance_2_5_video")).toBeNull();
  });
});

describe("usableRewrite", () => {
  it("takes the rewrite when every mention survives it", () => {
    const rewritten =
      `Kittens from ${IMAGE_MENTION}, dancing. Match the choreography of ${VIDEO_MENTION}.`;
    expect(usableRewrite(SPOKEN_PROMPT, rewritten)).toBe(rewritten);
  });

  it("keeps the original when the rewrite drops a mention", () => {
    const rewritten = `Kittens from ${IMAGE_MENTION}, dancing on the shoreline.`;
    expect(usableRewrite(SPOKEN_PROMPT, rewritten)).toBe(SPOKEN_PROMPT);
  });

  it("keeps the original when the rewrite renumbers mentions into provider markers", () => {
    const rewritten = "Kittens from @Image1, dancing like @Video1.";
    expect(usableRewrite(SPOKEN_PROMPT, rewritten)).toBe(SPOKEN_PROMPT);
  });

  it("keeps the original when the rewrite comes back blank", () => {
    expect(usableRewrite(SPOKEN_PROMPT, "   ")).toBe(SPOKEN_PROMPT);
  });

  it("trims a rewrite it accepts", () => {
    expect(usableRewrite("kittens dancing", "  Kittens, dancing.  "))
      .toBe("Kittens, dancing.");
  });

  it("accepts any rewrite of a prompt that carries no mentions", () => {
    expect(usableRewrite("make a seedance video of kittens", "Kittens, dancing."))
      .toBe("Kittens, dancing.");
  });
});

describe("rewriteChatGenerationPrompt", () => {
  let tempDir: string;
  let engine: Engine;
  const originalKey = process.env.OPENAI_API_KEY;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-rewrite-"));
    engine = createEngineForTest(tempDir);
  });

  afterEach(async () => {
    if (originalKey) process.env.OPENAI_API_KEY = originalKey;
    else delete process.env.OPENAI_API_KEY;
    await engine.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("passes a guideless generation model through untouched", async () => {
    const prompt = "Read the opening paragraph aloud";
    expect(await rewriteChatGenerationPrompt(engine, {
      bookId: "test-book",
      model: "elevenlabs:text-to-speech",
      prompt,
    })).toBe(prompt);
  });

  it("passes a blank prompt through untouched", async () => {
    expect(await rewriteChatGenerationPrompt(engine, {
      bookId: "test-book",
      model: "kie:bytedance/seedance-2-5",
      prompt: "   ",
    })).toBe("   ");
  });

  it("keeps the original prompt when the rewrite cannot run", async () => {
    delete process.env.OPENAI_API_KEY;
    expect(await rewriteChatGenerationPrompt(engine, {
      bookId: "test-book",
      model: "kie:bytedance/seedance-2-5",
      prompt: SPOKEN_PROMPT,
    })).toBe(SPOKEN_PROMPT);
  });
});
