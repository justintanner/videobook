import type { Engine } from "videobook-engine";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { createOpenAi } from "@apicity/openai";
import { queue, registerJobHandler, type JobHandlerContext } from "../queue.js";
import { getApiKey } from "../api-key.js";
import { probeVideo } from "../ffmpeg.js";
import {
  DOWNSTREAM_LEASE_WAIT_MS,
  withLocalLease,
} from "./_lease.js";
import { chunkStarts, chunkLength, extractAudioChunk } from "./_audio-chunks.js";
import { enqueueLazyAnalysisIfSlotted, enqueueLazyTimelineRender } from "../lazy-render.js";

const CHUNK_SECONDS = 5 * 60;

type TranscribeVideoAudioPayload = {
  type: "transcribe_video_audio";
  videoPath: string;
  assetId: string;
  assetDir: string;
  bookId: string;
  sourceFilename?: string;
};

type TranscribeVideoAudioResult = {
  success: boolean;
  reason?: string;
  text?: string;
  chunk_count?: number;
};

type OpenAiProvider = ReturnType<typeof createOpenAi>;

async function transcribeBytes(provider: OpenAiProvider, bytes: Uint8Array<ArrayBuffer>, filename: string): Promise<string> {
  const file = new File([bytes], filename, { type: audioMimeType(filename) });
  const result = await provider.post.v1.audio.transcriptions({
    file,
    model: "gpt-transcribe",
  });
  return result.text;
}

async function transcribeChunked(provider: OpenAiProvider, mediaPath: string, duration: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "videocity-transcribe-"));
  try {
    const texts: string[] = [];
    const starts = chunkStarts(duration, CHUNK_SECONDS);
    for (let index = 0; index < starts.length; index++) {
      const start = starts[index];
      const length = chunkLength(duration, start, CHUNK_SECONDS);
      const chunkName = `chunk-${String(index).padStart(3, "0")}.mp3`;
      const chunkPath = join(dir, chunkName);
      await extractAudioChunk(mediaPath, start, length, chunkPath);
      const bytes = await readFile(chunkPath);
      texts.push(await transcribeBytes(provider, new Uint8Array(bytes), chunkName));
    }
    return texts.map((text) => text.trim()).filter(Boolean).join(" ");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function runTranscribeVideoAudio(
  fs: Engine,
  payload: TranscribeVideoAudioPayload,
  ctx: JobHandlerContext,
): Promise<TranscribeVideoAudioResult> {
  const { videoPath, assetId, bookId } = payload;

  const apiKey = getApiKey("OPENAI_API_KEY");
  if (!apiKey) return { success: false, reason: "OPENAI_API_KEY not set" };

  const result = await withLocalLease(fs, bookId, assetId, ctx, "transcribe", async (): Promise<TranscribeVideoAudioResult> => {
    try {
      const provider = createOpenAi({ apiKey, timeout: 120_000 });
      const probe = await probeVideo(videoPath);

      let text: string;
      let chunkCount = 1;
      if (probe.duration > CHUNK_SECONDS) {
        chunkCount = chunkStarts(probe.duration, CHUNK_SECONDS).length;
        text = await transcribeChunked(provider, videoPath, probe.duration);
      } else {
        const sourceFilename = payload.sourceFilename ?? "original.mp3";
        const readResult = await fs.files.read(assetId, sourceFilename);
        if (!readResult.ok) throw new Error(readResult.error.message);
        text = await transcribeBytes(
          provider,
          new Uint8Array(readResult.value),
          sourceFilename,
        );
      }

      const jsonString = JSON.stringify({ text }, null, 2);
      await fs.files.write(assetId, ".analysis.gpt4otrans.json", jsonString);
      await queue.enqueue(`semantic-index-${assetId}-transcript-${Date.now()}`, {
        type: "semantic_index",
        assetId,
        bookId,
      } as unknown as Record<string, unknown>);

      return { success: true, text, chunk_count: chunkCount };
    } catch (err) {
      // Soft-fail: this job is enqueued eagerly after every video with audio
      // (process-video.ts). A failed transcript must not mark the asset
      // 'error' — the video itself is fine and the transcript is a sidecar,
      // same rationale as the waveform soft-fail in process-video.ts.
      // Returning (instead of throwing) lets withLocalLease complete the
      // lease, so the asset stays claimable for a later retry.
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[transcribe_video_audio] soft-failed for ${assetId}: ${reason}`);
      await fs.logs.append("transcribe-soft-fail", { assetId, error: reason }).catch(() => undefined);
      return { success: false, reason };
    }
  }, { waitForActiveMs: DOWNSTREAM_LEASE_WAIT_MS });
  // A force re-process (trim, re-download) invalidated the vision analysis;
  // for slotted assets re-run it here — after speech-to-text, so the analyze
  // prompt includes the fresh transcript — which revives auto-transcribe and
  // the lazy render below (that call skips while the analysis is missing).
  try {
    await enqueueLazyAnalysisIfSlotted(fs, bookId, assetId);
  } catch (err) {
    void err;
  }
  try {
    await enqueueLazyTimelineRender(fs, bookId, assetId);
  } catch (err) {
    void err;
  }
  return result;
}

export function registerTranscribeVideoAudioJob(fs: Engine): void {
  registerJobHandler("transcribe_video_audio", async (payload, ctx) =>
    runTranscribeVideoAudio(fs, payload as TranscribeVideoAudioPayload, ctx));
}

function audioMimeType(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case ".wav": return "audio/wav";
    case ".ogg": return "audio/ogg";
    case ".weba": return "audio/webm";
    case ".m4a": return "audio/mp4";
    case ".aac": return "audio/aac";
    case ".flac": return "audio/flac";
    default: return "audio/mpeg";
  }
}
