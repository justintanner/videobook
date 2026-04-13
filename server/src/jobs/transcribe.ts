import type { ClipfirstFs } from "clipfirst-fs";
import { kie } from "@apicity/kie";
import { uploadAssetFile } from "../kie-upload.js";
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

    const kieKey = process.env.KIE_API_KEY;
    if (!kieKey) throw new Error("KIE_API_KEY environment variable is not set");

    // Upload via KIE for the public audio URL (shared across both providers).
    const kieProvider = kie({ apiKey: kieKey, timeout: 60_000 });
    const downloadUrl = await uploadAssetFile(kieProvider, fs, assetId, audioFilename, projectSlug);

    const { provider, taskId, taskType, statusUrl, responseUrl } = await submitTranscribe({
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
        ...(statusUrl ? { falStatusUrl: statusUrl } : {}),
        ...(responseUrl ? { falResponseUrl: responseUrl } : {}),
      },
    });

    return { success: true, taskId, provider };
  });
}
