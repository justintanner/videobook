import type { ClipfirstFs } from "clipfirst-fs";
import { kie, submitMediaJob } from "@apicity/kie";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";

type ExtendGrokImagineVideoPayload = {
  type: "extend_grok_imagine_video";
  sourceVideoId: string;
  sourceVideoFilename: string;
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  extend_at?: number;
  extend_times?: "6" | "10";
};

export function registerExtendGrokImagineVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("extend_grok_imagine_video", async (payload) => {
    const {
      sourceVideoId, vidAssetId, vidAssetDir,
      projectSlug, prompt, extend_at, extend_times,
    } = payload as ExtendGrokImagineVideoPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const kieTaskIdResult = await fs.readMetadata<{ taskId: string }>(sourceVideoId, "kie-task-id", projectSlug);
    if (!kieTaskIdResult.ok) {
      throw new Error(`No Kie taskId found for source video ${sourceVideoId}. The source video must have been generated via Kie.`);
    }
    const kieTaskId = kieTaskIdResult.value.taskId;

    const provider = kie({ apiKey, timeout: 120_000 });

    const request = {
      model: "grok-imagine/extend" as const,
      input: {
        task_id: kieTaskId,
        prompt,
        extend_at: String(extend_at ?? 0),
        extend_times: extend_times ?? "6",
      },
    };

    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    await writePendingTask(fs, vidAssetId, projectSlug, {
      taskId,
      taskType: "grok_imagine_extend_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        sourceVideoId,
        prompt,
        ...(extend_at !== undefined ? { extend_at } : {}),
        ...(extend_times !== undefined ? { extend_times } : {}),
      },
    });

    return { success: true, taskId };
  });
}
