import type { VideocityFs } from "videocity-engine";
import { join, basename } from "node:path";
import { registerJobHandler, queue } from "../queue.js";
import { runFfmpeg, probeVideo, H264_MEDIUM, AUDIO_OPTS } from "../ffmpeg.js";
import { withLockedLocalLease } from "./_lease.js";

const LOCK_DURATION_MS = 600_000;

const STALE_DERIVATIVES = [
  ".original.analysis.json",
  ".analysis.gpt4otrans.json",
  "elevenlabs.json",
  ".kie-task.json",
  ".suggest-cuts.json",
];

type Cut = { cut_start: number; cut_end: number };

type ApplyCutsPayload = {
  type: "apply_cuts";
  inputPath: string;
  outputPath: string;
  cuts: Cut[];
  duration: number;
  hasAudio: boolean;
  assetId: string;
  assetDir: string;
  projectSlug: string;
};

function buildKeepSegments(cuts: Cut[], duration: number): Array<[number, number]> {
  const keeps: Array<[number, number]> = [];
  let cursor = 0;
  for (const c of cuts) {
    if (c.cut_start > cursor) keeps.push([cursor, c.cut_start]);
    cursor = c.cut_end;
  }
  if (cursor < duration) keeps.push([cursor, duration]);
  return keeps;
}

function buildFilterGraph(keeps: Array<[number, number]>, hasAudio: boolean): string {
  const parts: string[] = [];
  keeps.forEach(([s, e], i) => {
    parts.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${i}]`);
    if (hasAudio) {
      parts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
    }
  });
  const concatInputs = keeps
    .map((_, i) => (hasAudio ? `[v${i}][a${i}]` : `[v${i}]`))
    .join("");
  const tail = hasAudio ? "[v][a]" : "[v]";
  parts.push(
    `${concatInputs}concat=n=${keeps.length}:v=1:a=${hasAudio ? 1 : 0}${tail}`,
  );
  return parts.join(";");
}

export function registerApplyCutsJob(fs: VideocityFs): void {
  registerJobHandler("apply_cuts", async (payload, ctx) => {
    const {
      inputPath, outputPath, cuts, duration, hasAudio,
      assetId, assetDir, projectSlug,
    } = payload as ApplyCutsPayload;

    const result = await withLockedLocalLease(
      fs,
      projectSlug,
      assetId,
      assetDir,
      ctx,
      "apply_cuts",
      { durationMs: LOCK_DURATION_MS, data: { state: "cutting" } },
      async () => {
      const effectiveDuration = duration > 0 ? duration : (await probeVideo(inputPath)).duration;
      const keeps = buildKeepSegments(cuts, effectiveDuration);
      if (keeps.length === 0) {
        throw new Error("Cuts cover entire video — nothing left to keep.");
      }

      const filter = buildFilterGraph(keeps, hasAudio);
      const args = [
        "-y", "-i", inputPath,
        "-filter_complex", filter,
        "-map", "[v]",
        ...(hasAudio ? ["-map", "[a]"] : []),
        ...H264_MEDIUM,
        ...(hasAudio ? AUDIO_OPTS : []),
        outputPath,
      ];
      await runFfmpeg(args);

      const inputFilename = basename(inputPath);
      const outputFilename = basename(outputPath);
      await fs.deleteFile(assetId, inputFilename, projectSlug);
      await fs.renameFile(assetId, outputFilename, inputFilename, projectSlug);

      for (const stale of STALE_DERIVATIVES) {
        await fs.deleteFile(assetId, stale, projectSlug);
      }

      const newVideoPath = join(assetDir, inputFilename);
      return { newVideoPath, keptSegments: keeps.length };
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
        origin: "apply_cuts",
        cuts,
        applied_at: new Date().toISOString(),
      },
      force: true,
    } as unknown as Record<string, unknown>);

    return { success: true, kept_segments: result.keptSegments };
  });
}
