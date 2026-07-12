import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import { createFs } from "videocity-engine";
import sharp from "sharp";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

describe("generate_grok_imagine_video tool", () => {
  let client: Client;
  let tempDir: string;
  const originalKey = process.env.KIE_API_KEY;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  beforeEach(async () => {
    delete process.env.KIE_API_KEY;
    tempDir = await mkdtemp(join(tmpdir(), "videocity-grok-imagine-video-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
  });

  afterEach(async () => {
    if (originalKey) {
      process.env.KIE_API_KEY = originalKey;
    } else {
      delete process.env.KIE_API_KEY;
    }
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error when KIE_API_KEY is not set", async () => {
    const result = await client.callTool({
      name: "generate_grok_imagine_video",
      arguments: {
        asset_id: "img-test",
        project_slug: "test-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("not set");
  });

  it("returns error when asset_id does not start with img-", async () => {
    process.env.KIE_API_KEY = "test-key";

    const result = await client.callTool({
      name: "generate_grok_imagine_video",
      arguments: {
        asset_id: "vid-something",
        project_slug: "test-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("must start with img-");
  });

  it("returns error for nonexistent image asset", async () => {
    process.env.KIE_API_KEY = "test-key";

    const result = await client.callTool({
      name: "generate_grok_imagine_video",
      arguments: {
        asset_id: "img-does-not-exist",
        project_slug: "test-proj",
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when image asset has no image file", async () => {
    process.env.KIE_API_KEY = "test-key";

    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("img", "empty-img", "test-proj");
    if (!asset.ok) throw new Error("Failed to create asset");

    await fs.writeFile(asset.value.assetId, "notes.txt", "hello", "test-proj");

    const result = await client.callTool({
      name: "generate_grok_imagine_video",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "test-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No image file");
  });

  it("enqueues job with valid image asset", async () => {
    process.env.KIE_API_KEY = "test-key";

    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("img", "source-img", "test-proj");
    if (!asset.ok) throw new Error("Failed to create asset");

    const png = await sharp({
      create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer();
    await fs.writeFile(asset.value.assetId, "original.png", png, "test-proj");

    const result = await client.callTool({
      name: "generate_grok_imagine_video",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "test-proj",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.vid_asset_id).toMatch(/^vid-/);
    expect(parsed.source_images).toEqual([asset.value.assetId]);
    expect(parsed.job_id).toBeDefined();
  });

  it("enqueues job with up to 7 image_slugs", async () => {
    process.env.KIE_API_KEY = "test-key";

    const fs = createFs({ projectsDir: tempDir });
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const a = await fs.createAsset("img", `ref-${i}`, "test-proj");
      if (!a.ok) throw new Error("Failed to create asset");
      const png = await sharp({
        create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
      }).png().toBuffer();
      await fs.writeFile(a.value.assetId, "original.png", png, "test-proj");
      ids.push(a.value.assetId);
    }

    const result = await client.callTool({
      name: "generate_grok_imagine_video",
      arguments: {
        image_slugs: ids,
        project_slug: "test-proj",
        duration: 12,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.source_images).toEqual(ids);
  });

  it("rejects more than 7 image_slugs", async () => {
    process.env.KIE_API_KEY = "test-key";

    const fs = createFs({ projectsDir: tempDir });
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const a = await fs.createAsset("img", `over-${i}`, "test-proj");
      if (!a.ok) throw new Error("Failed to create asset");
      const png = await sharp({
        create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
      }).png().toBuffer();
      await fs.writeFile(a.value.assetId, "original.png", png, "test-proj");
      ids.push(a.value.assetId);
    }

    const result = await client.callTool({
      name: "generate_grok_imagine_video",
      arguments: {
        image_slugs: ids,
        project_slug: "test-proj",
        duration: 12,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("expected array to have <=7 items");
  });

  it("accepts a slashed @nb-1/<file> reference for replace_audio_with", async () => {
    process.env.KIE_API_KEY = "test-key";

    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("img", "anchor-img", "test-proj");
    if (!asset.ok) throw new Error("Failed to create asset");
    const png = await sharp({
      create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer();
    await fs.writeFile(asset.value.assetId, "original.png", png, "test-proj");

    // A plan may address per-scene audio as @nb-1/sN.mp3 — a sibling file inside
    // the non-media-prefixed `plan` asset, not an aud-* asset.
    const planDir = join(tempDir, "test-proj", "nb-1");
    await mkdir(planDir, { recursive: true });
    await writeFile(join(planDir, "s1.mp3"), Buffer.from("fake-mp3-bytes"));

    const result = await client.callTool({
      name: "generate_grok_imagine_video",
      arguments: {
        image_slugs: [asset.value.assetId],
        project_slug: "test-proj",
        replace_audio_with: "@nb-1/s1.mp3",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.replace_audio_with).toBe("nb-1");
  });

  it("rejects a bare non-aud reference for replace_audio_with", async () => {
    process.env.KIE_API_KEY = "test-key";

    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("img", "anchor2-img", "test-proj");
    if (!asset.ok) throw new Error("Failed to create asset");
    const png = await sharp({
      create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer();
    await fs.writeFile(asset.value.assetId, "original.png", png, "test-proj");

    const result = await client.callTool({
      name: "generate_grok_imagine_video",
      arguments: {
        image_slugs: [asset.value.assetId],
        project_slug: "test-proj",
        replace_audio_with: "vid-not-audio",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("audio slug must be aud-* asset");
  });

  it("returns standardized error when neither image_slugs nor asset_id is given", async () => {
    process.env.KIE_API_KEY = "test-key";

    const result = await client.callTool({
      name: "generate_grok_imagine_video",
      arguments: {
        project_slug: "test-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("requires at least one of: image_slugs, asset_id");
  });
});
