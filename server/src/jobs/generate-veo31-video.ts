import type { VideocityFs } from "videobook-engine";
import type { GoogleFlowProvider } from "@apicity/googleflow";
import { registerJobHandler } from "../queue.js";
import { buildVeo31VideoPayload, type GoogleVeo31Model, type Veo31VideoArgs } from "../payload-builders.js";
import { createGoogleFlowProvider, submitGoogleFlowVideoTask, uploadAssetToGoogleFlow } from "./_google-flow.js";
import type { RefInput } from "../tools/_seedance2-shared.js";

type GenerateVeo31VideoPayload = {
  type: "generate_veo31_video";
  veoModel: GoogleVeo31Model;
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  firstFrame?: RefInput;
  lastFrame?: RefInput;
  imageInputs: RefInput[];
  sourceImageIds: string[];
  prompt: string;
  aspect_ratio?: Veo31VideoArgs["aspect_ratio"];
  duration?: Veo31VideoArgs["duration"];
  seed?: number;
};

async function uploadRef(provider: GoogleFlowProvider, fs: VideocityFs, input: RefInput, projectSlug: string): Promise<string> {
  return uploadAssetToGoogleFlow(provider, fs, input.assetId, input.filename, projectSlug);
}

export function registerGenerateVeo31VideoJob(fs: VideocityFs): void {
  registerJobHandler("generate_veo31_video", async (payload, ctx) => {
    const p = payload as GenerateVeo31VideoPayload;
    const provider = createGoogleFlowProvider();

    const startImageId = p.firstFrame ? await uploadRef(provider, fs, p.firstFrame, p.projectSlug) : undefined;
    const endImageId = p.lastFrame ? await uploadRef(provider, fs, p.lastFrame, p.projectSlug) : undefined;
    const referenceImageIds: string[] = [];
    for (const input of p.imageInputs) {
      referenceImageIds.push(await uploadRef(provider, fs, input, p.projectSlug));
    }

    const request = buildVeo31VideoPayload(
      p.veoModel,
      {
        prompt: p.prompt,
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
      projectSlug: p.projectSlug,
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
