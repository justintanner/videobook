import type { TaskType, VideocityFs } from "videobook-engine";
import type { VolcengineVideoToVideoLipSyncMode } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildVolcengineLipSyncPayload } from "../payload-builders.js";

// Forward-compat bridge: videobook-engine@0.4.1 (latest) ships a closed
// TaskType union with no Volcengine entry, so the persisted task type is
// asserted here. The string flows through pendingTasks.write → the kie poller
// → complete_kie_task untouched, where the local union recognizes it. Drop the
// assertion once videobook-engine adds "volcengine_lipsync_video".
const VOLCENGINE_LIPSYNC_TASK_TYPE = "volcengine_lipsync_video" as TaskType;

type RefInput = { assetId: string; filename: string };

type GenerateVolcengineLipsyncVideoPayload = {
  type: "generate_volcengine_lipsync_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  videoInput: RefInput;
  audioInput: RefInput;
  sourceVideoIds: string[];
  sourceAudioIds: string[];
  mode: VolcengineVideoToVideoLipSyncMode;
  separate_vocal?: boolean;
  open_scenedet?: boolean;
  align_audio?: boolean;
  align_audio_reverse?: boolean;
  templ_start_seconds?: number;
};

async function uploadSingle(
  fs: VideocityFs,
  input: RefInput,
  projectSlug: string,
): Promise<string> {
  return uploadAssetToKie(fs, input.assetId, input.filename, projectSlug);
}

export function registerGenerateVolcengineLipsyncVideoJob(fs: VideocityFs): void {
  registerJobHandler("generate_volcengine_lipsync_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug,
      videoInput, audioInput, sourceVideoIds, sourceAudioIds,
      mode, separate_vocal, open_scenedet, align_audio, align_audio_reverse, templ_start_seconds,
    } = payload as GenerateVolcengineLipsyncVideoPayload;

    requireApiKey("KIE_API_KEY");

    const videoUrl = await uploadSingle(fs, videoInput, projectSlug);
    const audioUrl = await uploadSingle(fs, audioInput, projectSlug);

    const request = buildVolcengineLipSyncPayload(
      { mode, separate_vocal, open_scenedet, align_audio, align_audio_reverse, templ_start_seconds },
      { videoUrl, audioUrl },
    );

    // volcengine lip-sync bills per second of source video; schema has no duration.
    const videoMeta = await fs.readMetadata<{ duration?: number }>(
      videoInput.assetId, "original", projectSlug,
    );
    const durationHint =
      videoMeta.ok && typeof videoMeta.value?.duration === "number" && videoMeta.value.duration > 0
        ? videoMeta.value.duration
        : 5;

    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: VOLCENGINE_LIPSYNC_TASK_TYPE,
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      meta: {
        mode: "lipsync",
        sourceImageIds: [],
        sourceVideoIds,
        sourceAudioIds,
      },
      costHints: { duration: durationHint },
    });

    return { success: true, taskId };
  });
}
