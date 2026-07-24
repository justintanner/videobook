import type { Engine } from "videobook-engine";
import type { HappyHorseVideoEditRequest, MediaGenerationRequest } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildHappyHorseVideoEditPayload } from "../payload-builders.js";
import { replaceHappyHorseAssetMentions } from "../google-flow-refs.js";

type RefInput = { assetId: string; filename: string };

// Nominal per-second basis used only when a source video predates the
// `original` duration metadata. Forwarded to the paygate as a cost hint only;
// never serialized into the wire payload.
const FALLBACK_VIDEOEDIT_DURATION_SECONDS = 5;

type GenerateHappyhorseVideoeditPayload = {
  type: "generate_happyhorse_videoedit_video";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt: string;
  sourceVideo: RefInput;
  imageInputs: RefInput[];
  sourceVideoIds: string[];
  sourceImageIds: string[];
  resolution?: HappyHorseVideoEditRequest["input"]["resolution"];
  audio_setting?: HappyHorseVideoEditRequest["input"]["audio_setting"];
  seed?: number;
};

export function registerGenerateHappyhorseVideoeditVideoJob(fs: Engine): void {
  registerJobHandler("generate_happyhorse_videoedit_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, bookId, prompt,
      sourceVideo, imageInputs, sourceVideoIds, sourceImageIds,
      resolution, audio_setting, seed,
    } = payload as GenerateHappyhorseVideoeditPayload;

    requireApiKey("KIE_API_KEY");

    const videoUrl = await uploadAssetToKie(fs, sourceVideo.assetId, sourceVideo.filename, bookId);
    const referenceImages: string[] = [];
    for (const { assetId, filename } of imageInputs) {
      referenceImages.push(await uploadAssetToKie(fs, assetId, filename, bookId));
    }

    // happyhorse/video-edit has no `duration` field in its kie input schema —
    // the output length matches the source video_url. The paygate's per-second
    // rate derivation still needs a duration, so surface the source video's
    // measured duration as an out-of-band cost hint (falling back to a nominal
    // duration when the source predates `original` duration metadata). The hint
    // feeds computeEstimate only; the wire payload carries only documented
    // fields. tools/estimate-cost.ts enriches the same way for the UI preview.
    //
    // Kie's happyhorse/video-edit (1.0) prompt is a free-form edit instruction
    // with no inline marker syntax (the "[Image N]" form belongs to the 1.1
    // t2v/i2v/ref endpoints only). Rewrite @<slug> mentions to natural-language
    // noun phrases so local asset IDs don't leak onto the wire: the source
    // video mention becomes "the source video" (video_url carries the asset);
    // each reference image mention becomes "reference image N" matching its
    // position in the reference_image[] field.
    const normalizedPrompt = replaceHappyHorseAssetMentions(
      prompt,
      sourceVideo.assetId,
      imageInputs.map((input) => input.assetId),
    );
    const request: MediaGenerationRequest = buildHappyHorseVideoEditPayload(
      { prompt: normalizedPrompt, resolution, audio_setting, seed },
      videoUrl,
      referenceImages,
    );

    const sourceMeta = await fs.metadata.artifacts.read<{ duration?: number }>(sourceVideo.assetId, "original"
    );
    const durationHint =
      sourceMeta.ok && typeof sourceMeta.value?.duration === "number" && sourceMeta.value.duration > 0
        ? sourceMeta.value.duration
        : FALLBACK_VIDEOEDIT_DURATION_SECONDS;

    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "happyhorse_videoedit_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
      meta: { prompt, mode: "videoedit", sourceVideoIds, sourceImageIds },
      costHints: { duration: durationHint },
    });

    return { success: true, taskId };
  });
}
