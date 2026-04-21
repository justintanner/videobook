import type { ClipfirstFs } from "clipfirst-fs";
import { kie, submitMediaJob } from "@apicity/kie";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
import { buildSeedreamTextImagePayload } from "../payload-builders.js";

type GenerateSeedreamTextImagePayload = {
  type: "generate_seedream_text_image";
  prompt: string;
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  aspectRatio?: "1:1" | "4:3" | "3:4" | "16:9" | "9:16" | "2:3" | "3:2" | "21:9";
  quality?: "basic" | "high";
  nsfwChecker?: boolean;
};

export function registerGenerateSeedreamTextImageJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_seedream_text_image", async (payload) => {
    const {
      prompt, imgAssetId, imgAssetDir, projectSlug,
      aspectRatio, quality, nsfwChecker,
    } = payload as GenerateSeedreamTextImagePayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const request = buildSeedreamTextImagePayload({
      prompt,
      ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
      ...(quality !== undefined ? { quality } : {}),
      ...(nsfwChecker !== undefined ? { nsfw_checker: nsfwChecker } : {}),
    });
    await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    await writePendingTask(fs, imgAssetId, projectSlug, {
      taskId,
      taskType: "seedream_text_image",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        sourceImageIds: [],
        prompt,
        ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        ...(quality !== undefined ? { quality } : {}),
        ...(nsfwChecker !== undefined ? { nsfwChecker } : {}),
      },
    });

    return { success: true, taskId };
  });
}
