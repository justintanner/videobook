import type { Engine } from "videobook-engine";
import type { Seedance25Request } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildSeedance25VideoPayload } from "../payload-builders.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";

type RefInput = { assetId: string; filename: string };

type GenerateSeedance25VideoPayload = {
  type: "generate_seedance25_video";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt?: string;
  firstFrame?: RefInput;
  lastFrame?: RefInput;
  imageInputs: RefInput[];
  videoInputs: RefInput[];
  audioInputs: RefInput[];
  sourceImageIds: string[];
  sourceVideoIds: string[];
  sourceAudioIds: string[];
  return_last_frame?: boolean;
  generate_audio?: boolean;
  resolution?: Seedance25Request["input"]["resolution"];
  aspect_ratio?: Seedance25Request["input"]["aspect_ratio"];
  duration?: string;
  output_format?: Seedance25Request["input"]["output_format"];
  web_search?: boolean;
  nsfw_checker?: boolean;
  replaceAudioWith?: RefInput;
};

async function uploadAll(
  engine: Engine,
  inputs: RefInput[],
): Promise<string[]> {
  const urls: string[] = [];
  for (const { assetId, filename } of inputs) {
    urls.push(await uploadAssetToKie(engine, assetId, filename));
  }
  return urls;
}

export function registerGenerateSeedance25VideoJob(engine: Engine): void {
  registerJobHandler("generate_seedance25_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, bookId, prompt,
      firstFrame, lastFrame,
      imageInputs, videoInputs, audioInputs,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      return_last_frame, generate_audio,
      resolution, aspect_ratio, duration, output_format,
      web_search, nsfw_checker,
      replaceAudioWith,
    } = payload as unknown as GenerateSeedance25VideoPayload;

    requireApiKey("KIE_API_KEY");

    const firstFrameUrl = firstFrame
      ? await uploadAssetToKie(engine, firstFrame.assetId, firstFrame.filename)
      : undefined;
    const lastFrameUrl = lastFrame
      ? await uploadAssetToKie(engine, lastFrame.assetId, lastFrame.filename)
      : undefined;
    const referenceImageUrls = await uploadAll(engine, imageInputs);
    const referenceVideoUrls = await uploadAll(engine, videoInputs);
    const referenceAudioUrls = await uploadAll(engine, audioInputs);
    const normalizedPrompt = prompt === undefined
      ? undefined
      : transformProviderPrompt("generate_kie_seedance_2_5_video", {
        prompt,
        image_refs: imageInputs.map((input) => input.assetId),
        video_refs: videoInputs.map((input) => input.assetId),
        audio_refs: audioInputs.map((input) => input.assetId),
        first_frame_ref: firstFrame?.assetId,
        last_frame_ref: lastFrame?.assetId,
      });

    const request = buildSeedance25VideoPayload(
      {
        ...(normalizedPrompt !== undefined ? { prompt: normalizedPrompt } : {}),
        return_last_frame,
        generate_audio,
        resolution,
        aspect_ratio,
        duration,
        output_format,
        web_search,
        nsfw_checker,
      },
      {
        ...(firstFrameUrl ? { firstFrameUrl } : {}),
        ...(lastFrameUrl ? { lastFrameUrl } : {}),
        ...(referenceImageUrls.length > 0 ? { referenceImageUrls } : {}),
        ...(referenceVideoUrls.length > 0 ? { referenceVideoUrls } : {}),
        ...(referenceAudioUrls.length > 0 ? { referenceAudioUrls } : {}),
      },
    );

    const mode = firstFrame || lastFrame
      ? "frames"
      : imageInputs.length > 0 || videoInputs.length > 0 || audioInputs.length > 0
        ? "refs"
        : "text";
    const taskId = await submitKieTask(engine, ctx, {
      request,
      taskType: "seedance2_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
      meta: {
        mode,
        apiModel: "bytedance/seedance-2-5",
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(return_last_frame !== undefined ? { return_last_frame } : {}),
        ...(output_format !== undefined ? { output_format } : {}),
        ...(replaceAudioWith ? { replaceAudioWith } : {}),
      },
    });

    return { success: true, taskId };
  });
}
