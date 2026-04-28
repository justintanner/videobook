import type { ClipfirstFs } from "clipfirst-fs";
import { join, basename } from "node:path";
import { kie } from "@apicity/kie";
import { registerJobHandler, queue } from "../queue.js";
import { runFfmpeg, AUDIO_OPTS } from "../ffmpeg.js";
import { downloadUrlIntoAsset } from "./_download-into-asset.js";

const LOCK_DURATION_MS = 1_800_000;
const POLL_INTERVAL_MS = 4_000;
// Suno generation can take 60-90s end-to-end; bump headroom over the prior
// elevenlabs path which finished in <15s.
const POLL_TIMEOUT_MS = 360_000;
// kie's Suno endpoint requires callBackUrl; we don't run a webhook so we pass
// a placeholder. The task still completes and we collect via polling.
const SUNO_CALLBACK_URL = "https://example.invalid/clipfirst/no-callback";
// Fade-out at the tail of each trimmed Suno clip so chopped music doesn't end
// on a hard transient.
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

type KieProvider = ReturnType<typeof kie>;

const SUNO_TERMINAL_FAILURES = new Set([
  "CREATE_TASK_FAILED",
  "GENERATE_AUDIO_FAILED",
  "CALLBACK_EXCEPTION",
  "SENSITIVE_WORD_ERROR",
]);

async function generateSfxClip(
  provider: KieProvider,
  entry: SfxEntry,
  index: number,
): Promise<string> {
  const prompt = `Short ${entry.type} sound effect: ${entry.description}. Single percussive cue, no vocals.`;
  const submit = await provider.suno.post.api.v1.generate({
    prompt,
    model: "V5",
    instrumental: true,
    customMode: false,
    callBackUrl: SUNO_CALLBACK_URL,
  });
  const taskId = submit.data?.taskId;
  if (!taskId) {
    throw new Error(`SFX ${index}: Suno submit returned no taskId (${submit.msg ?? "unknown"})`);
  }

  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const info = await provider.suno.get.api.v1.generate.recordInfo(taskId);
    const status = info.data?.status;
    const tracks = info.data?.response?.sunoData ?? [];
    // FIRST_SUCCESS often arrives before any track has an audioUrl populated
    // — kie writes URLs as each track finishes. Take the first track that has
    // a non-empty audioUrl regardless of status; otherwise keep polling.
    const usable = tracks.find((t: { audioUrl?: string }) => typeof t?.audioUrl === "string" && t.audioUrl.length > 0);
    if (usable) return usable.audioUrl;
    if (status === "SUCCESS") {
      throw new Error(`SFX ${index}: Suno SUCCESS but no track had an audioUrl`);
    }
    if (status && SUNO_TERMINAL_FAILURES.has(status)) {
      throw new Error(
        `SFX ${index} failed: ${status}${info.data?.errorMessage ? ` — ${info.data.errorMessage}` : ""}`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`SFX ${index} timed out after ${POLL_TIMEOUT_MS}ms`);
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
    const dur = entry.duration_seconds;
    const fadeDur = Math.min(SFX_FADE_OUT_S, dur / 2);
    const fadeStart = Math.max(0, dur - fadeDur);
    // Suno tracks are ~60-90s — atrim them to the entry's duration_seconds
    // first, then fade out the tail so chopped music doesn't end on a
    // transient, then delay into position before mixing.
    const filters = [
      "aresample=48000",
      "aformat=sample_fmts=fltp:channel_layouts=stereo",
      `atrim=0:${dur}`,
      "asetpts=PTS-STARTPTS",
      `afade=t=out:st=${fadeStart}:d=${fadeDur}`,
    ];
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

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY is not set");

    const lockResult = await fs.acquireLock(assetDir, {
      durationMs: LOCK_DURATION_MS,
      data: { state: "applying_sfx" },
    });
    if (!lockResult.ok) throw new Error(`Asset is locked: ${lockResult.error.message}`);

    const generatedFilenames: string[] = [];
    try {
      const provider = kie({ apiKey, timeout: 60_000 });

      const urls = await Promise.all(
        sfx.map((entry, i) => generateSfxClip(provider, entry, i)),
      );

      for (let i = 0; i < urls.length; i++) {
        const filename = `original.sfx.${i}.mp3`;
        await downloadUrlIntoAsset(fs, urls[i], assetId, filename, projectSlug, { kind: "sfx" });
        generatedFilenames.push(filename);
      }

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
