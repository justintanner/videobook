import type { Engine } from "videobook-engine";
import { submitKieTask } from "./kie-paygate.js";
import type { GrokImageToVideoRequest } from "@apicity/kie";
import type { XaiVideoAsyncResponse, XaiVideoGenerateRequest } from "@apicity/xai";
import { uploadAssetFile } from "../upload.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildGrokImagineVideoPayload, buildXaiGrokImagineVideoPayload } from "../payload-builders.js";
import { callXaiPaid, createXaiPaygatedProvider, XAI_VIDEO_GENERATIONS_DOT_PATH } from "./xai-paygate.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";

type GenerateGrokImagineVideoPayload = {
  type: "generate_grok_imagine_video";
  sourceImageIds: string[];
  imageFilenames: string[];
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt?: string;
  mode?: Exclude<NonNullable<GrokImageToVideoRequest["input"]["mode"]>, "spicy">;
  duration?: number;
  resolution?: GrokImageToVideoRequest["input"]["resolution"];
  aspect_ratio?: GrokImageToVideoRequest["input"]["aspect_ratio"];
  nsfw_checker?: boolean;
  replaceAudioWith?: { assetId: string; filename: string };
  _provider?: string;
};

export function registerGenerateGrokImagineVideoJob(fs: Engine): void {
  registerJobHandler("generate_grok_imagine_video", async (payload, ctx) => {
    const {
      sourceImageIds, imageFilenames, vidAssetId, vidAssetDir,
      bookId, prompt, mode, duration, resolution, aspect_ratio, nsfw_checker, replaceAudioWith, _provider,
    } = payload as GenerateGrokImagineVideoPayload;

    if (sourceImageIds.length === 0) {
      throw new Error("generate_grok_imagine_video requires at least one source image");
    }
    if (sourceImageIds.length !== imageFilenames.length) {
      throw new Error("sourceImageIds / imageFilenames length mismatch");
    }

    const isXai = _provider !== undefined && _provider.startsWith("xai");
    const normalizedPrompt = prompt === undefined
      ? undefined
      : transformProviderPrompt(
        "generate_kie_grok_imagine_image_to_video",
        { prompt, image_refs: sourceImageIds },
        _provider,
      );

    if (isXai) {
      // xAI path — async video generation with pending task
      const apiKey = requireApiKey("XAI_API_KEY");

      const imageUrls: string[] = [];
      for (let i = 0; i < sourceImageIds.length; i++) {
        imageUrls.push(await uploadAssetFile(fs, sourceImageIds[i], imageFilenames[i], bookId));
      }

      const provider = createXaiPaygatedProvider(apiKey, 120_000);
      const request = buildXaiGrokImagineVideoPayload(
        { prompt: normalizedPrompt, duration, resolution, aspect_ratio, nsfw_checker },
        imageUrls,
      );
      await fs.metadata.artifacts.write(vidAssetId, "generation-payload", request);
      const { request_id } = await callXaiPaid<XaiVideoGenerateRequest, XaiVideoAsyncResponse>(
        provider.post.v1.videos.generations,
        XAI_VIDEO_GENERATIONS_DOT_PATH,
        request,
      );

      {
        const _ptResult = await fs.jobs.pending.write({
          taskId: request_id,
          taskType: "xai_grok_imagine_video",
          artifactId: vidAssetId,
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
      downloadUrls.push(await uploadAssetToKie(fs, sourceImageIds[i], imageFilenames[i], bookId));
    }

    const request = buildGrokImagineVideoPayload(
      {
        prompt,
        mode,
        duration,
        resolution,
        aspect_ratio,
        nsfw_checker,
        // Parallel asset ids so @img-* prompt mentions can reorder image_urls
        // to match first-mention order (@image1 = first named subject).
        image_refs: sourceImageIds,
      },
      downloadUrls,
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "grok_imagine_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
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
