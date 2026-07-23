import type { VideocityFs } from "videobook-engine";
import { join } from "node:path";
import { registerJobHandler } from "../queue.js";
import { extractWaveform } from "../ffmpeg.js";

// Background cache-fill for audio waveforms. Enqueued by buildAssetList when a
// video asset has no cached waveform, so list_assets / sync never block on the
// ffmpeg decode. The asset id is carried under `waveformAssetId` (not a key the
// queue treats as an asset-work id) so a failure here can't fail unrelated
// pending tasks or flip the asset into an error state — this is a pure
// best-effort optimization.
type ExtractWaveformPayload = {
  type: "extract_waveform";
  projectSlug: string;
  waveformAssetId: string;
  videoFilename: string;
};

export function registerExtractWaveformJob(fs: VideocityFs): void {
  registerJobHandler("extract_waveform", async (payload) => {
    const { projectSlug, waveformAssetId, videoFilename } =
      payload as ExtractWaveformPayload;

    // Idempotent: a concurrent poll may have already cached this waveform.
    const existing = await fs.readAudioWaveform(waveformAssetId, projectSlug);
    if (existing.ok) return { cached: true };

    const dir = await fs.resolveAssetDir(waveformAssetId, projectSlug);
    if (!dir.ok) {
      throw new Error(
        `extract_waveform: resolveAssetDir failed for ${waveformAssetId}: ${dir.error.message}`,
      );
    }

    const peaks = await extractWaveform(join(dir.value, videoFilename));
    // Persist even when empty. A silent track — or one ffmpeg can't decode —
    // caches as "no waveform" so we don't re-decode the same file on every
    // sync. extractWaveform already logs the underlying ffmpeg failure.
    const write = await fs.writeAudioWaveform(
      waveformAssetId,
      peaks,
      projectSlug,
    );
    if (!write.ok) {
      throw new Error(
        `extract_waveform: writeAudioWaveform failed for ${waveformAssetId}: ${write.error.message}`,
      );
    }
    return { peaks: peaks.length };
  });
}
