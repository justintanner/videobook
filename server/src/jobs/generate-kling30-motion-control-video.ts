import type { Engine } from "videobook-engine";
import type { KlingMotionControlRequest, MediaGenerationRequest } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildKling30MotionControlPayload } from "../payload-builders.js";

type RefInput = { assetId: string; filename: string };

// Nominal per-second basis used only when the motion video predates the
// `original` duration metadata. Forwarded to the paygate as a cost hint only;
// never serialized into the wire payload.
const FALLBACK_MOTION_CONTROL_DURATION_SECONDS = 5;

type GenerateKling30MotionControlPayload = {
  type: "generate_kling30_motion_control_video";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  imageInputs: RefInput[];
  videoInputs: RefInput[];
  sourceImageIds: string[];
  sourceVideoIds: string[];
  prompt?: string;
  mode?: KlingMotionControlRequest["input"]["mode"];
  character_orientation?: KlingMotionControlRequest["input"]["character_orientation"];
  background_source?: KlingMotionControlRequest["input"]["background_source"];
};

async function uploadInputs(fs: Engine, inputs: RefInput[], bookId: string): Promise<string[]> {
  const urls: string[] = [];
  for (const { assetId, filename } of inputs) {
    urls.push(await uploadAssetToKie(fs, assetId, filename, bookId));
  }
  return urls;
}

export function registerGenerateKling30MotionControlVideoJob(fs: Engine): void {
  registerJobHandler("generate_kling30_motion_control_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, bookId,
      imageInputs, videoInputs, sourceImageIds, sourceVideoIds,
      prompt, mode, character_orientation, background_source,
    } = payload as GenerateKling30MotionControlPayload;

    requireApiKey("KIE_API_KEY");

    const inputUrls = await uploadInputs(fs, imageInputs, bookId);
    const videoUrls = await uploadInputs(fs, videoInputs, bookId);

    // kling-3.0/motion-control has no `duration` field in its kie input schema
    // — the output length matches the input motion video. Surface the first
    // motion video's measured duration as an out-of-band cost hint (falling
    // back to a nominal duration when the motion video predates `original`
    // duration metadata). The hint feeds computeEstimate only; the wire
    // payload carries only documented fields. tools/estimate-cost.ts enriches
    // the same way for the UI preview.
    const request: MediaGenerationRequest = buildKling30MotionControlPayload(
      { prompt, mode, character_orientation, background_source },
      inputUrls,
      videoUrls,
    );

    const motionVideo = videoInputs[0];
    const motionMeta = await fs.metadata.artifacts.read<{ duration?: number }>(motionVideo.assetId, "original"
    );
    const durationHint =
      motionMeta.ok && typeof motionMeta.value?.duration === "number" && motionMeta.value.duration > 0
        ? motionMeta.value.duration
        : FALLBACK_MOTION_CONTROL_DURATION_SECONDS;

    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "kling30_motion_control_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
      meta: {
        ...(prompt !== undefined ? { prompt } : {}),
        ...(mode !== undefined ? { mode } : {}),
        sourceImageIds,
        sourceVideoIds,
      },
      costHints: { duration: durationHint },
    });

    return { success: true, taskId };
  });
}
