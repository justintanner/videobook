import type { Engine } from "videobook-engine";
import { extractWaveform, probeVideo } from "../ffmpeg.js";
import { enqueueAssetTagging } from "./tag-asset.js";
import { queue, registerJobHandler } from "../queue.js";
import { getApiKey } from "../api-key.js";
import { withLocalLease } from "./_lease.js";
import { registerMediaStreams } from "./process-video.js";
import { withTransientStorageRetry } from "./_storage-retry.js";

type ProcessAudioPayload = {
  type: "process_audio";
  audioPath: string;
  sourceFilename: string;
  assetId: string;
  assetDir: string;
  bookId: string;
  provenance: Record<string, unknown>;
};

export async function processAudioFile(
  engine: Engine,
  payload: ProcessAudioPayload,
  signal?: AbortSignal,
): Promise<{ success: true; duration: number }> {
  signal?.throwIfAborted();
  const probe = await probeVideo(payload.audioPath, { signal });
  if (!probe.audioStream) {
    throw new Error(`process_audio requires an audio stream: ${payload.assetId}`);
  }
  await registerMediaStreams(
    engine,
    payload.assetId,
    payload.sourceFilename,
    probe,
  );
  const duration = probe.audioDuration ?? probe.duration;
  await engine.metadata.artifacts.write(payload.assetId, "original", {
    ...payload.provenance,
    duration,
    sampleRateHz: probe.audioStream.audio?.sampleRateHz,
    channels: probe.audioStream.audio?.channels,
  });
  const waveform = await extractWaveform(payload.audioPath);
  if (waveform.length > 0) {
    const written = await engine.metadata.waveforms.write(payload.assetId, waveform);
    if (!written.ok) throw new Error(written.error.message);
  }
  if (process.env.NODE_ENV !== "test") {
    await queue.enqueue(`semantic-index-${payload.assetId}-${Date.now()}`, {
      type: "semantic_index",
      assetId: payload.assetId,
      bookId: payload.bookId,
    } as unknown as Record<string, unknown>);
    if (getApiKey("ELEVENLABS_API_KEY")) {
      await queue.enqueue(`transcribe-audio-${payload.assetId}-${Date.now()}`, {
        type: "transcribe",
        audioPath: payload.audioPath,
        audioFilename: payload.sourceFilename,
        tagAudioEvents: true,
        diarize: true,
        assetId: payload.assetId,
        assetDir: payload.assetDir,
        bookId: payload.bookId,
      } as unknown as Record<string, unknown>);
    } else if (getApiKey("OPENAI_API_KEY")) {
      await queue.enqueue(`transcribe-audio-${payload.assetId}-${Date.now()}`, {
        type: "transcribe_video_audio",
        videoPath: payload.audioPath,
        sourceFilename: payload.sourceFilename,
        assetId: payload.assetId,
        assetDir: payload.assetDir,
        bookId: payload.bookId,
      } as unknown as Record<string, unknown>);
    }
  }
  if (process.env.NODE_ENV !== "test") {
    await enqueueAssetTagging(engine, payload.assetId);
  }
  return { success: true, duration };
}

export function registerProcessAudioJob(engine: Engine): void {
  registerJobHandler("process_audio", async (payload, ctx) => {
    const input = payload as ProcessAudioPayload;
    return withLocalLease(
      engine,
      input.assetId,
      ctx,
      "process",
      async () => withTransientStorageRetry(
        () => processAudioFile(engine, input, ctx.signal),
        ctx.signal,
      ),
    );
  });
}
