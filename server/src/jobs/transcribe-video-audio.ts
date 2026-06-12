import type { VideocityFs } from "videocity-engine";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAi } from "@apicity/openai";
import { registerJobHandler, type JobHandlerContext } from "../queue.js";
import { getApiKey } from "../api-key.js";
import { probeVideo } from "../ffmpeg.js";
import { withLocalLease } from "./_lease.js";
import { chunkStarts, chunkLength, extractAudioChunk } from "./_audio-chunks.js";
import { enqueueLazyTimelineRender } from "../lazy-render.js";

// gpt-4o-mini-transcribe has two ceilings: it rejects requests once
// instructions + audio exceed its input budget (~25 minutes of audio), and it
// silently truncates transcripts at 2,000 output tokens (~1,500 words — only
// 7-8 minutes of fast speech). The output cap binds first: 15-minute chunks
// of a dense talk show came back cut off mid-sentence. 5-minute chunks cap a
// chunk's transcript at ~1,100 words even for fast speakers, with the side
// benefit that each mono 16kHz upload stays far under the 25MB file limit.
const CHUNK_SECONDS = 5 * 60;

type TranscribeVideoAudioPayload = {
  type: "transcribe_video_audio";
  videoPath: string;
  assetId: string;
  assetDir: string;
  projectSlug: string;
};

type TranscribeVideoAudioResult = {
  success: boolean;
  reason?: string;
  text?: string;
  chunk_count?: number;
};

type OpenAiProvider = ReturnType<typeof createOpenAi>;

async function transcribeBytes(provider: OpenAiProvider, bytes: Uint8Array<ArrayBuffer>, filename: string): Promise<string> {
  const file = new File([bytes], filename, { type: "audio/mpeg" });
  const result = await provider.post.v1.audio.transcriptions({
    file,
    model: "gpt-4o-mini-transcribe",
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
  fs: VideocityFs,
  payload: TranscribeVideoAudioPayload,
  ctx: JobHandlerContext,
): Promise<TranscribeVideoAudioResult> {
  const { videoPath, assetId, projectSlug } = payload;

  const apiKey = getApiKey("OPENAI_API_KEY");
  if (!apiKey) return { success: false, reason: "OPENAI_API_KEY not set" };

  const result = await withLocalLease(fs, projectSlug, assetId, ctx, "transcribe", async (): Promise<TranscribeVideoAudioResult> => {
    try {
      const provider = createOpenAi({ apiKey, timeout: 120_000 });
      const probe = await probeVideo(videoPath);

      let text: string;
      let chunkCount = 1;
      if (probe.duration > CHUNK_SECONDS) {
        chunkCount = chunkStarts(probe.duration, CHUNK_SECONDS).length;
        text = await transcribeChunked(provider, videoPath, probe.duration);
      } else {
        const readResult = await fs.readFile(assetId, "original.mp3", projectSlug);
        if (!readResult.ok) throw new Error(readResult.error.message);
        text = await transcribeBytes(provider, new Uint8Array(readResult.value), "original.mp3");
      }

      const jsonString = JSON.stringify({ text }, null, 2);
      await fs.writeFile(assetId, ".analysis.gpt4otrans.json", jsonString, projectSlug);

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
      await fs.logAction("transcribe-soft-fail", { assetId, error: reason }, projectSlug).catch(() => undefined);
      return { success: false, reason };
    }
  });
  try {
    await enqueueLazyTimelineRender(fs, projectSlug, assetId);
  } catch (err) {
    void err;
  }
  return result;
}

export function registerTranscribeVideoAudioJob(fs: VideocityFs): void {
  registerJobHandler("transcribe_video_audio", async (payload, ctx) =>
    runTranscribeVideoAudio(fs, payload as TranscribeVideoAudioPayload, ctx));
}
