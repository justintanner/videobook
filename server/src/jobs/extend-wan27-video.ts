import type { Engine } from "videobook-engine";
import type { Wan27Resolution } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildWan27FramesVideoPayload } from "../payload-builders.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";

type RefInput = { assetId: string; filename: string };

type ExtendWan27VideoPayload = {
  type: "extend_wan27_video";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt: string;
  sourceVideo: RefInput;
  sourceImageIds: string[];
  sourceVideoIds: string[];
  sourceAudioIds: string[];
  negative_prompt?: string;
  resolution?: Wan27Resolution;
  duration?: string;
  prompt_extend?: boolean;
  watermark?: boolean;
  nsfw_checker?: boolean;
  seed?: number;
};

export function registerExtendWan27VideoJob(engine: Engine): void {
  registerJobHandler("extend_wan27_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, bookId, prompt, negative_prompt,
      sourceVideo,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      resolution, duration, prompt_extend, watermark, nsfw_checker, seed,
    } = payload as ExtendWan27VideoPayload;

    requireApiKey("KIE_API_KEY");

    const firstClipUrl = await uploadAssetToKie(engine, sourceVideo.assetId, sourceVideo.filename);
    const normalizedPrompt = transformProviderPrompt(
      "extend_kie_wan_2_7_video",
      { prompt, video_ref: sourceVideo.assetId },
    ) ?? "";

    const request = buildWan27FramesVideoPayload(
      { prompt: normalizedPrompt, negative_prompt, resolution, duration, prompt_extend, watermark, nsfw_checker, seed },
      { firstClipUrl },
    );
    const taskId = await submitKieTask(engine, ctx, {
      request,
      taskType: "wan27_extend_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
      meta: {
        prompt,
        mode: "extend",
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
      },
    });

    return { success: true, taskId };
  });
}
