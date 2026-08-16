import { createHash } from "node:crypto";
import type {
  ClipAudio,
  EditIntent,
  EditOperation,
  Engine,
  Sequence,
  SourceSurface,
} from "videobook-engine";
import {
  findPrimaryMediaFile,
  MVP_CONTRACT_VERSION,
  sourceTicksToSequenceFrames,
} from "videobook-engine";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { scanNotebookMentions } from "videobook-engine/notebook-mentions";
import { resolveArtifactRefs } from "../artifact-refs.js";

const bookSchema = { book_id: z.string().uuid() };

function sequenceContinuationRevision(sequence: Sequence): string {
  return createHash("sha256").update(JSON.stringify({
    sequenceId: sequence.sequenceId,
    frameRate: sequence.frameRate,
    tracks: sequence.tracks,
    clips: sequence.clips,
    captions: sequence.captions,
  })).digest("hex");
}
const intentSchema = z.record(z.string(), z.unknown());
const editRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("insert"),
    artifact_id: z.string().uuid(),
    track_id: z.string().uuid().optional(),
    timeline_start_frame: z.number().int().nonnegative(),
    duration_frames: z.number().int().positive().optional(),
    source_start_tick: z.number().int().nonnegative().optional(),
    source_duration_ticks: z.number().int().positive().optional(),
    mode: z.enum(["insert", "overwrite"]).optional(),
  }),
  z.object({
    kind: z.literal("trim"),
    clip_id: z.string().uuid(),
    timeline_start_frame: z.number().int().nonnegative(),
    duration_frames: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("volume"),
    clip_id: z.string().uuid(),
    gain_db: z.number().min(-96).max(24),
    muted: z.boolean().optional(),
    fade_in_frames: z.number().int().nonnegative().optional(),
    fade_out_frames: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("duck"),
    narration_clip_id: z.string().uuid(),
    reduction_db: z.number().min(-36).max(-1),
  }),
  z.object({
    kind: z.literal("move"),
    clip_id: z.string().uuid(),
    track_id: z.string().uuid(),
    timeline_start_frame: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("split"),
    clip_id: z.string().uuid(),
    split_frame: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("delete"),
    clip_id: z.string().uuid(),
    ripple: z.boolean(),
  }),
  z.object({
    kind: z.literal("gap"),
    timeline_start_frame: z.number().int().nonnegative(),
    duration_frames: z.number().int().positive(),
    track_ids: z.array(z.string().uuid()).min(1).optional(),
  }),
  z.object({
    kind: z.literal("transform"),
    clip_id: z.string().uuid(),
    fit: z.enum(["fit", "fill", "crop"]).optional(),
    position_x: z.number().optional(),
    position_y: z.number().optional(),
    scale_x: z.number().positive().optional(),
    scale_y: z.number().positive().optional(),
    rotation_degrees: z.number().optional(),
    opacity: z.number().min(0).max(1).optional(),
    crop_top: z.number().min(0).max(1).optional(),
    crop_right: z.number().min(0).max(1).optional(),
    crop_bottom: z.number().min(0).max(1).optional(),
    crop_left: z.number().min(0).max(1).optional(),
  }),
  z.object({
    kind: z.literal("reframe"),
    clip_id: z.string().uuid(),
  }),
  z.object({
    kind: z.literal("speed"),
    clip_id: z.string().uuid(),
    numerator: z.number().int().positive(),
    denominator: z.number().int().positive(),
    reverse: z.boolean(),
    audio_policy: z.enum(["preserve-pitch", "resample", "mute"]),
  }),
  z.object({
    kind: z.literal("transition"),
    outgoing_clip_id: z.string().uuid(),
    incoming_clip_id: z.string().uuid(),
    transition_kind: z.enum(["cut", "dissolve"]).nullable(),
    duration_frames: z.number().int().positive().optional(),
    alignment: z.enum(["start", "center", "end"]).optional(),
  }),
  z.object({
    kind: z.literal("caption"),
    cue_id: z.string().uuid().optional(),
    track_id: z.string().uuid().optional(),
    timeline_start_frame: z.number().int().nonnegative(),
    duration_frames: z.number().int().positive(),
    text: z.string().min(1),
    style_id: z.enum(["clean", "bold", "high-contrast"]),
    speaker: z.string().min(1).optional(),
  }),
]);
const generationPlanSchema = z.object({
  tool: z.string().regex(/^(?:generate|extend|upscale)_/u),
  input: z.record(z.string(), z.unknown()),
  provider: z.string().min(1),
  model: z.string().min(1),
  estimated_cost_usd: z.number().nonnegative().optional(),
  estimate_unavailable: z.boolean().optional(),
  track_id: z.string().uuid(),
  timeline_start_frame: z.number().int().nonnegative(),
  duration_frames: z.number().int().positive().optional(),
});

type EditRequest = z.infer<typeof editRequestSchema>;
const UNSUPPORTED_CHAT_EDIT_MESSAGE = "I can safely plan insert, trim, volume, ducking, captions, move, split, delete, gaps, transforms, speed, and transitions. Name the action and its target.";
type ChatEditParse =
  | { kind: "plan"; requests: EditRequest[] }
  | {
    kind: "clarification";
    message: string;
    reason: "incomplete" | "unsupported";
  };

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function requiredTrack(
  sequence: Sequence,
  trackId: string | undefined,
  kind: "video" | "audio",
) {
  const track = trackId
    ? sequence.tracks.find((candidate) => candidate.trackId === trackId)
    : sequence.tracks.find((candidate) =>
        candidate.kind === kind && candidate.enabled && !candidate.locked);
  if (!track || track.kind !== kind || !track.enabled || track.locked) {
    throw new Error(`No editable ${kind} track is available`);
  }
  return track;
}

async function operationsForRequest(
  engine: Engine,
  sequence: Sequence,
  request: EditRequest,
): Promise<EditOperation[]> {
  if (request.kind === "trim") {
    const clip = sequence.clips.find((candidate) =>
      candidate.clipId === request.clip_id);
    if (!clip) throw new Error(`Sequence clip not found: ${request.clip_id}`);
    return [{
      kind: "trim-clip",
      clipId: clip.clipId,
      timelineStartFrame: request.timeline_start_frame,
      durationFrames: request.duration_frames,
    }];
  }
  if (request.kind === "volume") {
    const clip = sequence.clips.find((candidate) =>
      candidate.clipId === request.clip_id);
    if (!clip) throw new Error(`Sequence clip not found: ${request.clip_id}`);
    const track = sequence.tracks.find((candidate) =>
      candidate.trackId === clip.trackId);
    if (track?.kind !== "audio") {
      throw new Error("Volume changes require a clip on an audio track");
    }
    const current: ClipAudio = clip.audio ?? {
      gainDb: 0,
      muted: false,
      fadeInFrames: 0,
      fadeOutFrames: 0,
    };
    return [{
      kind: "set-clip-audio",
      clipId: clip.clipId,
      audio: {
        gainDb: request.gain_db,
        muted: request.muted ?? current.muted,
        fadeInFrames: request.fade_in_frames ?? current.fadeInFrames,
        fadeOutFrames: request.fade_out_frames ?? current.fadeOutFrames,
      },
    }];
  }
  if (request.kind === "duck") {
    const narration = sequence.clips.find((candidate) =>
      candidate.clipId === request.narration_clip_id);
    const narrationTrack = narration && sequence.tracks.find((candidate) =>
      candidate.trackId === narration.trackId);
    if (!narration || narrationTrack?.kind !== "audio") {
      throw new Error("Ducking requires a narration clip on an audio track");
    }
    const narrationEnd = narration.timelineStartFrame + narration.durationFrames;
    const overlaps = sequence.clips.filter((clip) => {
      const track = sequence.tracks.find((candidate) =>
        candidate.trackId === clip.trackId);
      const clipEnd = clip.timelineStartFrame + clip.durationFrames;
      return clip.clipId !== narration.clipId
        && track?.kind === "audio"
        && track.enabled
        && !track.locked
        && clip.enabled
        && clip.timelineStartFrame < narrationEnd
        && clipEnd > narration.timelineStartFrame;
    });
    if (overlaps.length === 0) {
      throw new Error("No editable audio clips overlap the narration");
    }
    return overlaps.map((clip) => {
      const current: ClipAudio = clip.audio ?? {
        gainDb: 0,
        muted: false,
        fadeInFrames: 0,
        fadeOutFrames: 0,
      };
      return {
        kind: "set-clip-audio" as const,
        clipId: clip.clipId,
        audio: {
          ...current,
          gainDb: Math.max(-96, current.gainDb + request.reduction_db),
        },
      };
    });
  }
  if (request.kind === "move") {
    const clip = sequence.clips.find((candidate) =>
      candidate.clipId === request.clip_id);
    if (!clip) throw new Error(`Sequence clip not found: ${request.clip_id}`);
    const target = sequence.tracks.find((candidate) =>
      candidate.trackId === request.track_id);
    const source = sequence.tracks.find((candidate) =>
      candidate.trackId === clip.trackId);
    if (
      !target
      || !source
      || target.kind !== source.kind
      || target.locked
      || !target.enabled
    ) {
      throw new Error("Move destination is not a compatible editable track");
    }
    return [{
      kind: "move-clip",
      clipId: clip.clipId,
      trackId: target.trackId,
      timelineStartFrame: request.timeline_start_frame,
    }];
  }
  if (request.kind === "split") {
    if (!sequence.clips.some((candidate) => candidate.clipId === request.clip_id)) {
      throw new Error(`Sequence clip not found: ${request.clip_id}`);
    }
    return [{
      kind: "split-clip",
      clipId: request.clip_id,
      splitFrame: request.split_frame,
    }];
  }
  if (request.kind === "delete") {
    const clip = sequence.clips.find((candidate) =>
      candidate.clipId === request.clip_id);
    if (!clip) throw new Error(`Sequence clip not found: ${request.clip_id}`);
    return [{
      kind: "remove-range",
      trackIds: [clip.trackId],
      range: {
        sequenceId: sequence.sequenceId,
        startFrame: clip.timelineStartFrame,
        durationFrames: clip.durationFrames,
      },
      ripple: request.ripple,
    }];
  }
  if (request.kind === "gap") {
    const trackIds = request.track_ids ?? sequence.tracks
      .filter((track) => track.kind !== "caption" && track.enabled && !track.locked)
      .map((track) => track.trackId);
    const selected = new Set(trackIds);
    const clips = sequence.clips
      .filter((clip) =>
        selected.has(clip.trackId)
        && clip.timelineStartFrame >= request.timeline_start_frame)
      .sort((left, right) => right.timelineStartFrame - left.timelineStartFrame);
    if (clips.length === 0) throw new Error("No clips follow the requested gap");
    return clips.map((clip) => ({
      kind: "move-clip",
      clipId: clip.clipId,
      trackId: clip.trackId,
      timelineStartFrame: clip.timelineStartFrame + request.duration_frames,
    }));
  }
  if (request.kind === "transform") {
    const clip = sequence.clips.find((candidate) =>
      candidate.clipId === request.clip_id);
    if (!clip) throw new Error(`Sequence clip not found: ${request.clip_id}`);
    const current = clip.transform ?? {
      fit: "fill" as const,
      positionX: 0,
      positionY: 0,
      scaleX: 1,
      scaleY: 1,
      anchorX: 0.5,
      anchorY: 0.5,
      rotationDegrees: 0,
      cropTop: 0,
      cropRight: 0,
      cropBottom: 0,
      cropLeft: 0,
      opacity: 1,
      blendMode: "normal" as const,
    };
    return [{
      kind: "set-clip-transform",
      clipId: clip.clipId,
      transform: {
        ...current,
        fit: request.fit ?? current.fit,
        positionX: request.position_x ?? current.positionX,
        positionY: request.position_y ?? current.positionY,
        scaleX: request.scale_x ?? current.scaleX,
        scaleY: request.scale_y ?? current.scaleY,
        rotationDegrees: request.rotation_degrees ?? current.rotationDegrees,
        opacity: request.opacity ?? current.opacity,
        cropTop: request.crop_top ?? current.cropTop,
        cropRight: request.crop_right ?? current.cropRight,
        cropBottom: request.crop_bottom ?? current.cropBottom,
        cropLeft: request.crop_left ?? current.cropLeft,
      },
    }];
  }
  if (request.kind === "reframe") {
    const clip = sequence.clips.find((candidate) =>
      candidate.clipId === request.clip_id);
    if (!clip) throw new Error(`Sequence clip not found: ${request.clip_id}`);
    const track = sequence.tracks.find((candidate) =>
      candidate.trackId === clip.trackId);
    if (track?.kind !== "video") {
      throw new Error("Automatic reframe requires a visual clip");
    }
    const analysis = await engine.files.read(
      clip.source.artifactId,
      ".original.analysis.json",
    );
    let subjectPlacement: "left" | "center" | "right" = "center";
    if (analysis.ok) {
      try {
        const parsed = JSON.parse(
          typeof analysis.value === "string"
            ? analysis.value
            : new TextDecoder().decode(analysis.value),
        ) as { subjectPlacement?: unknown };
        if (
          parsed.subjectPlacement === "left"
          || parsed.subjectPlacement === "right"
        ) {
          subjectPlacement = parsed.subjectPlacement;
        }
      } catch {
        subjectPlacement = "center";
      }
    }
    const current = clip.transform ?? {
      fit: "fill" as const,
      positionX: 0,
      positionY: 0,
      scaleX: 1,
      scaleY: 1,
      anchorX: 0.5,
      anchorY: 0.5,
      rotationDegrees: 0,
      cropTop: 0,
      cropRight: 0,
      cropBottom: 0,
      cropLeft: 0,
      opacity: 1,
      blendMode: "normal" as const,
    };
    return [{
      kind: "set-clip-transform",
      clipId: clip.clipId,
      transform: {
        ...current,
        fit: "fill",
        positionX: subjectPlacement === "left"
          ? sequence.width * 0.18
          : subjectPlacement === "right"
            ? sequence.width * -0.18
            : 0,
      },
    }];
  }
  if (request.kind === "speed") {
    const clip = sequence.clips.find((candidate) =>
      candidate.clipId === request.clip_id);
    if (!clip || clip.source.kind !== "timed") {
      throw new Error("Speed and reverse require a timed sequence clip");
    }
    return [{
      kind: "set-clip-speed",
      clipId: clip.clipId,
      speed: {
        numerator: request.numerator,
        denominator: request.denominator,
      },
      reverse: request.reverse,
      audioPolicy: request.audio_policy,
    }];
  }
  if (request.kind === "transition") {
    const outgoing = sequence.clips.find((candidate) =>
      candidate.clipId === request.outgoing_clip_id);
    const incoming = sequence.clips.find((candidate) =>
      candidate.clipId === request.incoming_clip_id);
    if (!outgoing || !incoming || outgoing.trackId !== incoming.trackId) {
      throw new Error("Transition clips must exist on the same track");
    }
    return [{
      kind: "set-transition",
      outgoingClipId: outgoing.clipId,
      incomingClipId: incoming.clipId,
      transition: request.transition_kind === null
        ? null
        : {
            transitionId: uuidv7(),
            trackId: outgoing.trackId,
            outgoingClipId: outgoing.clipId,
            incomingClipId: incoming.clipId,
            kind: request.transition_kind,
            durationFrames: request.duration_frames ?? 12,
            alignment: request.alignment ?? "center",
          },
    }];
  }
  if (request.kind === "caption") {
    const track = request.track_id
      ? sequence.tracks.find((candidate) =>
          candidate.trackId === request.track_id)
      : sequence.tracks.find((candidate) =>
          candidate.kind === "caption" && candidate.enabled && !candidate.locked);
    if (!track || track.kind !== "caption" || track.locked || !track.enabled) {
      throw new Error("No editable caption track is available");
    }
    return [{
      kind: "upsert-caption-cue",
      cue: {
        cueId: request.cue_id ?? uuidv7(),
        trackId: track.trackId,
        timelineStartFrame: request.timeline_start_frame,
        durationFrames: request.duration_frames,
        text: request.text,
        styleId: request.style_id,
        ...(request.speaker ? { speaker: request.speaker } : {}),
      },
    }];
  }
  const artifact = engine.artifacts.get(request.artifact_id);
  if (!artifact.ok) throw new Error(artifact.error.message);
  const streams = engine.streams.list(artifact.value.artifactId);
  if (!streams.ok) throw new Error(streams.error.message);
  const timedStream = streams.value.find((stream) =>
    stream.kind === "video") ?? streams.value.find((stream) =>
    stream.kind === "audio");
  if (timedStream) {
    const track = requiredTrack(
      sequence,
      request.track_id,
      timedStream.kind,
    );
    const sourceStartTick = request.source_start_tick ?? 0;
    const sourceDurationTicks = request.source_duration_ticks
      ?? timedStream.durationTicks - sourceStartTick;
    if (
      sourceDurationTicks < 1
      || sourceStartTick + sourceDurationTicks > timedStream.durationTicks
    ) {
      throw new Error("Insert source range exceeds the registered stream");
    }
    return [{
      kind: "insert-clip",
      mode: request.mode ?? "insert",
      placement: {
        trackId: track.trackId,
        timelineStartFrame: request.timeline_start_frame,
        durationFrames: request.duration_frames ?? Math.max(
          1,
          sourceTicksToSequenceFrames(
            sourceDurationTicks,
            timedStream.timeBase,
            sequence.frameRate,
            "ceil",
          ),
        ),
        source: {
          kind: "timed",
          artifactId: artifact.value.artifactId,
          range: {
            streamId: timedStream.streamId,
            objectHash: timedStream.objectHash,
            startTick: sourceStartTick,
            durationTicks: sourceDurationTicks,
            timeBase: timedStream.timeBase,
          },
        },
        speed: { numerator: 1, denominator: 1 },
        reverse: false,
        audioPolicy: timedStream.kind === "video" ? "mute" : "preserve-pitch",
      },
    }];
  }
  const manifest = await engine.files.manifest(artifact.value.artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const media = findPrimaryMediaFile(manifest.value.files, artifact.value.kind);
  if (!media) throw new Error("The artifact has no insertable source media");
  const track = requiredTrack(sequence, request.track_id, "video");
  return [{
    kind: "insert-clip",
    mode: request.mode ?? "insert",
    placement: {
      trackId: track.trackId,
      timelineStartFrame: request.timeline_start_frame,
      durationFrames: request.duration_frames ?? 90,
      source: {
        kind: "still",
        artifactId: artifact.value.artifactId,
        sourcePath: media.name,
        objectHash: media.objectHash,
      },
    },
  }];
}

async function buildSequenceEditPlan(
  engine: Engine,
  input: EditRequest | EditRequest[],
  sourceSurface: SourceSurface,
  actor: string,
): Promise<Record<string, unknown>> {
  const sequence = engine.sequences.getPrimary();
  const commandId = uuidv7();
  const requests = Array.isArray(input) ? input : [input];
  const operations = (await Promise.all(requests.map((request) =>
    operationsForRequest(engine, sequence, request)))).flat();
  const confirmationRequired = requests.length > 1 || operations.length > 1;
  const intent: EditIntent = {
    intentVersion: MVP_CONTRACT_VERSION,
    commandId,
    sequenceId: sequence.sequenceId,
    baseRevision: engine.head,
    actor,
    sourceSurface,
    confirmationPolicy: "reversible-single-step",
    operations,
  };
  const summary = requests.length === 1
    ? `${requests[0].kind.slice(0, 1).toUpperCase()}${requests[0].kind.slice(1)} sequence edit`
    : `Apply ${requests.length} ordered sequence edits`;
  return {
    planVersion: 1,
    planId: commandId,
    sourceSurface,
    actor,
    bookId: engine.book.get().bookId,
    summary,
    normalizedReferences: [
      {
        kind: "sequence",
        targetId: sequence.sequenceId,
        revision: engine.head,
      },
    ],
    stages: [{
      stageId: `${commandId}:edit:0`,
      kind: "edit",
      summary: requests.map((request) => request.kind).join(" → "),
      intent,
    }],
    confirmation: {
      required: confirmationRequired,
      policy: confirmationRequired ? "always" : "reversible-single-step",
      reason: confirmationRequired
        ? "This plan contains multiple ordered operations"
        : "One reversible edit can apply immediately",
    },
  };
}

function clipIdFromText(sequence: Sequence, value: string): string | null {
  const token = value.replace(/^@/u, "").toLowerCase();
  const matches = sequence.clips.filter((clip) =>
    clip.clipId.toLowerCase().startsWith(token));
  return matches.length === 1 ? matches[0].clipId : null;
}

function trackIdFromText(sequence: Sequence, value: string): string | null {
  const token = value.replace(/^@/u, "").toLowerCase();
  const matches = sequence.tracks.filter((track) =>
    track.trackId.toLowerCase().startsWith(token)
    || track.name.toLowerCase() === token);
  return matches.length === 1 ? matches[0].trackId : null;
}

function integerMatch(text: string, expression: RegExp): number | null {
  const match = expression.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

async function parseChatEditClause(
  engine: Engine,
  sequence: Sequence,
  clause: string,
  mediaContext?: { artifactId: string },
): Promise<EditRequest | string> {
  const normalized = clause.trim();
  if (
    /\b(insert|add|place)\b/iu.test(normalized)
    && !/\bgap\b/iu.test(normalized)
  ) {
    const reference = scanNotebookMentions(normalized)[0]?.reference;
    const startFrame = integerMatch(
      normalized,
      /\b(?:at|from|starting\s+at)\s+(?:frame\s+)?(\d+)\b/iu,
    );
    const durationFrames = integerMatch(
      normalized,
      /\b(?:for|duration(?:\s+of)?)\s+(\d+)\s*(?:frames?)?\b/iu,
    );
    if ((!reference && !mediaContext) || startFrame === null) {
      return "Tell me which @asset to insert and the destination frame.";
    }
    if (!reference && mediaContext) {
      return {
        kind: "insert",
        artifact_id: mediaContext.artifactId,
        timeline_start_frame: startFrame,
        ...(durationFrames === null ? {} : { duration_frames: durationFrames }),
      };
    }
    const resolved = await resolveArtifactRefs(engine, [reference!]);
    if (resolved.unresolved.length > 0) {
      return `I could not resolve @${reference}. Choose a source from the library.`;
    }
    const artifact = resolved.resolved[0];
    if (!artifact) return `I could not resolve @${reference}.`;
    return {
      kind: "insert",
      artifact_id: artifact.artifactId,
      timeline_start_frame: startFrame,
      ...(durationFrames === null ? {} : { duration_frames: durationFrames }),
    };
  }
  if (/\bmove\b/iu.test(normalized)) {
    const references = normalized.match(/@?[0-9a-f-]{8,}/giu) ?? [];
    const clipId = references[0]
      ? clipIdFromText(sequence, references[0])
      : null;
    const trackId = references[1]
      ? trackIdFromText(sequence, references[1])
      : null;
    const startFrame = integerMatch(
      normalized,
      /\b(?:at|to|from)\s+(?:frame\s+)?(\d+)\b/iu,
    );
    if (!clipId || !trackId || startFrame === null) {
      return "Tell me the clip ID, destination track ID, and destination frame.";
    }
    return {
      kind: "move",
      clip_id: clipId,
      track_id: trackId,
      timeline_start_frame: startFrame,
    };
  }
  if (/\bsplit\b/iu.test(normalized)) {
    const reference = /(?:clip\s+)?(@?[0-9a-f-]{8,})/iu.exec(normalized)?.[1];
    const clipId = reference ? clipIdFromText(sequence, reference) : null;
    const splitFrame = integerMatch(
      normalized,
      /\b(?:at|on)\s+(?:frame\s+)?(\d+)\b/iu,
    );
    if (!clipId || splitFrame === null) {
      return "Tell me the clip ID and sequence frame where it should split.";
    }
    return { kind: "split", clip_id: clipId, split_frame: splitFrame };
  }
  if (/\b(delete|remove)\b/iu.test(normalized)) {
    const reference = /(?:clip\s+)?(@?[0-9a-f-]{8,})/iu.exec(normalized)?.[1];
    const clipId = reference ? clipIdFromText(sequence, reference) : null;
    if (!clipId) return "Tell me which clip ID to delete.";
    return {
      kind: "delete",
      clip_id: clipId,
      ripple: /\bripple\b/iu.test(normalized),
    };
  }
  if (/\bgap\b/iu.test(normalized)) {
    const startFrame = integerMatch(
      normalized,
      /\b(?:at|from)\s+(?:frame\s+)?(\d+)\b/iu,
    );
    const durationFrames = integerMatch(
      normalized,
      /\b(?:for|duration(?:\s+of)?)\s+(\d+)\s*(?:frames?)?\b/iu,
    );
    if (startFrame === null || durationFrames === null) {
      return "Tell me the gap start frame and duration in frames.";
    }
    return {
      kind: "gap",
      timeline_start_frame: startFrame,
      duration_frames: durationFrames,
    };
  }
  if (/\b(fit|fill|crop)\b/iu.test(normalized)) {
    const reference = /(?:clip\s+)?(@?[0-9a-f-]{8,})/iu.exec(normalized)?.[1];
    const clipId = reference ? clipIdFromText(sequence, reference) : null;
    const fit = /\bfit\b/iu.test(normalized)
      ? "fit"
      : /\bcrop\b/iu.test(normalized)
        ? "crop"
        : "fill";
    if (!clipId) return "Tell me which clip ID to fit, fill, or crop.";
    return { kind: "transform", clip_id: clipId, fit };
  }
  if (/\breframe\b/iu.test(normalized)) {
    const reference = /(?:clip\s+)?(@?[0-9a-f-]{8,})/iu.exec(normalized)?.[1];
    const clipId = reference ? clipIdFromText(sequence, reference) : null;
    if (!clipId) return "Tell me which visual clip ID to reframe.";
    return { kind: "reframe", clip_id: clipId };
  }
  if (/\breverse\b/iu.test(normalized)) {
    const reference = /(?:clip\s+)?(@?[0-9a-f-]{8,})/iu.exec(normalized)?.[1];
    const clipId = reference ? clipIdFromText(sequence, reference) : null;
    const clip = clipId
      ? sequence.clips.find((candidate) => candidate.clipId === clipId)
      : null;
    if (!clip || clip.source.kind !== "timed") {
      return "Tell me which timed clip ID to reverse.";
    }
    const timed = clip as Extract<typeof clip, { source: { kind: "timed" } }>;
    return {
      kind: "speed",
      clip_id: clip.clipId,
      numerator: timed.speed.numerator,
      denominator: timed.speed.denominator,
      reverse: !timed.reverse,
      audio_policy: timed.audioPolicy,
    };
  }
  if (/\b(dissolve|transition)\b/iu.test(normalized)) {
    const references = normalized.match(/@?[0-9a-f-]{8,}/giu) ?? [];
    const outgoing = references[0]
      ? clipIdFromText(sequence, references[0])
      : null;
    const incoming = references[1]
      ? clipIdFromText(sequence, references[1])
      : null;
    const durationFrames = integerMatch(
      normalized,
      /\b(?:for|duration(?:\s+of)?)\s+(\d+)\s*(?:frames?)?\b/iu,
    );
    if (!outgoing || !incoming) {
      return "Tell me the outgoing and incoming clip IDs for the transition.";
    }
    return {
      kind: "transition",
      outgoing_clip_id: outgoing,
      incoming_clip_id: incoming,
      transition_kind: /\bdissolve\b/iu.test(normalized) ? "dissolve" : "cut",
      ...(durationFrames === null ? {} : { duration_frames: durationFrames }),
    };
  }
  if (/\bcaption\b/iu.test(normalized)) {
    const startFrame = integerMatch(
      normalized,
      /\b(?:at|from|starting\s+at)\s+(?:frame\s+)?(\d+)\b/iu,
    );
    const durationFrames = integerMatch(
      normalized,
      /\b(?:for|duration(?:\s+of)?)\s+(\d+)\s*(?:frames?)?\b/iu,
    );
    const style = /\bhigh-contrast\b/iu.test(normalized)
      ? "high-contrast"
      : /\bbold\b/iu.test(normalized)
        ? "bold"
        : "clean";
    const quoted = /["“]([^"”]+)["”]/u.exec(normalized)?.[1]?.trim();
    const unquoted = normalized
      .replace(/^.*?\bcaption\b/iu, "")
      .replace(/\b(?:at|from|starting\s+at)\s+(?:frame\s+)?\d+\b/giu, "")
      .replace(/\b(?:for|duration(?:\s+of)?)\s+\d+\s*(?:frames?)?\b/giu, "")
      .replace(/\b(?:clean|bold|high-contrast)\b/giu, "")
      .replace(/^[\s:,-]+|[\s:,-]+$/gu, "");
    const text = quoted ?? unquoted;
    if (startFrame === null || durationFrames === null || !text) {
      return "Tell me the caption text, start frame, and duration in frames.";
    }
    return {
      kind: "caption",
      timeline_start_frame: startFrame,
      duration_frames: durationFrames,
      text,
      style_id: style,
    };
  }
  if (/\btrim\b/iu.test(normalized)) {
    const reference = /(?:clip\s+)?(@?[0-9a-f-]{8,})/iu.exec(normalized)?.[1];
    const startFrame = integerMatch(
      normalized,
      /\b(?:at|from|starting\s+at)\s+(?:frame\s+)?(\d+)\b/iu,
    );
    const durationFrames = integerMatch(
      normalized,
      /\b(?:for|duration(?:\s+of)?)\s+(\d+)\s*(?:frames?)?\b/iu,
    );
    const clipId = reference ? clipIdFromText(sequence, reference) : null;
    if (!clipId || startFrame === null || durationFrames === null) {
      return "Tell me the clip ID, destination frame, and duration in frames.";
    }
    return {
      kind: "trim",
      clip_id: clipId,
      timeline_start_frame: startFrame,
      duration_frames: durationFrames,
    };
  }
  if (/\b(volume|gain|louder|quieter|mute)\b/iu.test(normalized)) {
    const reference = /(?:clip\s+)?(@?[0-9a-f-]{8,})/iu.exec(normalized)?.[1];
    const gainMatch = /(-?\d+(?:\.\d+)?)\s*(?:db)?\b/iu.exec(
      normalized.replace(reference ?? "", ""),
    );
    const clipId = reference ? clipIdFromText(sequence, reference) : null;
    const gainDb = /\bmute\b/iu.test(normalized)
      ? -96
      : gainMatch
        ? Number(gainMatch[1])
        : Number.NaN;
    if (!clipId || !Number.isFinite(gainDb) || gainDb < -96 || gainDb > 24) {
      return "Tell me the audio clip ID and gain from -96 to 24 dB.";
    }
    return {
      kind: "volume",
      clip_id: clipId,
      gain_db: gainDb,
      ...(gainDb === -96 ? { muted: true } : {}),
    };
  }
  if (/\bduck\b/iu.test(normalized)) {
    const reference = /(?:clip\s+)?(@?[0-9a-f-]{8,})/iu.exec(normalized)?.[1];
    const clipId = reference ? clipIdFromText(sequence, reference) : null;
    const reduction = /(-\d+(?:\.\d+)?)\s*(?:db)?\b/iu.exec(
      normalized.replace(reference ?? "", ""),
    );
    const reductionDb = reduction ? Number(reduction[1]) : -12;
    if (!clipId || reductionDb < -36 || reductionDb > -1) {
      return "Tell me the narration clip ID and a reduction from -36 to -1 dB.";
    }
    return {
      kind: "duck",
      narration_clip_id: clipId,
      reduction_db: reductionDb,
    };
  }
  return UNSUPPORTED_CHAT_EDIT_MESSAGE;
}

async function parseChatEditRequest(
  engine: Engine,
  prompt: string,
  mediaContext?: { artifactId: string },
): Promise<ChatEditParse> {
  const clauses = prompt.split(/\s*(?:;|\band\s+then\b|\bthen\b)\s*/iu)
    .filter((clause) => clause.trim().length > 0);
  if (clauses.length === 0) {
    return {
      kind: "clarification",
      message: "Describe the edit you want to make.",
      reason: "incomplete",
    };
  }
  const sequence = engine.sequences.getPrimary();
  const requests: EditRequest[] = [];
  for (const clause of clauses) {
    const parsed = await parseChatEditClause(
      engine,
      sequence,
      clause,
      mediaContext,
    );
    if (typeof parsed === "string") {
      return {
        kind: "clarification",
        message: parsed,
        reason: parsed === UNSUPPORTED_CHAT_EDIT_MESSAGE
          ? "unsupported"
          : "incomplete",
      };
    }
    requests.push(parsed);
  }
  return { kind: "plan", requests };
}

export function buildGenerationInsertPlan(
  engine: Engine,
  input: z.infer<typeof generationPlanSchema>,
  sourceSurface: SourceSurface,
  actor: string,
): Record<string, unknown> & { planId: string } {
  if (
    input.estimated_cost_usd === undefined
    && input.estimate_unavailable !== true
  ) {
    throw new Error("Generation requires a cost estimate or unavailable warning");
  }
  const sequence = engine.sequences.getPrimary();
  const track = sequence.tracks.find((candidate) =>
    candidate.trackId === input.track_id);
  if (!track || track.locked || !track.enabled) {
    throw new Error("Generation destination track is not editable");
  }
  const planId = uuidv7();
  return {
    planVersion: 1,
    planId,
    sourceSurface,
    actor,
    bookId: engine.book.get().bookId,
    summary: `Generate with ${input.model} and insert the result`,
    normalizedReferences: [{
      kind: "sequence",
      targetId: sequence.sequenceId,
      revision: sequenceContinuationRevision(sequence),
    }],
    stages: [{
      stageId: `${planId}:queued:0`,
      kind: "queued",
      summary: `Run ${input.tool}`,
      jobType: "generation",
      tool: input.tool,
      input: input.input,
      provider: input.provider,
      model: input.model,
      ...(input.estimated_cost_usd === undefined
        ? { estimateUnavailable: true }
        : { estimatedCostUsd: input.estimated_cost_usd }),
      insertsOutput: true,
      continuation: {
        sequenceId: sequence.sequenceId,
        baseRevision: sequenceContinuationRevision(sequence),
        destination: {
          trackId: track.trackId,
          timelineStartFrame: input.timeline_start_frame,
          ...(input.duration_frames === undefined
            ? {}
            : { durationFrames: input.duration_frames }),
        },
      },
    }],
    confirmation: {
      required: true,
      policy: "always",
      reason: "This plan can incur provider spend",
    },
  };
}

export async function continueQueuedInsert(
  engine: Engine,
  plan: Record<string, unknown>,
  outputArtifactId: string,
  actor: string,
): Promise<Record<string, unknown>> {
  const stages = Array.isArray(plan.stages) ? plan.stages : [];
  const stage = stages.find((candidate) =>
    typeof candidate === "object"
    && candidate !== null
    && (candidate as Record<string, unknown>).kind === "queued") as
    | Record<string, unknown>
    | undefined;
  const continuation = stage && typeof stage.continuation === "object"
    && stage.continuation !== null
    ? stage.continuation as Record<string, unknown>
    : null;
  const destination = continuation
    && typeof continuation.destination === "object"
    && continuation.destination !== null
    ? continuation.destination as Record<string, unknown>
    : null;
  const sequenceId = continuation?.sequenceId;
  const baseRevision = continuation?.baseRevision;
  if (
    stage?.insertsOutput !== true
    || typeof sequenceId !== "string"
    || typeof baseRevision !== "string"
    || !destination
  ) {
    throw new Error("The plan has no revision-pinned queued insertion");
  }
  const sequence = engine.sequences.getPrimary();
  const currentRevision = sequenceContinuationRevision(sequence);
  if (sequence.sequenceId !== sequenceId || currentRevision !== baseRevision) {
    return {
      kind: "stale-continuation",
      message: "The sequence changed while generation was running. Review a new destination.",
      expectedRevision: baseRevision,
      currentRevision,
      outputArtifactId,
    };
  }
  const trackId = destination.trackId;
  const timelineStartFrame = destination.timelineStartFrame;
  const durationFrames = destination.durationFrames;
  if (
    typeof trackId !== "string"
    || typeof timelineStartFrame !== "number"
    || (
      durationFrames !== undefined
      && typeof durationFrames !== "number"
    )
  ) {
    throw new Error("The queued insertion destination is invalid");
  }
  const next = await buildSequenceEditPlan(engine, {
    kind: "insert",
    artifact_id: outputArtifactId,
    track_id: trackId,
    timeline_start_frame: timelineStartFrame,
    ...(durationFrames === undefined ? {} : { duration_frames: durationFrames }),
  }, "system", actor);
  next.parentActionId = typeof plan.planId === "string" ? plan.planId : undefined;
  return next;
}

export function commandPlanDefs(engine: Engine): ToolDef[] {
  return [
    {
      name: "plan_sequence_edit",
      description: "Compile a UI, slash, or chat insert, trim, or volume request into one CommandPlan",
      scope: "book",
      schema: {
        ...bookSchema,
        source_surface: z.enum(["ui", "slash", "chat"]),
        actor: z.string().min(1),
        request: z.union([
          editRequestSchema,
          z.array(editRequestSchema).min(1).max(20),
        ]),
      },
      handler: async (args) => {
        try {
          return json(await buildSequenceEditPlan(
            engine,
            args.request as EditRequest,
            args.source_surface as SourceSurface,
            String(args.actor),
          ));
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "plan_chat_command",
      description: "Parse a natural-language sequence edit into a typed CommandPlan without executing tools",
      scope: "book",
      schema: {
        ...bookSchema,
        actor: z.string().min(1),
        prompt: z.string().min(1),
        media_context: z.object({
          notebook_id: z.string().uuid(),
          cell_id: z.string().uuid(),
          artifact_id: z.string().uuid(),
        }).optional(),
      },
      handler: async (args) => {
        try {
          let mediaContext: { artifactId: string } | undefined;
          if (args.media_context) {
            const context = args.media_context as {
              notebook_id: string;
              cell_id: string;
              artifact_id: string;
            };
            const notebook = engine.notebooks.read(context.notebook_id);
            if (!notebook.ok) throw new Error(notebook.error.message);
            const cell = notebook.value.cells.find((candidate) =>
              candidate.id === context.cell_id);
            if (!cell || (cell.type !== "image" && cell.type !== "video")) {
              throw new Error("Fullscreen media context must reference an image or video cell");
            }
            if (cell.outputArtifactId !== context.artifact_id) {
              throw new Error("Fullscreen media context does not match the cell output");
            }
            const artifact = engine.artifacts.get(context.artifact_id);
            if (!artifact.ok) throw new Error(artifact.error.message);
            mediaContext = { artifactId: artifact.value.artifactId };
          }
          const parsed = await parseChatEditRequest(
            engine,
            String(args.prompt),
            mediaContext,
          );
          if (parsed.kind === "clarification") return json(parsed);
          return json(await buildSequenceEditPlan(
            engine,
            parsed.requests,
            "chat",
            String(args.actor),
          ));
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "plan_generation_insert",
      description: "Plan a paid queued generation with provider, model, cost, and a revision-pinned insertion",
      scope: "book",
      schema: {
        ...bookSchema,
        source_surface: z.enum(["ui", "slash", "chat"]),
        actor: z.string().min(1),
        generation: generationPlanSchema,
      },
      handler: async (args) => {
        try {
          return json(buildGenerationInsertPlan(
            engine,
            args.generation as z.infer<typeof generationPlanSchema>,
            args.source_surface as SourceSurface,
            String(args.actor),
          ));
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "continue_queued_insert",
      description: "Turn a completed generation into an insertion plan only when its pinned sequence destination is still current",
      scope: "book",
      schema: {
        ...bookSchema,
        plan: z.record(z.string(), z.unknown()),
        output_artifact_id: z.string().uuid(),
        actor: z.string().min(1),
      },
      handler: async (args) => {
        try {
          return json(await continueQueuedInsert(
            engine,
            args.plan as Record<string, unknown>,
            String(args.output_artifact_id),
            String(args.actor),
          ));
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "preview_edit_intent",
      description: "Preview one CommandPlan edit stage through the canonical engine diff",
      scope: "book",
      schema: {
        ...bookSchema,
        intent: intentSchema,
      },
      handler: async (args) => {
        const preview = engine.edits.preview(args.intent as unknown as EditIntent);
        return preview.ok ? json(preview.value) : failure(preview.error.message);
      },
    },
    {
      name: "commit_edit_intent",
      description: "Commit an unchanged previewed CommandPlan edit stage atomically",
      scope: "book",
      schema: {
        ...bookSchema,
        intent: intentSchema,
        preview_hash: z.string().min(1),
      },
      handler: async (args) => {
        const committed = await engine.edits.commit(
          args.intent as unknown as EditIntent,
          String(args.preview_hash),
        );
        return committed.ok ? json(committed.value) : failure(committed.error.message);
      },
    },
    {
      name: "get_edit_action",
      description: "Read the immutable audit record for a committed CommandPlan edit stage",
      scope: "book",
      schema: {
        ...bookSchema,
        action_id: z.string().uuid(),
      },
      handler: async (args) => {
        const action = engine.edits.get(String(args.action_id));
        return action.ok ? json(action.value) : failure(action.error.message);
      },
    },
    {
      name: "restore_edit_action",
      description: "Create a forward revision restoring a prior edit action or revision",
      scope: "book",
      schema: {
        ...bookSchema,
        target_action_id: z.string().uuid().optional(),
        target_revision: z.string().min(1).optional(),
        base_revision: z.string().min(1),
        actor: z.string().min(1),
        source_surface: z.enum(["ui", "slash", "chat"]),
      },
      handler: async (args) => {
        if (!args.target_action_id && !args.target_revision) {
          return failure("A target action or target revision is required");
        }
        const restored = await engine.edits.restore({
          ...(typeof args.target_action_id === "string"
            ? { targetActionId: args.target_action_id }
            : {}),
          ...(typeof args.target_revision === "string"
            ? { targetRevision: args.target_revision }
            : {}),
          baseRevision: String(args.base_revision),
          actor: String(args.actor),
          sourceSurface: args.source_surface as "ui" | "slash" | "chat",
        });
        return restored.ok ? json(restored.value) : failure(restored.error.message);
      },
    },
  ];
}
