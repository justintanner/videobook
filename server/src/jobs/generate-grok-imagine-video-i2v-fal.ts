import type { Engine } from "videobook-engine";
import { uploadAssetToFal } from "./_fal-upload.js";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { submitFalJob } from "./_fal-shared.js";

type FrameInput = { assetId: string; filename: string };

type Payload = {
  type: "generate_grok_imagine_video_i2v_fal";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt: string;
  firstFrame: FrameInput;
  sourceImageIds: string[];
  duration?: number;
  aspect_ratio?: string;
  resolution?: string;
};

export function registerGenerateGrokImagineVideoI2vFalJob(fs: Engine): void {
  registerJobHandler("generate_grok_imagine_video_i2v_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(fs, p.bookId, p.vidAssetId, ctx, "generate", async (ownerId) => {
  
      const image_url = await uploadAssetToFal(fs, p.firstFrame.assetId, p.firstFrame.filename, p.bookId);
  
      const input: Record<string, unknown> = {
        prompt: p.prompt,
        image_url,
        ...(p.duration !== undefined ? { duration: p.duration } : {}),
        ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
        ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
      };
  
      const taskId = await submitFalJob({
        fs,
        bookId: p.bookId,
        assetId: p.vidAssetId,
        assetDir: p.vidAssetDir,
        endpointId: "xai/grok-imagine-video/image-to-video",
        input,
        taskType: "fal_grok_imagine_video_i2v",
        meta: { prompt: p.prompt, mode: "i2v", sourceImageIds: p.sourceImageIds, return_last_frame: false },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
