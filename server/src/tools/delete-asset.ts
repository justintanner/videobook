import type { Artifact, Engine } from "videobook-engine";
import { z } from "zod";
import type { ForgetAssetOutcome } from "../forget-asset.js";
import { queue } from "../queue.js";
import {
  readTimeline,
  timelineFailure,
  timelineInput,
  writeTimeline,
} from "../timeline-helpers.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

const FORGET_TIMEOUT_MS = 5 * 60_000;

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

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

async function deleteArtifact(engine: Engine, artifact: Artifact): Promise<ToolResult> {
  const assetId = artifact.artifactId;
  const references = engine.artifacts.deletionReferences(assetId, { deleteOwnedMedia: true });
  if (!references.ok) return timelineFailure(references.error.message);
  const removable = new Set(engine.sequences.getPrimary().clips
    .filter((clip) => clip.source.artifactId === assetId).map((clip) => clip.clipId));
  const blockers = references.value.filter((reference) => reference.kind !== "sequenceClip" || !removable.has(reference.id));
  if (blockers.length > 0) {
    return timelineFailure(`Artifact is still referenced: ${assetId} (${blockers.map((reference) => reference.kind).join(", ")}); delete it with forget and clear_references to clear them`);
  }
  const timeline = await removeArtifactFromTimeline(engine, assetId);
  if (timeline.error) return timelineFailure(timeline.error);
  const result = await engine.artifacts.delete(assetId, { deleteOwnedMedia: true });
  if (!result.ok) return timelineFailure(result.error.message);
  return jsonResult({
    status: "deleted",
    artifact_id: assetId,
    ...(artifact.label ? { label: artifact.label } : {}),
    deleted_at: new Date().toISOString(),
    timeline,
  });
}

async function forgetArtifact(bookId: string, artifactId: string, clearReferences: boolean): Promise<ToolResult> {
  try {
    const outcome = await queue.enqueueAndWait<ForgetAssetOutcome>(
      `forget-asset-${artifactId}`,
      { type: "forget_asset", bookId, forgetArtifactId: artifactId, clearReferences },
      FORGET_TIMEOUT_MS,
    );
    return jsonResult({
      status: outcome.status,
      artifact_id: outcome.artifactId,
      ...(outcome.label ? { label: outcome.label } : {}),
      references: outcome.references,
      cleared_cells: outcome.clearedCells,
      forgotten_objects: outcome.forgottenObjects,
      shared_objects: outcome.sharedObjects,
      reclaimed_bytes: outcome.reclaimedBytes,
    });
  } catch (cause) {
    return timelineFailure(cause instanceof Error ? cause.message : String(cause));
  }
}

export function deleteAssetDef(engine: Engine): ToolDef {
  return {
    name: "delete_asset",
    description: "Delete an asset, dropping its sequence clips. forget also destroys its stored bytes (bytes another asset shares are kept)",
    annotations: { destructiveHint: true, idempotentHint: false },
    schema: {
      asset_id: z.string(),
      book_id: z.string().uuid(),
      forget: z.boolean().optional().describe("Permanently destroy the stored content too"),
      clear_references: z.boolean().optional()
        .describe("With forget: clear notebook cells and sequence clips holding the asset first"),
    },
    handler: async (args) => {
      const artifact = engine.artifacts.get(String(args.asset_id));
      if (!artifact.ok) return timelineFailure(artifact.error.message);
      if (args.forget === true) {
        return forgetArtifact(String(args.book_id), artifact.value.artifactId, args.clear_references === true);
      }
      if (args.clear_references === true) return timelineFailure("clear_references applies only with forget");
      return deleteArtifact(engine, artifact.value);
    },
  };
}
