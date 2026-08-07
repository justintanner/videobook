import type { FalEndpointInputMap } from "@apicity/fal";
import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";

type MediaInput = { assetId: string; filename: string };

type FalInput = FalEndpointInputMap["bytedance/seedance-2.0/fast/reference-to-video"];

type Payload = {
  type: "generate_seedance2_fast_r2v_fal";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt: string;
  imageInputs: MediaInput[];
  videoInputs: MediaInput[];
  audioInputs: MediaInput[];
  sourceImageIds: string[];
  sourceVideoIds: string[];
  sourceAudioIds: string[];
  resolution?: FalInput["resolution"];
  duration?: FalInput["duration"];
  aspect_ratio?: FalInput["aspect_ratio"];
  generate_audio?: boolean;
  seed?: number;
};

export function registerGenerateSeedance2FastR2vFalJob(fs: Engine): void {
  registerJobHandler("generate_seedance2_fast_r2v_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(fs, p.bookId, p.vidAssetId, ctx, "generate", async (ownerId) => {
  
      const image_urls: string[] = [];
      for (const img of p.imageInputs) {
        image_urls.push(await uploadAssetToFal(fs, img.assetId, img.filename, p.bookId));
      }
      const video_urls: string[] = [];
      for (const vid of p.videoInputs) {
        video_urls.push(await uploadAssetToFal(fs, vid.assetId, vid.filename, p.bookId));
      }
      const audio_urls: string[] = [];
      for (const aud of p.audioInputs) {
        audio_urls.push(await uploadAssetToFal(fs, aud.assetId, aud.filename, p.bookId));
      }
  
      const input: FalInput = {
        prompt: p.prompt,
        ...(image_urls.length > 0 ? { image_urls } : {}),
        ...(video_urls.length > 0 ? { video_urls } : {}),
        ...(audio_urls.length > 0 ? { audio_urls } : {}),
        ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
        ...(p.duration !== undefined ? { duration: p.duration } : {}),
        ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
        ...(p.generate_audio !== undefined ? { generate_audio: p.generate_audio } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
      };
  
      const taskId = await submitFalJob({
        fs,
        bookId: p.bookId,
        assetId: p.vidAssetId,
        assetDir: p.vidAssetDir,
        endpointId: "bytedance/seedance-2.0/fast/reference-to-video",
        input,
        taskType: "fal_seedance2_fast_r2v",
        meta: {
          prompt: p.prompt,
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
