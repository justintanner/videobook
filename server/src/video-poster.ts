import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isThumbnailBlank, runFfmpeg } from "./ffmpeg.js";

export async function extractVideoPoster(
  videoPath: string,
  duration: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const scratch = await mkdtemp(join(tmpdir(), "videobook-poster-"));
  const posterPath = join(scratch, "poster.jpg");
  try {
    const extract = async (seconds: number): Promise<Buffer> => {
      await runFfmpeg([
        "-y", "-ss", String(seconds), "-i", videoPath,
        "-map", "0:v:0", "-frames:v", "1", "-q:v", "2", posterPath,
      ], { signal });
      const bytes = await readFile(posterPath);
      if (bytes.length === 0) throw new Error("Video poster is empty");
      return bytes;
    };
    const first = await extract(0);
    if (duration > 0 && await isThumbnailBlank(posterPath)) {
      try {
        return await extract(duration / 2);
      } catch {
        signal?.throwIfAborted();
      }
    }
    return first;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
