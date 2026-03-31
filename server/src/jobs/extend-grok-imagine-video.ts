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
};

export function registerExtendGrokImagineVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("extend_grok_imagine_video", async (payload) => {
    const {
      sourceVideoId, sourceVideoFilename, vidAssetId, vidAssetDir,
      projectSlug, prompt, duration,
    } = payload as ExtendGrokImagineVideoPayload;

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
    const upload = await kieProvider.api["file-stream-upload"]({ file: blob, filename: sourceVideoFilename });
    if (!upload.data?.downloadUrl) throw new Error("KIE upload failed: no download URL in response");
    const videoUrl = upload.data.downloadUrl;

    const provider = xai({ apiKey, timeout: 120_000 });
    const request = {
      prompt: prompt ?? "",
      video: { url: videoUrl },
      ...(duration !== undefined ? { duration: parseInt(duration, 10) } : {}),
    };
    const { request_id } = await provider.v1.videos.extensions(request);

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
  });
}
