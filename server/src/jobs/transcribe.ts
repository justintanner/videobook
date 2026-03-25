import type { ClipfirstFs } from "clipfirst-fs";
import { kie } from "@nakedapi/kie";
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

    const readResult = await fs.readFile(assetId, audioFilename, projectSlug);
    if (!readResult.ok) throw new Error(readResult.error.message);
    const blob = new Blob([new Uint8Array(readResult.value)]);

    const upload = await provider.api.fileStreamUpload({
      file: blob,
      filename: audioFilename,
    });
    const downloadUrl = upload.data!.downloadUrl;

    const taskResult = await provider.api.v1.jobs.createTask({
      model: "elevenlabs/speech-to-text",
      input: {
        audio_url: downloadUrl,
        tag_audio_events: tagAudioEvents,
        diarize,
        ...(languageCode ? { language_code: languageCode } : {}),
      },
    });

    const taskId = taskResult.data!.taskId;

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
