import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  findAudioFile,
  findVideoFile,
  type ArtifactManifestFile,
  type Engine,
} from "videobook-engine";
import { z } from "zod";
import { audioOnlyOutputOptions, videoAudioOutputOptions } from "../audio-encoding.js";
import { probeVideo } from "../ffmpeg.js";
import { queue } from "../queue.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

export type AudioMixAssetKind = "video" | "audio";

type ResolvedAudioMixAsset = {
  assetId: string;
  kind: AudioMixAssetKind;
  assetDir: string;
  filename: string;
  path: string;
};

function toolError(message: string): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function normalizeAssetId(assetId: string): string {
  return assetId.trim().replace(/^@/, "");
}

function findMediaFile(
  files: ArtifactManifestFile[],
  kind: AudioMixAssetKind,
): ArtifactManifestFile | null {
  return kind === "video"
    ? findVideoFile(files)
    : findAudioFile(files, kind);
}

export async function resolveAudioMixAsset(
  engine: Engine,
  assetIdInput: string,
): Promise<ResolvedAudioMixAsset> {
  const assetId = normalizeAssetId(assetIdInput);
  const artifact = engine.artifacts.get(assetId);
  if (!artifact.ok) throw new Error(artifact.error.message);
  if (artifact.value.kind !== "video" && artifact.value.kind !== "audio") {
    throw new Error(`Audio mix artifacts must be video or audio, got ${artifact.value.kind} artifact ${assetId}`);
  }
  const kind: AudioMixAssetKind = artifact.value.kind;

  const manifestResult = await engine.files.manifest(assetId);
  if (!manifestResult.ok) throw new Error(manifestResult.error.message);

  const file = findMediaFile(manifestResult.value.files, kind);
  if (!file) {
    throw new Error(`No ${kind} file found in artifact ${assetId}`);
  }

  return {
    assetId,
    kind,
    assetDir: manifestResult.value.path,
    filename: file.name,
    path: join(manifestResult.value.path, file.name),
  };
}

export function audioMixDef(engine: Engine): ToolDef {
  return {
    name: "audio_mix",
    description:
      "Mix a video or audio layer asset into a target video or audio asset in place, starting at 0 seconds at volume 0-100; the target keeps its duration and picture.",
    schema: {
      target_asset_id: z.string().describe("Artifact id to edit in-place (video or audio)"),
      layer_asset_id: z.string().describe("Artifact whose audio is layered onto the target (video or audio artifact id)"),
      volume: z.number().min(0).max(100).describe("Layer volume percentage from 0 to 100"),
      book_id: z.string().describe("Book UUID"),
    },
    handler: async (args) => {
      const { target_asset_id, layer_asset_id, volume, book_id } = args as {
        target_asset_id: string;
        layer_asset_id: string;
        volume: number;
        book_id: string;
      };

      let target: ResolvedAudioMixAsset;
      let layer: ResolvedAudioMixAsset;
      try {
        [target, layer] = await Promise.all([
          resolveAudioMixAsset(engine, target_asset_id),
          resolveAudioMixAsset(engine, layer_asset_id),
        ]);
        const [targetProbe, layerProbe] = await Promise.all([
          probeVideo(target.path),
          probeVideo(layer.path),
        ]);
        if (!layerProbe.hasAudio || (layerProbe.audioDuration ?? layerProbe.duration) <= 0) {
          throw new Error("Layer asset has no playable audio stream");
        }
        if (target.kind === "video") {
          if (!targetProbe.videoStream || targetProbe.videoDuration <= 0) {
            throw new Error("Video target has no playable video stream");
          }
          videoAudioOutputOptions(target.filename);
        } else {
          if (!targetProbe.hasAudio || (targetProbe.audioDuration ?? targetProbe.duration) <= 0) {
            throw new Error("Audio target has no playable audio stream");
          }
          audioOnlyOutputOptions(target.filename);
        }
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }

      const token = randomUUID();
      const jobId = `audio-mix-${target.assetId}-${token}`;

      try {
        await queue.enqueueAndWait(jobId, {
          type: "audio_mix",
          targetPath: target.path,
          targetFilename: target.filename,
          targetKind: target.kind,
          layerPath: layer.path,
          layerAssetId: layer.assetId,
          volume,
          assetId: target.assetId,
          assetDir: target.assetDir,
          bookId: book_id,
        } as unknown as Record<string, unknown>, 1_800_000);
      } catch (error) {
        return toolError(`Audio mix failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            target_asset_id: target.assetId,
            layer_asset_id: layer.assetId,
            volume,
            job_id: jobId,
            status: "completed",
          }),
        }],
      };
    },
  };
}
