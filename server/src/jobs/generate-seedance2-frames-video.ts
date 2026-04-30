import type { ClipfirstFs } from "clipfirst-engine";
import { kie, submitMediaJob } from "@apicity/kie";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { buildSeedance2VideoPayload } from "../payload-builders.js";

type FrameInput = { assetId: string; filename: string };

type GenerateSeedance2FramesVideoPayload = {
  type: "generate_seedance2_frames_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  firstFrame: FrameInput;
  lastFrame: FrameInput;
  sourceImageIds: string[];
  model?: "bytedance/seedance-2-fast" | "bytedance/seedance-2";
  aspect_ratio?: string;
  resolution?: "480p" | "720p" | "1080p";
  duration?: string;
  generate_audio?: boolean;
  return_last_frame?: boolean;
  web_search?: boolean;
};

async function uploadFrame(
  fs: ClipfirstFs,
  frame: FrameInput,
  projectSlug: string,
): Promise<string> {
  return uploadAssetToKie(fs, frame.assetId, frame.filename, projectSlug);
}

export function registerGenerateSeedance2FramesVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_seedance2_frames_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt,
      firstFrame, lastFrame, sourceImageIds,
      model, aspect_ratio, resolution, duration,
      generate_audio, return_last_frame, web_search,
    } = payload as GenerateSeedance2FramesVideoPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const firstFrameUrl = await uploadFrame(fs, firstFrame, projectSlug);
    const lastFrameUrl = await uploadFrame(fs, lastFrame, projectSlug);

    const request = buildSeedance2VideoPayload(
      { prompt, model, aspect_ratio, resolution, duration, generate_audio, return_last_frame, web_search },
      { firstFrameUrl, lastFrameUrl },
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
          mode: "frames",
          sourceImageIds,
          ...(return_last_frame !== undefined ? { return_last_frame } : {}),
        },
    });
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}
