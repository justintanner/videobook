import type { ClipfirstFs } from "clipfirst-engine";
import { alibaba } from "@apicity/alibaba";
import type { AlibabaMultimodalGenerationRequest } from "@apicity/alibaba/zod";
import { uploadAssetToAlibaba } from "./_alibaba-upload.js";
import { queue, registerJobHandler } from "../queue.js";
import { buildAlibabaQwenImagePayload } from "../payload-builders.js";

type GenerateAlibabaQwenImagePayload = {
  type: "generate_alibaba_qwen_image" | "generate_alibaba_qwen_image_edit";
  prompt: string;
  imageInputs: Array<{ assetId: string; filename: string }>;
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  projectSlug: string;
  model: AlibabaMultimodalGenerationRequest["model"];
  size?: string;
  n?: number;
  negativePrompt?: string;
  promptExtend?: boolean;
  watermark?: boolean;
  seed?: number;
};

async function runQwenImageJob(
  fs: ClipfirstFs,
  payload: GenerateAlibabaQwenImagePayload,
  taskType: "alibaba_qwen_image" | "alibaba_qwen_image_edit",
  ctx: import("../queue.js").JobHandlerContext,
): Promise<{ success: true; requestId: string }> {
  const {
    prompt, imageInputs, imgAssetId, imgAssetDir, sourceImageIds,
    projectSlug, model, size, n, negativePrompt, promptExtend, watermark, seed,
  } = payload;

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY environment variable is not set");

  const uploadedUrls: string[] = [];
  for (const { assetId: srcAssetId, filename } of imageInputs) {
    uploadedUrls.push(await uploadAssetToAlibaba(fs, srcAssetId, filename, projectSlug, model));
  }

  const provider = alibaba({ apiKey, timeout: 120_000 });

  const request = buildAlibabaQwenImagePayload(
    {
      prompt, model, size, n,
      negative_prompt: negativePrompt,
      prompt_extend: promptExtend,
      watermark, seed,
    },
    uploadedUrls,
  );
  await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);

  const response = await provider.post.api.v1.services.aigc.multimodalGeneration.generation(request);

  const resultUrls: string[] = [];
  for (const choice of response.output.choices) {
    for (const part of choice.message.content) {
      if (part.image) resultUrls.push(part.image);
    }
  }
  if (resultUrls.length === 0) throw new Error("Alibaba Qwen response contained no image URLs");

  // Hand off to the downstream completion job: write a pending_tasks row so
  // complete_kie_task can claim the lease via getOwner+setLease, then mark
  // completing so a duplicate dispatch is skipped.
  const ptResult = await fs.pendingTasks.write(projectSlug, {
    taskId: response.request_id,
    taskType,
    assetId: imgAssetId,
    assetDir: imgAssetDir,
    meta: { sourceImageIds, prompt, model },
  }, ctx.getOwnerId());
  if (!ptResult.ok) {
    throw new Error(`Failed to write pending-task for ${imgAssetId}: ${ptResult.error.message}`);
  }
  ctx.setLease({ kind: "task", taskId: response.request_id });
  await fs.pendingTasks.markCompleting(projectSlug, imgAssetId);

  const jobId = `complete-alibaba-qwen-${imgAssetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: "complete_kie_task",
    taskId: response.request_id,
    taskType,
    assetId: imgAssetId,
    assetDir: imgAssetDir,
    projectSlug,
    meta: {
      sourceImageIds,
      prompt,
      model,
      ...(size !== undefined ? { size } : {}),
      ...(n !== undefined ? { n } : {}),
      ...(negativePrompt !== undefined ? { negativePrompt } : {}),
      ...(promptExtend !== undefined ? { promptExtend } : {}),
      ...(watermark !== undefined ? { watermark } : {}),
      ...(seed !== undefined ? { seed } : {}),
    },
    resultUrls,
  } as unknown as Record<string, unknown>);

  return { success: true, requestId: response.request_id };
}

export function registerGenerateAlibabaQwenImageJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_alibaba_qwen_image", async (payload, ctx) => {
    return runQwenImageJob(fs, payload as GenerateAlibabaQwenImagePayload, "alibaba_qwen_image", ctx);
  });
}

export function registerGenerateAlibabaQwenImageEditJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_alibaba_qwen_image_edit", async (payload, ctx) => {
    return runQwenImageJob(fs, payload as GenerateAlibabaQwenImagePayload, "alibaba_qwen_image_edit", ctx);
  });
}
