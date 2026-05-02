import type { ClipfirstFs } from "clipfirst-engine";
import { kie, submitMediaJob } from "@apicity/kie";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { buildSeedance2VideoPayload } from "../payload-builders.js";

type FrameInput = { assetId: string; filename: string };

type GenerateSeedance2I2vVideoPayload = {
  type: "generate_seedance2_i2v_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  firstFrame: FrameInput;
  lastFrame?: FrameInput;
  sourceImageIds: string[];
  model?: "bytedance/seedance-2-fast" | "bytedance/seedance-2";
  aspect_ratio?: string;
  resolution?: "480p" | "720p" | "1080p";
  duration?: string;
  generate_audio?: boolean;
  return_last_frame?: boolean;
  web_search?: boolean;
};

export function registerGenerateSeedance2I2vVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_seedance2_i2v_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt,
      firstFrame, lastFrame, sourceImageIds,
      model, aspect_ratio, resolution, duration,
      generate_audio, return_last_frame, web_search,
    } = payload as GenerateSeedance2I2vVideoPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const firstFrameUrl = await uploadAssetToKie(fs, firstFrame.assetId, firstFrame.filename, projectSlug);
    const lastFrameUrl = lastFrame
      ? await uploadAssetToKie(fs, lastFrame.assetId, lastFrame.filename, projectSlug)
      : undefined;

    const request = buildSeedance2VideoPayload(
      { prompt, model, aspect_ratio, resolution, duration, generate_audio, return_last_frame, web_search },
      { firstFrameUrl, ...(lastFrameUrl ? { lastFrameUrl } : {}) },
    );
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "seedance2_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        meta: {
          prompt,
          mode: "i2v",
          sourceImageIds,
          ...(return_last_frame !== undefined ? { return_last_frame } : {}),
        },
    }, ctx.getOwnerId());
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
      if (_ptResult.value === null) throw new Error(`Lost local lease while writing pending-task`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}
