import type { VideocityFs } from "videocity-engine";
import type { HappyHorse11AspectRatio, HappyHorseResolution } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildHappyHorseRefPayload } from "../payload-builders.js";
import { rewriteImageSlugMentionsToBrackets } from "../google-flow-refs.js";

type RefInput = { assetId: string; filename: string };

type GenerateHappyhorseRefVideoPayload = {
  type: "generate_happyhorse_ref_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  imageInputs: RefInput[];
  sourceImageIds: string[];
  resolution?: HappyHorseResolution;
  aspect_ratio?: HappyHorse11AspectRatio;
  duration?: string;
};

export function registerGenerateHappyhorseRefVideoJob(fs: VideocityFs): void {
  registerJobHandler("generate_happyhorse_ref_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt,
      imageInputs, sourceImageIds,
      resolution, aspect_ratio, duration,
    } = payload as GenerateHappyhorseRefVideoPayload;

    requireApiKey("KIE_API_KEY");

    const referenceImages: string[] = [];
    for (const { assetId, filename } of imageInputs) {
      referenceImages.push(await uploadAssetToKie(fs, assetId, filename, projectSlug));
    }

    // 1.1 reference-to-video resolves "[Image N]" markers against reference_image[]
    // order — rewrite confirmed @img-* slugs so local asset IDs never hit the wire.
    const normalizedPrompt = rewriteImageSlugMentionsToBrackets(
      prompt,
      imageInputs.map((input) => input.assetId),
    );
    const request = buildHappyHorseRefPayload(
      { prompt: normalizedPrompt, resolution, aspect_ratio, duration },
      referenceImages,
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "happyhorse_ref_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      meta: { prompt, mode: "ref", sourceImageIds },
    });

    return { success: true, taskId };
  });
}
