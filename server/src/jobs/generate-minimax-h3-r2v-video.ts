import type { Engine } from "videobook-engine";
import type { MiniMaxH3ReferenceAspectRatio, MiniMaxH3Resolution } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildMiniMaxH3R2vPayload } from "../payload-builders.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";

type RefInput = { assetId: string; filename: string };

type GenerateMiniMaxH3R2vVideoPayload = {
  type: "generate_minimax_h3_r2v_video";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt: string;
  duration: string;
  imageInputs: RefInput[];
  videoInputs: RefInput[];
  audioInputs: RefInput[];
  sourceImageIds: string[];
  sourceVideoIds: string[];
  sourceAudioIds: string[];
  aspect_ratio?: MiniMaxH3ReferenceAspectRatio;
  resolution?: MiniMaxH3Resolution;
};

async function uploadAll(
  fs: Engine,
  inputs: RefInput[],
): Promise<string[]> {
  const urls: string[] = [];
  for (const { assetId, filename } of inputs) {
    urls.push(await uploadAssetToKie(fs, assetId, filename));
  }
  return urls;
}

export function registerGenerateMiniMaxH3R2vVideoJob(fs: Engine): void {
  registerJobHandler("generate_minimax_h3_r2v_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, bookId, prompt, duration,
      imageInputs, videoInputs, audioInputs,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      aspect_ratio, resolution,
    } = payload as GenerateMiniMaxH3R2vVideoPayload;

    requireApiKey("KIE_API_KEY");

    const referenceImageUrls = await uploadAll(fs, imageInputs);
    const referenceVideoUrls = await uploadAll(fs, videoInputs);
    const referenceAudioUrls = await uploadAll(fs, audioInputs);

    const normalizedPrompt = transformProviderPrompt("generate_kie_minimax_h3_reference_to_video", {
      prompt,
      image_refs: imageInputs.map((input) => input.assetId),
      video_refs: videoInputs.map((input) => input.assetId),
      audio_refs: audioInputs.map((input) => input.assetId),
    }) ?? "";
    const request = buildMiniMaxH3R2vPayload(
      { prompt: normalizedPrompt, duration, aspect_ratio, resolution },
      {
        ...(referenceImageUrls.length > 0 ? { referenceImageUrls } : {}),
        ...(referenceVideoUrls.length > 0 ? { referenceVideoUrls } : {}),
        ...(referenceAudioUrls.length > 0 ? { referenceAudioUrls } : {}),
      },
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "minimax_h3_r2v_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
      meta: { prompt, mode: "r2v", sourceImageIds, sourceVideoIds, sourceAudioIds },
    });

    return { success: true, taskId };
  });
}
