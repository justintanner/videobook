import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import { srtContent } from "./srt.js";
import {
  AUDIO_OPTS,
  H264_MEDIUM,
  probeVideo,
  runFfmpeg,
  type ProbeResult,
} from "./ffmpeg.js";

interface MediaRange {
  startSeconds: number;
  endSeconds: number;
}

interface MediaSplitRequest {
  range: MediaRange;
  title: string;
}

export const MINIMUM_SPLIT_PIECE_SECONDS = 0.02;

export interface BurnInCaption {
  text: string;
  startSeconds: number;
  durationSeconds: number;
}

export async function materializeArtifactFile(
  engine: Engine,
  artifactId: string,
  preferredNames: string[],
): Promise<{ path: string; cleanup: () => Promise<void>; sourcePath: string }> {
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const names = manifest.value.files.map((file) => file.name);
  const sourcePath = preferredNames.find((name) => names.includes(name))
    ?? names.find((name) => /\.(mp4|mov|mkv|webm|m4a|wav|mp3)$/i.test(name))
    ?? names[0];
  if (!sourcePath) throw new Error(`Artifact ${artifactId} has no media files`);
  const scratch = await mkdtemp(join(tmpdir(), `vb-media-${artifactId.slice(0, 8)}-`));
  const bytes = await engine.files.read(artifactId, sourcePath);
  if (!bytes.ok) throw new Error(bytes.error.message);
  const path = join(scratch, sourcePath.replaceAll("/", "_"));
  await writeFile(path, bytes.value);
  return {
    path,
    sourcePath,
    cleanup: async () => {
      await rm(scratch, { recursive: true, force: true });
    },
  };
}

async function ingestOutput(
  engine: Engine,
  kind: "video" | "audio" | "image" | "final",
  title: string,
  fileName: string,
  filePath: string,
): Promise<string> {
  const artifact = await engine.artifacts.create({ kind, label: title });
  if (!artifact.ok) throw new Error(artifact.error.message);
  const written = await engine.files.writeFromPath(
    artifact.value.artifactId,
    fileName,
    filePath,
  );
  if (!written.ok) throw new Error(written.error.message);
  return artifact.value.artifactId;
}

async function registerMediaProbe(
  engine: Engine,
  artifactId: string,
  sourcePath: string,
  probe: ProbeResult,
): Promise<void> {
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = manifest.value.files.find((candidate) =>
    candidate.name === sourcePath);
  if (!file) throw new Error(`Output file missing from ${artifactId}: ${sourcePath}`);
  for (const [kind, stream] of [
    ["video", probe.videoStream],
    ["audio", probe.audioStream],
  ] as const) {
    if (!stream) continue;
    const registered = await engine.streams.register({
      artifactId,
      sourcePath,
      objectHash: file.objectHash,
      streamIndex: stream.index,
      kind,
      timeBase: stream.timeBase,
      durationTicks: stream.durationTicks,
      codec: stream.codec,
      ...(kind === "video" && stream.video ? { video: stream.video } : {}),
      ...(kind === "audio" && stream.audio ? { audio: stream.audio } : {}),
    });
    if (!registered.ok) throw new Error(registered.error.message);
  }
  const metadata = await engine.metadata.artifacts.write(
    artifactId,
    "original",
    {
      width: probe.width,
      height: probe.height,
      duration: probe.duration,
      fps: probe.fps,
      hasAudio: probe.hasAudio,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
    },
  );
  if (!metadata.ok) throw new Error(metadata.error.message);
}

function validateSplitRange(
  sourceArtifactId: string,
  sourceDuration: number,
  range: MediaRange,
): number {
  if (
    !Number.isFinite(range.startSeconds)
    || !Number.isFinite(range.endSeconds)
    || range.startSeconds < 0
  ) {
    throw new Error("Split range must use finite, non-negative seconds");
  }
  if (!(range.endSeconds > range.startSeconds)) {
    throw new Error("Split range must have positive duration");
  }
  if (range.startSeconds >= sourceDuration) {
    throw new Error(
      `Cannot split artifact ${sourceArtifactId}: requested range ${range.startSeconds}-${range.endSeconds}s starts at or after the source video duration of ${sourceDuration}s`,
    );
  }
  return Math.min(range.endSeconds, sourceDuration) - range.startSeconds;
}

async function splitMaterializedRange(
  engine: Engine,
  sourceArtifactId: string,
  sourcePath: string,
  sourceDuration: number,
  range: MediaRange,
  title: string,
): Promise<{ artifactId: string; durationSeconds: number }> {
  const duration = validateSplitRange(sourceArtifactId, sourceDuration, range);
  const outDir = await mkdtemp(join(tmpdir(), "vb-split-"));
  const outPath = join(outDir, "split.mp4");
  try {
    await runFfmpeg([
      "-y",
      "-ss",
      String(range.startSeconds),
      "-i",
      sourcePath,
      "-t",
      String(duration),
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      ...H264_MEDIUM,
      ...AUDIO_OPTS,
      "-movflags",
      "+faststart",
      outPath,
    ]);
    const probe = await probeVideo(outPath);
    if (!probe.videoStream) {
      throw new Error(
        `Cannot split artifact ${sourceArtifactId}: FFmpeg output has no video stream`,
      );
    }
    const artifactId = await ingestOutput(
      engine,
      "video",
      title,
      "original.mp4",
      outPath,
    );
    await registerMediaProbe(engine, artifactId, "original.mp4", probe);
    return {
      artifactId,
      durationSeconds: probe.duration || duration,
    };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

export async function splitSourceRanges(
  engine: Engine,
  sourceArtifactId: string,
  requests: readonly MediaSplitRequest[],
  concurrency = 2,
): Promise<Array<{ artifactId: string; durationSeconds: number }>> {
  if (requests.length === 0) throw new Error("At least one split range is required");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("Split concurrency must be a positive integer");
  }
  const source = await materializeArtifactFile(engine, sourceArtifactId, [
    "original.mp4",
    "original.mov",
  ]);
  try {
    const sourceProbe = await probeVideo(source.path);
    if (!sourceProbe.videoStream) {
      throw new Error(
        `Cannot split artifact ${sourceArtifactId}: source has no video stream`,
      );
    }
    const sourceDuration = sourceProbe.videoDuration || sourceProbe.duration;
    if (!(sourceDuration > 0)) {
      throw new Error(
        `Cannot split artifact ${sourceArtifactId}: source video duration is unavailable`,
      );
    }
    for (const request of requests) {
      validateSplitRange(sourceArtifactId, sourceDuration, request.range);
    }
    const results = new Array<{ artifactId: string; durationSeconds: number }>(
      requests.length,
    );
    let nextIndex = 0;
    let failed = false;
    const worker = async (): Promise<void> => {
      while (!failed) {
        const index = nextIndex;
        nextIndex += 1;
        const request = requests[index];
        if (!request) return;
        try {
          results[index] = await splitMaterializedRange(
            engine,
            sourceArtifactId,
            source.path,
            sourceDuration,
            request.range,
            request.title,
          );
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    };
    const settled = await Promise.allSettled(
      Array.from(
        { length: Math.min(concurrency, requests.length) },
        async () => await worker(),
      ),
    );
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) throw rejected.reason;
    return results;
  } finally {
    await source.cleanup();
  }
}

function buildConcatFilterGraph(
  ranges: readonly MediaRange[],
  hasAudio: boolean,
): string {
  const parts: string[] = [];
  ranges.forEach((range, index) => {
    parts.push(
      `[0:v]trim=start=${range.startSeconds}:end=${range.endSeconds},setpts=PTS-STARTPTS[v${index}]`,
    );
    if (hasAudio) {
      parts.push(
        `[0:a]atrim=start=${range.startSeconds}:end=${range.endSeconds},asetpts=PTS-STARTPTS[a${index}]`,
      );
    }
  });
  const concatInputs = ranges
    .map((_, index) => (hasAudio ? `[v${index}][a${index}]` : `[v${index}]`))
    .join("");
  const tail = hasAudio ? "[v][a]" : "[v]";
  parts.push(
    `${concatInputs}concat=n=${ranges.length}:v=1:a=${hasAudio ? 1 : 0}${tail}`,
  );
  return parts.join(";");
}

export async function concatSourceRanges(
  engine: Engine,
  sourceArtifactId: string,
  ranges: readonly MediaRange[],
  title: string,
): Promise<{ artifactId: string; durationSeconds: number }> {
  if (ranges.length === 0) {
    throw new Error("At least one concat range is required");
  }
  if (ranges.length === 1) {
    return await splitSourceRange(
      engine,
      sourceArtifactId,
      ranges[0]!,
      title,
    );
  }
  const source = await materializeArtifactFile(engine, sourceArtifactId, [
    "original.mp4",
    "original.mov",
  ]);
  const outDir = await mkdtemp(join(tmpdir(), "vb-concat-"));
  const outPath = join(outDir, "concat.mp4");
  try {
    const probe = await probeVideo(source.path);
    if (!probe.videoStream) {
      throw new Error(
        `Cannot concat artifact ${sourceArtifactId}: source has no video stream`,
      );
    }
    const sourceDuration = probe.videoDuration || probe.duration;
    for (const range of ranges) {
      validateSplitRange(sourceArtifactId, sourceDuration, range);
    }
    const hasAudio = probe.hasAudio;
    const filter = buildConcatFilterGraph(ranges, hasAudio);
    await runFfmpeg([
      "-y",
      "-i",
      source.path,
      "-filter_complex",
      filter,
      "-map",
      "[v]",
      ...(hasAudio ? ["-map", "[a]"] : []),
      ...H264_MEDIUM,
      ...(hasAudio ? AUDIO_OPTS : []),
      "-movflags",
      "+faststart",
      outPath,
    ]);
    const outputProbe = await probeVideo(outPath);
    if (!outputProbe.videoStream) {
      throw new Error(
        `Cannot concat artifact ${sourceArtifactId}: FFmpeg output has no video stream`,
      );
    }
    const artifactId = await ingestOutput(
      engine,
      "video",
      title,
      "original.mp4",
      outPath,
    );
    await registerMediaProbe(engine, artifactId, "original.mp4", outputProbe);
    return {
      artifactId,
      durationSeconds: outputProbe.duration
        || ranges.reduce(
          (total, range) => total + (range.endSeconds - range.startSeconds),
          0,
        ),
    };
  } finally {
    await source.cleanup();
    await rm(outDir, { recursive: true, force: true });
  }
}

export async function splitSourceRange(
  engine: Engine,
  sourceArtifactId: string,
  range: MediaRange,
  title: string,
): Promise<{ artifactId: string; durationSeconds: number }> {
  return (await splitSourceRanges(
    engine,
    sourceArtifactId,
    [{ range, title }],
    1,
  ))[0]!;
}

export async function extractSourceAudio(
  engine: Engine,
  sourceArtifactId: string,
  title: string,
  range?: { startSeconds: number; durationSeconds?: number },
): Promise<{ artifactId: string; durationSeconds: number }> {
  const source = await materializeArtifactFile(engine, sourceArtifactId, [
    "original.mp4",
    "original.mov",
    "original.m4a",
    "original.wav",
  ]);
  const outDir = await mkdtemp(join(tmpdir(), "vb-audio-"));
  const outPath = join(outDir, "audio.m4a");
  try {
    const args = ["-y"];
    if (range && Number.isFinite(range.startSeconds) && range.startSeconds > 0) {
      args.push("-ss", String(range.startSeconds));
    }
    args.push("-i", source.path, "-vn");
    if (range && range.durationSeconds && range.durationSeconds > 0) {
      args.push("-t", String(range.durationSeconds));
    }
    args.push(...AUDIO_OPTS, outPath);
    await runFfmpeg(args);
    const probe = await probeVideo(outPath);
    const artifactId = await ingestOutput(
      engine,
      "audio",
      title,
      "original.m4a",
      outPath,
    );
    await registerMediaProbe(engine, artifactId, "original.m4a", probe);
    const existing = await engine.metadata.artifacts.read<Record<string, unknown>>(
      artifactId,
      "original",
    );
    const metadata = await engine.metadata.artifacts.write(
      artifactId,
      "original",
      {
        ...(existing.ok ? existing.value : {}),
        origin: "extract_audio",
        sourceArtifactId,
        ...(range
          ? {
              startSeconds: range.startSeconds,
              ...(range.durationSeconds === undefined
                ? {}
                : { durationSeconds: range.durationSeconds }),
            }
          : {}),
      },
    );
    if (!metadata.ok) throw new Error(metadata.error.message);
    return {
      artifactId,
      durationSeconds: probe.duration || probe.audioDuration || 0,
    };
  } finally {
    await source.cleanup();
    await rm(outDir, { recursive: true, force: true });
  }
}

export async function captureFrame(
  engine: Engine,
  sourceArtifactId: string,
  options: {
    role: "first" | "time" | "last";
    range?: MediaRange;
    timestampSeconds?: number;
    title: string;
  },
): Promise<{ artifactId: string; atSeconds: number }> {
  const source = await materializeArtifactFile(engine, sourceArtifactId, [
    "original.mp4",
    "original.mov",
  ]);
  const outDir = await mkdtemp(join(tmpdir(), "vb-frame-"));
  const outPath = join(outDir, "frame.jpg");
  try {
    const probe = await probeVideo(source.path);
    if (!probe.videoStream) {
      throw new Error(
        `Cannot capture frame from artifact ${sourceArtifactId}: source has no video stream`,
      );
    }
    const start = options.range?.startSeconds ?? 0;
    const sourceEnd = probe.videoDuration || probe.duration;
    if (!(sourceEnd > 0)) {
      throw new Error(
        `Cannot capture frame from artifact ${sourceArtifactId}: source video duration is unavailable`,
      );
    }
    if (!Number.isFinite(start) || start < 0 || start >= sourceEnd) {
      throw new Error(
        `Cannot capture frame from artifact ${sourceArtifactId}: requested start ${start}s is outside the source video duration of ${sourceEnd}s`,
      );
    }
    const requestedEnd = options.range?.endSeconds ?? sourceEnd;
    const end = sourceEnd > 0
      ? Math.min(requestedEnd, sourceEnd)
      : requestedEnd;
    const requestedTimestamp = options.timestampSeconds;
    if (
      options.role === "time"
      && (
        typeof requestedTimestamp !== "number"
        || !Number.isFinite(requestedTimestamp)
      )
    ) {
      throw new Error(
        `Cannot capture frame from artifact ${sourceArtifactId}: requested timestamp ${String(requestedTimestamp)}s is not a finite number`,
      );
    }
    const frameDuration = 1 / Math.max(probe.avgFps ?? probe.fps, 1);
    const lastFrameAt = Math.max(start, end - frameDuration);
    const atSeconds = options.role === "first"
      ? start
      : options.role === "time"
        ? Math.min(Math.max(requestedTimestamp!, start), lastFrameAt)
        : lastFrameAt;
    const attempts = options.role === "last"
      ? [...new Set([atSeconds, Math.max(start, atSeconds - frameDuration), start])]
      : [atSeconds];
    let capturedAt: number | null = null;
    let captureError: unknown;
    for (const candidate of attempts) {
      try {
        await rm(outPath, { force: true });
        await runFfmpeg([
          "-y",
          "-ss",
          String(candidate),
          "-i",
          source.path,
          "-map",
          "0:v:0",
          "-frames:v",
          "1",
          "-q:v",
          "2",
          outPath,
        ]);
        const bytes = await readFile(outPath);
        if (bytes.byteLength >= 32) {
          capturedAt = candidate;
          break;
        }
        captureError = new Error("Captured frame is empty");
      } catch (error) {
        captureError = error;
      }
    }
    if (capturedAt === null) {
      throw captureError instanceof Error
        ? captureError
        : new Error("Could not capture a frame from the source video");
    }
    const artifactId = await ingestOutput(
      engine,
      "image",
      options.title,
      "original.jpg",
      outPath,
    );
    const metadata = await engine.metadata.artifacts.write(
      artifactId,
      "original",
      {
        origin: "extract_frame",
        sourceArtifactId,
        frameMode: options.role,
        atSeconds: capturedAt,
      },
    );
    if (!metadata.ok) throw new Error(metadata.error.message);
    return { artifactId, atSeconds: capturedAt };
  } finally {
    await source.cleanup();
    await rm(outDir, { recursive: true, force: true });
  }
}

export async function normalizeSceneVideo(
  engine: Engine,
  videoArtifactId: string,
  audioArtifactId: string,
  title: string,
  durationSeconds = 15,
): Promise<{ artifactId: string; durationSeconds: number }> {
  const video = await materializeArtifactFile(engine, videoArtifactId, [
    "original_audio_replaced.mp4",
    "original.mp4",
  ]);
  const audio = await materializeArtifactFile(engine, audioArtifactId, [
    "original.m4a",
    "original.wav",
    "original.mp3",
    "original.mp4",
  ]);
  const outDir = await mkdtemp(join(tmpdir(), "vb-normalize-scene-"));
  const outPath = join(outDir, "scene.mp4");
  try {
    await runFfmpeg([
      "-y",
      "-i",
      video.path,
      "-i",
      audio.path,
      "-filter_complex",
      `[0:v]setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${durationSeconds},scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v];[1:a]atrim=duration=${durationSeconds},asetpts=PTS-STARTPTS,apad=pad_dur=${durationSeconds}[a]`,
      "-map",
      "[v]",
      "-map",
      "[a]",
      ...H264_MEDIUM,
      ...AUDIO_OPTS,
      "-t",
      String(durationSeconds),
      "-movflags",
      "+faststart",
      outPath,
    ]);
    const probe = await probeVideo(outPath);
    const artifactId = await ingestOutput(
      engine,
      "video",
      title,
      "original.mp4",
      outPath,
    );
    await registerMediaProbe(engine, artifactId, "original.mp4", probe);
    return {
      artifactId,
      durationSeconds: probe.duration || durationSeconds,
    };
  } finally {
    await video.cleanup();
    await audio.cleanup();
    await rm(outDir, { recursive: true, force: true });
  }
}

function burnInSrt(captions: BurnInCaption[]): string {
  return srtContent(captions.map((caption) => ({
    startSeconds: caption.startSeconds,
    endSeconds: caption.startSeconds + caption.durationSeconds,
    text: caption.text,
  })));
}

function subtitleFilterPath(path: string): string {
  return path
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'");
}

export async function exportSequenceMaster(
  engine: Engine,
  clipArtifactIds: string[],
  audioArtifactId: string | null,
  title: string,
  options: {
    captions?: BurnInCaption[];
  } = {},
): Promise<{ artifactId: string }> {
  if (clipArtifactIds.length === 0) {
    throw new Error("Export requires at least one clip");
  }
  const outDir = await mkdtemp(join(tmpdir(), "vb-export-"));
  const listPath = join(outDir, "concat.txt");
  const concatPath = join(outDir, "picture.mp4");
  const finalPath = join(outDir, "master.mp4");
  const captionsPath = join(outDir, "captions.srt");
  const cleanups: Array<() => Promise<void>> = [];
  try {
    const lines: string[] = [];
    for (const clipId of clipArtifactIds) {
      const clip = await materializeArtifactFile(engine, clipId, ["original.mp4"]);
      cleanups.push(clip.cleanup);
      lines.push(`file '${clip.path.replaceAll("'", "'\\''")}'`);
    }
    await writeFile(listPath, `${lines.join("\n")}\n`);
    await runFfmpeg([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      ...H264_MEDIUM,
      "-an",
      concatPath,
    ]);
    const captions = options.captions ?? [];
    if (captions.length > 0) {
      await writeFile(captionsPath, burnInSrt(captions));
    }
    const videoFilter = captions.length > 0
      ? [
          "-vf",
          `subtitles='${subtitleFilterPath(captionsPath)}':force_style='FontName=Arial,FontSize=28,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=42'`,
        ]
      : [];
    if (audioArtifactId) {
      const audio = await materializeArtifactFile(engine, audioArtifactId, [
        "original.m4a",
        "original.wav",
        "original.mp4",
      ]);
      cleanups.push(audio.cleanup);
      await runFfmpeg([
        "-y",
        "-i",
        concatPath,
        "-i",
        audio.path,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0?",
        ...videoFilter,
        ...H264_MEDIUM,
        ...AUDIO_OPTS,
        "-shortest",
        "-movflags",
        "+faststart",
        finalPath,
      ]);
    } else {
      await runFfmpeg([
        "-y",
        "-i",
        concatPath,
        "-f",
        "lavfi",
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        ...videoFilter,
        ...H264_MEDIUM,
        ...AUDIO_OPTS,
        "-shortest",
        "-movflags",
        "+faststart",
        finalPath,
      ]);
    }
    const probe = await probeVideo(finalPath);
    const artifactId = await ingestOutput(
      engine,
      "final",
      title,
      "original.mp4",
      finalPath,
    );
    await registerMediaProbe(engine, artifactId, "original.mp4", probe);
    return { artifactId };
  } finally {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
    await rm(outDir, { recursive: true, force: true });
  }
}
