import type { TaskType, VideocityFs } from "videobook-engine";
import type { Omnihuman15OutputResolution } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildOmnihumanPayload } from "../payload-builders.js";

// Forward-compat bridge: videobook-engine ships a closed TaskType union with no
// OmniHuman entry, so the persisted task type is asserted here. The string flows
// through pendingTasks.write → the kie poller → complete_kie_task untouched,
// where the local union recognizes it. Drop the assertion once videobook-engine
// adds "omnihuman_video" (mirrors generate-volcengine-lipsync-video.ts).
const OMNIHUMAN_TASK_TYPE = "omnihuman_video" as TaskType;

type RefInput = { assetId: string; filename: string };

type GenerateOmnihumanVideoPayload = {
  type: "generate_omnihuman_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  imageInput: RefInput;
  audioInput: RefInput;
  sourceImageIds: string[];
  sourceAudioIds: string[];
  prompt?: string;
  output_resolution?: Omnihuman15OutputResolution;
  pe_fast_mode?: boolean;
  seed?: number;
};

export function registerGenerateOmnihumanVideoJob(fs: VideocityFs): void {
  registerJobHandler("generate_omnihuman_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug,
      imageInput, audioInput, sourceImageIds, sourceAudioIds,
      prompt, output_resolution, pe_fast_mode, seed,
    } = payload as GenerateOmnihumanVideoPayload;

    requireApiKey("KIE_API_KEY");

    const imageUrl = await uploadAssetToKie(fs, imageInput.assetId, imageInput.filename, projectSlug);
    const audioUrl = await uploadAssetToKie(fs, audioInput.assetId, audioInput.filename, projectSlug);

    const request = buildOmnihumanPayload(
      { prompt, output_resolution, pe_fast_mode, seed },
      { imageUrl, audioUrl },
    );

    // omnihuman-1-5 bills per second of driving audio; schema has no duration.
    // Pass measured audio length as a cost-only hint (see KieCostHints).
    const audioMeta = await fs.readMetadata<{ duration?: number }>(
      audioInput.assetId, "original", projectSlug,
    );
    const durationHint =
      audioMeta.ok && typeof audioMeta.value?.duration === "number" && audioMeta.value.duration > 0
        ? audioMeta.value.duration
        : 5;

    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: OMNIHUMAN_TASK_TYPE,
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      meta: {
        mode: "omnihuman",
        sourceImageIds,
        sourceVideoIds: [],
        sourceAudioIds,
        ...(prompt !== undefined ? { prompt } : {}),
      },
      costHints: { duration: durationHint },
    });

    return { success: true, taskId };
  });
}
