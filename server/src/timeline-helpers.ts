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
  isUuidV7,
  normalizeRational,
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
  return clip.audio ? { volume: clip.audio.muted ? 0 : gainDbToVolume(clip.audio.gainDb) } : {};
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
  const manifest = await engine.files.manifest(artifact.artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = kind === "video"
    ? findVideoFile(manifest.value.files)
    : findAudioFile(manifest.value.files, artifact.kind)
      ?? findPrimaryMediaFile(manifest.value.files, artifact.kind);
  if (!file) {
    throw new Error(`${artifact.label ?? artifact.artifactId} has no ${kind} source file`);
  }
  const existing = engine.streams.list(artifact.artifactId);
  if (!existing.ok) throw new Error(existing.error.message);
  const registered = existing.value.find((stream) => stream.kind === kind
    && stream.sourcePath === file.name
    && stream.objectHash === file.objectHash);
  if (registered) return registered;

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
      durationFrames: framesFromSeconds(3, sequence),
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

interface PlannedClip {
  clipId: string;
  existing?: SequenceClip;
  placement: ClipPlacement;
}

function clipAudio(
  durationFrames: number,
  volume: number | undefined,
  requestedFadeInFrames: number | undefined,
  requestedFadeOutFrames: number | undefined,
  existing?: SequenceClip,
): ClipAudio | undefined {
  const previous = existing?.audio;
  if (!previous && volume === undefined && !requestedFadeInFrames && !requestedFadeOutFrames) {
    return undefined;
  }
  const preserveGain = previous && (volume === undefined || volume === clipVolume(existing!).volume);
  const fadeInFrames = Math.min(durationFrames, requestedFadeInFrames ?? previous?.fadeInFrames ?? 0);
  const fadeOutFrames = Math.min(durationFrames - fadeInFrames, requestedFadeOutFrames ?? previous?.fadeOutFrames ?? 0);
  return {
    gainDb: preserveGain ? previous.gainDb : volumeToGainDb(volume),
    muted: preserveGain ? previous.muted : volume === 0,
    fadeInFrames,
    fadeOutFrames,
  };
}

function placementFromClip(clip: SequenceClip): ClipPlacement {
  return {
    trackId: clip.trackId,
    timelineStartFrame: clip.timelineStartFrame,
    durationFrames: clip.durationFrames,
    source: clip.source,
    ...("speed" in clip ? { speed: clip.speed, reverse: clip.reverse, audioPolicy: clip.audioPolicy } : {}),
    ...(clip.transform ? { transform: clip.transform } : {}),
    ...(clip.audio ? { audio: clip.audio } : {}),
  };
}

function validateTimelineInput(engine: Engine, sequence: Sequence, input: TimelineInput, trackIds: Set<string>): void {
  const ids = new Set<string>();
  for (const entry of [...input.slots ?? [], ...input.audio ?? []]) {
    if (entry.id) {
      if (!isUuidV7(entry.id)) throw new Error(`Clip ID must be a UUIDv7: ${entry.id}`);
      if (ids.has(entry.id)) throw new Error(`Duplicate clip ID: ${entry.id}`);
      ids.add(entry.id);
      const existing = sequence.clips.find((clip) => clip.clipId === entry.id);
      if (existing && !trackIds.has(existing.trackId)) {
        throw new Error(`Clip belongs to a track outside the compatibility timeline: ${entry.id}`);
      }
    }
    requiredArtifact(engine, entry.artifactId);
  }
  for (const clip of input.audio ?? []) {
    if (!Number.isSafeInteger(clip.startFrame) || clip.startFrame < 0
      || !Number.isSafeInteger(clip.durationFrames) || clip.durationFrames < 1
      || !Number.isSafeInteger(clip.startFrame + clip.durationFrames)) {
      throw new Error("Audio timeline range must use safe non-negative integer frames");
    }
  }
}

async function planSlots(engine: Engine, sequence: Sequence, slots: TimelineSlotInput[], trackId: string): Promise<PlannedClip[]> {
  const previous = clipsForTrack(sequence, trackId);
  const retainedIds = new Set(slots.map((slot) => slot.id));
  const retained = previous.filter((clip) => retainedIds.has(clip.clipId));
  const preservesOrder = retained.length === slots.length && slots.every((slot, index) =>
    slot.id === retained[index]?.clipId && slot.artifactId === retained[index]?.source.artifactId);
  let nextStart = 0;
  const planned: PlannedClip[] = [];
  for (const slot of slots) {
    const existing = previous.find((clip) => clip.clipId === slot.id && clip.source.artifactId === slot.artifactId);
    const source = existing ? undefined : await slotSource(engine, slot.artifactId);
    const base: ClipPlacement = existing ? placementFromClip(existing) : {
      trackId,
      timelineStartFrame: nextStart,
      durationFrames: source!.durationFrames,
      source: source!.source,
      ...(source!.source.kind === "timed" ? {
        speed: { numerator: 1, denominator: 1 }, reverse: false, audioPolicy: "preserve-pitch" as const,
      } : {}),
    };
    const audio = clipAudio(base.durationFrames, slot.volume,
      slot.audioFadeIn === undefined ? undefined : framesFromSeconds(slot.audioFadeIn, sequence),
      slot.audioFadeOut === undefined ? undefined : framesFromSeconds(slot.audioFadeOut, sequence), existing);
    const placement = {
      ...base,
      timelineStartFrame: preservesOrder
        ? base.timelineStartFrame - previous.filter((clip) => !retainedIds.has(clip.clipId)
          && clip.timelineStartFrame < base.timelineStartFrame).reduce((total, clip) => total + clip.durationFrames, 0)
        : nextStart,
      ...(audio ? { audio } : {}),
    };
    nextStart = placement.timelineStartFrame + placement.durationFrames;
    if (!Number.isSafeInteger(nextStart)) throw new Error("Timeline exceeds safe integer precision");
    planned.push({ clipId: slot.id ?? uuidv7(), existing, placement });
  }
  return planned;
}

async function planAudio(engine: Engine, sequence: Sequence, audio: TimelineAudioInput[]): Promise<PlannedClip[]> {
  const audioTracks = sequence.tracks.filter((track) => track.kind === "audio");
  const planned: PlannedClip[] = [];
  for (const clip of audio) {
    const existing = sequence.clips.find((candidate) => candidate.clipId === clip.id
      && candidate.source.artifactId === clip.artifactId
      && audioTracks.some((track) => track.trackId === candidate.trackId));
    const source = existing ? undefined : await audioSource(engine, clip.artifactId);
    const base: ClipPlacement = existing ? placementFromClip(existing) : {
      trackId: "", timelineStartFrame: clip.startFrame, durationFrames: clip.durationFrames,
      source: source!.source, reverse: false, audioPolicy: "preserve-pitch",
      speed: normalizeRational({ numerator: source!.sourceFrames, denominator: clip.durationFrames }),
    };
    const speed = existing && "speed" in existing && existing.durationFrames !== clip.durationFrames
      ? normalizeRational({ numerator: existing.speed.numerator * existing.durationFrames,
          denominator: existing.speed.denominator * clip.durationFrames })
      : base.speed;
    const settings = clipAudio(clip.durationFrames, clip.volume,
      clip.fadeIn === undefined ? undefined : framesFromMilliseconds(clip.fadeIn, sequence),
      clip.fadeOut === undefined ? undefined : framesFromMilliseconds(clip.fadeOut, sequence), existing);
    planned.push({ clipId: clip.id ?? uuidv7(), existing, placement: {
      ...base, timelineStartFrame: clip.startFrame, durationFrames: clip.durationFrames,
      ...(speed ? { speed } : {}), ...(settings ? { audio: settings } : {}),
    } });
  }
  return planned;
}

function endFrame(clip: Pick<ClipPlacement, "timelineStartFrame" | "durationFrames">): number {
  return clip.timelineStartFrame + clip.durationFrames;
}

interface AudioLane {
  trackId: string;
  enabled: boolean;
  muted: boolean;
  solo: boolean;
  locked: boolean;
  clips: ClipPlacement[];
}

function allocateAudioLanes(sequence: Sequence, clips: PlannedClip[]): AudioLane[] {
  const tracks = sequence.tracks.filter((track) => track.kind === "audio").sort((left, right) => left.ordinal - right.ordinal);
  const lanes: AudioLane[] = tracks.map((track) => ({ ...track, clips: [] }));
  const ordered = [...clips].sort((left, right) => Number(!left.existing || left.placement.timelineStartFrame !== left.existing.timelineStartFrame)
    - Number(!right.existing || right.placement.timelineStartFrame !== right.existing.timelineStartFrame));
  for (const clip of ordered) {
    const fits = (lane: typeof lanes[number]) => lane.clips.every((entry) =>
      entry.timelineStartFrame >= endFrame(clip.placement) || clip.placement.timelineStartFrame >= endFrame(entry));
    const preferred = lanes.find((lane) => lane.trackId === clip.existing?.trackId);
    const settings = { enabled: preferred?.enabled ?? true, muted: preferred?.muted ?? false, solo: preferred?.solo ?? false };
    let lane = preferred && fits(preferred) ? preferred : lanes.find((candidate) => !candidate.locked
      && candidate.enabled === settings.enabled && candidate.muted === settings.muted && candidate.solo === settings.solo && fits(candidate));
    if (!lane) {
      lane = { trackId: uuidv7(), locked: false, clips: [], ...settings };
      lanes.push(lane);
    }
    lane.clips.push(clip.placement);
    clip.placement.trackId = lane.trackId;
  }
  return lanes.slice(tracks.length);
}

function timelineOperations(sequence: Sequence, planned: PlannedClip[], managedTracks: Set<string>): EditOperation[] {
  const retained = new Set(planned.filter((clip) => clip.existing).map((clip) => clip.clipId));
  const operations: EditOperation[] = [];
  for (const transition of sequence.transitions) {
    const outgoing = planned.find((clip) => clip.clipId === transition.outgoingClipId && clip.existing)?.placement;
    const incoming = planned.find((clip) => clip.clipId === transition.incomingClipId && clip.existing)?.placement;
    if (!outgoing || !incoming) continue;
    if (outgoing.trackId !== incoming.trackId || endFrame(outgoing) !== incoming.timelineStartFrame
      || transition.durationFrames > Math.min(outgoing.durationFrames, incoming.durationFrames)) {
      operations.push({ kind: "set-transition", transition: null,
        outgoingClipId: transition.outgoingClipId, incomingClipId: transition.incomingClipId });
    }
  }
  for (const clip of sequence.clips
    .filter((clip) => managedTracks.has(clip.trackId) && !retained.has(clip.clipId))
  ) {
    operations.push({ kind: "remove-range", trackIds: [clip.trackId], ripple: false,
      range: { sequenceId: sequence.sequenceId, startFrame: clip.timelineStartFrame, durationFrames: clip.durationFrames } });
  }
  const moving = planned.filter(({ existing, placement }) => existing && (
    existing.timelineStartFrame !== placement.timelineStartFrame || existing.trackId !== placement.trackId
    || existing.durationFrames !== placement.durationFrames));
  let stagingFrame = Math.max(0, ...sequence.clips.map(endFrame), ...planned.map((clip) => endFrame(clip.placement)));
  const staged = new Map<string, number>();
  for (const clip of moving) {
    staged.set(clip.clipId, stagingFrame);
    operations.push({ kind: "move-clip", clipId: clip.clipId, trackId: clip.existing!.trackId, timelineStartFrame: stagingFrame });
    stagingFrame += Math.max(clip.existing!.durationFrames, clip.placement.durationFrames);
    if (!Number.isSafeInteger(stagingFrame)) throw new Error("Timeline move exceeds safe integer precision");
  }
  for (const { clipId, existing, placement } of planned) {
    if (!existing) continue;
    if (existing.durationFrames !== placement.durationFrames) {
      operations.push({ kind: "trim-clip", clipId, timelineStartFrame: staged.get(clipId)!, durationFrames: placement.durationFrames,
        ...(existing.source.kind === "timed" ? { sourceRange: existing.source.range } : {}) });
    }
    if (staged.has(clipId)) operations.push({ kind: "move-clip", clipId, trackId: placement.trackId, timelineStartFrame: placement.timelineStartFrame });
    if (placement.audio && JSON.stringify(placement.audio) !== JSON.stringify(existing.audio)) {
      operations.push({ kind: "set-clip-audio", clipId, audio: placement.audio });
    }
    if ("speed" in existing && placement.speed && JSON.stringify(existing.speed) !== JSON.stringify(placement.speed)) {
      operations.push({ kind: "set-clip-speed", clipId, speed: placement.speed, reverse: existing.reverse, audioPolicy: existing.audioPolicy });
    }
  }
  for (const { clipId, existing, placement } of planned) {
    if (!existing) operations.push({ kind: "insert-clip", clipId, placement, mode: "overwrite" });
  }
  return operations;
}

function previewTimeline(engine: Engine, operations: EditOperation[]): { intent: EditIntent; previewHash: string } | undefined {
  if (operations.length === 0) return undefined;
  const sequence = engine.sequences.getPrimary();
  const intent: EditIntent = {
    intentVersion: MVP_CONTRACT_VERSION, commandId: uuidv7(), sequenceId: sequence.sequenceId,
    baseRevision: sequence.revision, actor: "videobook.timeline-compat", sourceSurface: "slash",
    confirmationPolicy: "always", operations,
  };
  const preview = engine.edits.preview(intent);
  if (!preview.ok) throw new Error(preview.error.message);
  if (!preview.value.valid) throw new Error(preview.value.conflicts.map((conflict) => conflict.message).join("; ")
    || "Timeline edit conflicts with the current sequence");
  return { intent, previewHash: preview.value.previewHash };
}

export async function writeTimeline(
  engine: Engine,
  input: TimelineInput,
  options: { removeArtifactId?: string; dryRun?: boolean } = {},
): Promise<TimelineWriteResult> {
  try {
    let sequence = engine.sequences.getPrimary();
    const videoTrack = sequence.tracks.filter((track) => track.kind === "video").sort((left, right) => left.ordinal - right.ordinal)[0];
    if (!videoTrack) throw new Error("Primary sequence has no video track");
    const managedTracks = new Set(sequence.tracks.filter((track) => track.kind === "audio" || track.trackId === videoTrack.trackId).map((track) => track.trackId));
    validateTimelineInput(engine, sequence, input, managedTracks);
    const slots = await planSlots(engine, sequence, input.slots ?? [], videoTrack.trackId);
    const audio = await planAudio(engine, sequence, input.audio ?? []);
    const extraTracks = new Set(sequence.clips.filter((clip) => options.removeArtifactId
      && clip.source.artifactId === options.removeArtifactId && !managedTracks.has(clip.trackId)).map((clip) => clip.trackId));
    const extraClips = sequence.clips.filter((clip) => extraTracks.has(clip.trackId) && clip.source.artifactId !== options.removeArtifactId)
      .map((clip) => ({ clipId: clip.clipId, existing: clip, placement: placementFromClip(clip) }));
    for (const trackId of extraTracks) managedTracks.add(trackId);
    const pendingLanes = allocateAudioLanes(sequence, audio);
    const pendingLaneIds = new Set(pendingLanes.map((lane) => lane.trackId));
    let planned = [...slots, ...audio, ...extraClips];
    if (pendingLanes.length > 0) {
      const validationTrack = sequence.tracks.find((track) => track.kind === "audio" && !track.locked);
      if (!validationTrack) throw new Error("Primary sequence has no unlocked audio track");
      let validationStart = Math.max(0, ...sequence.clips.map(endFrame), ...planned.map((clip) => endFrame(clip.placement)));
      const validationPlan = planned.map((clip) => {
        if (!pendingLaneIds.has(clip.placement.trackId)) return clip;
        const placement = { ...clip.placement, trackId: validationTrack.trackId, timelineStartFrame: validationStart };
        validationStart = endFrame(placement);
        return { ...clip, placement };
      });
      previewTimeline(engine, timelineOperations(sequence, validationPlan, managedTracks));
      if (options.dryRun) return timelineSuccessResult(readTimeline(engine));
      const laneIds = new Map<string, string>();
      for (const pending of pendingLanes) {
        const added = await engine.sequences.addTrack(sequence.sequenceId, { kind: "audio" });
        if (!added.ok) throw new Error(added.error.message);
        const track = added.value.tracks.find((candidate) => !sequence.tracks.some((existing) => existing.trackId === candidate.trackId))!;
        laneIds.set(pending.trackId, track.trackId);
        sequence = added.value;
        if (!pending.enabled || pending.muted || pending.solo) {
          const configured = await engine.sequences.updateTrack(track.trackId, {
            enabled: pending.enabled, muted: pending.muted, solo: pending.solo,
          });
          if (!configured.ok) throw new Error(configured.error.message);
          sequence = configured.value;
        }
      }
      planned = planned.map((clip) => ({ ...clip, placement: { ...clip.placement, trackId: laneIds.get(clip.placement.trackId) ?? clip.placement.trackId } }));
    }
    const preview = previewTimeline(engine, timelineOperations(sequence, planned, managedTracks));
    if (options.dryRun) return timelineSuccessResult(readTimeline(engine));
    if (preview) {
      const committed = await engine.edits.commit(preview.intent, preview.previewHash);
      if (!committed.ok) return timelineError(committed.error.message);
    }
    if (orientation(sequence) !== input.render) {
      const canvas = await engine.sequences.updateCanvas(sequence.sequenceId, CANVAS[input.render]);
      if (!canvas.ok) return timelineError(canvas.error.message);
    }
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
  const match = /^@?s(\d+)$/i.exec(value.trim());
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
