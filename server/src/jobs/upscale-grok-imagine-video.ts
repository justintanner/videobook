import type { Engine } from "videobook-engine";
import { submitKieTask } from "./kie-paygate.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
type UpscaleGrokImagineVideoPayload = {
  type: "upscale_grok_imagine_video";
  sourceVideoId: string;
  sourceVideoFilename: string;
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
};

export function registerUpscaleGrokImagineVideoJob(engine: Engine): void {
  registerJobHandler("upscale_grok_imagine_video", async (payload, ctx) => {
    const {
      sourceVideoId, vidAssetId, vidAssetDir, bookId,
    } = payload as UpscaleGrokImagineVideoPayload;

    requireApiKey("KIE_API_KEY");

    const kieTaskIdResult = await engine.metadata.artifacts.read<{ taskId: string }>(sourceVideoId, "kie-task-id");
    if (!kieTaskIdResult.ok) {
      throw new Error(`No Kie taskId found for source video ${sourceVideoId}. The source video must have been generated via Kie.`);
    }
    const kieTaskId = kieTaskIdResult.value.taskId;

    const request = {
      model: "grok-imagine/upscale" as const,
      input: {
        task_id: kieTaskId,
      },
    };

    const taskId = await submitKieTask(engine, ctx, {
      request,
      taskType: "grok_imagine_upscale_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
      meta: {
        sourceVideoId,
        upscale: true,
      },
    });

    return { success: true, taskId };
  });
}
