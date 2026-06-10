import type { VideocityFs } from "videocity-engine";
import type { Wan27Resolution } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildWan27FramesVideoPayload } from "../payload-builders.js";

type RefInput = { assetId: string; filename: string };

type ExtendWan27VideoPayload = {
  type: "extend_wan27_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
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

export function registerExtendWan27VideoJob(fs: VideocityFs): void {
  registerJobHandler("extend_wan27_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt, negative_prompt,
      sourceVideo,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      resolution, duration, prompt_extend, watermark, nsfw_checker, seed,
    } = payload as ExtendWan27VideoPayload;

    requireApiKey("KIE_API_KEY");

    const firstClipUrl = await uploadAssetToKie(fs, sourceVideo.assetId, sourceVideo.filename, projectSlug);

    const request = buildWan27FramesVideoPayload(
      { prompt, negative_prompt, resolution, duration, prompt_extend, watermark, nsfw_checker, seed },
      { firstClipUrl },
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "wan27_extend_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
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
