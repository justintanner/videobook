import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";
import { loadAssetForAnalysis } from "./_suggest-shared.js";

export function suggestSfxDef(fs: VideocityFs): ToolDef {
  return {
    name: "suggest_sfx",
    description:
      "Analyze a video asset (frames + transcript + metadata) and return structured SFX suggestions: " +
      "timestamps, slug types, and descriptions. Runs in the background and persists to .suggest-sfx.json. " +
      "Requires a transcript — run /transcribe first if missing. Use /apply-sfx to mix the result.",
    schema: {
      asset_id: z.string().describe("Video asset ID (vid-* or @vid-slug)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, project_slug } = args as { asset_id: string; project_slug: string };
      const assetId = asset_id.replace(/^@/, "");

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const loaded = await loadAssetForAnalysis(fs, assetId, project_slug);
      if (!loaded.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: loaded.error.message }],
        };
      }

      const jobId = `suggest-sfx-${assetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "suggest_sfx",
        assetId,
        assetDir: loaded.value.manifest.path,
        projectSlug: project_slug,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id: assetId, job_id: jobId, status: "enqueued" }),
        }],
      };
    },
  };
}
