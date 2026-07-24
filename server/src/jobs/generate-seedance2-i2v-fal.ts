import type { Engine } from "videobook-engine";
import { uploadAssetToFal } from "./_fal-upload.js";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { submitFalJob } from "./_fal-shared.js";

type FrameInput = { assetId: string; filename: string };

type Payload = {
  type: "generate_seedance2_i2v_fal";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt: string;
  firstFrame: FrameInput;
  endFrame?: FrameInput;
  sourceImageIds: string[];
  resolution?: string;
  duration?: string;
  aspect_ratio?: string;
  generate_audio?: boolean;
  seed?: number;
};

export function registerGenerateSeedance2I2vFalJob(fs: Engine): void {
  registerJobHandler("generate_seedance2_i2v_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(fs, p.bookId, p.vidAssetId, ctx, "generate", async (ownerId) => {
  
      const image_url = await uploadAssetToFal(fs, p.firstFrame.assetId, p.firstFrame.filename, p.bookId);
      const end_image_url = p.endFrame
        ? await uploadAssetToFal(fs, p.endFrame.assetId, p.endFrame.filename, p.bookId)
        : undefined;
  
      const input: Record<string, unknown> = {
        prompt: p.prompt,
        image_url,
        ...(end_image_url ? { end_image_url } : {}),
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
        endpointId: "bytedance/seedance-2.0/image-to-video",
        input,
        taskType: "fal_seedance2_i2v",
        meta: { prompt: p.prompt, mode: "i2v", sourceImageIds: p.sourceImageIds, return_last_frame: false },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
