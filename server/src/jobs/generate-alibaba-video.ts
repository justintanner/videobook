import type { Engine } from "videobook-engine";
import {
  createAlibaba,
  type AlibabaVideoSynthesisParameters,
  type AlibabaVideoSynthesisRequest,
} from "@apicity/alibaba";
import { uploadAssetToAlibaba } from "./_alibaba-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildAlibabaVideoPayload } from "../payload-builders.js";
import {
  assertProviderPayload,
  transformProviderPrompt,
} from "../provider-prompt-transform.js";

type RefInput = { assetId: string; filename: string };

type GenerateAlibabaVideoPayload = {
  type: "generate_alibaba_video";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt: string;
  negative_prompt?: string;
  model: AlibabaVideoSynthesisRequest["model"];
  firstFrame?: RefInput;
  lastFrame?: RefInput;
  firstClip?: RefInput;
  drivingAudio?: RefInput;
  videoRef?: RefInput;
  sourceImageIds: string[];
  sourceVideoIds: string[];
  sourceAudioIds: string[];
  resolution?: AlibabaVideoSynthesisParameters["resolution"];
  duration?: AlibabaVideoSynthesisParameters["duration"];
  prompt_extend?: AlibabaVideoSynthesisParameters["prompt_extend"];
  watermark?: AlibabaVideoSynthesisParameters["watermark"];
  audio_setting?: AlibabaVideoSynthesisParameters["audio_setting"];
  seed?: AlibabaVideoSynthesisParameters["seed"];
};

async function uploadInput(
  fs: Engine,
  input: RefInput,
  bookId: string,
  model: string,
): Promise<string> {
  return uploadAssetToAlibaba(fs, input.assetId, input.filename, bookId, model);
}

export function registerGenerateAlibabaVideoJob(fs: Engine): void {
  registerJobHandler("generate_alibaba_video", async (payload, ctx) => {
    const {
      vidAssetId, bookId, prompt, negative_prompt, model,
      firstFrame, lastFrame, firstClip, drivingAudio, videoRef,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      resolution, duration, prompt_extend, watermark, audio_setting, seed,
    } = payload as GenerateAlibabaVideoPayload;

    const apiKey = requireApiKey("DASHSCOPE_API_KEY");

    const firstFrameUrl = firstFrame ? await uploadInput(fs, firstFrame, bookId, model) : undefined;
    const lastFrameUrl = lastFrame ? await uploadInput(fs, lastFrame, bookId, model) : undefined;
    const firstClipUrl = firstClip ? await uploadInput(fs, firstClip, bookId, model) : undefined;
    const drivingAudioUrl = drivingAudio ? await uploadInput(fs, drivingAudio, bookId, model) : undefined;
    const videoUrl = videoRef ? await uploadInput(fs, videoRef, bookId, model) : undefined;

    const provider = createAlibaba({ apiKey, timeout: 120_000 });
    const normalizedPrompt = transformProviderPrompt(
      "generate_alibaba_wan_2_7_video",
      {
        prompt,
        first_frame_ref: firstFrame?.assetId,
        last_frame_ref: lastFrame?.assetId,
        first_clip_ref: firstClip?.assetId,
        driving_audio_ref: drivingAudio?.assetId,
        video_ref: videoRef?.assetId,
      },
    ) ?? "";

    const request = buildAlibabaVideoPayload(
      {
        prompt: normalizedPrompt,
        negative_prompt,
        model,
        resolution,
        duration,
        prompt_extend,
        watermark,
        audio_setting,
        seed,
      },
      { firstFrameUrl, lastFrameUrl, firstClipUrl, drivingAudioUrl, videoUrl },
    );
    assertProviderPayload(request, {
      toolName: "generate_alibaba_wan_2_7_video",
      wire: true,
    });
    await fs.metadata.artifacts.write(vidAssetId, "generation-payload", request);
    const submitResult = await provider.post.api.v1.services.aigc.videoGeneration.videoSynthesis(request);
    const taskId = submitResult.output.task_id;
    {
      const _ptResult = await fs.jobs.pending.write({
        taskId,
        taskType: "alibaba_video",
        artifactId: vidAssetId,
        meta: {
          prompt,
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
