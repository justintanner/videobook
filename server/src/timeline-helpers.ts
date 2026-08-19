import { join } from "node:path";
import type {
  Artifact,
  ArtifactStream,
  ClipAudio,
  ClipPlacement,
  EditIntent,
  EditOperation,
  Engine,
  MediaSourceSnapshot,
  Sequence,
  SequenceClip,
} from "videobook-engine";
import {
  findAudioFile,
  findPrimaryMediaFile,
  findVideoFile,
  MVP_CONTRACT_VERSION,
  sourceTicksToSequenceFrames,
} from "videobook-engine";
import { v7 as uuidv7 } from "uuid";
import { probeVideo } from "./ffmpeg.js";
import type { ToolResult } from "./tools/tool-def.js";

export type TimelineRender = "landscape" | "portrait" | "square";

interface TimelineSlot {
  id: string;
  artifactId: string;
  volume?: number;
  audioFadeIn?: number;
  audioFadeOut?: number;
}

interface TimelineAudio {
  id: string;
  artifactId: string;
  startFrame: number;
  durationFrames: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
}

interface Timeline {
  bookId: string;
  render: TimelineRender;
  slots: TimelineSlot[];
  audio: TimelineAudio[];
}

export interface TimelineSlotInput extends Omit<TimelineSlot, "id"> {
  id?: string;
}

interface TimelineAudioInput extends Omit<TimelineAudio, "id"> {
  id?: string;
}

export interface TimelineInput {
  render: TimelineRender;
  slots?: TimelineSlotInput[];
  audio?: TimelineAudioInput[];
}

type TimelineWriteResult =
  | { ok: true; value: Timeline }
  | { ok: false; error: { message: string } };

const CANVAS: Record<TimelineRender, { width: number; height: number }> = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
};

function orientation(sequence: Sequence): TimelineRender {
  if (sequence.width === sequence.height) return "square";
  return sequence.width > sequence.height ? "landscape" : "portrait";
}

function clipsForTrack(
  sequence: Sequence,
  trackId: string,
): SequenceClip[] {
  return sequence.clips
    .filter((clip) => clip.trackId === trackId)
    .sort((left, right) =>
      left.timelineStartFrame - right.timelineStartFrame
      || left.clipId.localeCompare(right.clipId)
    );
}

function gainDbToVolume(gainDb: number): number {
  if (gainDb <= -120) return 0;
  return Math.round(100_000_000 * (10 ** (gainDb / 20))) / 1_000_000;
}

function volumeToGainDb(volume: number | undefined): number {
  if (volume === undefined) return 0;
  if (volume <= 0) return -120;
  return 20 * Math.log10(volume / 100);
}

function clipVolume(clip: SequenceClip): Pick<TimelineSlot, "volume"> {
  return clip.audio ? { volume: gainDbToVolume(clip.audio.gainDb) } : {};
}

function secondsFromFrames(frames: number, sequence: Sequence): number {
  return frames * sequence.frameRate.denominator / sequence.frameRate.numerator;
}

function millisecondsFromFrames(frames: number, sequence: Sequence): number {
  return Math.round(secondsFromFrames(frames, sequence) * 1_000_000) / 1_000;
}

function framesFromSeconds(seconds: number, sequence: Sequence): number {
  return Math.max(
    0,
    Math.round(seconds * sequence.frameRate.numerator / sequence.frameRate.denominator),
  );
}

function framesFromMilliseconds(milliseconds: number, sequence: Sequence): number {
  return framesFromSeconds(milliseconds / 1_000, sequence);
}

export function readTimeline(engine: Engine): Timeline {
  const sequence = engine.sequences.getPrimary();
  const primaryVideoTrack = sequence.tracks
    .filter((track) => track.kind === "video")
    .sort((left, right) => left.ordinal - right.ordinal)[0];
  const audioTrackIds = new Set(
    sequence.tracks
      .filter((track) => track.kind === "audio")
      .map((track) => track.trackId),
  );
  const slots = primaryVideoTrack
    ? clipsForTrack(sequence, primaryVideoTrack.trackId).map((clip) => ({
        id: clip.clipId,
        artifactId: clip.source.artifactId,
        ...clipVolume(clip),
        ...(clip.audio
          ? {
              audioFadeIn: secondsFromFrames(
                clip.audio.fadeInFrames,
                sequence,
              ),
              audioFadeOut: secondsFromFrames(
                clip.audio.fadeOutFrames,
                sequence,
              ),
            }
          : {}),
      }))
    : [];
  const audio = sequence.clips
    .filter((clip) => audioTrackIds.has(clip.trackId))
    .sort((left, right) =>
      left.timelineStartFrame - right.timelineStartFrame
      || left.clipId.localeCompare(right.clipId)
    )
    .map((clip) => ({
      id: clip.clipId,
      artifactId: clip.source.artifactId,
      startFrame: clip.timelineStartFrame,
      durationFrames: clip.durationFrames,
      ...clipVolume(clip),
      ...(clip.audio
        ? {
            fadeIn: millisecondsFromFrames(clip.audio.fadeInFrames, sequence),
            fadeOut: millisecondsFromFrames(clip.audio.fadeOutFrames, sequence),
          }
        : {}),
    }));
  return {
    bookId: engine.book.get().bookId,
    render: orientation(sequence),
    slots,
    audio,
  };
}

export function timelinePayload(timeline: Timeline): Record<string, unknown> {
  return {
    book_id: timeline.bookId,
    render: timeline.render,
    slots: timeline.slots.map((slot) => ({
      id: slot.id,
      artifact_id: slot.artifactId,
      ...(slot.volume === undefined ? {} : { volume: slot.volume }),
      ...(slot.audioFadeIn === undefined ? {} : { audioFadeIn: slot.audioFadeIn }),
      ...(slot.audioFadeOut === undefined ? {} : { audioFadeOut: slot.audioFadeOut }),
    })),
    audio: timeline.audio.map((clip) => ({
      id: clip.id,
      artifact_id: clip.artifactId,
      start_frame: clip.startFrame,
      duration_frames: clip.durationFrames,
      ...(clip.volume === undefined ? {} : { volume: clip.volume }),
      ...(clip.fadeIn === undefined ? {} : { fadeIn: clip.fadeIn }),
      ...(clip.fadeOut === undefined ? {} : { fadeOut: clip.fadeOut }),
    })),
  };
}

export function timelineInput(timeline: Timeline): TimelineInput {
  return {
    render: timeline.render,
    slots: timeline.slots.map((slot) => ({
      id: slot.id,
      artifactId: slot.artifactId,
      ...(slot.volume === undefined ? {} : { volume: slot.volume }),
      ...(slot.audioFadeIn === undefined ? {} : { audioFadeIn: slot.audioFadeIn }),
      ...(slot.audioFadeOut === undefined ? {} : { audioFadeOut: slot.audioFadeOut }),
    })),
    audio: timeline.audio.map((clip) => ({
      id: clip.id,
      artifactId: clip.artifactId,
      startFrame: clip.startFrame,
      durationFrames: clip.durationFrames,
      ...(clip.volume === undefined ? {} : { volume: clip.volume }),
      ...(clip.fadeIn === undefined ? {} : { fadeIn: clip.fadeIn }),
      ...(clip.fadeOut === undefined ? {} : { fadeOut: clip.fadeOut }),
    })),
  };
}

function timelineSuccessResult(timeline: Timeline): TimelineWriteResult {
  return { ok: true, value: timeline };
}

function timelineError(error: unknown): TimelineWriteResult {
  return {
    ok: false,
    error: {
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function requiredArtifact(engine: Engine, reference: string): Artifact {
  const result = engine.artifacts.get(reference);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function requiredTimedStream(
  engine: Engine,
  artifact: Artifact,
  kind: "video" | "audio",
): Promise<ArtifactStream> {
  const existing = engine.streams.list(artifact.artifactId);
  if (!existing.ok) throw new Error(existing.error.message);
  const registered = existing.value.find((stream) => stream.kind === kind);
  if (registered) return registered;

  const manifest = await engine.files.manifest(artifact.artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = kind === "video"
    ? findVideoFile(manifest.value.files)
    : findAudioFile(manifest.value.files, artifact.kind)
      ?? findPrimaryMediaFile(manifest.value.files, artifact.kind);
  if (!file) {
    throw new Error(`${artifact.label ?? artifact.artifactId} has no ${kind} source file`);
  }
  const probe = await probeVideo(join(manifest.value.path, file.name));
  const stream = kind === "video" ? probe.videoStream : probe.audioStream;
  if (!stream) throw new Error(`${artifact.label ?? artifact.artifactId} has no ${kind} stream`);
  const result = await engine.streams.register({
    artifactId: artifact.artifactId,
    sourcePath: file.name,
    objectHash: file.objectHash,
    streamIndex: stream.index,
    kind,
    timeBase: stream.timeBase,
    durationTicks: stream.durationTicks,
    codec: stream.codec,
    ...(stream.video ? { video: stream.video } : {}),
    ...(stream.audio ? { audio: stream.audio } : {}),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function slotSource(
  engine: Engine,
  artifactId: string,
): Promise<{ source: MediaSourceSnapshot; durationFrames: number }> {
  const artifact = requiredArtifact(engine, artifactId);
  const sequence = engine.sequences.getPrimary();
  if (artifact.kind === "image") {
    const manifest = await engine.files.manifest(artifact.artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const file = findPrimaryMediaFile(manifest.value.files, artifact.kind);
    if (!file) throw new Error(`${artifact.label ?? artifact.artifactId} has no image source file`);
    return {
      source: {
        kind: "still",
        artifactId: artifact.artifactId,
        sourcePath: file.name,
        objectHash: file.objectHash,
      },
      durationFrames: 90,
    };
  }
  const stream = await requiredTimedStream(engine, artifact, "video");
  return {
    source: {
      kind: "timed",
      artifactId: artifact.artifactId,
      range: {
        streamId: stream.streamId,
        objectHash: stream.objectHash,
        startTick: 0,
        durationTicks: stream.durationTicks,
        timeBase: stream.timeBase,
      },
    },
    durationFrames: Math.max(
      1,
      sourceTicksToSequenceFrames(
        stream.durationTicks,
        stream.timeBase,
        sequence.frameRate,
      ),
    ),
  };
}

async function audioSource(
  engine: Engine,
  artifactId: string,
): Promise<{
  source: Extract<MediaSourceSnapshot, { kind: "timed" }>;
  sourceFrames: number;
}> {
  const artifact = requiredArtifact(engine, artifactId);
  const sequence = engine.sequences.getPrimary();
  const stream = await requiredTimedStream(engine, artifact, "audio");
  return {
    source: {
      kind: "timed",
      artifactId: artifact.artifactId,
      range: {
        streamId: stream.streamId,
        objectHash: stream.objectHash,
        startTick: 0,
        durationTicks: stream.durationTicks,
        timeBase: stream.timeBase,
      },
    },
    sourceFrames: Math.max(
      1,
      sourceTicksToSequenceFrames(
        stream.durationTicks,
        stream.timeBase,
        sequence.frameRate,
      ),
    ),
  };
}

function clipAudio(
  durationFrames: number,
  volume: number | undefined,
  requestedFadeInFrames: number,
  requestedFadeOutFrames: number,
): ClipAudio | undefined {
  if (
    volume === undefined
    && requestedFadeInFrames === 0
    && requestedFadeOutFrames === 0
  ) {
    return undefined;
  }
  const fadeInFrames = Math.min(durationFrames, requestedFadeInFrames);
  const fadeOutFrames = Math.min(
    durationFrames - fadeInFrames,
    requestedFadeOutFrames,
  );
  return {
    gainDb: volumeToGainDb(volume),
    muted: volume === 0,
    fadeInFrames,
    fadeOutFrames,
  };
}

function overlaps(
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean {
  return left.start < right.end && right.start < left.end;
}

async function ensureAudioTracks(
  engine: Engine,
  requiredCount: number,
): Promise<Sequence> {
  let sequence = engine.sequences.getPrimary();
  while (
    sequence.tracks.filter((track) => track.kind === "audio").length
    < requiredCount
  ) {
    const result = await engine.sequences.addTrack(sequence.sequenceId, {
      kind: "audio",
    });
    if (!result.ok) throw new Error(result.error.message);
    sequence = result.value;
  }
  return sequence;
}

export async function writeTimeline(
  engine: Engine,
  input: TimelineInput,
): Promise<TimelineWriteResult> {
  try {
    let sequence = engine.sequences.getPrimary();
    const canvas = CANVAS[input.render];
    const canvasResult = await engine.sequences.updateCanvas(
      sequence.sequenceId,
      canvas,
    );
    if (!canvasResult.ok) return timelineError(canvasResult.error.message);
    sequence = canvasResult.value;

    const slots = input.slots ?? [];
    const audio = input.audio ?? [];
    const slotSources = await Promise.all(
      slots.map((slot) => slotSource(engine, slot.artifactId)),
    );
    const audioSources = await Promise.all(
      audio.map((clip) => audioSource(engine, clip.artifactId)),
    );

    const lanes: Array<Array<{ start: number; end: number }>> = [];
    const audioLaneIndexes = audio.map((clip) => {
      const range = {
        start: clip.startFrame,
        end: clip.startFrame + clip.durationFrames,
      };
      let lane = lanes.findIndex((entries) =>
        entries.every((entry) => !overlaps(entry, range))
      );
      if (lane < 0) {
        lane = lanes.length;
        lanes.push([]);
      }
      lanes[lane]!.push(range);
      return lane;
    });
    sequence = await ensureAudioTracks(engine, lanes.length);

    const videoTrack = sequence.tracks
      .filter((track) => track.kind === "video")
      .sort((left, right) => left.ordinal - right.ordinal)[0];
    if (!videoTrack) throw new Error("Primary sequence has no video track");
    const audioTracks = sequence.tracks
      .filter((track) => track.kind === "audio")
      .sort((left, right) => left.ordinal - right.ordinal);

    const operations: EditOperation[] = [];
    const mediaTrackIds = sequence.tracks
      .filter((track) => track.kind === "video" || track.kind === "audio")
      .map((track) => track.trackId);
    const mediaClipIds = new Set(
      sequence.clips
        .filter((clip) => mediaTrackIds.includes(clip.trackId))
        .map((clip) => clip.clipId),
    );
    const existing = sequence.clips.filter((clip) => mediaClipIds.has(clip.clipId));
    const maxEnd = existing.reduce(
      (maximum, clip) =>
        Math.max(maximum, clip.timelineStartFrame + clip.durationFrames),
      0,
    );
    if (maxEnd > 0) {
      operations.push({
        kind: "remove-range",
        trackIds: mediaTrackIds,
        range: {
          sequenceId: sequence.sequenceId,
          startFrame: 0,
          durationFrames: maxEnd,
        },
        ripple: false,
      });
    }

    let slotStartFrame = 0;
    for (const [index, slot] of slots.entries()) {
      const source = slotSources[index]!;
      const placement: ClipPlacement = {
        trackId: videoTrack.trackId,
        timelineStartFrame: slotStartFrame,
        durationFrames: source.durationFrames,
        source: source.source,
        ...(source.source.kind === "timed"
          ? {
              speed: { numerator: 1, denominator: 1 },
              reverse: false,
              audioPolicy: "preserve-pitch" as const,
            }
          : {}),
        ...(clipAudio(
          source.durationFrames,
          slot.volume,
          framesFromSeconds(slot.audioFadeIn ?? 0, sequence),
          framesFromSeconds(slot.audioFadeOut ?? 0, sequence),
        )
          ? {
              audio: clipAudio(
                source.durationFrames,
                slot.volume,
                framesFromSeconds(slot.audioFadeIn ?? 0, sequence),
                framesFromSeconds(slot.audioFadeOut ?? 0, sequence),
              ),
            }
          : {}),
      };
      operations.push({
        kind: "insert-clip",
        ...(slot.id ? { clipId: slot.id } : { clipId: uuidv7() }),
        placement,
        mode: "overwrite",
      });
      slotStartFrame += source.durationFrames;
    }

    for (const [index, clip] of audio.entries()) {
      const source = audioSources[index]!;
      const track = audioTracks[audioLaneIndexes[index]!];
      if (!track) throw new Error("Primary sequence has no audio track");
      const audioSettings = clipAudio(
        clip.durationFrames,
        clip.volume,
        framesFromMilliseconds(clip.fadeIn ?? 0, sequence),
        framesFromMilliseconds(clip.fadeOut ?? 0, sequence),
      );
      operations.push({
        kind: "insert-clip",
        ...(clip.id ? { clipId: clip.id } : { clipId: uuidv7() }),
        placement: {
          trackId: track.trackId,
          timelineStartFrame: clip.startFrame,
          durationFrames: clip.durationFrames,
          source: source.source,
          speed: {
            numerator: source.sourceFrames,
            denominator: clip.durationFrames,
          },
          reverse: false,
          audioPolicy: "preserve-pitch",
          ...(audioSettings ? { audio: audioSettings } : {}),
        },
        mode: "overwrite",
      });
    }

    if (operations.length === 0) return timelineSuccessResult(readTimeline(engine));
    const intent: EditIntent = {
      intentVersion: MVP_CONTRACT_VERSION,
      commandId: uuidv7(),
      sequenceId: sequence.sequenceId,
      baseRevision: sequence.revision,
      actor: "videobook.timeline-compat",
      sourceSurface: "slash",
      confirmationPolicy: "always",
      operations,
    };
    const preview = engine.edits.preview(intent);
    if (!preview.ok) return timelineError(preview.error.message);
    if (!preview.value.valid) {
      return timelineError(
        preview.value.conflicts.map((conflict) => conflict.message).join("; ")
        || "Timeline edit conflicts with the current sequence",
      );
    }
    const committed = await engine.edits.commit(intent, preview.value.previewHash);
    if (!committed.ok) return timelineError(committed.error.message);
    return timelineSuccessResult(readTimeline(engine));
  } catch (error) {
    return timelineError(error);
  }
}

export function timelineSuccess(timeline: Timeline): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(timelinePayload(timeline)) }],
  };
}

export function timelineFailure(message: string): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export function slotIndex(value: string): number | null {
  const match = /^s(\d+)$/.exec(value);
  if (!match) return null;
  const index = Number.parseInt(match[1]!, 10) - 1;
  return index >= 0 ? index : null;
}

export function resolveArtifact(
  engine: Engine,
  reference: string,
): Artifact | null {
  const result = engine.artifacts.get(reference);
  return result.ok ? result.value : null;
}

const SLOT_REF_PATTERN = /@s(\d{1,3})\b/giu;

export function timelineSlotArtifactIds(engine: Engine): string[] {
  return readTimeline(engine).slots.map((slot) => slot.artifactId);
}

/** Replace `@s01`-style timeline slot refs with `@<artifact-id>` tokens. */
export function expandTimelineSlotRefs(
  text: string,
  slotArtifactIds: readonly string[],
): string {
  return text.replace(SLOT_REF_PATTERN, (token: string, digits: string) => {
    const index = Number.parseInt(digits, 10) - 1;
    const artifactId = index >= 0 ? slotArtifactIds[index] : undefined;
    return artifactId ? `@${artifactId}` : token;
  });
}
