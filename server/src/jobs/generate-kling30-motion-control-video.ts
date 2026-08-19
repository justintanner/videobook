import type { Engine } from "videobook-engine";
import type { KlingMotionControlRequest, MediaGenerationRequest } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildKling30MotionControlPayload } from "../payload-builders.js";
import { assertKlingMotionControlDuration } from "../kling-motion-control-duration.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";

type RefInput = { assetId: string; filename: string };

type GenerateKling30MotionControlPayload = {
  type: "generate_kling30_motion_control_video";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  imageInputs: RefInput[];
  videoInputs: RefInput[];
  sourceImageIds: string[];
  sourceVideoIds: string[];
  prompt?: string;
  mode?: KlingMotionControlRequest["input"]["mode"];
  character_orientation?: KlingMotionControlRequest["input"]["character_orientation"];
  background_source?: KlingMotionControlRequest["input"]["background_source"];
};

async function uploadInputs(engine: Engine, inputs: RefInput[]): Promise<string[]> {
  const urls: string[] = [];
  for (const { assetId, filename } of inputs) {
    urls.push(await uploadAssetToKie(engine, assetId, filename));
  }
  return urls;
}

export function registerGenerateKling30MotionControlVideoJob(engine: Engine): void {
  registerJobHandler("generate_kling30_motion_control_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, bookId,
      imageInputs, videoInputs, sourceImageIds, sourceVideoIds,
      prompt, mode, character_orientation, background_source,
    } = payload as GenerateKling30MotionControlPayload;

    const motionVideo = videoInputs[0];
    if (!motionVideo) throw new Error("Kling 3.0 Motion Control requires one motion video");
    const durationHint = await assertKlingMotionControlDuration(
      engine,
      motionVideo.assetId,
      character_orientation === "image" ? "image" : "video",
    );

    requireApiKey("KIE_API_KEY");

    const inputUrls = await uploadInputs(engine, imageInputs);
    const videoUrls = await uploadInputs(engine, videoInputs);
    const normalizedPrompt = prompt === undefined
      ? undefined
      : transformProviderPrompt("generate_kie_kling_3_0_motion_control", {
        prompt,
        character_image_refs: imageInputs.map((input) => input.assetId),
        motion_video_refs: videoInputs.map((input) => input.assetId),
      });

    const request: MediaGenerationRequest = buildKling30MotionControlPayload(
      { prompt: normalizedPrompt, mode, character_orientation, background_source },
      inputUrls,
      videoUrls,
    );

    const taskId = await submitKieTask(engine, ctx, {
      request,
      taskType: "kling30_motion_control_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
      meta: {
        ...(prompt !== undefined ? { prompt } : {}),
        ...(mode !== undefined ? { mode } : {}),
        sourceImageIds,
        sourceVideoIds,
      },
      costHints: { duration: durationHint },
    });

    return { success: true, taskId };
  });
}
