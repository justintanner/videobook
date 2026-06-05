import type { VideocityFs } from "vc-engine";
import { z } from "zod";
import { extname, join } from "node:path";
import { queue } from "../queue.js";
import { findAudioFile, findVideoFile } from "vc-engine";
import type { ToolDef } from "./tool-def.js";

const BOOST_MIN = 1.0;
const BOOST_MAX = 4.0;

function validateBoost(boost: number): string | null {
  if (boost === 1.0) return "Boost 1.0 is a no-op — nothing to change";
  if (boost < BOOST_MIN || boost > BOOST_MAX)
    return `Boost must be between ${BOOST_MIN} and ${BOOST_MAX}, got ${boost}`;
  return null;
}

export function audioBoostDef(fs: VideocityFs): ToolDef {
  return {
    name: "audio_boost",
    description:
      "Boost audio volume of a video or audio asset using a linear multiplier (1.0–4.0). Operates in-place with git versioning.",
    schema: {
      asset_id: z.string().describe("Asset ID (vid-* or aud-*)"),
      project_slug: z.string().describe("Project slug"),
      boost: z.number().describe("Volume multiplier (1.0–4.0). >1 = louder."),
    },
    handler: async (args) => {
      const { asset_id, project_slug, boost } = args as {
        asset_id: string;
        project_slug: string;
        boost: number;
      };

      const boostError = validateBoost(boost);
      if (boostError) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: boostError }],
        };
      }

      const isVideo = asset_id.startsWith("vid-");
      const isAudio = asset_id.startsWith("aud-");
      if (!isVideo && !isAudio) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `audio_boost only supports vid-* or aud-* assets, got ${asset_id}`,
          }],
        };
      }

      const manifestResult = await fs.getManifest(asset_id, project_slug);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const manifest = manifestResult.value;
      const file = isVideo
        ? findVideoFile(manifest.files)
        : findAudioFile(manifest.files, asset_id);
      if (!file) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `No ${isVideo ? "video" : "audio"} file found in asset ${asset_id}`,
          }],
        };
      }

      const assetDir = manifest.path;
      const inputPath = join(assetDir, file.name);
      const ext = extname(file.name) || (isVideo ? ".mp4" : ".mp3");
      const tempPath = join(assetDir, `boost_pending${ext}`);
      const jobId = `boost-${asset_id}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "audio_boost",
        inputPath,
        outputPath: tempPath,
        boost,
        isVideo,
        assetId: asset_id,
        assetDir,
        projectSlug: project_slug,
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id, job_id: jobId, status: "enqueued" }),
        }],
      };
    },
  };
}

