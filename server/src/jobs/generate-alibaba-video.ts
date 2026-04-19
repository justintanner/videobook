import type { ClipfirstFs } from "clipfirst-fs";
import { alibaba, type AlibabaVideoSynthesisParameters } from "@apicity/alibaba";
import { uploadAssetToAlibaba } from "./_alibaba-upload.js";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
import { buildAlibabaVideoPayload } from "../payload-builders.js";

type RefInput = { assetId: string; filename: string };

type GenerateAlibabaVideoPayload = {
  type: "generate_alibaba_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  negative_prompt?: string;
  model?: string;
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
  fs: ClipfirstFs,
  input: RefInput,
  projectSlug: string,
  model: string,
): Promise<string> {
  return uploadAssetToAlibaba(fs, input.assetId, input.filename, projectSlug, model);
}

export function registerGenerateAlibabaVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_alibaba_video", async (payload) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt, negative_prompt, model,
      firstFrame, lastFrame, firstClip, drivingAudio, videoRef,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      resolution, duration, prompt_extend, watermark, audio_setting, seed,
    } = payload as GenerateAlibabaVideoPayload;

    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey) throw new Error("DASHSCOPE_API_KEY environment variable is not set");

    const uploadModel = model ?? "wan2.7-i2v";
    const firstFrameUrl = firstFrame ? await uploadInput(fs, firstFrame, projectSlug, uploadModel) : undefined;
    const lastFrameUrl = lastFrame ? await uploadInput(fs, lastFrame, projectSlug, uploadModel) : undefined;
    const firstClipUrl = firstClip ? await uploadInput(fs, firstClip, projectSlug, uploadModel) : undefined;
    const drivingAudioUrl = drivingAudio ? await uploadInput(fs, drivingAudio, projectSlug, uploadModel) : undefined;
    const videoUrl = videoRef ? await uploadInput(fs, videoRef, projectSlug, uploadModel) : undefined;

    // DashScope requires `X-DashScope-OssResourceResolve: enable` to resolve
    // `oss://` URIs produced by our native upload path. The SDK only sets
    // `X-DashScope-Async`, so we wrap fetch to add the extra header on
    // requests to the video-synthesis endpoint.
    const provider = alibaba({
      apiKey,
      timeout: 120_000,
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);
        if (url.includes("/services/aigc/video-generation/video-synthesis")) {
          const headers = new Headers(init?.headers);
          headers.set("X-DashScope-OssResourceResolve", "enable");
          return fetch(input, { ...init, headers });
        }
        return fetch(input, init);
      },
    });

    const request = buildAlibabaVideoPayload(
      {
        prompt,
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
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const submitResult = await provider.post.api.v1.services.aigc.videoGeneration.videoSynthesis(request);
    const taskId = submitResult.output.task_id;
    await writePendingTask(fs, vidAssetId, projectSlug, {
      taskId,
      taskType: "alibaba_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        prompt,
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
      },
    });

    return { success: true, taskId };
  });
}
