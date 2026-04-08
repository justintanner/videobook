import type { ClipfirstFs } from "clipfirst-fs";
import { kie, uploadFile, submitMediaJob } from "@nakedapi/kie";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
import { buildWan27FramesVideoPayload } from "../payload-builders.js";

type RefInput = { assetId: string; filename: string };

type GenerateWan27FramesVideoPayload = {
  type: "generate_wan27_frames_video";
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
  resolution?: "720p" | "1080p";
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
  const readResult = await fs.readFile(input.assetId, input.filename, projectSlug);
  if (!readResult.ok) throw new Error(readResult.error.message);
  const blob = new Blob([new Uint8Array(readResult.value)]);
  return uploadFile(provider, blob, input.filename);
}

export function registerGenerateWan27FramesVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_wan27_frames_video", async (payload) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt, negative_prompt,
      firstFrame, lastFrame, firstClip, drivingAudio,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      resolution, duration, prompt_extend, nsfw_checker, seed,
    } = payload as GenerateWan27FramesVideoPayload;

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
      taskType: "wan27_frames_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        prompt,
        mode: "frames",
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
      },
    });

    return { success: true, taskId };
  });
}
