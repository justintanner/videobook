import type { VideocityFs } from "videocity-engine";
import type { KlingMotionControlRequest, MediaGenerationRequest } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildKling30MotionControlPayload } from "../payload-builders.js";

type RefInput = { assetId: string; filename: string };

// Nominal per-second basis used only when the motion video predates the
// `original` duration metadata. The paygate bounds cost off this hint; it is
// never billed against (createTask ignores unknown top-level fields).
const FALLBACK_MOTION_CONTROL_DURATION_SECONDS = 5;

type GenerateKling30MotionControlPayload = {
  type: "generate_kling30_motion_control_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  imageInputs: RefInput[];
  videoInputs: RefInput[];
  sourceImageIds: string[];
  sourceVideoIds: string[];
  prompt?: string;
  mode?: KlingMotionControlRequest["input"]["mode"];
  character_orientation?: KlingMotionControlRequest["input"]["character_orientation"];
  background_source?: KlingMotionControlRequest["input"]["background_source"];
};

async function uploadInputs(fs: VideocityFs, inputs: RefInput[], projectSlug: string): Promise<string[]> {
  const urls: string[] = [];
  for (const { assetId, filename } of inputs) {
    urls.push(await uploadAssetToKie(fs, assetId, filename, projectSlug));
  }
  return urls;
}

export function registerGenerateKling30MotionControlVideoJob(fs: VideocityFs): void {
  registerJobHandler("generate_kling30_motion_control_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug,
      imageInputs, videoInputs, sourceImageIds, sourceVideoIds,
      prompt, mode, character_orientation, background_source,
    } = payload as GenerateKling30MotionControlPayload;

    requireApiKey("KIE_API_KEY");

    const inputUrls = await uploadInputs(fs, imageInputs, projectSlug);
    const videoUrls = await uploadInputs(fs, videoInputs, projectSlug);

    const baseRequest = buildKling30MotionControlPayload(
      { prompt, mode, character_orientation, background_source },
      inputUrls,
      videoUrls,
    );

    // kling-3.0/motion-control has no `duration` field in its kie input schema —
    // the output length matches the input motion video. The cost estimator (and
    // the paygate OTP minted from this request) keys the per-second rate off
    // duration, so without one computeEstimate rejects the request as unbounded
    // and submission fails. Surface the first motion video's measured duration
    // as a top-level hint (mirrors happyhorse/video-edit; kie's createTask
    // ignores unknown top-level fields), falling back to a nominal duration when
    // the motion video predates `original` duration metadata. The cost preview
    // already enriches the same way in tools/estimate-cost.ts.
    const motionVideo = videoInputs[0];
    const motionMeta = await fs.readMetadata<{ duration?: number }>(
      motionVideo.assetId, "original", projectSlug,
    );
    const durationHint =
      motionMeta.ok && typeof motionMeta.value?.duration === "number" && motionMeta.value.duration > 0
        ? motionMeta.value.duration
        : FALLBACK_MOTION_CONTROL_DURATION_SECONDS;
    const request: MediaGenerationRequest & { duration: number } = { ...baseRequest, duration: durationHint };

    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "kling30_motion_control_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      meta: {
        ...(prompt !== undefined ? { prompt } : {}),
        ...(mode !== undefined ? { mode } : {}),
        sourceImageIds,
        sourceVideoIds,
      },
    });

    return { success: true, taskId };
  });
}
