import type { ClipfirstFs } from "clipfirst-fs";
import { kie, submitMediaJob } from "@apicity/kie";
import { uploadAssetFile } from "../kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
import { buildWan27VideoEditPayload } from "../payload-builders.js";

type RefInput = { assetId: string; filename: string };

type GenerateWan27VideoeditVideoPayload = {
  type: "generate_wan27_videoedit_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt?: string;
  negative_prompt?: string;
  videoInput: RefInput;
  imageInput?: RefInput;
  sourceImageIds: string[];
  sourceVideoIds: string[];
  sourceAudioIds: string[];
  resolution?: "720p" | "1080p";
  aspect_ratio?: string;
  duration?: string;
  audio_setting?: "auto" | "origin";
  prompt_extend?: boolean;
  watermark?: boolean;
  nsfw_checker?: boolean;
  seed?: number;
};

async function uploadSingle(
  fs: ClipfirstFs,
  provider: ReturnType<typeof kie>,
  input: RefInput,
  projectSlug: string,
): Promise<string> {
  return uploadAssetFile(provider, fs, input.assetId, input.filename, projectSlug);
}

export function registerGenerateWan27VideoeditVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_wan27_videoedit_video", async (payload) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt, negative_prompt,
      videoInput, imageInput,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      resolution, aspect_ratio, duration, audio_setting, prompt_extend, watermark, nsfw_checker, seed,
    } = payload as GenerateWan27VideoeditVideoPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const videoUrl = await uploadSingle(fs, provider, videoInput, projectSlug);
    const referenceImageUrl = imageInput ? await uploadSingle(fs, provider, imageInput, projectSlug) : undefined;

    const request = buildWan27VideoEditPayload(
      { prompt, negative_prompt, resolution, aspect_ratio, duration, audio_setting, prompt_extend, watermark, nsfw_checker, seed },
      { videoUrl, referenceImageUrl },
    );
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    await writePendingTask(fs, vidAssetId, projectSlug, {
      taskId,
      taskType: "wan27_videoedit_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        prompt: prompt ?? "",
        mode: "videoedit",
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
      },
    });

    return { success: true, taskId };
  });
}
