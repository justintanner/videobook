import type { ClipfirstFs } from "clipfirst-fs";
import { kie, submitMediaJob } from "@apicity/kie";
import { uploadAssetFile } from "../kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
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
  resolution?: "720p" | "1080p";
  duration?: string;
  prompt_extend?: boolean;
  nsfw_checker?: boolean;
  seed?: number;
};

export function registerExtendWan27VideoJob(fs: ClipfirstFs): void {
  registerJobHandler("extend_wan27_video", async (payload) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt, negative_prompt,
      sourceVideo,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      resolution, duration, prompt_extend, nsfw_checker, seed,
    } = payload as ExtendWan27VideoPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const firstClipUrl = await uploadAssetFile(provider, fs, sourceVideo.assetId, sourceVideo.filename, projectSlug);

    const request = buildWan27FramesVideoPayload(
      { prompt, negative_prompt, resolution, duration, prompt_extend, nsfw_checker, seed },
      { firstClipUrl },
    );
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    await writePendingTask(fs, vidAssetId, projectSlug, {
      taskId,
      taskType: "wan27_extend_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
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
