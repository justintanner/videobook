import type { ClipfirstFs } from "clipfirst-fs";
import { kie, submitMediaJob } from "@nakedapi/kie";
import { xai } from "@nakedapi/xai";
import { registerJobHandler } from "../queue.js";
import { writePendingTask, deletePendingTask } from "./pending-task.js";
import { buildGrokImagineTextPayload } from "../payload-builders.js";

type GenerateGrokImagineTextImagePayload = {
  type: "generate_grok_imagine_text_image";
  prompt: string;
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  aspectRatio?: string;
  _provider?: string;
};

export function registerGenerateGrokImagineTextImageJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_grok_imagine_text_image", async (payload) => {
    const {
      prompt, imgAssetId, imgAssetDir, projectSlug, aspectRatio, _provider,
    } = payload as GenerateGrokImagineTextImagePayload;

    const isXai = _provider !== undefined && _provider.startsWith("xai");

    if (isXai) {
      // xAI path — synchronous image generation
      const apiKey = process.env.XAI_API_KEY;
      if (!apiKey) throw new Error("XAI_API_KEY environment variable is not set");

      const provider = xai({ apiKey, timeout: 120_000 });

      const request = {
        prompt,
        n: 1,
        response_format: "url" as const,
        ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
      };
      const result = await provider.post.v1.images.generations(request);

      const imageUrl = result.data[0]?.url;
      if (!imageUrl) throw new Error("xAI returned no image URL");

      const resp = await fetch(imageUrl);
      if (!resp.ok) throw new Error(`Failed to download result image: ${resp.status}`);
      const resultBuffer = Buffer.from(await resp.arrayBuffer());

      await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
      await fs.writeFile(imgAssetId, "original.png", resultBuffer, projectSlug);
      await deletePendingTask(fs, imgAssetId, projectSlug);

      return { success: true, provider: "xai" };
    }

    // Kie path — async task-based generation
    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const request = buildGrokImagineTextPayload({ prompt, aspect_ratio: aspectRatio });
    const taskId = await submitMediaJob(provider, request);

    await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
    await writePendingTask(fs, imgAssetId, projectSlug, {
      taskId,
      taskType: "grok_imagine_text",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: { prompt, ...(aspectRatio !== undefined ? { aspectRatio } : {}) },
    });

    return { success: true, taskId };
  });
}
