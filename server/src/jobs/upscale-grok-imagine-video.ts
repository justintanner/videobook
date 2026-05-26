import type { ClipfirstFs } from "vc-engine";
import { kie, submitMediaJob } from "@apicity/kie";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
type UpscaleGrokImagineVideoPayload = {
  type: "upscale_grok_imagine_video";
  sourceVideoId: string;
  sourceVideoFilename: string;
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
};

export function registerUpscaleGrokImagineVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("upscale_grok_imagine_video", async (payload, ctx) => {
    const {
      sourceVideoId, vidAssetId, vidAssetDir, projectSlug,
    } = payload as UpscaleGrokImagineVideoPayload;

    const apiKey = requireApiKey("KIE_API_KEY");

    const kieTaskIdResult = await fs.readMetadata<{ taskId: string }>(sourceVideoId, "kie-task-id", projectSlug);
    if (!kieTaskIdResult.ok) {
      throw new Error(`No Kie taskId found for source video ${sourceVideoId}. The source video must have been generated via Kie.`);
    }
    const kieTaskId = kieTaskIdResult.value.taskId;

    const provider = kie({ apiKey, timeout: 120_000 });

    const request = {
      model: "grok-imagine/upscale" as const,
      input: {
        task_id: kieTaskId,
      },
    };

    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "grok_imagine_upscale_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        meta: {
          sourceVideoId,
          upscale: true,
        },
    }, ctx.getOwnerId());
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
      if (_ptResult.value === null) throw new Error(`Lost local lease while writing pending-task`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}
