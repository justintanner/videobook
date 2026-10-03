import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { Engine } from "videobook-engine";
import { probeVideo } from "../ffmpeg.js";
import { registerJobHandler } from "../queue.js";
import { extractVideoPoster } from "../video-poster.js";

type ExtractVideoPosterPayload = {
  type: "extract_video_poster";
  bookId: string;
  posterArtifactId: string;
  sourceFilename: string;
  sourceHash: string;
};

export function registerExtractVideoPosterJob(engine: Engine): void {
  registerJobHandler("extract_video_poster", async (payload, { signal }) => {
    const { posterArtifactId, sourceFilename, sourceHash } =
      payload as ExtractVideoPosterPayload;
    const needsPoster = async (): Promise<boolean> => {
      const manifest = await engine.files.manifest(posterArtifactId);
      if (!manifest.ok) throw new Error(manifest.error.message);
      return !manifest.value.files.some((file) => file.name === "original.jpg")
        && manifest.value.files.some((file) =>
          file.name === sourceFilename && file.objectHash === sourceHash);
    };
    if (!await needsPoster()) return { skipped: true };
    const source = await engine.files.read(posterArtifactId, sourceFilename);
    if (!source.ok) throw new Error(source.error.message);
    if (createHash("sha256").update(source.value).digest("hex") !== sourceHash) {
      return { skipped: true };
    }
    const scratch = await mkdtemp(join(tmpdir(), "videobook-poster-source-"));
    try {
      const sourcePath = join(scratch, `source${extname(sourceFilename)}`);
      await writeFile(sourcePath, source.value);
      const probe = await probeVideo(sourcePath, { signal });
      const poster = await extractVideoPoster(
        sourcePath,
        probe.videoDuration || probe.duration,
        signal,
      );
      signal?.throwIfAborted();
      if (!await needsPoster()) return { skipped: true };
      const written = await engine.files.write(posterArtifactId, "original.jpg", poster);
      if (!written.ok) throw new Error(written.error.message);
      return { success: true };
    } catch (error) {
      if (!signal?.aborted && await needsPoster()) {
        const recorded = await engine.metadata.artifacts.write(posterArtifactId, "poster-recovery", {
          sourceHash,
          failed: true,
        });
        if (!recorded.ok) throw new Error(recorded.error.message);
      }
      throw error;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
