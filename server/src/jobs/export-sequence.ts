import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  Engine,
  Sequence,
  SequenceClip,
  SequenceTrack,
  TimedSequenceClip,
} from "videobook-engine";
import { runFfmpeg, probeVideo, AUDIO_OPTS, H264_MEDIUM } from "../ffmpeg.js";
import { registerJobHandler } from "../queue.js";
import { replaceArtifactFileFromPath } from "./_persist-output.js";
import { validateSequenceExport } from "../tools/export-sequence.js";

interface ExportSequencePayload {
  type: "export_sequence";
  bookId: string;
  sequenceRevision: string;
  orientation: "landscape" | "portrait" | "square";
  captions: "burn-in" | "sidecar" | "omit";
}

interface ResolvedClip {
  clip: SequenceClip;
  track: SequenceTrack;
  path: string;
  inputIndex: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

function rational(value: { numerator: number; denominator: number }): number {
  return value.numerator / value.denominator;
}

function secondsForFrames(sequence: Sequence, frames: number): number {
  return frames / rational(sequence.frameRate);
}

function sourceSeconds(clip: SequenceClip): { start: number; duration: number } {
  if (clip.source.kind === "still") return { start: 0, duration: 0 };
  const timeBase = rational(clip.source.range.timeBase);
  return {
    start: clip.source.range.startTick * timeBase,
    duration: clip.source.range.durationTicks * timeBase,
  };
}

function escapeFilterPath(path: string): string {
  return path.replace(/\\/gu, "\\\\").replace(/:/gu, "\\:").replace(/'/gu, "\\'");
}

function captionTimestamp(seconds: number): string {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor(totalMilliseconds % 3_600_000 / 60_000);
  const secs = Math.floor(totalMilliseconds % 60_000 / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function webVtt(sequence: Sequence): string {
  const cues = [...sequence.captions].sort((left, right) =>
    left.timelineStartFrame - right.timelineStartFrame);
  const body = cues.map((cue) => {
    const start = secondsForFrames(sequence, cue.timelineStartFrame);
    const end = secondsForFrames(
      sequence,
      cue.timelineStartFrame + cue.durationFrames,
    );
    return `${captionTimestamp(start)} --> ${captionTimestamp(end)}\n${cue.text}`;
  }).join("\n\n");
  return `WEBVTT\n\n${body}${body ? "\n" : ""}`;
}

async function resolveClips(
  engine: Engine,
  sequence: Sequence,
): Promise<ResolvedClip[]> {
  const tracks = new Map(sequence.tracks.map((track) => [track.trackId, track]));
  const resolved: ResolvedClip[] = [];
  for (const clip of sequence.clips.filter((candidate) => candidate.enabled)) {
    const track = tracks.get(clip.trackId);
    if (!track || !track.enabled || track.kind === "caption") continue;
    const artifact = engine.artifacts.get(clip.source.artifactId);
    if (!artifact.ok) throw new Error(artifact.error.message);
    const manifest = await engine.files.manifest(artifact.value.artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const streams = engine.streams.list(artifact.value.artifactId);
    if (!streams.ok) throw new Error(streams.error.message);
    const expectedHash = clip.source.kind === "timed"
      ? clip.source.range.objectHash
      : clip.source.objectHash;
    const file = manifest.value.files.find((candidate) =>
      candidate.objectHash === expectedHash);
    if (!file) throw new Error(`Source object missing for clip ${clip.clipId}`);
    resolved.push({
      clip,
      track,
      path: join(manifest.value.path, file.name),
      inputIndex: resolved.length + 1,
      hasVideo: clip.source.kind === "still"
        || streams.value.some((stream) => stream.kind === "video"),
      hasAudio: streams.value.some((stream) => stream.kind === "audio"),
    });
  }
  return resolved;
}

function inputArgs(
  sequence: Sequence,
  resolved: ResolvedClip[],
  width: number,
  height: number,
): string[] {
  const duration = secondsForFrames(
    sequence,
    Math.max(...sequence.clips.map((clip) =>
      clip.timelineStartFrame + clip.durationFrames)),
  );
  const fps = rational(sequence.frameRate);
  const args = [
    "-f", "lavfi",
    "-i", `color=c=black:s=${width}x${height}:r=${fps}:d=${duration}`,
  ];
  for (const item of resolved) {
    const outputDuration = secondsForFrames(sequence, item.clip.durationFrames);
    const source = sourceSeconds(item.clip);
    if (item.clip.source.kind === "still") {
      args.push("-loop", "1", "-t", String(outputDuration), "-i", item.path);
    } else {
      args.push(
        "-ss", String(source.start),
        "-t", String(source.duration),
        "-i", item.path,
      );
    }
  }
  return args;
}

function videoFilter(
  sequence: Sequence,
  resolved: ResolvedClip[],
  width: number,
  height: number,
): { filters: string[]; output: string } {
  const fps = rational(sequence.frameRate);
  const filters = [
    `[0:v]scale=${width}:${height},fps=${fps},format=yuv420p[vbase]`,
  ];
  let previous = "vbase";
  const visual = resolved
    .filter((item) => item.track.kind === "video" && item.hasVideo)
    .sort((left, right) =>
      left.track.ordinal - right.track.ordinal
      || left.clip.timelineStartFrame - right.clip.timelineStartFrame);
  visual.forEach((item, index) => {
    const transform = item.clip.transform;
    const fit = transform?.fit ?? "fill";
    const crop = transform
      ? `crop=iw*${1 - transform.cropLeft - transform.cropRight}:ih*${1 - transform.cropTop - transform.cropBottom}:iw*${transform.cropLeft}:ih*${transform.cropTop},`
      : "";
    const scale = fit === "fit"
      ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`
      : `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
    const duration = secondsForFrames(sequence, item.clip.durationFrames);
    const start = secondsForFrames(sequence, item.clip.timelineStartFrame);
    const source = sourceSeconds(item.clip);
    const sourceDuration = item.clip.source.kind === "timed"
      ? source.duration
      : duration;
    const playbackRate = item.clip.source.kind === "timed"
      ? (item.clip as TimedSequenceClip).speed.numerator
        / (item.clip as TimedSequenceClip).speed.denominator
      : 1;
    const clipLabel = `vclip${index}`;
    const outputLabel = `vstage${index}`;
    const opacity = transform?.opacity ?? 1;
    const reverse = item.clip.source.kind === "timed"
      && (item.clip as TimedSequenceClip).reverse
      ? "reverse,"
      : "";
    const transformFilters = transform
      ? `,scale=iw*${transform.scaleX}:ih*${transform.scaleY},rotate=${transform.rotationDegrees}*PI/180:ow=rotw(iw):oh=roth(ih):c=none`
      : "";
    const transition = clipTransitions(sequence, item.clip);
    const fadeIn = transition.incoming
      ? `,fade=t=in:st=0:d=${secondsForFrames(sequence, transition.incoming.durationFrames)}:alpha=1`
      : "";
    const fadeOut = transition.outgoing
      ? `,fade=t=out:st=${Math.max(0, duration - secondsForFrames(sequence, transition.outgoing.durationFrames))}:d=${secondsForFrames(sequence, transition.outgoing.durationFrames)}:alpha=1`
      : "";
    filters.push(
      `[${item.inputIndex}:v]${crop}${reverse}${scale}${transformFilters},fps=${fps},trim=duration=${sourceDuration},setpts=(PTS-STARTPTS)/${playbackRate},tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},setpts=PTS+${start}/TB,format=rgba,colorchannelmixer=aa=${opacity}${fadeIn}${fadeOut}[${clipLabel}]`,
    );
    const x = `(W-w)/2+${transform?.positionX ?? 0}`;
    const y = `(H-h)/2+${transform?.positionY ?? 0}`;
    filters.push(
      `[${previous}][${clipLabel}]overlay=${x}:${y}:enable='between(t,${start},${start + duration})'[${outputLabel}]`,
    );
    previous = outputLabel;
  });
  return { filters, output: previous };
}

function clipTransitions(sequence: Sequence, clip: SequenceClip) {
  return {
    incoming: sequence.transitions.find((transition) =>
      transition.kind === "dissolve" && transition.incomingClipId === clip.clipId),
    outgoing: sequence.transitions.find((transition) =>
      transition.kind === "dissolve" && transition.outgoingClipId === clip.clipId),
  };
}

function atempoFilters(speed: number): string[] {
  const filters: string[] = [];
  let remaining = speed;
  while (remaining > 2) {
    filters.push("atempo=2");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) > 0.000001) {
    filters.push(`atempo=${remaining}`);
  }
  return filters;
}

function audioFilter(
  sequence: Sequence,
  resolved: ResolvedClip[],
  duration: number,
): { filters: string[]; output: string } {
  const filters = [
    `anullsrc=r=${sequence.audioSampleRateHz}:cl=stereo,atrim=duration=${duration}[asilence]`,
  ];
  const audio = resolved.filter((item) => {
    if (!item.hasAudio) return false;
    if (item.track.kind === "audio") return !item.track.muted;
    const clip = item.clip;
    if (item.track.kind !== "video" || clip.source.kind !== "timed") return false;
    return (clip as TimedSequenceClip).audioPolicy !== "mute";
  });
  const labels = ["[asilence]"];
  audio.forEach((item, index) => {
    const clipDuration = secondsForFrames(sequence, item.clip.durationFrames);
    const start = secondsForFrames(sequence, item.clip.timelineStartFrame);
    const audioSettings = item.clip.audio;
    const timed = item.clip as TimedSequenceClip;
    const speed = timed.speed.numerator / timed.speed.denominator;
    const gain = audioSettings?.muted
      ? 0
      : 10 ** ((audioSettings?.gainDb ?? 0) / 20);
    const transitions = clipTransitions(sequence, item.clip);
    const antiClickFade = Math.min(0.005, clipDuration / 2);
    const fadeIn = Math.max(
      antiClickFade,
      secondsForFrames(sequence, audioSettings?.fadeInFrames ?? 0),
      transitions.incoming
        ? secondsForFrames(sequence, transitions.incoming.durationFrames)
        : 0,
    );
    const fadeOut = Math.max(
      antiClickFade,
      secondsForFrames(sequence, audioSettings?.fadeOutFrames ?? 0),
      transitions.outgoing
        ? secondsForFrames(sequence, transitions.outgoing.durationFrames)
        : 0,
    );
    const chain = [
      ...(timed.reverse ? ["areverse"] : []),
      ...atempoFilters(speed),
      "apad",
      `atrim=duration=${clipDuration}`,
      "asetpts=PTS-STARTPTS",
      `volume=${gain}`,
      ...(fadeIn > 0 ? [`afade=t=in:d=${fadeIn}`] : []),
      ...(fadeOut > 0
        ? [`afade=t=out:st=${Math.max(0, clipDuration - fadeOut)}:d=${fadeOut}`]
        : []),
      `adelay=${Math.round(start * 1000)}|${Math.round(start * 1000)}`,
    ];
    const label = `aclip${index}`;
    filters.push(`[${item.inputIndex}:a]${chain.join(",")}[${label}]`);
    labels.push(`[${label}]`);
  });
  filters.push(
    `${labels.join("")}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0[aout]`,
  );
  return { filters, output: "aout" };
}

export function buildSequenceFfmpegArgs(
  sequence: Sequence,
  resolved: ResolvedClip[],
  width: number,
  height: number,
  outputPath: string,
  captionPath?: string,
): string[] {
  const durationFrames = Math.max(
    ...sequence.clips.map((clip) =>
      clip.timelineStartFrame + clip.durationFrames),
  );
  const duration = secondsForFrames(sequence, durationFrames);
  const video = videoFilter(sequence, resolved, width, height);
  const audio = audioFilter(sequence, resolved, duration);
  const filters = [...video.filters, ...audio.filters];
  let videoOutput = video.output;
  if (captionPath) {
    filters.push(
      `[${videoOutput}]subtitles='${escapeFilterPath(captionPath)}'[vcaptioned]`,
    );
    videoOutput = "vcaptioned";
  }
  return [
    ...inputArgs(sequence, resolved, width, height),
    "-filter_complex", filters.join(";"),
    "-map", `[${videoOutput}]`,
    ...H264_MEDIUM,
    "-pix_fmt", "yuv420p",
    "-map", `[${audio.output}]`,
    ...AUDIO_OPTS,
    "-t", String(duration),
    "-movflags", "+faststart",
    "-y", outputPath,
  ];
}

export function registerExportSequenceJob(engine: Engine): void {
  registerJobHandler("export_sequence", async (payload, context) => {
    const request = payload as unknown as ExportSequencePayload;
    const validation = await validateSequenceExport(engine, {
      sequence_revision: request.sequenceRevision,
      orientation: request.orientation,
      captions: request.captions,
    });
    if (!validation.valid) {
      throw new Error(validation.errors.map((issue) => issue.message).join("; "));
    }
    const sequence = engine.sequences.getPrimary();
    const resolved = await resolveClips(engine, sequence);
    const workspace = await mkdtemp(join(tmpdir(), "videobook-export-"));
    const outputFilename = "original.mp4";
    const outputPath = join(workspace, outputFilename);
    const captionPath = join(workspace, "captions.vtt");
    try {
      if (request.captions !== "omit") {
        await writeFile(captionPath, webVtt(sequence), "utf8");
      }
      await runFfmpeg(buildSequenceFfmpegArgs(
        sequence,
        resolved,
        validation.width,
        validation.height,
        outputPath,
        request.captions === "burn-in" ? captionPath : undefined,
      ), { signal: context.signal });
      const slug = `final-${request.orientation}-${request.captions}-${request.sequenceRevision.slice(0, 8)}`;
      let final = engine.artifacts.get(slug);
      if (!final.ok) {
        final = await engine.artifacts.create("final", slug);
      }
      if (!final.ok) throw new Error(final.error.message);
      await replaceArtifactFileFromPath(
        engine,
        request.bookId,
        final.value.artifactId,
        outputFilename,
        outputPath,
      );
      if (request.captions === "sidecar") {
        await replaceArtifactFileFromPath(
          engine,
          request.bookId,
          final.value.artifactId,
          "captions.vtt",
          captionPath,
        );
      }
      const manifest = await engine.files.manifest(final.value.artifactId);
      if (!manifest.ok) throw new Error(manifest.error.message);
      const output = manifest.value.files.find((file) =>
        file.name === outputFilename);
      if (!output) throw new Error("Rendered MP4 was not persisted");
      const persistedPath = join(manifest.value.path, outputFilename);
      const probe = await probeVideo(persistedPath, { signal: context.signal });
      const registered = engine.streams.list(final.value.artifactId);
      if (!registered.ok) throw new Error(registered.error.message);
      if (
        probe.videoStream
        && !registered.value.some((stream) =>
          stream.kind === "video" && stream.objectHash === output.objectHash)
      ) {
        const stream = await engine.streams.register({
          artifactId: final.value.artifactId,
          sourcePath: outputFilename,
          objectHash: output.objectHash,
          streamIndex: probe.videoStream.index,
          kind: "video",
          timeBase: probe.videoStream.timeBase,
          durationTicks: probe.videoStream.durationTicks,
          codec: probe.videoStream.codec,
          video: probe.videoStream.video!,
        });
        if (!stream.ok) throw new Error(stream.error.message);
      }
      if (
        probe.audioStream
        && !registered.value.some((stream) =>
          stream.kind === "audio" && stream.objectHash === output.objectHash)
      ) {
        const stream = await engine.streams.register({
          artifactId: final.value.artifactId,
          sourcePath: outputFilename,
          objectHash: output.objectHash,
          streamIndex: probe.audioStream.index,
          kind: "audio",
          timeBase: probe.audioStream.timeBase,
          durationTicks: probe.audioStream.durationTicks,
          codec: probe.audioStream.codec,
          audio: probe.audioStream.audio!,
        });
        if (!stream.ok) throw new Error(stream.error.message);
      }
      const provenance = {
        sequenceId: sequence.sequenceId,
        sequenceRevision: request.sequenceRevision,
        renderer: "ffmpeg",
        rendererVersion: "videobook-canonical-v1",
        settings: {
          orientation: request.orientation,
          captions: request.captions,
          width: validation.width,
          height: validation.height,
          frameRate: sequence.frameRate,
          videoCodec: "h264",
          audioCodec: "aac",
        },
        inputObjectHashes: validation.inputObjectHashes,
        outputObjectHash: output.objectHash,
        renderedAt: new Date().toISOString(),
      };
      const metadata = await engine.metadata.artifacts.write(
        final.value.artifactId,
        "export",
        provenance,
      );
      if (!metadata.ok) throw new Error(metadata.error.message);
      return {
        success: true,
        artifactId: final.value.artifactId,
        artifactSlug: final.value.slug,
        output: outputFilename,
        outputObjectHash: output.objectHash,
        provenance,
      };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
}
