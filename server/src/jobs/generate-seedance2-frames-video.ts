import type { ClipfirstFs } from "clipfirst-fs";
import { kie, submitMediaJob } from "@nakedapi/kie";
import { uploadAssetFile } from "../kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
import { buildSeedance2VideoPayload } from "../payload-builders.js";

type FrameInput = { assetId: string; filename: string };

type GenerateSeedance2FramesVideoPayload = {
  type: "generate_seedance2_frames_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  firstFrame?: FrameInput;
  lastFrame?: FrameInput;
  sourceImageIds: string[];
  aspect_ratio?: string;
  resolution?: "480p" | "720p";
  duration?: string;
  generate_audio?: boolean;
  return_last_frame?: boolean;
  web_search?: boolean;
};

async function uploadFrame(
  fs: ClipfirstFs,
  provider: ReturnType<typeof kie>,
  frame: FrameInput,
  projectSlug: string,
): Promise<string> {
  return uploadAssetFile(provider, fs, frame.assetId, frame.filename, projectSlug);
}

export function registerGenerateSeedance2FramesVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_seedance2_frames_video", async (payload) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt,
      firstFrame, lastFrame, sourceImageIds,
      aspect_ratio, resolution, duration,
      generate_audio, return_last_frame, web_search,
    } = payload as GenerateSeedance2FramesVideoPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const firstFrameUrl = firstFrame ? await uploadFrame(fs, provider, firstFrame, projectSlug) : undefined;
    const lastFrameUrl = lastFrame ? await uploadFrame(fs, provider, lastFrame, projectSlug) : undefined;

    const request = buildSeedance2VideoPayload(
      { prompt, aspect_ratio, resolution, duration, generate_audio, return_last_frame, web_search },
      { firstFrameUrl, lastFrameUrl },
    );
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    await writePendingTask(fs, vidAssetId, projectSlug, {
      taskId,
      taskType: "seedance2_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        prompt,
        mode: "frames",
        sourceImageIds,
        ...(return_last_frame !== undefined ? { return_last_frame } : {}),
      },
    });

    return { success: true, taskId };
  });
}
