import type { FalEndpointInputMap } from "@apicity/fal";
import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";

type RefInput = { assetId: string; filename: string };

type FalInput = FalEndpointInputMap["alibaba/wan-3.0/reference-to-video"];

type Payload = {
  type: "generate_wan30_r2v_fal";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt?: string;
  imageInputs: RefInput[];
  videoInputs: RefInput[];
  audioInputs: RefInput[];
  sourceImageIds: string[];
  sourceVideoIds: string[];
  sourceAudioIds: string[];
  file_url?: string;
  web_url?: string;
  aspect_ratio?: FalInput["aspect_ratio"];
  resolution?: FalInput["resolution"];
  duration: number;
  audio?: boolean;
  enable_prompt_expansion?: boolean;
  enable_thinking?: boolean;
  enable_safety_checker?: boolean;
  seed?: number;
};

export function registerGenerateWan30R2vFalJob(engine: Engine): void {
  registerJobHandler("generate_wan30_r2v_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(engine, p.vidAssetId, ctx, "generate", async (ownerId) => {

      const reference_image_urls: string[] = [];
      for (const img of p.imageInputs) {
        reference_image_urls.push(await uploadAssetToFal(engine, img.assetId, img.filename));
      }
      const reference_video_urls: string[] = [];
      for (const vid of p.videoInputs) {
        reference_video_urls.push(await uploadAssetToFal(engine, vid.assetId, vid.filename));
      }
      const reference_audio_urls: string[] = [];
      for (const aud of p.audioInputs) {
        reference_audio_urls.push(await uploadAssetToFal(engine, aud.assetId, aud.filename));
      }

      const input: FalInput = {
        ...(p.prompt !== undefined ? { prompt: p.prompt } : {}),
        ...(reference_image_urls.length > 0 ? { reference_image_urls } : {}),
        ...(reference_video_urls.length > 0 ? { reference_video_urls } : {}),
        ...(reference_audio_urls.length > 0 ? { reference_audio_urls } : {}),
        ...(p.file_url !== undefined ? { file_url: p.file_url } : {}),
        ...(p.web_url !== undefined ? { web_url: p.web_url } : {}),
        ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
        ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
        duration: p.duration,
        ...(p.audio !== undefined ? { audio: p.audio } : {}),
        ...(p.enable_prompt_expansion !== undefined ? { enable_prompt_expansion: p.enable_prompt_expansion } : {}),
        ...(p.enable_thinking !== undefined ? { enable_thinking: p.enable_thinking } : {}),
        ...(p.enable_safety_checker !== undefined ? { enable_safety_checker: p.enable_safety_checker } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
      };

      const taskId = await submitFalJob({
        engine,
        bookId: p.bookId,
        assetId: p.vidAssetId,
        assetDir: p.vidAssetDir,
        endpointId: "alibaba/wan-3.0/reference-to-video",
        input,
        taskType: "fal_wan30_r2v",
        meta: {
          prompt: p.prompt ?? "",
          mode: "reference",
          sourceImageIds: p.sourceImageIds,
          sourceVideoIds: p.sourceVideoIds,
          sourceAudioIds: p.sourceAudioIds,
        },
        expectedOwnerId: ownerId,
      });

      return { taskId, result: { success: true, taskId } };    });
  });
}
