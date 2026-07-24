import type { Engine } from "videobook-engine";
import type { VeoGenerateRequest, VeoModel } from "@apicity/kie";
import { submitVeoTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildVeo3VideoPayload } from "../payload-builders.js";

type RefInput = { assetId: string; filename: string };

type GenerateVeo3VideoPayload = {
  type: "generate_veo3_video";
  veoModel: VeoModel;
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  imageInputs: RefInput[];
  sourceImageIds: string[];
  prompt: string;
  aspect_ratio?: VeoGenerateRequest["aspectRatio"];
  seed?: number;
};

async function uploadAll(fs: Engine, inputs: RefInput[], bookId: string): Promise<string[]> {
  const urls: string[] = [];
  for (const { assetId, filename } of inputs) {
    urls.push(await uploadAssetToKie(fs, assetId, filename, bookId));
  }
  return urls;
}

export function registerGenerateVeo3VideoJob(fs: Engine): void {
  registerJobHandler("generate_veo3_video", async (payload, ctx) => {
    const {
      veoModel,
      vidAssetId, vidAssetDir, bookId,
      imageInputs, sourceImageIds,
      prompt, aspect_ratio, seed,
    } = payload as unknown as GenerateVeo3VideoPayload;

    requireApiKey("KIE_API_KEY");

    const imageUrls = await uploadAll(fs, imageInputs, bookId);

    const request = buildVeo3VideoPayload(
      veoModel,
      { prompt, ...(aspect_ratio !== undefined ? { aspect_ratio } : {}), ...(seed !== undefined ? { seed } : {}) },
      imageUrls.length > 0 ? { imageUrls } : {},
    );

    // Reuse the shared seedance2_video TaskType + completion handler — they
    // download resultUrls[0] as the video and key provenance off meta.apiModel.
    await submitVeoTask(fs, ctx, {
      request,
      taskType: "seedance2_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
      meta: {
        apiModel: veoModel,
        sourceImageIds,
        ...(prompt !== undefined ? { prompt } : {}),
      },
    });

    return { success: true };
  });
}
