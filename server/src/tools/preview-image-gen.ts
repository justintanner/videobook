import type { Engine } from "videobook-engine";
import { z } from "zod";
import {
  getImageModels,
  buildImageModelOption,
  extractLastUsedImageModel,
} from "../image-models.js";
import type { ActionLogEntry, ModelOption } from "../image-models.js";
import type { ToolDef } from "./tool-def.js";
import { expandTimelineSlotRefs, timelineSlotArtifactIds } from "../timeline-helpers.js";
import { parseArtifactIdTags, resolveArtifactRefs } from "../artifact-refs.js";
import {
  scanNotebookMentions,
  stripNotebookMentions,
} from "videobook-engine/notebook-mentions";

type PreviewImageModelOption = Pick<ModelOption, "key" | "image_slots">;

function supportsResolvedImages(
  option: PreviewImageModelOption,
  resolvedImageCount: number,
): boolean {
  const slots = option.image_slots;
  if (resolvedImageCount === 0) return !slots || slots.min === 0;
  if (!slots || resolvedImageCount < slots.min) return false;
  return slots.max === null || resolvedImageCount <= slots.max;
}

export function selectPreviewImageModel(
  modelOverride: string | undefined,
  historicalModel: string | null,
  resolvedImageCount: number,
  modelOptions: PreviewImageModelOption[],
): string {
  if (modelOverride) return modelOverride;

  const fallback = resolvedImageCount > 0 ? "gpt_image" : "gpt_image_text";
  if (!historicalModel || historicalModel === "nano_banana") return fallback;

  const historicalOption = modelOptions.find((option) => option.key === historicalModel);
  if (!historicalOption) return fallback;
  return supportsResolvedImages(historicalOption, resolvedImageCount)
    ? historicalModel
    : fallback;
}

export function previewImageGenDef(fs: Engine): ToolDef {
  return {
    name: "prepare_image_generation",
    description:
      "Return a preview with schema, prefilled parameters, validation, and model options for all available image models.",
    schema: {
      prompt: z.string().describe("Natural language generation prompt (e.g., 'generate an image of a sunset')"),
      book_id: z.string().describe("Book id"),
      selected_model: z.string().optional().describe("Override: which model key to select (e.g. 'nano_banana')"),
      selected_provider: z.string().optional().describe("Override: which provider key to select (e.g. 'xai')"),
    },
    handler: async (args) => {
      const { prompt, book_id: bookId, selected_model: modelOverride, selected_provider: providerOverride } = args as {
        prompt: string;
        book_id: string;
        selected_model?: string;
        selected_provider?: string;
      };

      // 1. Expand @s01 slot refs → @<artifact-id> tokens
      const expandedPrompt = expandTimelineSlotRefs(prompt, timelineSlotArtifactIds(fs));

      // 2. Resolve @<artifact-id> tags
      const { resolved: resolvedAssets, unresolved } = await resolveArtifactRefs(
        fs,
        parseArtifactIdTags(expandedPrompt),
      );

      // 3. Load prompt history from action log
      let historyEntries: ActionLogEntry[] = [];
      try {
        const log = fs.history.actionLog();
        historyEntries = log as ActionLogEntry[];
      } catch {
        // action log unavailable
      }

      // 3b. Build set of valid artifact-id tags for the current book so
      //     historical references that no longer exist are stripped.
      const allProjectAssets = fs.artifacts.list();
      const projectAssetTags = new Set(allProjectAssets.map((a) => `@${a.artifactId}`));

      // 4. Build model options for all image models
      // Strip @asset tags from prompt to get the user's text input
      const cleanPrompt = stripNotebookMentions(
        prompt,
        scanNotebookMentions(prompt).map((mention) => mention.reference),
      ).trim();
      const baseParams: Record<string, unknown> = { prompt: cleanPrompt };

      const imageModels = getImageModels();
      const modelOptions = Object.entries(imageModels).map(([key, info]) =>
        buildImageModelOption(key, info, baseParams, resolvedAssets, historyEntries, providerOverride, projectAssetTags),
      );

      // 5. Use explicit override, then a compatible non-Gemini historical model, then GPT Image 2
      //    If the chosen model doesn't support the requested provider, pick the first that does.
      const resolvedImageCount = resolvedAssets.filter(
        (asset) => asset.artifactType === "image" && asset.filePath,
      ).length;
      let selectedModel = selectPreviewImageModel(
        modelOverride,
        extractLastUsedImageModel(historyEntries),
        resolvedImageCount,
        modelOptions,
      );
      if (providerOverride) {
        const chosen = modelOptions.find((o) => o.key === selectedModel);
        const supportsProvider = chosen?.providers.some((p) => p.key === providerOverride);
        if (!supportsProvider) {
          const compatible = modelOptions.find(
            (option) => option.providers.some((provider) => provider.key === providerOverride)
              && supportsResolvedImages(option, resolvedImageCount),
          );
          if (compatible) selectedModel = compatible.key;
        }
      }
      const selectedOption = modelOptions.find((o) => o.key === selectedModel) ?? modelOptions[0];

      // 6. Build resolved_assets output
      const assetDicts = resolvedAssets.map((a) => {
        const fileName = a.filePath?.split("/").pop() ?? "original.png";
        const src = a.filePath ? `/files/${bookId}/${a.artifactId}/${fileName}` : "";
        const isVideo = a.artifactType === "video";
        return {
          ref: a.tag,
          src,
          thumbnailSrc: isVideo && a.filePath ? `/files/${bookId}/${a.artifactId}/original.jpg` : undefined,
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
