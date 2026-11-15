import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { Engine } from "videobook-engine";
import { queue, registerJobHandler } from "../queue.js";
import { mixBuiltinSfxIntoVideo } from "../sound-effects/mix.js";
import type { BuiltinSfxCue } from "../sound-effects/mix.js";
import { SOUND_SIDECARS } from "../stale-sidecars.js";
import { withLockedLocalLease } from "./_lease.js";
import { replaceArtifactFileFromPath } from "./_persist-output.js";

const LOCK_DURATION_MS = 1_800_000;

interface ApplyBuiltinSfxPayload {
  videoPath: string;
  cues: BuiltinSfxCue[];
  assetId: string;
  assetDir: string;
  bookId: string;
}

export function registerApplyBuiltinSfxJob(engine: Engine): void {
  registerJobHandler("apply_builtin_sfx", async (payload, ctx) => {
    const { videoPath, cues, assetId, assetDir, bookId } = payload as unknown as ApplyBuiltinSfxPayload;
    await withLockedLocalLease(engine, assetId, assetDir, ctx, "apply_sfx",
      { durationMs: LOCK_DURATION_MS, data: { state: "applying_sfx" } },
      async () => {
        const scratch = await mkdtemp(join(tmpdir(), "videobook-builtin-sfx-"));
        try {
          const outputPath = join(scratch, `mixed${extname(videoPath) || ".mp4"}`);
          await mixBuiltinSfxIntoVideo(videoPath, outputPath, scratch, cues, ctx.signal);
          await replaceArtifactFileFromPath(engine, assetId, basename(videoPath), outputPath);
          for (const filename of SOUND_SIDECARS) {
            const result = await engine.files.delete(assetId, filename);
            if (!result.ok && result.error.code !== "NOT_FOUND") throw new Error(result.error.message);
          }
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );
    await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
      type: "process_video", videoPath, assetId, assetDir, bookId, force: true,
      provenance: { origin: "apply_builtin_sfx", sounds: cues.map((cue) => cue.sound), sfx_count: cues.length, applied_at: new Date().toISOString() },
    });
    return { success: true, sfx_count: cues.length };
  });
}
