import type { ClipfirstFs } from "clipfirst-fs";
import { kie, uploadFile, submitMediaJob } from "@nakedapi/kie";
import { xai } from "@nakedapi/xai";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
import { buildGrokImagineVideoPayload, buildXaiGrokImagineVideoPayload } from "../payload-builders.js";

type GenerateGrokImagineVideoPayload = {
  type: "generate_grok_imagine_video";
  imagePath: string;
  imageFilename: string;
  vidAssetId: string;
  vidAssetDir: string;
  sourceImageId: string;
  projectSlug: string;
  prompt?: string;
  mode?: "fun" | "normal" | "spicy";
  duration?: "6" | "10";
  resolution?: "480p" | "720p";
  _provider?: string;
};

export function registerGenerateGrokImagineVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_grok_imagine_video", async (payload) => {
    const {
      imageFilename, vidAssetId, vidAssetDir,
      sourceImageId, projectSlug, prompt, mode, duration, resolution, _provider,
    } = payload as GenerateGrokImagineVideoPayload;

    const isXai = _provider !== undefined && _provider.startsWith("xai");

    const readResult = await fs.readFile(sourceImageId, imageFilename, projectSlug);
    if (!readResult.ok) throw new Error(readResult.error.message);
    const imageBytes = new Uint8Array(readResult.value);

    if (isXai) {
      // xAI path — async video generation with pending task
      const apiKey = process.env.XAI_API_KEY;
      if (!apiKey) throw new Error("XAI_API_KEY environment variable is not set");

      // Upload image via kie for a publicly accessible URL (xai needs a URL, not base64)
      const kieKey = process.env.KIE_API_KEY;
      let imageUrl: string;
      if (kieKey) {
        const kieProvider = kie({ apiKey: kieKey, timeout: 60_000 });
        const blob = new Blob([imageBytes]);
        imageUrl = await uploadFile(kieProvider, blob, imageFilename);
      } else {
        // Fallback: base64 data URL
        const ext = imageFilename.split(".").pop()?.toLowerCase() ?? "png";
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
        const b64 = Buffer.from(imageBytes).toString("base64");
        imageUrl = `data:${mime};base64,${b64}`;
      }

      const provider = xai({ apiKey, timeout: 120_000 });
      const request = buildXaiGrokImagineVideoPayload(
        { prompt, mode, duration, resolution },
        [imageUrl],
      );
      const { request_id } = await provider.post.v1.videos.generations(request);

      await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
      await writePendingTask(fs, vidAssetId, projectSlug, {
        taskId: request_id,
        taskType: "xai_grok_imagine_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        projectSlug,
        createdAt: new Date().toISOString(),
        meta: {
          sourceImageId,
          ...(prompt !== undefined ? { prompt } : {}),
          ...(duration !== undefined ? { duration } : {}),
          ...(resolution !== undefined ? { resolution } : {}),
        },
      });

      return { success: true, requestId: request_id, provider: "xai" };
    }

    // Kie path — async task-based generation
    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });
    const blob = new Blob([imageBytes]);

    const downloadUrl = await uploadFile(provider, blob, imageFilename);

    const request = buildGrokImagineVideoPayload(
      { prompt, mode, duration, resolution },
      [downloadUrl],
    );
    const taskId = await submitMediaJob(provider, request);

    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    await fs.writeMetadata(vidAssetId, "kie-task-id", { taskId }, projectSlug);
    await writePendingTask(fs, vidAssetId, projectSlug, {
      taskId,
      taskType: "grok_imagine_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        sourceImageId,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
      },
    });

    return { success: true, taskId };
  });
}
