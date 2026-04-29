import type { ClipfirstFs } from "clipfirst-engine";
import { uploadAssetFile } from "../upload.js";
import { registerJobHandler } from "../queue.js";
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

    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType,
        assetId,
        assetDir,
        meta: {
          ...(languageCode ? { languageCode } : {}),
          ...(autoRender ? { autoRender } : {}),
          ...(endpointId ? { falEndpointId: endpointId } : {}),
        },
    });
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${assetId}: ${_ptResult.error.message}`);
    }

    return { success: true, taskId, provider };
  });
}
