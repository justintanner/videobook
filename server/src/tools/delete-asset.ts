import type { Engine } from "videobook-engine";
import { z } from "zod";
import {
  readTimeline,
  timelineFailure,
  timelineInput,
  writeTimeline,
} from "../timeline-helpers.js";
import type { ToolDef } from "./tool-def.js";

/** Drops every primary-sequence clip and audio clip that plays the artifact. */
export async function removeArtifactFromTimeline(
  engine: Engine,
  artifactId: string,
  options: { dryRun?: boolean } = {},
): Promise<{ updated: boolean; error?: string }> {
  const timeline = readTimeline(engine);
  const slots = timeline.slots.filter((slot) => slot.artifactId !== artifactId);
  const audio = timeline.audio.filter((clip) => clip.artifactId !== artifactId);
  if (!engine.sequences.getPrimary().clips.some((clip) => clip.source.artifactId === artifactId)) {
    return { updated: false };
  }
  const result = await writeTimeline(engine, {
    ...timelineInput(timeline),
    slots: slots.map((slot) => ({
      id: slot.id,
      artifactId: slot.artifactId,
      ...(slot.volume === undefined ? {} : { volume: slot.volume }),
      ...(slot.audioFadeIn === undefined ? {} : { audioFadeIn: slot.audioFadeIn }),
      ...(slot.audioFadeOut === undefined ? {} : { audioFadeOut: slot.audioFadeOut }),
    })),
    audio: audio.map((clip) => ({
      id: clip.id,
      artifactId: clip.artifactId,
      startFrame: clip.startFrame,
      durationFrames: clip.durationFrames,
      ...(clip.volume === undefined ? {} : { volume: clip.volume }),
      ...(clip.fadeIn === undefined ? {} : { fadeIn: clip.fadeIn }),
      ...(clip.fadeOut === undefined ? {} : { fadeOut: clip.fadeOut }),
    })),
  }, { removeArtifactId: artifactId, ...options });
  return result.ok ? { updated: true } : { updated: false, error: result.error.message };
}

export function deleteAssetDef(engine: Engine): ToolDef {
  return {
    name: "delete_asset",
    description: "Delete an artifact and its owned media records after removing timeline references",
    schema: {
      asset_id: z.string(),
      book_id: z.string().uuid(),
    },
    handler: async (args) => {
      const assetId = String(args.asset_id);
      const artifact = engine.artifacts.get(assetId);
      if (!artifact.ok) return timelineFailure(artifact.error.message);
      const references = engine.artifacts.deletionReferences(assetId, { deleteOwnedMedia: true });
      if (!references.ok) return timelineFailure(references.error.message);
      const removable = new Set(engine.sequences.getPrimary().clips
        .filter((clip) => clip.source.artifactId === assetId).map((clip) => clip.clipId));
      const blockers = references.value.filter((reference) => reference.kind !== "sequenceClip" || !removable.has(reference.id));
      if (blockers.length > 0) {
        return timelineFailure(`Artifact is still referenced: ${assetId} (${blockers.map((reference) => reference.kind).join(", ")})`);
      }
      const timeline = await removeArtifactFromTimeline(engine, artifact.value.artifactId);
      if (timeline.error) return timelineFailure(timeline.error);
      const result = await engine.artifacts.delete(artifact.value.artifactId, { deleteOwnedMedia: true });
      if (!result.ok) return timelineFailure(result.error.message);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "deleted",
            artifact_id: artifact.value.artifactId,
            ...(artifact.value.label ? { label: artifact.value.label } : {}),
            deleted_at: new Date().toISOString(),
            timeline,
          }),
        }],
      };
    },
  };
}
