import type { VideocityFs } from "vc-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "vc-engine";
import type { ToolDef } from "./tool-def.js";

const DEFAULT_HANDLE = "justinwtanner";

function defaultUrl(handle: string): string {
  return `https://x.com/${handle}`;
}

function defaultLabel(handle: string): string {
  return `X: ${handle}`;
}

export function watermarkVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "watermark_video",
    description: "Overlay a black-and-white QR code plus 'X: <handle>' text in the bottom-right corner during the last 2 seconds of a video. Operates in-place with git versioning.",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. vid-my-video)"),
      project_slug: z.string().describe("Project slug"),
      handle: z.string().optional().describe(`X handle without @ (default: ${DEFAULT_HANDLE})`),
      url: z.string().optional().describe("URL the QR code resolves to (default: https://x.com/<handle>)"),
    },
    handler: async (args) => {
      const { asset_id, project_slug, handle, url } = args as {
        asset_id: string; project_slug: string; handle?: string; url?: string;
      };

      const resolvedHandle = (handle ?? DEFAULT_HANDLE).replace(/^@/, "").trim();
      if (!resolvedHandle) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "handle must be a non-empty string" }],
        };
      }
      const resolvedUrl = url ?? defaultUrl(resolvedHandle);
      const resolvedLabel = defaultLabel(resolvedHandle);

      const manifestResult = await fs.getManifest(asset_id, project_slug);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const manifest = manifestResult.value;
      const videoFile = findVideoFile(manifest.files);
      if (!videoFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No video file found in asset ${asset_id}` }],
        };
      }

      const assetDir = manifest.path;
      const videoPath = join(assetDir, videoFile.name);
      const tempPath = join(assetDir, "original_watermarked.mp4");
      const jobId = `watermark-${asset_id}-${Date.now()}`;

      const jobPayload: Record<string, unknown> = {
        type: "watermark_video",
        inputPath: videoPath,
        outputPath: tempPath,
        url: resolvedUrl,
        label: resolvedLabel,
        assetId: asset_id,
        assetDir,
        projectSlug: project_slug,
      };

      try {
        await queue.enqueueAndWait(jobId, jobPayload);
      } catch (err) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Watermark failed: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id, job_id: jobId, status: "completed", url: resolvedUrl, label: resolvedLabel }),
        }],
      };
    },
  };
}

