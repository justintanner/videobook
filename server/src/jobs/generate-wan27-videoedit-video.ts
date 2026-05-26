import type { VideocityFs } from "vc-engine";
import { kie, submitMediaJob, type Wan27Resolution } from "@apicity/kie";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
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
  resolution?: Wan27Resolution;
  aspect_ratio?: string;
  duration?: string;
  audio_setting?: "auto" | "origin";
  prompt_extend?: boolean;
  watermark?: boolean;
  nsfw_checker?: boolean;
  seed?: number;
};

async function uploadSingle(
  fs: VideocityFs,
  provider: ReturnType<typeof kie>,
  input: RefInput,
  projectSlug: string,
): Promise<string> {
  return uploadAssetToKie(fs, input.assetId, input.filename, projectSlug);
}

export function registerGenerateWan27VideoeditVideoJob(fs: VideocityFs): void {
  registerJobHandler("generate_wan27_videoedit_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt, negative_prompt,
      videoInput, imageInput,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      resolution, aspect_ratio, duration, audio_setting, prompt_extend, watermark, nsfw_checker, seed,
    } = payload as GenerateWan27VideoeditVideoPayload;

    const apiKey = requireApiKey("KIE_API_KEY");

    const provider = kie({ apiKey, timeout: 60_000 });

    const videoUrl = await uploadSingle(fs, provider, videoInput, projectSlug);
    const referenceImageUrl = imageInput ? await uploadSingle(fs, provider, imageInput, projectSlug) : undefined;

    const request = buildWan27VideoEditPayload(
      { prompt, negative_prompt, resolution, aspect_ratio, duration, audio_setting, prompt_extend, watermark, nsfw_checker, seed },
      { videoUrl, referenceImageUrl },
    );
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "wan27_videoedit_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        meta: {
          prompt: prompt ?? "",
          mode: "videoedit",
          sourceImageIds,
          sourceVideoIds,
          sourceAudioIds,
        },
    }, ctx.getOwnerId());
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
      if (_ptResult.value === null) throw new Error(`Lost local lease while writing pending-task`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}
