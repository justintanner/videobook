import type { ClipfirstFs } from "clipfirst-engine";
import { kie, submitMediaJob } from "@apicity/kie";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { buildKling30MotionControlPayload } from "../payload-builders.js";

type RefInput = { assetId: string; filename: string };

type GenerateKling30MotionControlPayload = {
  type: "generate_kling30_motion_control_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  imageInputs: RefInput[];
  videoInputs: RefInput[];
  sourceImageIds: string[];
  sourceVideoIds: string[];
  prompt?: string;
  mode?: "720p" | "1080p";
  character_orientation?: "video" | "image";
  background_source?: "input_video" | "input_image";
};

async function uploadInputs(fs: ClipfirstFs, inputs: RefInput[], projectSlug: string): Promise<string[]> {
  const urls: string[] = [];
  for (const { assetId, filename } of inputs) {
    urls.push(await uploadAssetToKie(fs, assetId, filename, projectSlug));
  }
  return urls;
}

export function registerGenerateKling30MotionControlVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_kling30_motion_control_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug,
      imageInputs, videoInputs, sourceImageIds, sourceVideoIds,
      prompt, mode, character_orientation, background_source,
    } = payload as GenerateKling30MotionControlPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const inputUrls = await uploadInputs(fs, imageInputs, projectSlug);
    const videoUrls = await uploadInputs(fs, videoInputs, projectSlug);

    const request = buildKling30MotionControlPayload(
      { prompt, mode, character_orientation, background_source },
      inputUrls,
      videoUrls,
    );
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "kling30_motion_control_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        meta: {
          ...(prompt !== undefined ? { prompt } : {}),
          ...(mode !== undefined ? { mode } : {}),
          sourceImageIds,
          sourceVideoIds,
        },
    }, ctx.getOwnerId());
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
      if (_ptResult.value === null) throw new Error(`Lost local lease while writing pending-task`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}
