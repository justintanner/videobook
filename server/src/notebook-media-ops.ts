import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import {
  AUDIO_OPTS,
  H264_MEDIUM,
  probeVideo,
  runFfmpeg,
} from "./ffmpeg.js";

export interface MediaRange {
  startSeconds: number;
  endSeconds: number;
}

async function materializeArtifactFile(
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
  const artifact = await engine.artifacts.create({ kind, name: title });
  if (!artifact.ok) throw new Error(artifact.error.message);
  const written = await engine.files.writeFromPath(
    artifact.value.artifactId,
    fileName,
    filePath,
  );
  if (!written.ok) throw new Error(written.error.message);
  return artifact.value.artifactId;
}

export async function splitSourceRange(
  engine: Engine,
  sourceArtifactId: string,
  range: MediaRange,
  title: string,
): Promise<{ artifactId: string; durationSeconds: number }> {
  if (!(range.endSeconds > range.startSeconds)) {
    throw new Error("Split range must have positive duration");
  }
  const source = await materializeArtifactFile(engine, sourceArtifactId, [
    "original.mp4",
    "original.mov",
  ]);
  const outDir = await mkdtemp(join(tmpdir(), "vb-split-"));
  const outPath = join(outDir, "split.mp4");
  try {
    const duration = range.endSeconds - range.startSeconds;
    await runFfmpeg([
      "-y",
      "-ss",
      String(range.startSeconds),
      "-i",
      source.path,
      "-t",
      String(duration),
      ...H264_MEDIUM,
      ...AUDIO_OPTS,
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
    return {
      artifactId,
      durationSeconds: probe.duration || duration,
    };
  } finally {
    await source.cleanup();
    await rm(outDir, { recursive: true, force: true });
  }
}

export async function extractSourceAudio(
  engine: Engine,
  sourceArtifactId: string,
  title: string,
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
    await runFfmpeg([
      "-y",
      "-i",
      source.path,
      "-vn",
      ...AUDIO_OPTS,
      outPath,
    ]);
    const probe = await probeVideo(outPath);
    const artifactId = await ingestOutput(
      engine,
      "audio",
      title,
      "original.m4a",
      outPath,
    );
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
    role: "first" | "last";
    range?: MediaRange;
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
    const start = options.range?.startSeconds ?? 0;
    const end = options.range?.endSeconds ?? probe.duration;
    const atSeconds = options.role === "first"
      ? start
      : Math.max(start, end - (1 / Math.max(probe.fps || 30, 1)));
    await runFfmpeg([
      "-y",
      "-ss",
      String(atSeconds),
      "-i",
      source.path,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      outPath,
    ]);
    const bytes = await readFile(outPath);
    if (bytes.byteLength < 32) {
      throw new Error("Captured frame is empty");
    }
    const artifactId = await ingestOutput(
      engine,
      "image",
      options.title,
      "original.jpg",
      outPath,
    );
    return { artifactId, atSeconds };
  } finally {
    await source.cleanup();
    await rm(outDir, { recursive: true, force: true });
  }
}

export async function exportSequenceMaster(
  engine: Engine,
  clipArtifactIds: string[],
  audioArtifactId: string | null,
  title: string,
): Promise<{ artifactId: string }> {
  if (clipArtifactIds.length === 0) {
    throw new Error("Export requires at least one clip");
  }
  const outDir = await mkdtemp(join(tmpdir(), "vb-export-"));
  const listPath = join(outDir, "concat.txt");
  const concatPath = join(outDir, "picture.mp4");
  const finalPath = join(outDir, "master.mp4");
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
        ...H264_MEDIUM,
        ...AUDIO_OPTS,
        "-movflags",
        "+faststart",
        finalPath,
      ]);
    }
    const artifactId = await ingestOutput(
      engine,
      "final",
      title,
      "original.mp4",
      finalPath,
    );
    return { artifactId };
  } finally {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
    await rm(outDir, { recursive: true, force: true });
  }
}
