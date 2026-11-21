import { join } from "node:path";
import type { Engine } from "videobook-engine";
import { z } from "zod";
import { probeVideo } from "../ffmpeg.js";
import { queue } from "../queue.js";
import { BUILTIN_SOUND_IDS } from "../sound-effects/catalog.js";
import { findApplySfxSourceFile } from "./apply-sfx.js";
import type { ToolDef } from "./tool-def.js";

const cueSchema = z.object({
  sound: z.enum(BUILTIN_SOUND_IDS).describe("Built-in sound"),
  timestamp: z.number().min(0).describe("Seconds into the video where the sound starts"),
  volume: z.number().min(0).max(100).default(70).describe("Sound volume percent"),
});

export function applyBuiltinSfxDef(engine: Engine): ToolDef {
  return {
    name: "apply_builtin_sfx",
    description: "Mix local, free sound effects into a video: zoom_in, zoom_out, whoosh, swish, pop, click, ding, impact, riser, glitch, shutdown, error. For other sounds, use apply_sfx to generate them.",
    schema: {
      asset_id: z.string().describe("Video asset ID"),
      book_id: z.string().describe("Book id"),
      sfx: z.array(cueSchema).min(1).max(16).describe("Sound placements"),
    },
    handler: async (args) => {
      const assetId = String(args.asset_id).replace(/^@/u, "");
      const error = (text: string) => ({ isError: true as const, content: [{ type: "text" as const, text }] });
      const parsed = z.array(cueSchema).min(1).max(16).safeParse(args.sfx);
      if (!parsed.success) return error(parsed.error.message);
      const manifest = await engine.files.manifest(assetId);
      if (!manifest.ok) return error(manifest.error.message);
      const file = findApplySfxSourceFile(manifest.value.files);
      if (!file) return error(`No video file found in asset ${assetId}`);
      const videoPath = join(manifest.value.path, file.name);
      try {
        const source = await probeVideo(videoPath);
        const duration = source.videoDuration > 0 ? source.videoDuration : source.duration;
        const resolved = parsed.data.filter((cue) => cue.timestamp < duration - 0.05);
        const dropped = parsed.data.length - resolved.length;
        if (resolved.length === 0) return error(`All sound cues start within 0.05 seconds of the end or beyond the ${duration.toFixed(2)} second video.`);
        const cleared = await engine.jobs.failures.clear(assetId);
        if (!cleared.ok) return error(cleared.error.message);
        const jobId = `apply-builtin-sfx-${assetId}-${Date.now()}`;
        await queue.enqueueAndWait(jobId, {
          type: "apply_builtin_sfx", videoPath, assetId, assetDir: manifest.value.path, bookId: args.book_id,
          cues: resolved.map((cue) => ({ sound: cue.sound, startSeconds: cue.timestamp, gain: cue.volume / 100 })),
        }, 1_800_000);
        return { content: [{ type: "text" as const, text: JSON.stringify({ asset_id: assetId, job_id: jobId, status: "completed", applied: resolved.length, dropped }) }] };
      } catch (cause) {
        return error(`Apply built-in SFX failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
  };
}
