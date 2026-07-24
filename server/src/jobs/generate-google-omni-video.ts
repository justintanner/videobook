import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { buildGoogleOmniVideoPayload, type GoogleOmniVideoArgs } from "../payload-builders.js";
import { createGoogleFlowProvider, submitGoogleFlowVideoTask, uploadAssetToGoogleFlow } from "./_google-flow.js";
import type { RefInput } from "../tools/_seedance2-shared.js";

type GenerateGoogleOmniVideoPayload = {
  type: "generate_google_omni_video";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  firstFrame?: RefInput;
  imageInputs: RefInput[];
  videoInput?: RefInput;
  sourceImageIds: string[];
  sourceVideoIds: string[];
  prompt: string;
  duration?: GoogleOmniVideoArgs["duration"];
  aspect_ratio?: GoogleOmniVideoArgs["aspect_ratio"];
  seed?: number;
  video_clip_start?: number;
  video_clip_ends?: number;
  voice_refs?: string[];
  character_refs?: string[];
};

export function registerGenerateGoogleOmniVideoJob(fs: Engine): void {
  registerJobHandler("generate_google_omni_video", async (payload, ctx) => {
    const p = payload as GenerateGoogleOmniVideoPayload;
    const provider = createGoogleFlowProvider();

    const referenceImageIds: string[] = [];
    for (const input of p.imageInputs) {
      referenceImageIds.push(await uploadAssetToGoogleFlow(provider, fs, input.assetId, input.filename, p.bookId));
    }
    const startImageId = p.firstFrame
      ? await uploadAssetToGoogleFlow(provider, fs, p.firstFrame.assetId, p.firstFrame.filename, p.bookId)
      : undefined;
    const referenceVideoId = p.videoInput
      ? await uploadAssetToGoogleFlow(provider, fs, p.videoInput.assetId, p.videoInput.filename, p.bookId)
      : undefined;

    const request = buildGoogleOmniVideoPayload(
      {
        prompt: p.prompt,
        ...(p.duration !== undefined ? { duration: p.duration } : {}),
        ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
        ...(p.video_clip_start !== undefined ? { video_clip_start: p.video_clip_start } : {}),
        ...(p.video_clip_ends !== undefined ? { video_clip_ends: p.video_clip_ends } : {}),
      },
      {
        ...(startImageId !== undefined ? { startImageId } : {}),
        ...(referenceImageIds.length > 0 ? { referenceImageIds } : {}),
        ...(referenceVideoId !== undefined ? { referenceVideoId } : {}),
        // Voice/character refs are provider-side ids (from create_google_flow_*)
        // — no upload needed, pass them straight through.
        ...(p.voice_refs && p.voice_refs.length > 0 ? { voiceRefs: p.voice_refs } : {}),
        ...(p.character_refs && p.character_refs.length > 0 ? { characterRefs: p.character_refs } : {}),
      },
    );

    const taskId = await submitGoogleFlowVideoTask(fs, ctx, {
      request,
      assetId: p.vidAssetId,
      assetDir: p.vidAssetDir,
      bookId: p.bookId,
      // Rides the shared single-mp4 completion (see generate-veo31-video.ts).
      taskType: "seedance2_video",
      meta: {
        apiModel: "omni-flash",
        sourceImageIds: p.sourceImageIds,
        sourceVideoIds: p.sourceVideoIds,
        prompt: p.prompt,
      },
    });

    return { success: true, taskId };
  });
}
