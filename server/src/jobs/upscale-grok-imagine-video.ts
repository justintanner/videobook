import type { ClipfirstFs } from "clipfirst-engine";
import { kie, submitMediaJob } from "@apicity/kie";
import { registerJobHandler } from "../queue.js";
type UpscaleGrokImagineVideoPayload = {
  type: "upscale_grok_imagine_video";
  sourceVideoId: string;
  sourceVideoFilename: string;
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
};

export function registerUpscaleGrokImagineVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("upscale_grok_imagine_video", async (payload) => {
    const {
      sourceVideoId, vidAssetId, vidAssetDir, projectSlug,
    } = payload as UpscaleGrokImagineVideoPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

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
    });
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
    }

    return { success: true, taskId };
  });
}
