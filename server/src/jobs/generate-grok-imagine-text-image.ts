import type { ClipfirstFs } from "clipfirst-fs";
import { xai } from "@nakedapi/xai";
import { registerJobHandler } from "../queue.js";
import { deletePendingTask } from "./pending-task.js";

type GenerateGrokImagineTextImagePayload = {
  type: "generate_grok_imagine_text_image";
  prompt: string;
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  aspectRatio?: string;
  resolution?: "1k" | "2k";
};

export function registerGenerateGrokImagineTextImageJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_grok_imagine_text_image", async (payload) => {
    const {
      prompt, imgAssetId, projectSlug, aspectRatio, resolution,
    } = payload as GenerateGrokImagineTextImagePayload;

    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) throw new Error("XAI_API_KEY environment variable is not set");

    const provider = xai({ apiKey, timeout: 120_000 });

    const request = {
      prompt,
      n: 1,
      response_format: "url" as const,
      ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
      ...(resolution !== undefined ? { resolution } : {}),
    };
    await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);

    const result = await provider.v1.images.generations(request);

    const imageUrl = result.data[0]?.url;
    if (!imageUrl) throw new Error("xAI returned no image URL");

    const resp = await fetch(imageUrl);
    if (!resp.ok) throw new Error(`Failed to download result image: ${resp.status}`);
    const resultBuffer = Buffer.from(await resp.arrayBuffer());

    await fs.writeFile(imgAssetId, "original.png", resultBuffer, projectSlug);
    await deletePendingTask(fs, imgAssetId, projectSlug);

    return { success: true, provider: "xai" };
  });
}
