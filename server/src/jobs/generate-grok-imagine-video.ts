import type { ClipfirstFs } from "clipfirst-engine";
import { kie, submitMediaJob } from "@apicity/kie";
import { uploadAssetFile } from "../upload.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { xai } from "@apicity/xai";
import { registerJobHandler } from "../queue.js";
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
  duration?: number;
  resolution?: "480p" | "720p";
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "2:3" | "3:2";
  nsfw_checker?: boolean;
  _provider?: string;
};

export function registerGenerateGrokImagineVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_grok_imagine_video", async (payload, ctx) => {
    const {
      imageFilename, vidAssetId, vidAssetDir,
      sourceImageId, projectSlug, prompt, mode, duration, resolution, aspect_ratio, nsfw_checker, _provider,
    } = payload as GenerateGrokImagineVideoPayload;

    const isXai = _provider !== undefined && _provider.startsWith("xai");

    if (isXai) {
      // xAI path — async video generation with pending task
      const apiKey = process.env.XAI_API_KEY;
      if (!apiKey) throw new Error("XAI_API_KEY environment variable is not set");

      const imageUrl = await uploadAssetFile(fs, sourceImageId, imageFilename, projectSlug);

      const provider = xai({ apiKey, timeout: 120_000 });
      const request = buildXaiGrokImagineVideoPayload(
        { prompt, mode, duration, resolution, aspect_ratio, nsfw_checker },
        [imageUrl],
      );
      await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
      const { request_id } = await provider.post.v1.videos.generations(request);

      {
        const _ptResult = await fs.pendingTasks.write(projectSlug, {
          taskId: request_id,
          taskType: "xai_grok_imagine_video",
          assetId: vidAssetId,
          assetDir: vidAssetDir,
          meta: {
            sourceImageId,
            ...(prompt !== undefined ? { prompt } : {}),
            ...(duration !== undefined ? { duration } : {}),
            ...(resolution !== undefined ? { resolution } : {}),
          },
      });
        if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
      }
      ctx.setLease({ kind: "task", taskId: request_id });

      return { success: true, requestId: request_id, provider: "xai" };
    }

    // Kie path — async task-based generation
    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const downloadUrl = await uploadAssetToKie(fs, sourceImageId, imageFilename, projectSlug);

    const request = buildGrokImagineVideoPayload(
      { prompt, mode, duration, resolution, aspect_ratio, nsfw_checker },
      [downloadUrl],
    );
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    await fs.writeMetadata(vidAssetId, "kie-task-id", { taskId }, projectSlug);
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "grok_imagine_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        meta: {
          sourceImageId,
          ...(prompt !== undefined ? { prompt } : {}),
          ...(mode !== undefined ? { mode } : {}),
          ...(duration !== undefined ? { duration } : {}),
          ...(resolution !== undefined ? { resolution } : {}),
        },
    });
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}
