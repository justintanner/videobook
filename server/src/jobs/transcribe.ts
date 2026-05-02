import type { ClipfirstFs } from "clipfirst-engine";
import type {
  ElevenLabsSpeechToTextRequest,
  ElevenLabsSpeechToTextResponse,
} from "@apicity/elevenlabs";
import { elevenlabs } from "@apicity/elevenlabs";
import { findVideoFile } from "clipfirst-engine";
import { join } from "node:path";
import { queue, registerJobHandler } from "../queue.js";
import { withLocalLease } from "./_lease.js";
import {
  readStoredRenderDefaults,
  readAnalysisRecommendations,
} from "../tools/sync.js";

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
      assetDir,
      projectSlug,
      autoRender,
    } = payload as TranscribePayload;

    return withLocalLease(
      fs,
      projectSlug,
      assetId,
      ctx,
      "transcribe",
      async () => {
        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) throw new Error("ELEVENLABS_API_KEY environment variable is not set");

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

        if (autoRender) {
          await enqueueAutoRender(fs, assetId, assetDir, projectSlug);
        }

        return { success: true, provider: "elevenlabs" as const };
      },
    );
  });
}

async function enqueueAutoRender(
  fs: ClipfirstFs,
  assetId: string,
  assetDir: string,
  projectSlug: string,
): Promise<void> {
  const manifestResult = await fs.getManifest(assetId, projectSlug);
  if (!manifestResult.ok) {
    throw new Error(`Failed to get manifest for auto-render: ${manifestResult.error.message}`);
  }

  const videoFile = findVideoFile(manifestResult.value.files);
  if (!videoFile) throw new Error(`No video file found for auto-render: ${assetId}`);

  const videoPath = join(assetDir, videoFile.name);
  const jobId = `auto-render-${assetId}`;

  const timelineResult = await fs.readProjectMeta<{ render?: string }>("timeline", projectSlug);
  const orientation = timelineResult.ok
    ? (Array.isArray(timelineResult.value.render)
        ? timelineResult.value.render[0]
        : timelineResult.value.render) ?? "landscape"
    : "landscape";

  const stored = await readStoredRenderDefaults(fs, assetId, projectSlug, orientation);
  const analysisRecs = await readAnalysisRecommendations(fs, assetId, projectSlug);
  const subtitlesEnabled = analysisRecs.subtitlesEnabled !== false;

  await queue.enqueue(jobId, {
    type: "render_project",
    projectSlug,
    orientation,
    assets: [{
      assetId,
      assetDir,
      videoPath,
      videoFilename: videoFile.name,
      hasElevenlabs: true,
    }],
    subtitlesEnabled,
    highlightStyle: stored.highlightStyle as string,
    position: stored.position as string,
    fontSize: stored.fontSize as string,
    textColor: stored.textColor as string,
    highlightColor: stored.highlightColor as string,
    audioFadeIn: stored.audioFadeIn as number,
    audioFadeOut: stored.audioFadeOut as number,
    audioVolume: stored.audioVolume as number,
    osgImagePath: (stored.osgImagePath as string | null) ?? null,
    osgPosition: stored.osgPosition as string,
    backgroundMode: stored.backgroundMode as string,
  });
}
