import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { createEngine } from "videobook-engine";
import type { Engine } from "videobook-engine";
import { isPlaceholderApiKey } from "../api-key.js";
import { IMAGE_EDIT_ADAPTERS } from "./_image-edit-adapter.js";

/**
 * Live per-model image-edit submissions. Consumes provider credits, so it is a
 * manual run only: `npm run test:image-edit:live` with KIE_API_KEY / FAL_API_KEY
 * exported. Each model gates on its own provider key; models without a key skip.
 */
const KIE_LIVE = !!process.env.KIE_API_KEY && !isPlaceholderApiKey(process.env.KIE_API_KEY);
const FAL_LIVE = !!process.env.FAL_API_KEY && !isPlaceholderApiKey(process.env.FAL_API_KEY);

const EDIT_PROMPTS: Record<string, string> = {
  "seedream/5-pro-image-to-image": "Change the entire image to a uniform deep blue color",
  "gpt-image-2-5-flare-image-to-image": "Change the entire image to a uniform deep blue color",
  "gpt-image-2-5-sunburst-image-to-image": "Change the entire image to a uniform deep blue color",
  "gpt-image-2-image-to-image": "Change the entire image to a uniform deep blue color",
  "fal-ai/nano-banana-pro/edit": "Change the entire image to a uniform deep blue color",
  "fal-ai/nano-banana-2/edit": "Change the entire image to a uniform deep blue color",
  "alibaba/qwen-image-3/edit": "Change the entire image to a uniform deep blue color",
  "fal-ai/wan/v2.7/edit": "Solid deep blue",
};

const LIVE_BY_PROVIDER: Record<string, boolean> = {
  kie: KIE_LIVE,
  fal: FAL_LIVE,
};

async function makeEngine(): Promise<{ engine: Engine; dispose: () => Promise<void> }> {
  const tempDir = await mkdtemp(join(tmpdir(), "videobook-image-edit-live-"));
  const engine = createEngine({
    rootDir: tempDir,
    initialBookName: "image-edit-live",
  });
  return {
    engine,
    dispose: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function makeSourceArtifact(engine: Engine): Promise<string> {
  const source = await engine.artifacts.create({ kind: "image", label: "Live source" });
  if (!source.ok) throw new Error(source.error.message);
  const png = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 30, b: 30 } },
  }).png().toBuffer();
  const written = await engine.files.write(source.value.artifactId, "source.png", png);
  if (!written.ok) throw new Error(written.error.message);
  return source.value.artifactId;
}

for (const adapter of IMAGE_EDIT_ADAPTERS) {
  const providerLive = LIVE_BY_PROVIDER[findProvider(adapter.id)] ?? false;

  describe.skipIf(!providerLive)(`image edit adapter live: ${adapter.id}`, () => {
    it("submits a semantic edit and returns a normalized image buffer", { timeout: 600_000 }, async () => {
      const { engine, dispose } = await makeEngine();
      try {
        const sourceArtifactId = await makeSourceArtifact(engine);
        const output = await engine.artifacts.create({ kind: "image", label: "Live edit output" });
        if (!output.ok) throw new Error(output.error.message);

        const url = await adapter.uploadAsset(engine, sourceArtifactId, "source.png");
        const request = adapter.buildSemanticRequest({
          imageUrls: [url],
          prompt: EDIT_PROMPTS[adapter.id] ?? "Change the entire image to a uniform deep blue color",
          width: 64,
          height: 64,
        });
        const taskId = await adapter.submit(engine, output.value.artifactId, request);
        expect(taskId).toBeTruthy();

        const images = await adapter.awaitResult(taskId, new AbortController().signal);
        expect(images.length).toBeGreaterThan(0);
        const metadata = await sharp(images[0]!).metadata();
        expect(metadata.format).toBe("png");
        expect(metadata.width).toBeGreaterThan(0);
      } finally {
        await dispose();
      }
    });
  });
}

function findProvider(adapterId: string): "kie" | "fal" {
  return adapterId.startsWith("fal") ? "fal" : "kie";
}
