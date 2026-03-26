/**
 * preview_image MCP tool — returns a rich preview JSON for the frontend to
 * render a dynamic parameter form for image generation.
 *
 * Always defaults to nano_banana (richest settings). The user can switch
 * models via the dropdown in the UI.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { resolveAllAssets, expandSlotRefs } from "../asset-resolver.js";
import {
  IMAGE_MODELS,
  buildImageModelOption,
  extractLastUsedImageModel,
} from "../image-models.js";
import type { ActionLogEntry } from "../image-models.js";
import type { ToolDef } from "./tool-def.js";

export function previewImageGenDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "preview_image",
    description:
      "Return a preview with schema, prefilled parameters, validation, and model options for all available image models.",
    schema: {
      prompt: z.string().describe("Natural language generation prompt (e.g., 'generate an image of a sunset')"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { prompt, project_slug: slug } = args as {
        prompt: string;
        project_slug: string;
      };

      // 1. Expand @s01 slot refs → actual asset slugs
      let expandedPrompt = prompt;
      const timelineResult = await fs.readProjectMeta<{ slots: Array<{ slug: string }> }>("timeline", slug);
      if (timelineResult.ok && timelineResult.value.slots) {
        expandedPrompt = expandSlotRefs(prompt, timelineResult.value.slots);
      }

      // 2. Resolve @asset tags
      const { resolved: resolvedAssets, unresolved } = await resolveAllAssets(expandedPrompt, fs, slug);

      // 3. Load prompt history from action log
      let historyEntries: ActionLogEntry[] = [];
      try {
        const log = await fs.getActionLog({ limit: 100 }, slug);
        historyEntries = log as ActionLogEntry[];
      } catch {
        // action log unavailable
      }

      // 4. Build model options for all image models
      // Strip @asset tags from prompt to get the user's text input
      const cleanPrompt = prompt.replace(/@\S+/g, "").trim();
      const baseParams: Record<string, unknown> = { prompt: cleanPrompt };

      const modelOptions = Object.entries(IMAGE_MODELS).map(([key, info]) =>
        buildImageModelOption(key, info, baseParams, resolvedAssets, historyEntries),
      );

      // 5. Default to last successful generation model, fall back to nano_banana
      const selectedModel = extractLastUsedImageModel(historyEntries) ?? "nano_banana";
      const selectedOption = modelOptions.find((o) => o.key === selectedModel) ?? modelOptions[0];

      // 6. Build resolved_assets output
      const assetDicts = resolvedAssets.map((a) => {
        const fileName = a.file_path?.split("/").pop() ?? "original.png";
        return {
          slug: a.tag,
          src: a.file_path ? `/files/${slug}/${a.asset_id}/${fileName}` : "",
          type: a.asset_type === "video" ? "video" as const : "image" as const,
        };
      });

      // Add unresolved tag warnings
      const allWarnings = [...(selectedOption.validation.warnings ?? [])];
      for (const tag of unresolved) {
        allWarnings.push(`Unresolved @tag: ${tag}`);
      }

      const preview = {
        tool_name: selectedOption.tool_name,
        tool_description: selectedOption.description,
        schema: selectedOption.schema,
        prefilled_values: selectedOption.prefilled_values,
        validation: {
          ...selectedOption.validation,
          warnings: allWarnings,
        },
        resolved_assets: assetDicts,
        category: "image",
        selected_model: selectedModel,
        selected_provider: selectedOption.selected_provider,
        model_options: modelOptions,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(preview) }],
      };
    },
  };
}

export function registerPreviewImageGenTool(server: McpServer, fs: ClipfirstFs): void {
  const def = previewImageGenDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
