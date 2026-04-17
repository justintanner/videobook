import type { ClipfirstFs } from "clipfirst-fs";
import { kie, submitMediaJob, type Wan27Resolution } from "@apicity/kie";
import { uploadAssetFile } from "../upload.js";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
import { buildWan27FramesVideoPayload } from "../payload-builders.js";

type RefInput = { assetId: string; filename: string };

type GenerateWan27I2vVideoPayload = {
  type: "generate_wan27_i2v_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  negative_prompt?: string;
  firstFrame?: RefInput;
  lastFrame?: RefInput;
  firstClip?: RefInput;
  drivingAudio?: RefInput;
  sourceImageIds: string[];
  sourceVideoIds: string[];
  sourceAudioIds: string[];
  resolution?: Wan27Resolution;
  duration?: string;
  prompt_extend?: boolean;
  nsfw_checker?: boolean;
  seed?: number;
};

async function uploadInput(
  fs: ClipfirstFs,
  provider: ReturnType<typeof kie>,
  input: RefInput,
  projectSlug: string,
): Promise<string> {
  return uploadAssetFile(fs, input.assetId, input.filename, projectSlug);
}

export function registerGenerateWan27I2vVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_wan27_i2v_video", async (payload) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt, negative_prompt,
      firstFrame, lastFrame, firstClip, drivingAudio,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      resolution, duration, prompt_extend, nsfw_checker, seed,
    } = payload as GenerateWan27I2vVideoPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const firstFrameUrl = firstFrame ? await uploadInput(fs, provider, firstFrame, projectSlug) : undefined;
    const lastFrameUrl = lastFrame ? await uploadInput(fs, provider, lastFrame, projectSlug) : undefined;
    const firstClipUrl = firstClip ? await uploadInput(fs, provider, firstClip, projectSlug) : undefined;
    const drivingAudioUrl = drivingAudio ? await uploadInput(fs, provider, drivingAudio, projectSlug) : undefined;

    const request = buildWan27FramesVideoPayload(
      { prompt, negative_prompt, resolution, duration, prompt_extend, nsfw_checker, seed },
      { firstFrameUrl, lastFrameUrl, firstClipUrl, drivingAudioUrl },
    );
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    await writePendingTask(fs, vidAssetId, projectSlug, {
      taskId,
      taskType: "wan27_i2v_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        prompt,
        mode: "i2v",
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
      },
    });

    return { success: true, taskId };
  });
}
