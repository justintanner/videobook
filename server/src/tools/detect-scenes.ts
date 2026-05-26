import type { VideocityFs } from "vc-engine";
import { findVideoFile } from "vc-engine";
import { z } from "zod";
import { join } from "node:path";
import { detectSceneCandidates } from "../scene-detect.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

export function detectScenesDef(fs: VideocityFs): ToolDef {
  return {
    name: "detect_scenes",
    description:
      "Run ffmpeg scdet over a video asset and return a candidate timeline of natural visual breaks. " +
      "Each candidate is { t, score, kind } where kind=\"shot\" is a camera/cut change (scdet score ≥ 10) " +
      "and kind=\"settle\" is a motion-settle moment inside a steady shot (the falling edge of a sustained " +
      "high-motion run, e.g. \"the man finished standing up\"). Used by /plan-vis to align scene boundaries " +
      "to picture rather than audio; also useful as a standalone read-only diagnostic.",
    schema: {
      source_asset_id: z.string().describe("Video asset id (vid-*) inside the project"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args): Promise<ToolResult> => {
      const { source_asset_id, project_slug } = args as {
        source_asset_id: string;
        project_slug: string;
      };
      const sourceAssetId = source_asset_id.replace(/^@/, "");

      const manifestResult = await fs.getManifest(sourceAssetId, project_slug, { includeDotfiles: false });
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }
      const videoFile = findVideoFile(manifestResult.value.files);
      if (!videoFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No video file found in asset ${sourceAssetId}` }],
        };
      }

      let candidates;
      try {
        candidates = await detectSceneCandidates(join(manifestResult.value.path, videoFile.name));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Scene detection failed: ${msg}` }],
        };
      }

      const shots = candidates.filter((c) => c.kind === "shot").length;
      const settles = candidates.filter((c) => c.kind === "settle").length;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id: sourceAssetId,
            count: candidates.length,
            shots,
            settles,
            candidates,
          }),
        }],
      };
    },
  };
}
