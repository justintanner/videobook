import type { Engine } from "videobook-engine";
import type { GeminiOmniVideoDuration, GeminiOmniVideoAspectRatio, GeminiOmniVideoResolution } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildGeminiOmniVideoPayload } from "../payload-builders.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";

type RefInput = { assetId: string; filename: string };

type GenerateGeminiOmniVideoPayload = {
  type: "generate_gemini_omni_video";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  imageInputs: RefInput[];
  videoInput?: RefInput;
  sourceImageIds: string[];
  sourceVideoIds: string[];
  prompt: string;
  duration: GeminiOmniVideoDuration;
  aspect_ratio?: GeminiOmniVideoAspectRatio;
  resolution?: GeminiOmniVideoResolution;
  seed?: number;
  video_clip_start?: number;
  video_clip_ends?: number;
};

export function registerGenerateGeminiOmniVideoJob(fs: Engine): void {
  registerJobHandler("generate_gemini_omni_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, bookId,
      imageInputs, videoInput,
      sourceImageIds, sourceVideoIds,
      prompt, duration, aspect_ratio, resolution, seed,
      video_clip_start, video_clip_ends,
    } = payload as unknown as GenerateGeminiOmniVideoPayload;

    requireApiKey("KIE_API_KEY");

    const imageUrls: string[] = [];
    for (const { assetId, filename } of imageInputs) {
      imageUrls.push(await uploadAssetToKie(fs, assetId, filename, bookId));
    }
    const videoUrl = videoInput
      ? await uploadAssetToKie(fs, videoInput.assetId, videoInput.filename, bookId)
      : undefined;

    const normalizedPrompt = transformProviderPrompt(
      "generate_kie_gemini_omni_video",
      {
        prompt,
        image_refs: imageInputs.map((input) => input.assetId),
        video_ref: videoInput?.assetId,
      },
    ) ?? "";
    const request = buildGeminiOmniVideoPayload(
      {
        prompt: normalizedPrompt,
        duration,
        aspect_ratio,
        resolution,
        seed,
        video_clip_start,
        video_clip_ends,
      },
      {
        ...(imageUrls.length > 0 ? { imageUrls } : {}),
        ...(videoUrl !== undefined ? { videoUrl } : {}),
      },
    );

    // Reuse the shared seedance2_video TaskType + completion handler — they key
    // off taskType, not the apiModel. apiModel rides in meta so the completed
    // asset records gemini-omni-video provenance accurately.
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "seedance2_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
      meta: {
        apiModel: "gemini-omni-video",
        sourceImageIds,
        sourceVideoIds,
        prompt,
      },
    });

    return { success: true, taskId };
  });
}
