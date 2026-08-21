import type { Engine } from "videobook-engine";
import type { MediaGenerationRequest } from "@apicity/kie";
import {
  KlingOmniImageToVideoRequestSchema,
  KlingOmniReferenceToVideoRequestSchema,
  KlingOmniTextToVideoRequestSchema,
  KlingOmniTransformationRequestSchema,
} from "@apicity/kie/zod";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildKlingOmniVideoPayload } from "../payload-builders.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";
import {
  KLING_OMNI_API_MODELS,
  KLING_OMNI_JOB_TYPE,
  KLING_OMNI_MODE_TOOLS,
  KLING_OMNI_TASK_TYPE,
  type KlingOmniMode,
} from "../kling-omni.js";

type RefInput = { assetId: string; filename: string };

type GenerateKlingOmniVideoPayload = {
  type: typeof KLING_OMNI_JOB_TYPE;
  mode: KlingOmniMode;
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt: string;
  imageInputs: RefInput[];
  videoInputs: RefInput[];
  sourceImageIds: string[];
  sourceVideoIds: string[];
  audio?: boolean;
  resolution?: "720p" | "1080p" | "4k";
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "auto";
  duration?: number | string;
  customize_multi_shots?: boolean;
  prefer_multi_shots?: boolean;
  multi_prompt?: Array<{ prompt: string; duration: number }>;
};

async function uploadAll(engine: Engine, inputs: RefInput[]): Promise<string[]> {
  const urls: string[] = [];
  for (const { assetId, filename } of inputs) {
    urls.push(await uploadAssetToKie(engine, assetId, filename));
  }
  return urls;
}

export function registerGenerateKlingOmniVideoJob(engine: Engine): void {
  registerJobHandler(KLING_OMNI_JOB_TYPE, async (payload, ctx) => {
    const {
      mode, vidAssetId, vidAssetDir, bookId, prompt,
      imageInputs, videoInputs, sourceImageIds, sourceVideoIds,
      audio, resolution, aspect_ratio, duration,
      customize_multi_shots, prefer_multi_shots, multi_prompt,
    } = payload as unknown as GenerateKlingOmniVideoPayload;

    requireApiKey("KIE_API_KEY");

    const imageUrls = await uploadAll(engine, imageInputs);
    const videoUrls = await uploadAll(engine, videoInputs);
    const toolName = KLING_OMNI_MODE_TOOLS[mode];
    const normalizedPrompt = transformProviderPrompt(toolName, {
      prompt,
      image_refs: imageInputs.map((input) => input.assetId),
      video_refs: videoInputs.map((input) => input.assetId),
    });
    const built = buildKlingOmniVideoPayload(
      mode,
      {
        prompt: normalizedPrompt ?? prompt,
        audio,
        resolution,
        aspect_ratio,
        duration,
        customize_multi_shots,
        prefer_multi_shots,
        multi_prompt,
      },
      { imageUrls, videoUrls },
    );
    const parsed = mode === "text"
      ? KlingOmniTextToVideoRequestSchema.parse(built)
      : mode === "image"
        ? KlingOmniImageToVideoRequestSchema.parse(built)
        : mode === "reference"
          ? KlingOmniReferenceToVideoRequestSchema.parse(built)
          : KlingOmniTransformationRequestSchema.parse(built);

    const taskId = await submitKieTask(engine, ctx, {
      request: parsed as MediaGenerationRequest,
      taskType: KLING_OMNI_TASK_TYPE,
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
      meta: {
        apiModel: KLING_OMNI_API_MODELS[mode],
        mode,
        sourceImageIds,
        sourceVideoIds,
        prompt,
        ...(audio !== undefined ? { audio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(duration !== undefined ? { duration } : {}),
      },
    });

    return { success: true, taskId };
  });
}
