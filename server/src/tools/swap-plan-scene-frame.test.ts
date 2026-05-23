import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { createFs } from "clipfirst-engine";
import type { ClipfirstFs } from "clipfirst-engine";
import { queue } from "../queue.js";
import { swapPlanSceneFrameDef } from "./swap-plan-scene-frame.js";

type TextContent = Array<{ type: string; text: string }>;
type Result<T> = { ok: true; value: T } | { ok: false; error: { message: string } };

const PROJECT = "test-proj";

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function testPng(width = 10, height = 10): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  }).png().toBuffer();
}

describe("swap_plan_scene_frame aspect payloads", () => {
  let tempDir: string;
  let fs: ClipfirstFs;
  const originalKieKey = process.env.KIE_API_KEY;
  const originalFalKey = process.env.FAL_API_KEY;

  beforeEach(async () => {
    process.env.KIE_API_KEY = "test-kie-key";
    process.env.FAL_API_KEY = "test-fal-key";
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-swap-plan-scene-frame-test-"));
    fs = createFs({ projectsDir: tempDir });
    unwrap(await fs.createProject(PROJECT));
    vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalKieKey) {
      process.env.KIE_API_KEY = originalKieKey;
    } else {
      delete process.env.KIE_API_KEY;
    }
    if (originalFalKey) {
      process.env.FAL_API_KEY = originalFalKey;
    } else {
      delete process.env.FAL_API_KEY;
    }
    fs.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function seedPlan(width: number, height: number): Promise<string[]> {
    const source = unwrap(await fs.createAsset("vid", "source", PROJECT));
    unwrap(await fs.writeMetadata(source.assetId, "original", { width, height, duration: 10 }, PROJECT));

    const chars: string[] = [];
    const png = await testPng();
    for (const name of ["char-a", "char-b"]) {
      const asset = unwrap(await fs.createAsset("img", name, PROJECT));
      unwrap(await fs.writeFile(asset.assetId, "original.png", png, PROJECT));
      chars.push(asset.assetId);
    }

    const project = unwrap(await fs.getProject(PROJECT));
    await mkdir(join(project.path, "plan"), { recursive: true });
    const sidecar = {
      scenes: [{
        start: 0,
        end: 8,
        visual: "A test scene with two people.",
        swap: { image1: null, image2: null },
      }],
      source_asset_id: source.assetId,
      characters: chars.map((assetId, index) => ({
        asset_id: assetId,
        name: `Character ${index + 1}`,
        description: "",
      })),
      total_duration_s: 8,
      max_scene_seconds: 14,
      model: "test-model",
    };
    unwrap(await fs.writeFile("plan", ".plan.json", JSON.stringify(sidecar, null, 2), PROJECT));
    unwrap(await fs.writeFile("plan", "s1-image1-source.jpg", await testPng(32, 18), PROJECT));
    return chars;
  }

  function enqueuedPayload(): Record<string, unknown> {
    const enqueue = vi.mocked(queue.enqueue);
    expect(enqueue).toHaveBeenCalledTimes(1);
    return enqueue.mock.calls[0][1] as Record<string, unknown>;
  }

  it("enqueues KIE swaps with a source-derived aspect ratio", async () => {
    const chars = await seedPlan(1080, 1920);

    const result = await swapPlanSceneFrameDef(fs).handler({
      project_slug: PROJECT,
      scene_index: 0,
      frame_index: 1,
      character_asset_ids: chars.map((id) => `@${id}`),
      provider: "kie",
      model: "nano-banana-pro",
    });

    expect(result.isError).toBeFalsy();
    const payload = enqueuedPayload();
    expect(payload.aspectRatio).toBe("9:16");
    expect(payload.resolution).toBe("2K");
    const parsed = JSON.parse((result.content as TextContent)[0].text) as { aspect?: Record<string, unknown> };
    expect(parsed.aspect).toMatchObject({
      source_width: 1080,
      source_height: 1920,
      image_aspect_ratio: "9:16",
    });
  });

  it("enqueues Fal Nano Banana swaps with a source-derived aspect ratio", async () => {
    const chars = await seedPlan(1440, 1080);

    const result = await swapPlanSceneFrameDef(fs).handler({
      project_slug: PROJECT,
      scene_index: 0,
      frame_index: 1,
      character_asset_ids: chars.map((id) => `@${id}`),
      provider: "fal",
      model: "nano-banana-pro",
    });

    expect(result.isError).toBeFalsy();
    const payload = enqueuedPayload();
    expect(payload.aspect_ratio).toBe("4:3");
    expect(payload.resolution).toBe("2K");
  });

  it("enqueues Fal Wan swaps with a source-derived image size", async () => {
    const chars = await seedPlan(1080, 1440);

    const result = await swapPlanSceneFrameDef(fs).handler({
      project_slug: PROJECT,
      scene_index: 0,
      frame_index: 1,
      character_asset_ids: chars.map((id) => `@${id}`),
      provider: "fal",
      model: "wan-2-7-image-pro",
    });

    expect(result.isError).toBeFalsy();
    const payload = enqueuedPayload();
    expect(payload.image_size).toBe("portrait_4_3");
    expect(payload.aspect_ratio).toBeUndefined();
  });
});
