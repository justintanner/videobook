import type { Engine } from "videobook-engine";
import { findAudioFile } from "videobook-engine";
import type {
  ElevenLabsSpeechToTextRequest,
  ElevenLabsSpeechToTextResponse,
} from "@apicity/elevenlabs";
import { createElevenLabs } from "@apicity/elevenlabs";
import { requireApiKey } from "../api-key.js";

const ELEVENLABS_TIMEOUT_MS = 5 * 60_000;

export type TranscribeOptions = {
  tagAudioEvents: boolean;
  diarize: boolean;
  languageCode?: string;
};

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

/**
 * Transcribe an asset's audio with ElevenLabs scribe_v2 and write the result
 * to `elevenlabs.json` in the asset directory. Lease-agnostic: the caller owns
 * the asset lease (the transcribe job's local lease, or the render job's render
 * lease when auto-transcribing). Throws on missing API key, unreadable audio,
 * or a failed write so the caller can surface the failure.
 */
export async function transcribeAssetToElevenLabsJson(
  fs: Engine,
  bookId: string,
  assetId: string,
  audioFilename: string,
  options: TranscribeOptions,
): Promise<void> {
  const response = await requestElevenLabsTranscript(
    fs,
    bookId,
    assetId,
    audioFilename,
    options,
  );
  await writeElevenLabsTranscript(fs, bookId, assetId, response, options);
}

export async function requestElevenLabsTranscript(
  fs: Engine,
  bookId: string,
  assetId: string,
  audioFilename: string,
  options: TranscribeOptions,
): Promise<ElevenLabsSpeechToTextResponse> {
  const apiKey = requireApiKey("ELEVENLABS_API_KEY");

  const readResult = await fs.files.read(assetId, audioFilename);
  if (!readResult.ok) {
    throw new Error(`Failed to read audio for ${assetId}: ${readResult.error.message}`);
  }
  const audioBytes = new Uint8Array(readResult.value);
  const audioBlob = new Blob([audioBytes], { type: inferAudioMime(audioFilename) });

  const provider = createElevenLabs({ apiKey, timeout: ELEVENLABS_TIMEOUT_MS });
  const request: ElevenLabsSpeechToTextRequest = {
    model_id: "scribe_v2",
    file: audioBlob,
    tag_audio_events: options.tagAudioEvents,
    diarize: options.diarize,
    ...(options.languageCode ? { language_code: options.languageCode } : {}),
  };
  return provider.v1.speechToText(request);
}

export async function writeElevenLabsTranscript(
  fs: Engine,
  bookId: string,
  assetId: string,
  response: ElevenLabsSpeechToTextResponse,
  options: TranscribeOptions,
): Promise<void> {
  const transcriptionStr = JSON.stringify(response, null, 2);
  const writeResult = await fs.files.write(assetId, "elevenlabs.json", transcriptionStr
  );
  if (!writeResult.ok) {
    throw new Error(`Failed to write transcription: ${writeResult.error.message}`);
  }

  await fs.history.recordOperation("transcribe", assetId, {
      ...(options.languageCode ? { language_code: options.languageCode } : {}),
    }
  );
}

/**
 * Ensure an asset has ElevenLabs word-level timings (elevenlabs.json),
 * transcribing inline if it's missing. Idempotent — returns immediately when the
 * file already exists. Lease-agnostic: the caller owns the asset lease (a render
 * job's render lease, a plan job's analyze lease). Throws on missing audio, a
 * missing API key, or an API/write failure so the caller surfaces the cause.
 */
export async function ensureElevenLabsTranscript(
  fs: Engine,
  bookId: string,
  assetId: string,
): Promise<void> {
  if ((await fs.files.read(assetId, "elevenlabs.json")).ok) return;
  const manifest = await fs.files.manifest(assetId);
  if (!manifest.ok) throw new Error(`auto-transcribe failed: ${manifest.error.message}`);
  const audioFile = findAudioFile(manifest.value.files, assetId);
  if (!audioFile) throw new Error(`auto-transcribe failed: no audio file found in asset ${assetId}`);
  await transcribeAssetToElevenLabsJson(fs, bookId, assetId, audioFile.name, {
    tagAudioEvents: true,
    diarize: true,
  });
}
