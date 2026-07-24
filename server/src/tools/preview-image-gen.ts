/**
 * prepare_image_generation MCP tool — returns a rich preview JSON for the frontend to
 * render a dynamic parameter form for image generation.
 *
 * Always defaults to nano_banana (richest settings). The user can switch
 * models via the dropdown in the UI.
 */
import type { Engine } from "videobook-engine";
import { z } from "zod";
import {
  getImageModels,
  buildImageModelOption,
  extractLastUsedImageModel,
} from "../image-models.js";
import type { ActionLogEntry } from "../image-models.js";
import type { ToolDef } from "./tool-def.js";

export function previewImageGenDef(fs: Engine): ToolDef {
  return {
    name: "prepare_image_generation",
    description:
      "Return a preview with schema, prefilled parameters, validation, and model options for all available image models.",
    schema: {
      prompt: z.string().describe("Natural language generation prompt (e.g., 'generate an image of a sunset')"),
      project_slug: z.string().describe("Project slug"),
      selected_model: z.string().optional().describe("Override: which model key to select (e.g. 'nano_banana')"),
      selected_provider: z.string().optional().describe("Override: which provider key to select (e.g. 'xai')"),
    },
    handler: async (args) => {
      const { prompt, project_slug: slug, selected_model: modelOverride, selected_provider: providerOverride } = args as {
        prompt: string;
        project_slug: string;
        selected_model?: string;
        selected_provider?: string;
      };

      // 1. Expand @s01 slot refs → actual asset slugs
      let expandedPrompt = prompt;
      const timelineResult = await fs.metadata.projects.read<{ slots: Array<{ slug: string }> }>("timeline", slug);
      if (timelineResult.ok && timelineResult.value.slots) {
        expandedPrompt = fs.resolver.expandSlotRefs(prompt, timelineResult.value.slots);
      }

      // 2. Resolve @asset tags
      const resolvedResult = await fs.resolver.resolveAll(expandedPrompt, slug);
      if (!resolvedResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: resolvedResult.error.message }],
        };
      }
      const { resolved: resolvedAssets, unresolved } = resolvedResult.value;

      // 3. Load prompt history from action log
      let historyEntries: ActionLogEntry[] = [];
      try {
        const log = fs.history.actionLog(slug, { limit: 100 });
        historyEntries = log as ActionLogEntry[];
      } catch {
        // action log unavailable
      }

      // 3b. Build set of valid asset tags for the current project so
      //     historical slug references that no longer exist are stripped.
      const allProjectAssets = fs.artifacts.list(slug);
      const projectAssetTags = new Set(allProjectAssets.map((a) => `@${a.slug}`));

      // 4. Build model options for all image models
      // Strip @asset tags from prompt to get the user's text input
      const cleanPrompt = prompt.replace(/@\S+/g, "").trim();
      const baseParams: Record<string, unknown> = { prompt: cleanPrompt };

      const imageModels = getImageModels();
      const modelOptions = Object.entries(imageModels).map(([key, info]) =>
        buildImageModelOption(key, info, baseParams, resolvedAssets, historyEntries, providerOverride, projectAssetTags),
      );

      // 5. Use explicit override, then last successful generation model, then nano_banana
      //    If the chosen model doesn't support the requested provider, pick the first that does.
      let selectedModel = modelOverride ?? extractLastUsedImageModel(historyEntries) ?? "nano_banana";
      if (providerOverride) {
        const chosen = modelOptions.find((o) => o.key === selectedModel);
        const supportsProvider = chosen?.providers.some((p) => p.key === providerOverride);
        if (!supportsProvider) {
          const compatible = modelOptions.find((o) => o.providers.some((p) => p.key === providerOverride));
          if (compatible) selectedModel = compatible.key;
        }
      }
      const selectedOption = modelOptions.find((o) => o.key === selectedModel) ?? modelOptions[0];

      // 6. Build resolved_assets output
      const assetDicts = resolvedAssets.map((a) => {
        const fileName = a.filePath?.split("/").pop() ?? "original.png";
        const src = a.filePath ? `/files/${slug}/${a.artifactSlug}/${fileName}` : "";
        const isVideo = a.artifactType === "video";
        return {
          slug: a.tag,
          src,
          thumbnailSrc: isVideo && a.filePath ? `/files/${slug}/${a.artifactSlug}/original.jpg` : undefined,
          type: isVideo ? "video" as const : "image" as const,
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
