import type { Engine } from "videobook-engine";
import { createAlibaba, type AlibabaImageGenerationRequest } from "@apicity/alibaba";
import { uploadAssetToAlibaba } from "./_alibaba-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
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

export function registerGenerateAlibabaImageJob(fs: Engine): void {
  registerJobHandler("generate_alibaba_image", async (payload, ctx) => {
    const {
      prompt, imageInputs, imgAssetId,
      sourceImageIds, projectSlug, model, size, n, watermark, thinkingMode, seed,
    } = payload as GenerateAlibabaImagePayload;

    const apiKey = requireApiKey("DASHSCOPE_API_KEY");

    const uploadedUrls: string[] = [];
    for (const { assetId: srcAssetId, filename } of imageInputs) {
      uploadedUrls.push(await uploadAssetToAlibaba(fs, srcAssetId, filename, projectSlug, model));
    }

    const provider = createAlibaba({ apiKey, timeout: 120_000 });

    const request = buildAlibabaImagePayload(
      { prompt, model, size, n, watermark, thinking_mode: thinkingMode, seed },
      uploadedUrls,
    );
    await fs.metadata.artifacts.write(imgAssetId, "generation-payload", request, projectSlug);
    const submitResult = await provider.post.api.v1.services.aigc.imageGeneration.generation(request);
    const taskId = submitResult.output.task_id;
    {
      const _ptResult = await fs.jobs.pending.write(projectSlug, {
        taskId,
        taskType: "alibaba_image",
        artifactId: imgAssetId,
        meta: {
          sourceImageIds,
          prompt,
          ...(size !== undefined ? { size } : {}),
          ...(n !== undefined ? { n } : {}),
          ...(watermark !== undefined ? { watermark } : {}),
          ...(thinkingMode !== undefined ? { thinkingMode } : {}),
          ...(seed !== undefined ? { seed } : {}),
        },
    }, ctx.getOwnerId());
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${imgAssetId}: ${_ptResult.error.message}`);
      if (_ptResult.value === null) throw new Error(`Lost local lease while writing pending-task`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}

export function registerGenerateAlibabaImageProJob(fs: Engine): void {
  registerJobHandler("generate_alibaba_image_pro", async (payload, ctx) => {
    const {
      prompt, imageInputs, imgAssetId,
      sourceImageIds, projectSlug, size, n, watermark, thinkingMode, seed,
    } = payload as GenerateAlibabaImagePayload;

    const apiKey = requireApiKey("DASHSCOPE_API_KEY");

    const uploadedUrls: string[] = [];
    for (const { assetId: srcAssetId, filename } of imageInputs) {
      uploadedUrls.push(await uploadAssetToAlibaba(fs, srcAssetId, filename, projectSlug, "wan2.7-image-pro"));
    }

    const provider = createAlibaba({ apiKey, timeout: 120_000 });

    const request = buildAlibabaImagePayload(
      { prompt, model: "wan2.7-image-pro", size, n, watermark, thinking_mode: thinkingMode, seed },
      uploadedUrls,
    );
    await fs.metadata.artifacts.write(imgAssetId, "generation-payload", request, projectSlug);
    const submitResult = await provider.post.api.v1.services.aigc.imageGeneration.generation(request);
    const taskId = submitResult.output.task_id;
    {
      const _ptResult = await fs.jobs.pending.write(projectSlug, {
        taskId,
        taskType: "alibaba_image_pro",
        artifactId: imgAssetId,
        meta: {
          sourceImageIds,
          prompt,
          ...(size !== undefined ? { size } : {}),
          ...(n !== undefined ? { n } : {}),
          ...(watermark !== undefined ? { watermark } : {}),
          ...(thinkingMode !== undefined ? { thinkingMode } : {}),
          ...(seed !== undefined ? { seed } : {}),
        },
    }, ctx.getOwnerId());
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${imgAssetId}: ${_ptResult.error.message}`);
      if (_ptResult.value === null) throw new Error(`Lost local lease while writing pending-task`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}
