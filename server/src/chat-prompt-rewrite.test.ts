import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { createEngineForTest } from "./engine.js";
import {
  CHAT_REWRITE_INSTRUCTION,
  rewriteChatGenerationPrompt,
  rewriteGuideForTool,
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

describe("rewriteGuideForTool", () => {
  it("maps each guided generation family to its prompting guide", () => {
    expect(rewriteGuideForTool("generate_kie_seedance_2_5_video")).toBe("seedance25");
    expect(rewriteGuideForTool("generate_kie_seedance_2_0_video")).toBe("seedance2");
    expect(rewriteGuideForTool("generate_kie_kling_3_0_omni_reference_to_video")).toBe("kling30");
    expect(rewriteGuideForTool("generate_kie_nano_banana_pro_text_to_image")).toBe("nano_banana");
    expect(rewriteGuideForTool("generate_kie_gpt_image_2_image_to_image")).toBe("gpt_image");
    expect(rewriteGuideForTool("generate_xai_grok_imagine_video")).toBe("grok_imagine");
    expect(rewriteGuideForTool("generate_kie_grok_imagine_text_to_image")).toBe("grok_image");
  });

  it("resolves legacy tool names through the generation registry", () => {
    expect(rewriteGuideForTool("generate_grok_imagine_ref_video")).toBe("grok_imagine");
  });

  it("returns null for a generation tool with no guide", () => {
    expect(rewriteGuideForTool("generate_elevenlabs_text_to_audio")).toBeNull();
    expect(rewriteGuideForTool("generate_kie_veo_3_0_video")).toBeNull();
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

  it("passes a guideless generation tool through untouched", async () => {
    const prompt = "Read the opening paragraph aloud";
    expect(await rewriteChatGenerationPrompt(engine, {
      bookId: "test-book",
      tool: "generate_elevenlabs_text_to_audio",
      prompt,
    })).toBe(prompt);
  });

  it("passes a blank prompt through untouched", async () => {
    expect(await rewriteChatGenerationPrompt(engine, {
      bookId: "test-book",
      tool: "generate_kie_seedance_2_5_video",
      prompt: "   ",
    })).toBe("   ");
  });

  it("keeps the original prompt when the rewrite cannot run", async () => {
    delete process.env.OPENAI_API_KEY;
    expect(await rewriteChatGenerationPrompt(engine, {
      bookId: "test-book",
      tool: "generate_kie_seedance_2_5_video",
      prompt: SPOKEN_PROMPT,
    })).toBe(SPOKEN_PROMPT);
  });
});
