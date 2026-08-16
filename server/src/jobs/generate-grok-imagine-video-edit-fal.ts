import type { FalEndpointInputMap } from "@apicity/fal";
import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";

type RefInput = { assetId: string; filename: string };

type FalInput = FalEndpointInputMap["xai/grok-imagine-video/edit-video"];

type Payload = {
  type: "generate_grok_imagine_video_edit_fal";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt: string;
  sourceVideo: RefInput;
  sourceVideoIds: string[];
  resolution?: FalInput["resolution"];
};

export function registerGenerateGrokImagineVideoEditFalJob(fs: Engine): void {
  registerJobHandler("generate_grok_imagine_video_edit_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(fs, p.vidAssetId, ctx, "generate", async (ownerId) => {
  
      const video_url = await uploadAssetToFal(fs, p.sourceVideo.assetId, p.sourceVideo.filename);
  
      const input: FalInput = {
        prompt: p.prompt,
        video_url,
        ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
      };
  
      const taskId = await submitFalJob({
        fs,
        bookId: p.bookId,
        assetId: p.vidAssetId,
        assetDir: p.vidAssetDir,
        endpointId: "xai/grok-imagine-video/edit-video",
        input,
        taskType: "fal_grok_imagine_video_edit",
        meta: { prompt: p.prompt, mode: "videoedit", sourceVideoIds: p.sourceVideoIds },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
