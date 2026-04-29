import type { ClipfirstFs } from "clipfirst-engine";
import { join, basename } from "node:path";
import { elevenlabs } from "@apicity/elevenlabs";
import { registerJobHandler, queue } from "../queue.js";
import { runFfmpeg, AUDIO_OPTS } from "../ffmpeg.js";

const LOCK_DURATION_MS = 1_800_000;
// Tail fade as a click-suppressor in case a cue ends on a transient.
const SFX_FADE_OUT_S = 0.2;

const STALE_DERIVATIVES = [
  ".original.analysis.json",
  ".analysis.gpt4otrans.json",
  "elevenlabs.json",
  ".kie-task.json",
  ".suggest-sfx.json",
];

type SfxEntry = {
  timestamp: number;
  type: string;
  description: string;
  duration_seconds: number;
  prompt: string | null;
};

type ApplySfxPayload = {
  type: "apply_sfx";
  videoPath: string;
  outputPath: string;
  sfx: SfxEntry[];
  hasAudio: boolean;
  assetId: string;
  assetDir: string;
  projectSlug: string;
};

async function generateAndWriteSfx(
  provider: ReturnType<typeof elevenlabs>,
  fs: ClipfirstFs,
  entry: SfxEntry,
  index: number,
  assetId: string,
  projectSlug: string,
): Promise<string> {
  const text = entry.prompt ?? `${entry.type}: ${entry.description}`;
  const audio = await provider.v1.soundGeneration({
    text,
    duration_seconds: entry.duration_seconds,
    prompt_influence: 0.75,
  });
  const filename = `original.sfx.${index}.mp3`;
  const writeResult = await fs.writeFile(assetId, filename, Buffer.from(audio), projectSlug);
  if (!writeResult.ok) throw new Error(`SFX ${index} write failed: ${writeResult.error.message}`);
  return filename;
}

function buildMixFilter(sfx: SfxEntry[], hasAudio: boolean): string {
  const parts: string[] = [];
  if (hasAudio) {
    parts.push(
      "[0:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[base]",
    );
  } else {
    parts.push(
      "anullsrc=channel_layout=stereo:sample_rate=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[base]",
    );
  }
  sfx.forEach((entry, i) => {
    const ms = Math.round(entry.timestamp * 1000);
    const filters = [
      "aresample=48000",
      "aformat=sample_fmts=fltp:channel_layouts=stereo",
    ];
    const fadeDur = Math.min(SFX_FADE_OUT_S, entry.duration_seconds / 4);
    if (fadeDur > 0.01) {
      filters.push(`afade=t=out:st=${entry.duration_seconds - fadeDur}:d=${fadeDur}`);
    }
    if (ms > 0) filters.push(`adelay=${ms}|${ms}`);
    parts.push(`[${i + 1}:a:0]${filters.join(",")}[s${i}]`);
  });
  const mixInputs = `[base]${sfx.map((_, i) => `[s${i}]`).join("")}`;
  parts.push(
    `${mixInputs}amix=inputs=${sfx.length + 1}:duration=first:dropout_transition=0:normalize=0[outa]`,
  );
  return parts.join(";");
}

export function registerApplySfxJob(fs: ClipfirstFs): void {
  registerJobHandler("apply_sfx", async (payload) => {
    const {
      videoPath, outputPath, sfx, hasAudio,
      assetId, assetDir, projectSlug,
    } = payload as ApplySfxPayload;

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set");

    const lockResult = await fs.acquireLock(assetDir, {
      durationMs: LOCK_DURATION_MS,
      data: { state: "applying_sfx" },
    });
    if (!lockResult.ok) throw new Error(`Asset is locked: ${lockResult.error.message}`);

    try {
      const provider = elevenlabs({ apiKey, timeout: 60_000 });

      const generatedFilenames = await Promise.all(
        sfx.map((entry, i) => generateAndWriteSfx(provider, fs, entry, i, assetId, projectSlug)),
      );

      const filter = buildMixFilter(sfx, hasAudio);
      const ffmpegArgs: string[] = ["-y", "-i", videoPath];
      for (const fn of generatedFilenames) {
        ffmpegArgs.push("-i", join(assetDir, fn));
      }
      ffmpegArgs.push(
        "-filter_complex", filter,
        "-map", "0:v", "-c:v", "copy",
        "-map", "[outa]", ...AUDIO_OPTS,
        outputPath,
      );
      await runFfmpeg(ffmpegArgs);

      const inputFilename = basename(videoPath);
      const outputFilename = basename(outputPath);
      await fs.deleteFile(assetId, inputFilename, projectSlug);
      await fs.renameFile(assetId, outputFilename, inputFilename, projectSlug);

      for (const fn of generatedFilenames) {
        await fs.deleteFile(assetId, fn, projectSlug).catch(() => {});
      }
      for (const stale of STALE_DERIVATIVES) {
        await fs.deleteFile(assetId, stale, projectSlug);
      }

      const newVideoPath = join(assetDir, inputFilename);
      await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
        type: "process_video",
        videoPath: newVideoPath,
        assetId,
        assetDir,
        projectSlug,
        provenance: {
          origin: "apply_sfx",
          sfx_count: sfx.length,
          applied_at: new Date().toISOString(),
        },
        force: true,
      } as unknown as Record<string, unknown>);

      return { success: true, sfx_count: sfx.length };
    } finally {
      await fs.releaseLock(assetDir);
    }
  });
}
