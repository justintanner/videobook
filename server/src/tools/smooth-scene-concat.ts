import { join } from "node:path";
import { z } from "zod";
import { findVideoFile, type VideocityFs } from "videobook-engine";
import { probeVideo, type ProbeResult } from "../ffmpeg.js";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";

function error(text: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text }],
  };
}

function stripVideoPrefix(assetId: string): string {
  return assetId.startsWith("vid-") ? assetId.slice(4) : assetId;
}

function concatName(firstAssetId: string, secondAssetId: string): string {
  return `scene-concat-${stripVideoPrefix(firstAssetId)}-${stripVideoPrefix(secondAssetId)}`;
}

function validVideoProbe(probe: ProbeResult): boolean {
  return probe.width > 0 && probe.height > 0 && probe.fps > 0 && probe.videoDuration > 0;
}

export function smoothSceneConcatDef(fs: VideocityFs): ToolDef {
  return {
    name: "smooth_scene_concat",
    description: "Smoothly concatenate two video scenes into a new vid-* asset. When their boundary audio overlaps, automatically aligns the shared waveform to avoid duplicated speech and dissolves the picture across that overlap. Otherwise uses a short crossfade.",
    schema: {
      first_asset_id: z.string().describe("First vid-* asset in playback order"),
      second_asset_id: z.string().describe("Second vid-* asset in playback order"),
      transition_seconds: z.number().min(0.05).max(5).optional().describe("Optional fixed crossfade duration in seconds. Omit to auto-align shared boundary audio, falling back to 0.35 seconds."),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const {
        first_asset_id,
        second_asset_id,
        transition_seconds,
        project_slug,
      } = args as {
        first_asset_id: string;
        second_asset_id: string;
        transition_seconds?: number;
        project_slug: string;
      };

      if (!first_asset_id.startsWith("vid-") || !second_asset_id.startsWith("vid-")) {
        return error("smooth_scene_concat requires two vid-* assets");
      }
      if (first_asset_id === second_asset_id) {
        return error("first_asset_id and second_asset_id must differ");
      }

      const [firstManifestResult, secondManifestResult] = await Promise.all([
        fs.getManifest(first_asset_id, project_slug),
        fs.getManifest(second_asset_id, project_slug),
      ]);
      if (!firstManifestResult.ok) {
        return error(`First asset: ${firstManifestResult.error.message}`);
      }
      if (!secondManifestResult.ok) {
        return error(`Second asset: ${secondManifestResult.error.message}`);
      }

      const firstVideo = findVideoFile(firstManifestResult.value.files);
      const secondVideo = findVideoFile(secondManifestResult.value.files);
      if (!firstVideo) return error(`No video file in asset ${first_asset_id}`);
      if (!secondVideo) return error(`No video file in asset ${second_asset_id}`);

      const firstPath = join(firstManifestResult.value.path, firstVideo.name);
      const secondPath = join(secondManifestResult.value.path, secondVideo.name);
      let firstProbe: ProbeResult;
      let secondProbe: ProbeResult;
      try {
        [firstProbe, secondProbe] = await Promise.all([
          probeVideo(firstPath),
          probeVideo(secondPath),
        ]);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return error(`Failed to probe input videos: ${message}`);
      }
      if (!validVideoProbe(firstProbe)) return error(`Invalid video in asset ${first_asset_id}`);
      if (!validVideoProbe(secondProbe)) return error(`Invalid video in asset ${second_asset_id}`);
      if (
        transition_seconds !== undefined &&
        transition_seconds >= Math.min(firstProbe.videoDuration, secondProbe.videoDuration)
      ) {
        return error("transition_seconds must be shorter than both video clips");
      }

      const assetResult = await fs.createAsset(
        "vid",
        concatName(first_asset_id, second_asset_id),
        project_slug,
      );
      if (!assetResult.ok) {
        return error(`Failed to create scene concat asset: ${assetResult.error.message}`);
      }

      const { assetId, path: assetDir } = assetResult.value;
      const outputPath = join(assetDir, "original.mp4");
      const jobId = `scene-concat-${assetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "smooth_scene_concat",
        firstPath,
        secondPath,
        outputPath,
        firstAssetId: first_asset_id,
        secondAssetId: second_asset_id,
        assetId,
        assetDir,
        projectSlug: project_slug,
        transitionSeconds: transition_seconds,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id: assetId,
            first_asset_id,
            second_asset_id,
            transition_seconds: transition_seconds ?? null,
            alignment_mode: transition_seconds === undefined ? "auto" : "fixed",
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
