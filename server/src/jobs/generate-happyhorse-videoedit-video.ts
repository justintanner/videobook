import type { VideocityFs } from "videocity-engine";
import type { HappyHorseVideoEditRequest, MediaGenerationRequest } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildHappyHorseVideoEditPayload } from "../payload-builders.js";

type RefInput = { assetId: string; filename: string };

// Nominal per-second basis used only when a source video predates the
// `original` duration metadata. The paygate bounds cost off this hint; it is
// never billed against (createTask ignores unknown top-level fields).
const FALLBACK_VIDEOEDIT_DURATION_SECONDS = 5;

type GenerateHappyhorseVideoeditPayload = {
  type: "generate_happyhorse_videoedit_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  sourceVideo: RefInput;
  imageInputs: RefInput[];
  sourceVideoIds: string[];
  sourceImageIds: string[];
  resolution?: HappyHorseVideoEditRequest["input"]["resolution"];
  audio_setting?: HappyHorseVideoEditRequest["input"]["audio_setting"];
  seed?: number;
};

export function registerGenerateHappyhorseVideoeditVideoJob(fs: VideocityFs): void {
  registerJobHandler("generate_happyhorse_videoedit_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt,
      sourceVideo, imageInputs, sourceVideoIds, sourceImageIds,
      resolution, audio_setting, seed,
    } = payload as GenerateHappyhorseVideoeditPayload;

    requireApiKey("KIE_API_KEY");

    const videoUrl = await uploadAssetToKie(fs, sourceVideo.assetId, sourceVideo.filename, projectSlug);
    const referenceImages: string[] = [];
    for (const { assetId, filename } of imageInputs) {
      referenceImages.push(await uploadAssetToKie(fs, assetId, filename, projectSlug));
    }

    const baseRequest = buildHappyHorseVideoEditPayload(
      { prompt, resolution, audio_setting, seed },
      videoUrl,
      referenceImages,
    );

    // happyhorse/video-edit has no `duration` field in its kie input schema —
    // the output length matches the source video_url. The cost estimator (and
    // the paygate OTP minted from this request) keys the per-second rate off
    // duration, so without one computeEstimate rejects the request as unbounded
    // and submission fails. Surface the source video's measured duration as a
    // top-level hint (mirrors grok-imagine/extend's resolution hint; kie's
    // createTask ignores unknown top-level fields), falling back to a nominal
    // duration when the source predates `original` duration metadata.
    const sourceMeta = await fs.readMetadata<{ duration?: number }>(
      sourceVideo.assetId, "original", projectSlug,
    );
    const durationHint =
      sourceMeta.ok && typeof sourceMeta.value?.duration === "number" && sourceMeta.value.duration > 0
        ? sourceMeta.value.duration
        : FALLBACK_VIDEOEDIT_DURATION_SECONDS;
    const request: MediaGenerationRequest & { duration: number } = { ...baseRequest, duration: durationHint };

    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "happyhorse_videoedit_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      meta: { prompt, mode: "videoedit", sourceVideoIds, sourceImageIds },
    });

    return { success: true, taskId };
  });
}
