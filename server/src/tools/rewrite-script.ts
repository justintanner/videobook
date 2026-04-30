import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

type RewriteVariant = "full" | "tldr";
type RewritePlatform = "ig" | "tiktok" | "youtube";

const CUSTOM_PROMPT_MAX = 500;

type OriginalMeta = {
  origin?: string;
  sourceAssetId?: string;
};

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

export function rewriteScriptDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "rewrite_script",
    description:
      "Rewrite a generated script asset in-place as a text-to-text transformation of its existing markdown (the source image is NOT re-read). " +
      "Variants: \"full\" (full reproduction prompt + breakdown) or \"tldr\" (1–2 sentence summary). " +
      "Optional platform preset (\"ig\" | \"tiktok\" | \"youtube\") tunes authentic-capture cues for that feed. " +
      "Optional custom_prompt applies a transformation instruction (e.g. \"replace the pig with a man in a blue suit\"). " +
      "Previous versions are preserved in git history via clipfirst-engine. " +
      "Returns immediately; sync reports status=\"generating\" until the new markdown is written.",
    schema: {
      asset_id: z.string().describe("Script asset ID (script-*)"),
      variant: z.enum(["full", "tldr"]).describe("Rewrite style"),
      platform: z.enum(["ig", "tiktok", "youtube"]).optional()
        .describe("Platform preset — tunes authentic-capture cues for the target feed"),
      custom_prompt: z.string().max(CUSTOM_PROMPT_MAX).optional()
        .describe("Optional transformation instruction, e.g. 'replace the pig with a man in a blue suit'"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, variant, platform, custom_prompt, project_slug } = args as {
        asset_id: string;
        variant: RewriteVariant;
        platform?: RewritePlatform;
        custom_prompt?: string;
        project_slug: string;
      };

      if (!asset_id.startsWith("script-")) {
        return error(`rewrite_script only accepts script-* assets, got: ${asset_id}`);
      }

      const originalResult = await fs.readMetadata<OriginalMeta>(asset_id, "original", project_slug);
      if (!originalResult.ok) {
        return error(`Script ${asset_id} has no .original.json metadata — cannot determine origin`);
      }
      const { origin, sourceAssetId } = originalResult.value;
      if (origin !== "describe_image" || !sourceAssetId) {
        return error(
          `rewrite_script currently supports scripts created by describe_image. Got origin=${origin ?? "unknown"}`,
        );
      }

      if (!process.env.XAI_API_KEY) {
        return error("XAI_API_KEY is not set");
      }

      const scriptManifest = await fs.getManifest(asset_id, project_slug);
      if (!scriptManifest.ok) {
        return error(scriptManifest.error.message);
      }

      const jobId = `rewrite-script-${variant}-${asset_id}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "rewrite_script",
        assetId: asset_id,
        sourceAssetId,
        projectSlug: project_slug,
        tldr: variant === "tldr",
        platform: platform ?? null,
        customPrompt: custom_prompt ?? null,
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            source_asset_id: sourceAssetId,
            script_asset_id: asset_id,
            job_id: jobId,
            status: "enqueued",
            variant,
            ...(platform ? { platform } : {}),
            ...(custom_prompt ? { custom_prompt } : {}),
          }),
        }],
      };
    },
  };
}

export function registerRewriteScriptTool(server: McpServer, fs: ClipfirstFs): void {
  const def = rewriteScriptDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
