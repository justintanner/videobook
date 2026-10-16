import type { Engine } from "videobook-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { requireArtifactKind } from "./_shared.js";

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

export function rewriteScriptDef(engine: Engine): ToolDef {
  return {
    name: "rewrite_script",
    description:
      "Rewrite a script asset's markdown in place without re-reading the source image: variant full (reproduction prompt and breakdown) or tldr (one or two sentences), with an optional platform preset and custom_prompt instruction. Asynchronous; earlier versions stay in history.",
    schema: {
      asset_id: z.string().describe("Script artifact id"),
      variant: z.enum(["full", "tldr"]).describe("Rewrite style"),
      platform: z.enum(["ig", "tiktok", "youtube"]).optional()
        .describe("Platform preset — tunes authentic-capture cues for the target feed"),
      custom_prompt: z.string().max(CUSTOM_PROMPT_MAX).optional()
        .describe("Optional transformation instruction, e.g. 'replace the pig with a man in a blue suit'"),
      book_id: z.string().describe("Book id"),
    },
    handler: async (args) => {
      const { asset_id, variant, platform, custom_prompt, book_id } = args as {
        asset_id: string;
        variant: RewriteVariant;
        platform?: RewritePlatform;
        custom_prompt?: string;
        book_id: string;
      };

      const kindGate = await requireArtifactKind(engine, asset_id, ["script"], "rewrite_script");
      if (kindGate) return kindGate;

      const originalResult = await engine.metadata.artifacts.read<OriginalMeta>(asset_id, "original");
      if (!originalResult.ok) {
        return error(`Script ${asset_id} has no native original metadata — cannot determine origin`);
      }
      const { origin, sourceAssetId } = originalResult.value;
      if (origin !== "describe_image" || !sourceAssetId) {
        return error(
          `rewrite_script currently supports scripts created by describe_image. Got origin=${origin ?? "unknown"}`,
        );
      }

      if (!process.env.OPENAI_API_KEY) {
        return error("OPENAI_API_KEY is not set");
      }

      const scriptManifest = await engine.files.manifest(asset_id);
      if (!scriptManifest.ok) {
        return error(scriptManifest.error.message);
      }

      const jobId = `rewrite-script-${variant}-${asset_id}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "rewrite_script",
        assetId: asset_id,
        sourceAssetId,
        bookId: book_id,
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
