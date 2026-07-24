import type {
  Artifact,
  Engine,
  Timeline,
  TimelineInput,
} from "videobook-engine";
import type { ToolResult } from "./tools/tool-def.js";

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

export function timelineSlotSlugs(engine: Engine): Array<{ slug: string }> {
  return engine.timeline.get().slots.flatMap((slot) => {
    const artifact = engine.artifacts.get(slot.artifactId);
    return artifact.ok ? [{ slug: artifact.value.slug }] : [];
  });
}
