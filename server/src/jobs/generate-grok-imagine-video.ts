import type { ClipfirstFs } from "clipfirst-fs";
import { kie, submitMediaJob } from "@apicity/kie";
import { uploadAssetFile } from "../kie-upload.js";
import { xai } from "@apicity/xai";
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

    if (isXai) {
      // xAI path — async video generation with pending task
      const apiKey = process.env.XAI_API_KEY;
      if (!apiKey) throw new Error("XAI_API_KEY environment variable is not set");

      // Upload image via kie for a publicly accessible URL
      const kieKey = process.env.KIE_API_KEY;
      if (!kieKey) throw new Error("KIE_API_KEY environment variable is required for image upload");
      const kieProvider = kie({ apiKey: kieKey, timeout: 60_000 });
      const imageUrl = await uploadAssetFile(kieProvider, fs, sourceImageId, imageFilename, projectSlug);

      const provider = xai({ apiKey, timeout: 120_000 });
      const request = buildXaiGrokImagineVideoPayload(
        { prompt, mode, duration, resolution },
        [imageUrl],
      );
      await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
      const { request_id } = await provider.post.v1.videos.generations(request);

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

    const downloadUrl = await uploadAssetFile(provider, fs, sourceImageId, imageFilename, projectSlug);

    const request = buildGrokImagineVideoPayload(
      { prompt, mode, duration, resolution },
      [downloadUrl],
    );
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
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
