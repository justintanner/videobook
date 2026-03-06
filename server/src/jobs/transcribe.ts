import type { ClipfirstFs } from "clipfirst-fs";
import { readFile } from "node:fs/promises";
import { kie, type TaskResult } from "@nakedapi/kie";
import { registerJobHandler } from "../queue.js";

const LOCK_DURATION_MS = 300_000;

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
};

export function registerTranscribeJob(fs: ClipfirstFs): void {
  registerJobHandler("transcribe", async (payload) => {
    const {
      audioPath, audioFilename, tagAudioEvents, diarize,
      languageCode, assetId, assetDir, projectSlug,
    } = payload as TranscribePayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const lockResult = await fs.acquireLock(assetDir, { durationMs: LOCK_DURATION_MS });
    if (!lockResult.ok) throw new Error(`Asset is locked: ${lockResult.error.message}`);

    try {
      const provider = kie({ apiKey, timeout: 60_000 });

      const audioBuffer = await readFile(audioPath);
      const blob = new Blob([audioBuffer]);

      const { downloadUrl } = await provider.uploadMedia({
        file: blob,
        filename: audioFilename,
      });

      const result: TaskResult = await provider.generate({
        model: "elevenlabs/speech-to-text",
        input: {
          audio_url: downloadUrl,
          tag_audio_events: tagAudioEvents,
          diarize,
          ...(languageCode ? { language_code: languageCode } : {}),
        },
      }, { timeoutMs: 300_000 });

      if (result.status === "failed") {
        throw new Error(`Transcription failed: ${result.error ?? "unknown error"}`);
      }

      if (!result.resultObject) {
        throw new Error("No transcription data in API response");
      }

      const transcriptionStr = JSON.stringify(result.resultObject, null, 2);

      const writeResult = await fs.writeFile(assetId, "elevenlabs.json", transcriptionStr, projectSlug);
      if (!writeResult.ok) {
        throw new Error(`Failed to write transcription: ${writeResult.error.message}`);
      }

      await fs.commitOperation("transcribe", assetId, {
        ...(languageCode ? { language_code: languageCode } : {}),
      }, projectSlug);

      return { success: true };
    } finally {
      await fs.releaseLock(assetDir);
    }
  });
}
