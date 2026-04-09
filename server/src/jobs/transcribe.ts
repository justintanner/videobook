import type { ClipfirstFs } from "clipfirst-fs";
import { kie, submitMediaJob } from "@nakedapi/kie";
import { uploadAssetFile } from "../kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";

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

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const downloadUrl = await uploadAssetFile(provider, fs, assetId, audioFilename, projectSlug);

    const request = {
      model: "elevenlabs/speech-to-text" as const,
      input: {
        audio_url: downloadUrl,
        tag_audio_events: tagAudioEvents,
        diarize,
        ...(languageCode ? { language_code: languageCode } : {}),
      },
    };
    const taskId = await submitMediaJob(provider, request);

    await writePendingTask(fs, assetId, projectSlug, {
      taskId,
      taskType: "transcribe",
      assetId,
      assetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        ...(languageCode ? { languageCode } : {}),
        ...(autoRender ? { autoRender } : {}),
      },
    });

    return { success: true, taskId };
  });
}
