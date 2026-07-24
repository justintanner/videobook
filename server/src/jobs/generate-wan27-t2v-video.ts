import type { Engine } from "videobook-engine";
import type { Wan27Resolution, Wan27TextToVideoRequest } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildWan27TextToVideoPayload } from "../payload-builders.js";

type RefInput = { assetId: string; filename: string };

type GenerateWan27T2vVideoPayload = {
  type: "generate_wan27_t2v_video";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt: string;
  negative_prompt?: string;
  audioRef?: RefInput;
  sourceAudioIds: string[];
  resolution?: Wan27Resolution;
  aspect_ratio?: Wan27TextToVideoRequest["input"]["ratio"];
  duration?: string;
  prompt_extend?: boolean;
  watermark?: boolean;
  nsfw_checker?: boolean;
  seed?: number;
};

export function registerGenerateWan27T2vVideoJob(fs: Engine): void {
  registerJobHandler("generate_wan27_t2v_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, bookId, prompt, negative_prompt,
      audioRef, sourceAudioIds,
      resolution, aspect_ratio, duration, prompt_extend, watermark, nsfw_checker, seed,
    } = payload as GenerateWan27T2vVideoPayload;

    requireApiKey("KIE_API_KEY");

    const audioUrl = audioRef ? await uploadAssetToKie(fs, audioRef.assetId, audioRef.filename, bookId) : undefined;

    const request = buildWan27TextToVideoPayload(
      { prompt, negative_prompt, resolution, aspect_ratio, duration, prompt_extend, watermark, nsfw_checker, seed },
      { audioUrl },
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "wan27_t2v_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
      meta: {
        prompt,
        mode: "t2v",
        sourceAudioIds,
      },
    });

    return { success: true, taskId };
  });
}
