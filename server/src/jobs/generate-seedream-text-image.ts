import type { ClipfirstFs } from "clipfirst-engine";
import { kie, submitMediaJob } from "@apicity/kie";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
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
  registerJobHandler("generate_seedream_text_image", async (payload, ctx) => {
    const {
      prompt, imgAssetId, imgAssetDir, projectSlug,
      aspectRatio, quality, nsfwChecker,
    } = payload as GenerateSeedreamTextImagePayload;

    const apiKey = requireApiKey("KIE_API_KEY");

    const provider = kie({ apiKey, timeout: 60_000 });

    const request = buildSeedreamTextImagePayload({
      prompt,
      ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
      ...(quality !== undefined ? { quality } : {}),
      ...(nsfwChecker !== undefined ? { nsfw_checker: nsfwChecker } : {}),
    });
    await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "seedream_text_image",
        assetId: imgAssetId,
        assetDir: imgAssetDir,
        meta: {
          sourceImageIds: [],
          prompt,
          ...(aspectRatio !== undefined ? { aspectRatio } : {}),
          ...(quality !== undefined ? { quality } : {}),
          ...(nsfwChecker !== undefined ? { nsfwChecker } : {}),
        },
    }, ctx.getOwnerId());
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${imgAssetId}: ${_ptResult.error.message}`);
      if (_ptResult.value === null) throw new Error(`Lost local lease while writing pending-task`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}
