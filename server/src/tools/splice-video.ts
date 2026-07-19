import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { probeVideo, type ProbeResult } from "../ffmpeg.js";
import { findVideoFile } from "videocity-engine";
import type { ToolDef } from "./tool-def.js";

function stripVidPrefix(id: string): string {
  return id.startsWith("vid-") ? id.slice(4) : id;
}

function deriveSpliceName(firstId: string, secondId: string): string {
  return `splice-${stripVidPrefix(firstId)}-${stripVidPrefix(secondId)}`;
}

export function spliceVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "splice_video",
    description: "Splice two videos with an explicit overlap window. An overlap of 0 concatenates both complete videos; a positive overlap searches that many seconds at the end of the first video for the frame that best matches the first frame of the second. Creates a new vid- asset.",
    schema: {
      first_asset_id: z.string().describe("Base video asset ID (e.g. vid-clip-a). The match point is searched within this video."),
      second_asset_id: z.string().describe("Continuation video asset ID (e.g. vid-clip-b). Its first frame is the search target."),
      overlap: z.number().min(0).describe("Possible overlap in seconds. Use 0 to concatenate both videos without trimming either one."),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { first_asset_id, second_asset_id, overlap, project_slug } = args as {
        first_asset_id: string;
        second_asset_id: string;
        overlap: number;
        project_slug: string;
      };

      if (first_asset_id === second_asset_id) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "first_asset_id and second_asset_id must differ" }],
        };
      }

      const [firstManifestRes, secondManifestRes] = await Promise.all([
        fs.getManifest(first_asset_id, project_slug),
        fs.getManifest(second_asset_id, project_slug),
      ]);
      if (!firstManifestRes.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `First asset: ${firstManifestRes.error.message}` }],
        };
      }
      if (!secondManifestRes.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Second asset: ${secondManifestRes.error.message}` }],
        };
      }

      const firstVideo = findVideoFile(firstManifestRes.value.files);
      const secondVideo = findVideoFile(secondManifestRes.value.files);
      if (!firstVideo) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No video file in asset ${first_asset_id}` }],
        };
      }
      if (!secondVideo) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No video file in asset ${second_asset_id}` }],
        };
      }

      const firstPath = join(firstManifestRes.value.path, firstVideo.name);
      const secondPath = join(secondManifestRes.value.path, secondVideo.name);

      let firstProbe: ProbeResult;
      let secondProbe: ProbeResult;
      try {
        [firstProbe, secondProbe] = await Promise.all([probeVideo(firstPath), probeVideo(secondPath)]);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to probe videos: ${msg}` }],
        };
      }

      const spliceName = deriveSpliceName(first_asset_id, second_asset_id);
      const assetResult = await fs.createAsset("vid", spliceName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create splice asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId, path: assetDir } = assetResult.value;
      const outputPath = join(assetDir, "original.mp4");
      const jobId = `splice-${assetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "splice_video",
        firstPath,
        secondPath,
        outputPath,
        firstAssetId: first_asset_id,
        secondAssetId: second_asset_id,
        assetId,
        assetDir,
        projectSlug: project_slug,
        targetWidth: firstProbe.width,
        targetHeight: firstProbe.height,
        firstFps: firstProbe.fps,
        firstDuration: firstProbe.videoDuration,
        firstHasAudio: firstProbe.hasAudio,
        secondHasAudio: secondProbe.hasAudio,
        overlap,
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id: assetId,
            first: first_asset_id,
            second: second_asset_id,
            overlap,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
