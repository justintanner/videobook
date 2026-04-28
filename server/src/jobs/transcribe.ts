import type { ClipfirstFs } from "clipfirst-fs";
import { uploadAssetFile } from "../upload.js";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
import { submitTranscribe } from "./transcribe-submit.js";

type TranscribePayload = {
  type: "transcribe";
  audioPath: string;
  audioFilename: string;
  tagAudioEvents: boolean;
  diarize: boolean;
  languageCode?: string;
  assetId: string;
  assetDir: string;
  projectSlug: string;
  autoRender?: boolean;
};

export function registerTranscribeJob(fs: ClipfirstFs): void {
  registerJobHandler("transcribe", async (payload) => {
    const {
      audioFilename, tagAudioEvents, diarize,
      languageCode, assetId, assetDir, projectSlug, autoRender,
    } = payload as TranscribePayload;

    const downloadUrl = await uploadAssetFile(fs, assetId, audioFilename, projectSlug);

    const { provider, taskId, taskType, endpointId } = await submitTranscribe({
      audioUrl: downloadUrl,
      tagAudioEvents,
      diarize,
      ...(languageCode ? { languageCode } : {}),
    });

    await writePendingTask(fs, assetId, projectSlug, {
      taskId,
      taskType,
      assetId,
      assetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        ...(languageCode ? { languageCode } : {}),
        ...(autoRender ? { autoRender } : {}),
        ...(endpointId ? { falEndpointId: endpointId } : {}),
      },
    });

    return { success: true, taskId, provider };
  });
}
