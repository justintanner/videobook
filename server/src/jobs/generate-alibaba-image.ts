import type { ClipfirstFs } from "clipfirst-engine";
import { alibaba, type AlibabaImageGenerationRequest } from "@apicity/alibaba";
import { uploadAssetToAlibaba } from "./_alibaba-upload.js";
import { registerJobHandler } from "../queue.js";
import { buildAlibabaImagePayload } from "../payload-builders.js";

type GenerateAlibabaImagePayload = {
  type: "generate_alibaba_image";
  prompt: string;
  imageInputs: Array<{ assetId: string; filename: string }>;
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  projectSlug: string;
  model: AlibabaImageGenerationRequest["model"];
  size?: string;
  n?: number;
  watermark?: boolean;
  thinkingMode?: boolean;
  seed?: number;
};

export function registerGenerateAlibabaImageJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_alibaba_image", async (payload) => {
    const {
      prompt, imageInputs, imgAssetId, imgAssetDir,
      sourceImageIds, projectSlug, model, size, n, watermark, thinkingMode, seed,
    } = payload as GenerateAlibabaImagePayload;

    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey) throw new Error("DASHSCOPE_API_KEY environment variable is not set");

    const uploadedUrls: string[] = [];
    for (const { assetId: srcAssetId, filename } of imageInputs) {
      uploadedUrls.push(await uploadAssetToAlibaba(fs, srcAssetId, filename, projectSlug, model));
    }

    const provider = alibaba({ apiKey, timeout: 120_000 });

    const request = buildAlibabaImagePayload(
      { prompt, model, size, n, watermark, thinking_mode: thinkingMode, seed },
      uploadedUrls,
    );
    await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
    const submitResult = await provider.post.api.v1.services.aigc.imageGeneration.generation(request);
    const taskId = submitResult.output.task_id;
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "alibaba_image",
        assetId: imgAssetId,
        assetDir: imgAssetDir,
        meta: {
          sourceImageIds,
          prompt,
          ...(size !== undefined ? { size } : {}),
          ...(n !== undefined ? { n } : {}),
          ...(watermark !== undefined ? { watermark } : {}),
          ...(thinkingMode !== undefined ? { thinkingMode } : {}),
          ...(seed !== undefined ? { seed } : {}),
        },
    });
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${imgAssetId}: ${_ptResult.error.message}`);
    }

    return { success: true, taskId };
  });
}

export function registerGenerateAlibabaImageProJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_alibaba_image_pro", async (payload) => {
    const {
      prompt, imageInputs, imgAssetId, imgAssetDir,
      sourceImageIds, projectSlug, size, n, watermark, thinkingMode, seed,
    } = payload as GenerateAlibabaImagePayload;

    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey) throw new Error("DASHSCOPE_API_KEY environment variable is not set");

    const uploadedUrls: string[] = [];
    for (const { assetId: srcAssetId, filename } of imageInputs) {
      uploadedUrls.push(await uploadAssetToAlibaba(fs, srcAssetId, filename, projectSlug, "wan2.7-image-pro"));
    }

    const provider = alibaba({ apiKey, timeout: 120_000 });

    const request = buildAlibabaImagePayload(
      { prompt, model: "wan2.7-image-pro", size, n, watermark, thinking_mode: thinkingMode, seed },
      uploadedUrls,
    );
    await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
    const submitResult = await provider.post.api.v1.services.aigc.imageGeneration.generation(request);
    const taskId = submitResult.output.task_id;
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "alibaba_image_pro",
        assetId: imgAssetId,
        assetDir: imgAssetDir,
        meta: {
          sourceImageIds,
          prompt,
          ...(size !== undefined ? { size } : {}),
          ...(n !== undefined ? { n } : {}),
          ...(watermark !== undefined ? { watermark } : {}),
          ...(thinkingMode !== undefined ? { thinkingMode } : {}),
          ...(seed !== undefined ? { seed } : {}),
        },
    });
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${imgAssetId}: ${_ptResult.error.message}`);
    }

    return { success: true, taskId };
  });
}
