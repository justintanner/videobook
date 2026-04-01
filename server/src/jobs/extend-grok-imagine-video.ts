import type { ClipfirstFs } from "clipfirst-fs";
import { kie } from "@nakedapi/kie";
import { xai } from "@nakedapi/xai";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";

type ExtendGrokImagineVideoPayload = {
  type: "extend_grok_imagine_video";
  sourceVideoId: string;
  sourceVideoFilename: string;
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt?: string;
  duration?: "6" | "10" | "15";
  _provider?: string;
};

export function registerExtendGrokImagineVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("extend_grok_imagine_video", async (payload) => {
    const {
      sourceVideoId, sourceVideoFilename, vidAssetId, vidAssetDir,
      projectSlug, prompt, duration, _provider,
    } = payload as ExtendGrokImagineVideoPayload;

    const isXai = _provider?.startsWith("xai");

    if (isXai) {
      // xAI path
      const apiKey = process.env.XAI_API_KEY;
      if (!apiKey) throw new Error("XAI_API_KEY environment variable is not set");

      const readResult = await fs.readFile(sourceVideoId, sourceVideoFilename, projectSlug);
      if (!readResult.ok) throw new Error(readResult.error.message);
      const videoBytes = new Uint8Array(readResult.value);

      // Upload video via KIE for a publicly accessible URL (xAI needs a URL)
      const kieKey = process.env.KIE_API_KEY;
      if (!kieKey) throw new Error("KIE_API_KEY environment variable is not set — required for video upload");
      const kieProvider = kie({ apiKey: kieKey, timeout: 120_000 });
      const blob = new Blob([videoBytes]);
      const upload = await kieProvider.post.api.fileStreamUpload({ file: blob, filename: sourceVideoFilename });
      if (!upload.data?.downloadUrl) throw new Error("KIE upload failed: no download URL in response");
      const videoUrl = upload.data.downloadUrl;

      const provider = xai({ apiKey, timeout: 120_000 });
      const request = {
        prompt: prompt ?? "",
        video: { url: videoUrl },
        ...(duration !== undefined ? { duration: parseInt(duration, 10) } : {}),
      };
      const { request_id } = await provider.post.v1.videos.extensions(request);

      await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
      await writePendingTask(fs, vidAssetId, projectSlug, {
        taskId: request_id,
        taskType: "xai_grok_imagine_extend_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        projectSlug,
        createdAt: new Date().toISOString(),
        meta: {
          sourceVideoId,
          ...(prompt !== undefined ? { prompt } : {}),
          ...(duration !== undefined ? { duration } : {}),
        },
      });

      return { success: true, requestId: request_id, provider: "xai" };
    }

    // Kie path
    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    // Read the source video's Kie taskId from metadata
    const kieTaskIdResult = await fs.readMetadata<{ taskId: string }>(sourceVideoId, "kie-task-id", projectSlug);
    if (!kieTaskIdResult.ok) {
      throw new Error(`No Kie taskId found for source video ${sourceVideoId}. The source video must have been generated via Kie.`);
    }
    const kieTaskId = kieTaskIdResult.value.taskId;

    const provider = kie({ apiKey, timeout: 120_000 });

    // Kie only supports "6" | "10" for extend_times
    const extendTimes = duration === "15" ? "10" : (duration ?? "6");

    const request = {
      model: "grok-imagine/extend",
      input: {
        task_id: kieTaskId,
        prompt: prompt ?? "",
        extend_at: 0,
        extend_times: extendTimes as "6" | "10",
      },
    };

    const taskResult = await provider.post.api.v1.jobs.createTask(request);
    if (!taskResult.data?.taskId) {
      const msg = (taskResult as Record<string, unknown>).msg as string | undefined;
      throw new Error(`KIE createTask failed: ${msg ?? 'no taskId in response'}`);
    }
    const taskId = taskResult.data.taskId;

    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    await writePendingTask(fs, vidAssetId, projectSlug, {
      taskId,
      taskType: "grok_imagine_extend_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        sourceVideoId,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(duration !== undefined ? { duration } : {}),
      },
    });

    return { success: true, taskId };
  });
}
