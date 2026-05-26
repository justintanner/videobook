import type { ClipfirstFs } from "vc-engine";
import type {
  ElevenLabsSpeechToTextRequest,
  ElevenLabsSpeechToTextResponse,
} from "@apicity/elevenlabs";
import { elevenlabs } from "@apicity/elevenlabs";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { withLocalLease } from "./_lease.js";

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

const ELEVENLABS_TIMEOUT_MS = 5 * 60_000;

function inferAudioMime(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    case "ogg":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "mp4":
    case "mov":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}

export function registerTranscribeJob(fs: ClipfirstFs): void {
  registerJobHandler("transcribe", async (payload, ctx) => {
    const {
      audioFilename,
      tagAudioEvents,
      diarize,
      languageCode,
      assetId,
      projectSlug,
    } = payload as TranscribePayload;

    return withLocalLease(
      fs,
      projectSlug,
      assetId,
      ctx,
      "transcribe",
      async () => {
        const apiKey = requireApiKey("ELEVENLABS_API_KEY");

        const readResult = await fs.readFile(assetId, audioFilename, projectSlug);
        if (!readResult.ok) {
          throw new Error(`Failed to read audio for ${assetId}: ${readResult.error.message}`);
        }
        const audioBytes = new Uint8Array(readResult.value);
        const audioBlob = new Blob([audioBytes], { type: inferAudioMime(audioFilename) });

        const provider = elevenlabs({ apiKey, timeout: ELEVENLABS_TIMEOUT_MS });
        const request: ElevenLabsSpeechToTextRequest = {
          model_id: "scribe_v2",
          file: audioBlob,
          tag_audio_events: tagAudioEvents,
          diarize,
          ...(languageCode ? { language_code: languageCode } : {}),
        };
        const response: ElevenLabsSpeechToTextResponse = await provider.v1.speechToText(request);

        const transcriptionStr = JSON.stringify(response, null, 2);
        const writeResult = await fs.writeFile(
          assetId,
          "elevenlabs.json",
          transcriptionStr,
          projectSlug,
        );
        if (!writeResult.ok) {
          throw new Error(`Failed to write transcription: ${writeResult.error.message}`);
        }

        await fs.commitOperation(
          "transcribe",
          assetId,
          {
            ...(languageCode ? { language_code: languageCode } : {}),
          },
          projectSlug,
        );

        return { success: true, provider: "elevenlabs" as const };
      },
    );
  });
}
