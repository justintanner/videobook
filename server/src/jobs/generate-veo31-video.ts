import type { Engine } from "videobook-engine";
import type { GoogleFlowProvider } from "@apicity/googleflow";
import { registerJobHandler } from "../queue.js";
import { buildVeo31VideoPayload, type GoogleVeo31Model, type Veo31VideoArgs } from "../payload-builders.js";
import { createGoogleFlowProvider, submitGoogleFlowVideoTask, uploadAssetToGoogleFlow } from "./_google-flow.js";
import type { RefInput } from "../tools/_seedance2-shared.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";

type GenerateVeo31VideoPayload = {
  type: "generate_veo31_video";
  veoModel: GoogleVeo31Model;
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  firstFrame?: RefInput;
  lastFrame?: RefInput;
  imageInputs: RefInput[];
  sourceImageIds: string[];
  prompt: string;
  aspect_ratio?: Veo31VideoArgs["aspect_ratio"];
  duration?: Veo31VideoArgs["duration"];
  seed?: number;
};

async function uploadRef(provider: GoogleFlowProvider, fs: Engine, input: RefInput): Promise<string> {
  return uploadAssetToGoogleFlow(provider, fs, input.assetId, input.filename);
}

export function registerGenerateVeo31VideoJob(fs: Engine): void {
  registerJobHandler("generate_veo31_video", async (payload, ctx) => {
    const p = payload as GenerateVeo31VideoPayload;
    const provider = createGoogleFlowProvider();

    const startImageId = p.firstFrame ? await uploadRef(provider, fs, p.firstFrame) : undefined;
    const endImageId = p.lastFrame ? await uploadRef(provider, fs, p.lastFrame) : undefined;
    const referenceImageIds: string[] = [];
    for (const input of p.imageInputs) {
      referenceImageIds.push(await uploadRef(provider, fs, input));
    }
    const toolName = p.veoModel === "veo-3.1-quality"
      ? "generate_google_flow_veo_3_1_quality_video"
      : p.veoModel === "veo-3.1-fast"
        ? "generate_google_flow_veo_3_1_fast_video"
        : p.veoModel === "veo-3.1-lite-low-priority"
          ? "generate_google_flow_veo_3_1_lite_low_priority_video"
          : "generate_google_flow_veo_3_1_lite_video";
    const normalizedPrompt = transformProviderPrompt(toolName, {
      prompt: p.prompt,
      image_refs: p.imageInputs.map((input) => input.assetId),
      first_frame_ref: p.firstFrame?.assetId,
      last_frame_ref: p.lastFrame?.assetId,
    }) ?? "";

    const request = buildVeo31VideoPayload(
      p.veoModel,
      {
        prompt: normalizedPrompt,
        ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
        ...(p.duration !== undefined ? { duration: p.duration } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
      },
      {
        ...(startImageId !== undefined ? { startImageId } : {}),
        ...(endImageId !== undefined ? { endImageId } : {}),
        ...(referenceImageIds.length > 0 ? { referenceImageIds } : {}),
      },
    );

    const taskId = await submitGoogleFlowVideoTask(fs, ctx, {
      request,
      assetId: p.vidAssetId,
      assetDir: p.vidAssetDir,
      bookId: p.bookId,
      // The engine's TaskType union has no google literal; ride the shared
      // single-mp4 completion like veo3/gemini-omni do, with the real model
      // in meta.apiModel for provenance.
      taskType: "seedance2_video",
      meta: {
        apiModel: p.veoModel,
        sourceImageIds: p.sourceImageIds,
        prompt: p.prompt,
      },
    });

    return { success: true, taskId };
  });
}
