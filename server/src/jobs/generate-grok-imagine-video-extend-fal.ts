import type { ClipfirstFs } from "clipfirst-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";

type RefInput = { assetId: string; filename: string };

type Payload = {
  type: "generate_grok_imagine_video_extend_fal";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  sourceVideo: RefInput;
  sourceVideoIds: string[];
  duration?: number;
};

export function registerGenerateGrokImagineVideoExtendFalJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_grok_imagine_video_extend_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(fs, p.projectSlug, p.vidAssetId, ctx, "generate", async (ownerId) => {
  
      const video_url = await uploadAssetToFal(fs, p.sourceVideo.assetId, p.sourceVideo.filename, p.projectSlug);
  
      const input: Record<string, unknown> = {
        prompt: p.prompt,
        video_url,
        ...(p.duration !== undefined ? { duration: p.duration } : {}),
      };
  
      const taskId = await submitFalJob({
        fs,
        projectSlug: p.projectSlug,
        assetId: p.vidAssetId,
        assetDir: p.vidAssetDir,
        endpointId: "xai/grok-imagine-video/extend-video",
        input,
        taskType: "fal_grok_imagine_video_extend",
        meta: { prompt: p.prompt, mode: "extend", sourceVideoIds: p.sourceVideoIds },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
