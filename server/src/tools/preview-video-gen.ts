/**
 * prepare_video_generation MCP tool — routes a natural language prompt to the best
 * video generation tool and returns a rich preview JSON for the frontend to
 * render a dynamic parameter form.
 */
import type { Engine } from "videobook-engine";
import { z } from "zod";
import {
  DEFAULT_VIDEO_MODEL_KEY,
  VIDEO_MODELS,
  buildVideoRoutingPrompt,
  buildModelOption,
  extractLastUsedModel,
} from "../video-models.js";
import type { ActionLogEntry } from "../video-models.js";
import type { ToolDef } from "./tool-def.js";

import { getCanonicalName } from "../generation-registry.js";
import { expandTimelineSlotRefs, timelineSlotArtifactIds } from "../timeline-helpers.js";
import { parseArtifactIdTags, resolveArtifactRefs } from "../artifact-refs.js";
import {
  buildIntelligenceResponses,
  firstResponseText,
  intelligenceRequest,
} from "../openai-intelligence.js";

function findSelectedModel(rawToolName: string): string | null {
  const canonical = getCanonicalName(rawToolName);
  for (const [key, info] of Object.entries(VIDEO_MODELS)) {
    if (info.tool_name === rawToolName || info.tool_name === canonical || getCanonicalName(info.tool_name) === canonical) return key;
    if (info.googleToolName === rawToolName || info.googleToolName === canonical || (info.googleToolName && getCanonicalName(info.googleToolName) === canonical)) return key;
  }
  return null;
}

export function selectPreviewVideoModel(
  modelOverride: string | undefined,
  historicalModel: string | null,
  routedToolName: string,
): string {
  const implicitHistoricalModel = historicalModel === "gemini_omni"
    ? null
    : historicalModel;
  return modelOverride
    ?? implicitHistoricalModel
    ?? findSelectedModel(routedToolName)
    ?? DEFAULT_VIDEO_MODEL_KEY;
}

export function previewVideoGenDef(fs: Engine): ToolDef {
  return {
    name: "prepare_video_generation",
    description:
      "Route a natural language prompt to the best video generation tool and return a preview with schema, prefilled parameters, validation, and model options for all available video models.",
    schema: {
      prompt: z.string().describe("Natural language generation prompt (e.g., 'gen a video of a sunset')"),
      book_id: z.string().describe("Book id"),
      selected_model: z.string().optional().describe("Override: which model key to select (e.g. 'kling30')"),
      selected_provider: z.string().optional().describe("Override: which provider key to select (e.g. 'kie')"),
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

      // 3. Route prompt (skip when model explicitly selected)
      let routedToolName = VIDEO_MODELS[DEFAULT_VIDEO_MODEL_KEY].tool_name;
      let routedParams: Record<string, unknown> = {};

      if (modelOverride) {
        // Explicit model selection — skip LLM routing, use the model's tool name
        const overrideInfo = Object.entries(VIDEO_MODELS).find(([key]) => key === modelOverride);
        if (overrideInfo) routedToolName = overrideInfo[1].tool_name;
      } else {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: "OPENAI_API_KEY environment variable is not set" }],
          };
        }

        try {
          const assetContext = resolvedAssets.map((a) => ({
            tag: a.tag,
            type: a.artifactType,
            asset_id: a.artifactId,
            has_file: a.filePath !== null,
          }));

          const imageTags = resolvedAssets
            .filter((a) => a.artifactType === "image")
            .map((a) => a.tag);
          const videoTags = resolvedAssets
            .filter((a) => a.artifactType === "video")
            .map((a) => a.tag);

          const userMessage = `User query: ${prompt}

Referenced assets:
${JSON.stringify(assetContext, null, 2)}

Available assets:
- Image assets: ${JSON.stringify(imageTags)}
- Video assets: ${JSON.stringify(videoTags)}

Determine which video generation tool to use and what parameters to pass.`;

          const responses = buildIntelligenceResponses(apiKey, {
            timeout: 15_000,
            retries: 0,
          });
          const result = await responses(intelligenceRequest({
            instructions: buildVideoRoutingPrompt(),
            input: userMessage,
            text: { format: { type: "json_object" } },
            max_output_tokens: 2_048,
          }));

          const decision = JSON.parse(firstResponseText(result)) as {
            tool?: string | null;
            params?: Record<string, unknown>;
          };

          if (decision.tool && Object.values(VIDEO_MODELS).some((m) => m.tool_name === decision.tool)) {
            routedToolName = decision.tool;
            routedParams = decision.params ?? {};
          }
        } catch {
          // LLM routing failure — fall through to the default model
        }
      }

      // 4. Load prompt history from action log
      let historyEntries: ActionLogEntry[] = [];
      try {
        const log = fs.history.actionLog();
        historyEntries = log as ActionLogEntry[];
      } catch {
        // action log unavailable
      }

      // 4b. Build set of valid artifact-id tags for the current book so
      //     historical references that no longer exist are stripped.
      const allProjectAssets = fs.artifacts.list();
      const projectAssetTags = new Set(allProjectAssets.map((a) => `@${a.artifactId}`));

      // 5. Build model options for all 5 video models
      // Only pass router params to the model that was actually routed to;
      // other models get empty base params so shared param names (mode, duration)
      // don't bleed across models with different allowed values.
      const modelOptions = Object.entries(VIDEO_MODELS).map(([key, info]) =>
        buildModelOption(
          key, info,
          info.tool_name === routedToolName ? routedParams : {},
          resolvedAssets, historyEntries, providerOverride, projectAssetTags,
        ),
      );

      // 6. Use explicit override, then last-used model from history, then routed
      //    If the chosen model doesn't support the requested provider, pick the first that does.
      const historicalModel = extractLastUsedModel(historyEntries);
      let selectedModel = selectPreviewVideoModel(
        modelOverride,
        historicalModel,
        routedToolName,
      );
      if (providerOverride) {
        const chosen = modelOptions.find((o) => o.key === selectedModel);
        const supportsProvider = chosen?.providers.some((p) => p.key === providerOverride);
        if (!supportsProvider) {
          const compatible = modelOptions.find((o) => o.providers.some((p) => p.key === providerOverride));
          if (compatible) selectedModel = compatible.key;
        }
      }
      const selectedOption = modelOptions.find((o) => o.key === selectedModel) ?? modelOptions[0];

      // 7. Build resolved_assets output (tag/src/type for the frontend)
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
        category: "video",
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
