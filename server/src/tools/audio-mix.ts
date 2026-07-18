import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  findAudioFile,
  findVideoFile,
  type AssetManifestFile,
  type VideocityFs,
} from "videocity-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

export type AudioMixAssetKind = "video" | "audio";

export type ResolvedAudioMixAsset = {
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
  return assetId.replace(/^@/, "");
}

function assetKind(assetId: string): AudioMixAssetKind | null {
  if (assetId.startsWith("vid-")) return "video";
  if (assetId.startsWith("aud-")) return "audio";
  return null;
}

function findMediaFile(
  files: AssetManifestFile[],
  assetId: string,
  kind: AudioMixAssetKind,
): AssetManifestFile | null {
  return kind === "video"
    ? findVideoFile(files)
    : findAudioFile(files, assetId);
}

export async function resolveAudioMixAsset(
  fs: VideocityFs,
  assetIdInput: string,
  projectSlug: string,
): Promise<ResolvedAudioMixAsset> {
  const assetId = normalizeAssetId(assetIdInput);
  const kind = assetKind(assetId);
  if (!kind) {
    throw new Error(`Audio mix assets must start with vid-* or aud-*, got: ${assetId}`);
  }

  const manifestResult = await fs.getManifest(assetId, projectSlug);
  if (!manifestResult.ok) throw new Error(manifestResult.error.message);

  const file = findMediaFile(manifestResult.value.files, assetId, kind);
  if (!file) {
    throw new Error(`No ${kind} file found in asset ${assetId}`);
  }

  return {
    assetId,
    kind,
    assetDir: manifestResult.value.path,
    filename: file.name,
    path: join(manifestResult.value.path, file.name),
  };
}

export function audioMixDef(fs: VideocityFs): ToolDef {
  return {
    name: "audio_mix",
    description:
      "Mix audio from a vid-* or aud-* layer asset into a vid-* or aud-* target asset in-place. "
      + "The layer starts at 0 seconds at the requested 0-100 volume. The target duration is preserved, "
      + "and video targets retain their original video stream with git versioning.",
    schema: {
      target_asset_id: z.string().describe("Asset to edit in-place (vid-* or aud-*)"),
      layer_asset_id: z.string().describe("Asset whose audio is layered onto the target (vid-* or aud-*)"),
      volume: z.number().min(0).max(100).describe("Layer volume percentage from 0 to 100"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { target_asset_id, layer_asset_id, volume, project_slug } = args as {
        target_asset_id: string;
        layer_asset_id: string;
        volume: number;
        project_slug: string;
      };

      let target: ResolvedAudioMixAsset;
      let layer: ResolvedAudioMixAsset;
      try {
        [target, layer] = await Promise.all([
          resolveAudioMixAsset(fs, target_asset_id, project_slug),
          resolveAudioMixAsset(fs, layer_asset_id, project_slug),
        ]);
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
          projectSlug: project_slug,
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
