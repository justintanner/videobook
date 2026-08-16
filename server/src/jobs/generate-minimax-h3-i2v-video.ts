import type { Engine } from "videobook-engine";
import type { MiniMaxH3Resolution } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildMiniMaxH3I2vPayload } from "../payload-builders.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";

type RefInput = { assetId: string; filename: string };

type GenerateMiniMaxH3I2vVideoPayload = {
  type: "generate_minimax_h3_i2v_video";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt: string;
  duration: string;
  firstFrame?: RefInput;
  lastFrame?: RefInput;
  sourceImageIds: string[];
  resolution?: MiniMaxH3Resolution;
};

export function registerGenerateMiniMaxH3I2vVideoJob(fs: Engine): void {
  registerJobHandler("generate_minimax_h3_i2v_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, bookId, prompt, duration,
      firstFrame, lastFrame, sourceImageIds, resolution,
    } = payload as GenerateMiniMaxH3I2vVideoPayload;

    requireApiKey("KIE_API_KEY");

    const firstFrameUrl = firstFrame
      ? await uploadAssetToKie(fs, firstFrame.assetId, firstFrame.filename)
      : undefined;
    const lastFrameUrl = lastFrame
      ? await uploadAssetToKie(fs, lastFrame.assetId, lastFrame.filename)
      : undefined;

    const normalizedPrompt = transformProviderPrompt("generate_kie_minimax_h3_image_to_video", {
      prompt,
      first_frame_ref: firstFrame?.assetId,
      last_frame_ref: lastFrame?.assetId,
    }) ?? "";
    const request = buildMiniMaxH3I2vPayload(
      { prompt: normalizedPrompt, duration, resolution },
      {
        ...(firstFrameUrl !== undefined ? { firstFrameUrl } : {}),
        ...(lastFrameUrl !== undefined ? { lastFrameUrl } : {}),
      },
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "minimax_h3_i2v_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
      meta: { prompt, mode: "i2v", sourceImageIds },
    });

    return { success: true, taskId };
  });
}
