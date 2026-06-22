import type { VideocityFs } from "videocity-engine";
import { submitKieTask } from "./kie-paygate.js";
import type { GrokImageToVideoRequest } from "@apicity/kie";
import type { XaiVideoAsyncResponse, XaiVideoGenerateRequest } from "@apicity/xai";
import { uploadAssetFile } from "../upload.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildGrokImagineVideoPayload, buildXaiGrokImagineVideoPayload } from "../payload-builders.js";
import { callXaiPaid, createXaiPaygatedProvider, XAI_VIDEO_GENERATIONS_DOT_PATH } from "./xai-paygate.js";

type GenerateGrokImagineVideoPayload = {
  type: "generate_grok_imagine_video";
  sourceImageIds: string[];
  imageFilenames: string[];
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt?: string;
  mode?: "fun" | "normal";
  duration?: number;
  resolution?: "480p" | "720p";
  aspect_ratio?: GrokImageToVideoRequest["input"]["aspect_ratio"];
  nsfw_checker?: boolean;
  replaceAudioWith?: { assetId: string; filename: string };
  _provider?: string;
};

export function registerGenerateGrokImagineVideoJob(fs: VideocityFs): void {
  registerJobHandler("generate_grok_imagine_video", async (payload, ctx) => {
    const {
      sourceImageIds, imageFilenames, vidAssetId, vidAssetDir,
      projectSlug, prompt, mode, duration, resolution, aspect_ratio, nsfw_checker, replaceAudioWith, _provider,
    } = payload as GenerateGrokImagineVideoPayload;

    if (sourceImageIds.length === 0) {
      throw new Error("generate_grok_imagine_video requires at least one source image");
    }
    if (sourceImageIds.length !== imageFilenames.length) {
      throw new Error("sourceImageIds / imageFilenames length mismatch");
    }

    const isXai = _provider !== undefined && _provider.startsWith("xai");

    if (isXai) {
      // xAI path — async video generation with pending task
      const apiKey = requireApiKey("XAI_API_KEY");

      const imageUrls: string[] = [];
      for (let i = 0; i < sourceImageIds.length; i++) {
        imageUrls.push(await uploadAssetFile(fs, sourceImageIds[i], imageFilenames[i], projectSlug));
      }

      const provider = createXaiPaygatedProvider(apiKey, 120_000);
      const request = buildXaiGrokImagineVideoPayload(
        { prompt, duration, resolution, aspect_ratio, nsfw_checker },
        imageUrls,
      );
      await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
      const { request_id } = await callXaiPaid<XaiVideoGenerateRequest, XaiVideoAsyncResponse>(
        provider.post.v1.videos.generations,
        XAI_VIDEO_GENERATIONS_DOT_PATH,
        request,
      );

      {
        const _ptResult = await fs.pendingTasks.write(projectSlug, {
          taskId: request_id,
          taskType: "xai_grok_imagine_video",
          assetId: vidAssetId,
          assetDir: vidAssetDir,
          meta: {
            sourceImageIds,
            ...(prompt !== undefined ? { prompt } : {}),
            ...(duration !== undefined ? { duration } : {}),
            ...(resolution !== undefined ? { resolution } : {}),
            ...(replaceAudioWith !== undefined ? { replaceAudioWith } : {}),
          },
        }, ctx.getOwnerId());
        if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
        if (_ptResult.value === null) throw new Error(`Lost local lease while writing pending-task`);
      }
      ctx.setLease({ kind: "task", taskId: request_id });

      return { success: true, requestId: request_id, provider: "xai" };
    }

    // Kie path — async task-based generation
    requireApiKey("KIE_API_KEY");

    const downloadUrls: string[] = [];
    for (let i = 0; i < sourceImageIds.length; i++) {
      downloadUrls.push(await uploadAssetToKie(fs, sourceImageIds[i], imageFilenames[i], projectSlug));
    }

    const request = buildGrokImagineVideoPayload(
      { prompt, mode, duration, resolution, aspect_ratio, nsfw_checker },
      downloadUrls,
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "grok_imagine_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      meta: {
        sourceImageIds,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(replaceAudioWith !== undefined ? { replaceAudioWith } : {}),
      },
    });

    return { success: true, taskId };
  });
}
