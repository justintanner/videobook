import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { NanoBanana21RequestSchema } from "@apicity/kie/zod";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../engine.js";
import { pauseBookQueueForTests } from "../queue.js";
import { translateToolPayload } from "../payload-builders.js";
import { assessKieRequestEstimate, assessToolCallEstimate } from "../jobs/cost-estimate-assessment.js";
import { imageEditAdapter } from "../jobs/_image-edit-adapter.js";
import { getImageToolSchema } from "../image-models.js";

const tool = "generate_kie_nano_banana_2_1_image";

describe("Nano Banana 2.1 generation and editing", () => {
  let root: string;
  let engine: Engine;
  let client: Client;
  const key = process.env.KIE_API_KEY;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-nb21-"));
    engine = createEngineForTest(root);
    client = await createTestClient(root);
    await pauseBookQueueForTests(engine.book.get().bookId);
    process.env.KIE_API_KEY = "test-nb21-key";
  });

  afterEach(async () => {
    await client.close();
    if (key === undefined) delete process.env.KIE_API_KEY; else process.env.KIE_API_KEY = key;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("queues the registered action, exposes its settings and translates references into the published request", async () => {
    const response = await client.callTool({ name: tool, arguments: { book_id: engine.book.get().bookId, prompt: "A street interview", resolution: "2K", aspect_ratio: "9:16" } });
    expect(response.isError).toBeFalsy();
    const jobs = engine.jobs.queue.list({ type: tool });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ toolName: tool, args: { resolution: "2K", aspect_ratio: "9:16" } });
    const schema = getImageToolSchema(tool);
    expect(schema?.properties).toHaveProperty("resolution");
    expect(schema?.properties).toHaveProperty("image_refs");
    const refs = Array.from({ length: 10 }, (_, index) => `https://example.test/${index}.png`);
    const translated = translateToolPayload(tool, { prompt: "Edit @image1 using @image2", image_refs: refs, resolution: "2K", aspect_ratio: "9:16" });
    expect(translated?.payload).toMatchObject({ model: "nano-banana-2-1", input: { image_input: refs, resolution: "2K", aspect_ratio: "9:16", output_format: "jpg" } });
    expect(NanoBanana21RequestSchema.safeParse(translated?.payload).success).toBe(true);
    expect(JSON.stringify(translated)).not.toContain("@image");
    expect(() => translateToolPayload(tool, { prompt: "Edit", image_refs: [...refs, "https://example.test/overflow.png"] })).toThrow("at most 10");
  });

  it("prices generation and default editing from the same published model and keeps stored model selection", async () => {
    for (const [resolution, usd] of [["1K", 0.02], ["2K", 0.03], ["4K", 0.045]] as const) {
      const quote = await assessToolCallEstimate(engine, tool, { prompt: "Edit", resolution });
      expect(quote.available).toBe(true);
      expect(quote.usd).toBeCloseTo(usd);
    }
    const adapter = imageEditAdapter("nano-banana-2-1")!;
    const request = adapter.buildSemanticRequest({ prompt: "Make the microphone bigger", imageUrls: ["https://example.test/source.png"], width: 1080, height: 1920 });
    expect(request).toMatchObject({ model: "nano-banana-2-1", input: { aspect_ratio: "9:16", output_format: "png", resolution: "1K" } });
    expect(assessKieRequestEstimate(NanoBanana21RequestSchema.parse(request)).usd).toBeCloseTo(0.02);
    expect(adapter.parseStoredPayload(request)?.model).toBe("nano-banana-2-1");
    const old = imageEditAdapter("seedream/5-pro-image-to-image")!;
    const oldRequest = old.buildSemanticRequest({ prompt: "Keep the saved model", imageUrls: ["https://example.test/source.png"], width: 1080, height: 1920 });
    expect(old.parseStoredPayload(oldRequest)?.model).toBe("seedream/5-pro-image-to-image");
    expect(adapter.parseStoredPayload(oldRequest)).toBeNull();
  });
});
