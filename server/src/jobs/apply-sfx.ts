import type { VideocityFs } from "videobook-engine";
import { join, basename } from "node:path";
import { createElevenLabs } from "@apicity/elevenlabs";
import { registerJobHandler, queue } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { probeVideo, runFfmpeg, AUDIO_OPTS } from "../ffmpeg.js";
import { withLockedLocalLease } from "./_lease.js";

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

export type SfxEntry = {
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
  assetId: string;
  assetDir: string;
  projectSlug: string;
};

async function generateAndWriteSfx(
  provider: ReturnType<typeof createElevenLabs>,
  fs: VideocityFs,
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

export function buildMixFilter(
  sfx: SfxEntry[],
  hasAudio: boolean,
  videoDurationSeconds: number,
): string {
  const parts: string[] = [];
  if (hasAudio) {
    parts.push(
      "[0:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[base]",
    );
  } else {
    if (!Number.isFinite(videoDurationSeconds) || videoDurationSeconds <= 0) {
      throw new Error(`Invalid silent video duration: ${videoDurationSeconds}`);
    }
    parts.push(
      `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${videoDurationSeconds},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:channel_layouts=stereo[base]`,
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

export async function mixSfxIntoVideo(
  videoPath: string,
  sfxPaths: string[],
  outputPath: string,
  sfx: SfxEntry[],
  signal?: AbortSignal,
): Promise<void> {
  if (sfxPaths.length !== sfx.length) {
    throw new Error("SFX file count does not match the requested cue count");
  }
  const source = await probeVideo(videoPath, { signal });
  const duration = source.videoDuration > 0 ? source.videoDuration : source.duration;
  const filter = buildMixFilter(sfx, source.hasAudio, duration);
  const ffmpegArgs: string[] = ["-y", "-i", videoPath];
  for (const sfxPath of sfxPaths) {
    ffmpegArgs.push("-i", sfxPath);
  }
  ffmpegArgs.push(
    "-filter_complex", filter,
    "-map", "0:v", "-c:v", "copy",
    "-map", "[outa]", ...AUDIO_OPTS,
    outputPath,
  );
  await runFfmpeg(ffmpegArgs, { signal });
}

export function registerApplySfxJob(fs: VideocityFs): void {
  registerJobHandler("apply_sfx", async (payload, ctx) => {
    const {
      videoPath, outputPath, sfx,
      assetId, assetDir, projectSlug,
    } = payload as ApplySfxPayload;

    const apiKey = requireApiKey("ELEVENLABS_API_KEY");

    const result = await withLockedLocalLease(
      fs,
      projectSlug,
      assetId,
      assetDir,
      ctx,
      "apply_sfx",
      { durationMs: LOCK_DURATION_MS, data: { state: "applying_sfx" } },
      async () => {
      const provider = createElevenLabs({ apiKey, timeout: 60_000 });

      const generatedFilenames = await Promise.all(
        sfx.map((entry, i) => generateAndWriteSfx(provider, fs, entry, i, assetId, projectSlug)),
      );

      await mixSfxIntoVideo(
        videoPath,
        generatedFilenames.map((filename) => join(assetDir, filename)),
        outputPath,
        sfx,
        ctx.signal,
      );

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
      return { newVideoPath, sfxCount: sfx.length };
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );

    await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
      type: "process_video",
      videoPath: result.newVideoPath,
      assetId,
      assetDir,
      projectSlug,
      provenance: {
        origin: "apply_sfx",
        sfx_count: result.sfxCount,
        applied_at: new Date().toISOString(),
      },
      force: true,
    } as unknown as Record<string, unknown>);

    return { success: true, sfx_count: result.sfxCount };
  });
}
