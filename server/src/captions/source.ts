import { join } from "node:path";
import { findPrimaryMediaFile } from "videobook-engine";
import type { ArtifactManifestFile, ArtifactStream, Engine } from "videobook-engine";
import { probeVideo } from "../ffmpeg.js";
import type { ProbeStream } from "../ffmpeg.js";
import { captionOutputFps, displayDimensions } from "./geometry.js";

export const TIMED_TRANSCRIPT_FILENAME = "elevenlabs.json";

export interface CaptionMediaSource {
  artifactId: string;
  kind: "video" | "final";
  label: string | null;
  file: ArtifactManifestFile;
  path: string;
  directory: string;
  mediaHash: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  audioFile: ArtifactManifestFile | null;
  transcriptFile: ArtifactManifestFile | null;
}

type VideoInfo = Pick<ProbeStream, "timeBase" | "durationTicks" | "video">;

function streamSeconds(stream: VideoInfo): number {
  return stream.durationTicks * stream.timeBase.numerator / stream.timeBase.denominator;
}

function registeredStreams(engine: Engine, artifactId: string, file: ArtifactManifestFile): ArtifactStream[] {
  const streams = engine.streams.list(artifactId);
  if (!streams.ok) return [];
  return streams.value.filter((stream) => stream.sourcePath === file.name && stream.objectHash === file.objectHash);
}

async function videoInfo(engine: Engine, artifactId: string, file: ArtifactManifestFile, path: string) {
  const streams = registeredStreams(engine, artifactId, file);
  const video = streams.find((stream) => stream.kind === "video" && stream.video);
  if (video?.video) return { video: video as VideoInfo, hasAudio: streams.some((stream) => stream.kind === "audio") };
  const probe = await probeVideo(path);
  if (!probe.videoStream?.video) throw new Error("The video has no picture stream to caption.");
  return { video: probe.videoStream as VideoInfo, hasAudio: probe.hasAudio };
}

function videoKind(kind: string): "video" | "final" {
  if (kind === "video" || kind === "final") return kind;
  throw new Error("Subtitles need a video. Choose a video cell.");
}

export async function captionMediaSource(engine: Engine, artifactId: string): Promise<CaptionMediaSource> {
  const artifact = engine.artifacts.get(artifactId);
  if (!artifact.ok) throw new Error(artifact.error.message);
  const kind = videoKind(artifact.value.kind);
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = findPrimaryMediaFile(manifest.value.files, kind);
  if (!file) throw new Error("The video file is missing. Wait for the video to finish processing.");
  const path = join(manifest.value.path, file.name);
  const { video, hasAudio } = await videoInfo(engine, artifactId, file, path);
  const coded = video.video!;
  const display = displayDimensions(coded);
  const durationSeconds = streamSeconds(video);
  if (!(durationSeconds > 0)) throw new Error("The video has no measurable duration.");
  return {
    artifactId,
    kind,
    label: artifact.value.label ?? null,
    file,
    path,
    directory: manifest.value.path,
    mediaHash: file.objectHash,
    durationSeconds,
    width: display.width,
    height: display.height,
    fps: captionOutputFps(coded.averageFrameRate, coded.nominalFrameRate),
    hasAudio,
    audioFile: manifest.value.files.find((entry) => entry.name === "original.mp3") ?? null,
    transcriptFile: manifest.value.files.find((entry) => entry.name === TIMED_TRANSCRIPT_FILENAME) ?? null,
  };
}
