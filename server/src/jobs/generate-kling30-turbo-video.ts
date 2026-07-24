import type { Engine } from "videobook-engine";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildKlingV3TurboVideoPayload } from "../payload-builders.js";
import type {
  KlingV3TurboAspectRatio,
  KlingV3TurboDuration,
  KlingV3TurboImageToVideoRequest,
  KlingV3TurboResolution,
  KlingV3TurboTextToVideoDuration,
  KlingV3TurboTextToVideoRequest,
} from "@apicity/kie";

type RefInput = { assetId: string; filename: string };

type GenerateKling30TurboVideoPayload = {
  type: "generate_kling30_turbo_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  imageInputs: RefInput[];
  sourceImageIds: string[];
  prompt: string;
  model: KlingV3TurboImageToVideoRequest["model"] | KlingV3TurboTextToVideoRequest["model"];
  duration?: KlingV3TurboDuration | KlingV3TurboTextToVideoDuration;
  resolution?: KlingV3TurboResolution;
  aspect_ratio?: KlingV3TurboAspectRatio;
};

async function uploadAll(fs: Engine, inputs: RefInput[], projectSlug: string): Promise<string[]> {
  const urls: string[] = [];
  for (const { assetId, filename } of inputs) {
    urls.push(await uploadAssetToKie(fs, assetId, filename, projectSlug));
  }
  return urls;
}

export function registerGenerateKling30TurboVideoJob(fs: Engine): void {
  registerJobHandler("generate_kling30_turbo_video", async (payload, ctx) => {
    const {
      vidAssetId,
      vidAssetDir,
      projectSlug,
      imageInputs,
      sourceImageIds,
      prompt,
      model,
      duration,
      resolution,
      aspect_ratio,
    } = payload as unknown as GenerateKling30TurboVideoPayload;

    requireApiKey("KIE_API_KEY");

    const imageUrls = await uploadAll(fs, imageInputs, projectSlug);

    const request = buildKlingV3TurboVideoPayload(
      {
        prompt,
        ...(duration !== undefined ? { duration } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
      },
      imageUrls,
    );

    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "kling30_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      meta: {
        apiModel: model,
        sourceImageIds,
        ...(prompt !== undefined ? { prompt } : {}),
      },
    });

    return { success: true, taskId };
  });
}
