import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs, AssetManifestFile } from "clipfirst-fs";
import { z } from "zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

type RewriteVariant = "full" | "tldr";

type OriginalMeta = {
  origin?: string;
  sourceAssetId?: string;
};

function findImageFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

export function rewriteScriptDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "rewrite_script",
    description:
      "Rewrite a generated script asset in-place using the same model that originally created it. " +
      "Variants: \"full\" (full reproduction prompt + breakdown) or \"tldr\" (1–2 sentence summary). " +
      "Previous versions are preserved in git history via clipfirst-fs. Returns immediately; sync " +
      "reports status=\"generating\" until the new markdown is written.",
    schema: {
      asset_id: z.string().describe("Script asset ID (script-*)"),
      variant: z.enum(["full", "tldr"]).describe("Rewrite style"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, variant, project_slug } = args as {
        asset_id: string;
        variant: RewriteVariant;
        project_slug: string;
      };

      if (!asset_id.startsWith("script-")) {
        return error(`rewrite_script only accepts script-* assets, got: ${asset_id}`);
      }

      const originalResult = await fs.readMetadata<OriginalMeta>(asset_id, "original", project_slug);
      if (!originalResult.ok) {
        return error(`Script ${asset_id} has no .original.json metadata — cannot determine source model`);
      }
      const { origin, sourceAssetId } = originalResult.value;
      if (origin !== "describe_image" || !sourceAssetId) {
        return error(
          `rewrite_script currently supports scripts created by describe_image. Got origin=${origin ?? "unknown"}`,
        );
      }

      if (!process.env.OPENAI_API_KEY && !process.env.KIE_API_KEY) {
        return error("Neither OPENAI_API_KEY nor KIE_API_KEY is set");
      }

      const manifestResult = await fs.getManifest(sourceAssetId, project_slug);
      if (!manifestResult.ok) {
        return error(`Failed to read source asset ${sourceAssetId}: ${manifestResult.error.message}`);
      }
      const imageFile = findImageFile(manifestResult.value.files);
      if (!imageFile) {
        return error(`No image file found in source asset ${sourceAssetId}`);
      }

      const scriptManifest = await fs.getManifest(asset_id, project_slug);
      if (!scriptManifest.ok) {
        return error(scriptManifest.error.message);
      }
      const scriptAssetDir = scriptManifest.value.path;

      await writePendingTask(fs, asset_id, project_slug, {
        taskId: QUEUED_TASK_ID,
        taskType: "describe_image",
        assetId: asset_id,
        assetDir: scriptAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: { sourceAssetId, variant },
      });

      const jobId = `rewrite-script-${variant}-${asset_id}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "describe_image",
        sourceAssetId,
        sourceImageFilename: imageFile.name,
        assetId: asset_id,
        projectSlug: project_slug,
        tldr: variant === "tldr",
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
