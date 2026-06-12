import { runFfmpeg } from "../ffmpeg.js";

// Start offsets (seconds) of sequential fixed-size chunks covering `duration`.
export function chunkStarts(duration: number, chunkSeconds: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [0];
  const count = Math.max(1, Math.ceil(duration / chunkSeconds));
  return Array.from({ length: count }, (_, index) => index * chunkSeconds);
}

// Clamped length (seconds) of the chunk starting at `start`, with a 0.1s floor
// so a near-zero tail still produces a decodable extract.
export function chunkLength(duration: number, start: number, chunkSeconds: number): number {
  if (duration <= 0) return 0;
  return Math.max(0.1, Math.min(chunkSeconds, duration - start));
}

// Extract a mono 16kHz mp3 segment of `mediaPath` to `chunkPath`.
export async function extractAudioChunk(mediaPath: string, start: number, duration: number, chunkPath: string): Promise<void> {
  await runFfmpeg([
    "-y",
    ...(start > 0 ? ["-ss", String(start)] : []),
    ...(duration > 0 ? ["-t", String(duration)] : []),
    "-i", mediaPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-acodec", "libmp3lame",
    "-q:a", "5",
    "-f", "mp3",
    chunkPath,
  ]);
}
