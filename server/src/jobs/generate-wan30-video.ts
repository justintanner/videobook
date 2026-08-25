import type { Engine } from "videobook-engine";
import type { MediaGenerationRequest } from "@apicity/kie";
import {
  Wan30VideoPrimeRequestSchema,
  Wan30VideoRequestSchema,
} from "@apicity/kie/zod";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildWan30VideoPayload } from "../payload-builders.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";

type RefInput = { assetId: string; filename: string };

type GenerateWan30VideoPayload = {
  type: "generate_wan30_video" | "generate_wan30_prime_video";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt?: string;
  firstFrame?: RefInput;
  lastFrame?: RefInput;
  imageInputs: RefInput[];
  videoInputs: RefInput[];
  audioInputs: RefInput[];
  sourceImageIds: string[];
  sourceVideoIds: string[];
  sourceAudioIds: string[];
  resolution?: "480P" | "720P" | "1080P";
  aspect_ratio?: "adaptive" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
  duration?: string;
  audio?: boolean;
  seed?: number;
  nsfw_checker?: boolean;
};

type Wan30Tier = {
  apiModel: "wan/3-0-video" | "wan/3-0-video-prime";
  jobType: GenerateWan30VideoPayload["type"];
  taskType: "wan30_video" | "wan30_prime_video";
  toolName: "generate_kie_wan_3_0_video" | "generate_kie_wan_3_0_prime_video";
  requestSchema: typeof Wan30VideoRequestSchema | typeof Wan30VideoPrimeRequestSchema;
};

const STANDARD_TIER: Wan30Tier = {
  apiModel: "wan/3-0-video",
  jobType: "generate_wan30_video",
  taskType: "wan30_video",
  toolName: "generate_kie_wan_3_0_video",
  requestSchema: Wan30VideoRequestSchema,
};

const PRIME_TIER: Wan30Tier = {
  apiModel: "wan/3-0-video-prime",
  jobType: "generate_wan30_prime_video",
  taskType: "wan30_prime_video",
  toolName: "generate_kie_wan_3_0_prime_video",
  requestSchema: Wan30VideoPrimeRequestSchema,
};

async function uploadAll(engine: Engine, inputs: RefInput[]): Promise<string[]> {
  const urls: string[] = [];
  for (const { assetId, filename } of inputs) {
    urls.push(await uploadAssetToKie(engine, assetId, filename));
  }
  return urls;
}

function registerTierJob(engine: Engine, tier: Wan30Tier): void {
  registerJobHandler(tier.jobType, async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, bookId, prompt,
      firstFrame, lastFrame,
      imageInputs, videoInputs, audioInputs,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      resolution, aspect_ratio, duration, audio, seed, nsfw_checker,
    } = payload as unknown as GenerateWan30VideoPayload;

    requireApiKey("KIE_API_KEY");

    const firstFrameUrl = firstFrame
      ? await uploadAssetToKie(engine, firstFrame.assetId, firstFrame.filename)
      : undefined;
    const lastFrameUrl = lastFrame
      ? await uploadAssetToKie(engine, lastFrame.assetId, lastFrame.filename)
      : undefined;
    const referenceImageUrls = await uploadAll(engine, imageInputs);
    const referenceVideoUrls = await uploadAll(engine, videoInputs);
    const referenceAudioUrls = await uploadAll(engine, audioInputs);
    const normalizedPrompt = prompt === undefined
      ? undefined
      : transformProviderPrompt(tier.toolName, {
        prompt,
        image_refs: imageInputs.map((input) => input.assetId),
        video_refs: videoInputs.map((input) => input.assetId),
        audio_refs: audioInputs.map((input) => input.assetId),
        first_frame_ref: firstFrame?.assetId,
        last_frame_ref: lastFrame?.assetId,
      });

    const built = buildWan30VideoPayload(
      tier.apiModel,
      {
        ...(normalizedPrompt !== undefined ? { prompt: normalizedPrompt } : {}),
        resolution,
        aspect_ratio,
        duration,
        audio,
        seed,
        nsfw_checker,
      },
      {
        ...(firstFrameUrl ? { firstFrameUrl } : {}),
        ...(lastFrameUrl ? { lastFrameUrl } : {}),
        ...(referenceImageUrls.length > 0 ? { referenceImageUrls } : {}),
        ...(referenceVideoUrls.length > 0 ? { referenceVideoUrls } : {}),
        ...(referenceAudioUrls.length > 0 ? { referenceAudioUrls } : {}),
      },
    );
    const parsed = tier.requestSchema.parse(built);

    const mode = firstFrame || lastFrame
      ? "frames"
      : imageInputs.length > 0 || videoInputs.length > 0 || audioInputs.length > 0
        ? "refs"
        : "text";
    const taskId = await submitKieTask(engine, ctx, {
      request: parsed as MediaGenerationRequest,
      taskType: tier.taskType,
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
      meta: {
        apiModel: tier.apiModel,
        mode,
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
        ...(prompt !== undefined ? { prompt } : {}),
      },
    });

    return { success: true, taskId };
  });
}

export function registerGenerateWan30VideoJob(engine: Engine): void {
  registerTierJob(engine, STANDARD_TIER);
}

export function registerGenerateWan30PrimeVideoJob(engine: Engine): void {
  registerTierJob(engine, PRIME_TIER);
}
