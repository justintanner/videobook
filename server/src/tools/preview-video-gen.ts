/**
 * preview_video MCP tool — routes a natural language prompt to the best
 * video generation tool and returns a rich preview JSON for the frontend to
 * render a dynamic parameter form.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { openai } from "@nakedapi/openai";
import { resolveAllAssets, expandSlotRefs } from "../asset-resolver.js";
import {
  VIDEO_MODELS,
  buildVideoRoutingPrompt,
  buildModelOption,
} from "../video-models.js";
import type { ActionLogEntry } from "../video-models.js";
import type { ToolDef } from "./tool-def.js";

function findSelectedModel(toolName: string): string | null {
  for (const [key, info] of Object.entries(VIDEO_MODELS)) {
    if (info.tool_name === toolName) return key;
  }
  return null;
}

export function previewVideoGenDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "preview_video",
    description:
      "Route a natural language prompt to the best video generation tool and return a preview with schema, prefilled parameters, validation, and model options for all available video models.",
    schema: {
      prompt: z.string().describe("Natural language generation prompt (e.g., 'gen a video of a sunset')"),
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

      // 3. Route prompt via GPT-4o-mini
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "OPENAI_API_KEY environment variable is not set" }],
        };
      }

      let routedToolName = "generate_kling30_video"; // fallback default
      let routedParams: Record<string, unknown> = {};

      try {
        const assetContext = resolvedAssets.map((a) => ({
          tag: a.tag,
          type: a.asset_type,
          asset_id: a.asset_id,
          has_file: a.file_path !== null,
        }));

        const imageTags = resolvedAssets
          .filter((a) => a.asset_type === "image")
          .map((a) => a.tag);
        const videoTags = resolvedAssets
          .filter((a) => a.asset_type === "video")
          .map((a) => a.tag);

        const userMessage = `User query: ${prompt}

Referenced assets:
${JSON.stringify(assetContext, null, 2)}

Available assets:
- Image assets: ${JSON.stringify(imageTags)}
- Video assets: ${JSON.stringify(videoTags)}

Determine which video generation tool to use and what parameters to pass.`;

        const provider = openai({ apiKey, timeout: 15_000 });
        const result = await provider.v1.chat.completions({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: buildVideoRoutingPrompt() },
            { role: "user", content: userMessage },
          ],
          response_format: { type: "json_object" },
          temperature: 0.1,
          max_completion_tokens: 512,
        });

        const decision = JSON.parse(result.content) as {
          tool?: string | null;
          params?: Record<string, unknown>;
        };

        if (decision.tool && Object.values(VIDEO_MODELS).some((m) => m.tool_name === decision.tool)) {
          routedToolName = decision.tool;
          routedParams = decision.params ?? {};
        }
      } catch {
        // LLM routing failure — fall through to kling30 default
      }

      // 4. Load prompt history from action log
      let historyEntries: ActionLogEntry[] = [];
      try {
        const log = await fs.getActionLog({ limit: 100 }, slug);
        historyEntries = log as ActionLogEntry[];
      } catch {
        // action log unavailable
      }

      // 5. Build model options for all 5 video models
      // Only pass router params to the model that was actually routed to;
      // other models get empty base params so shared param names (mode, duration)
      // don't bleed across models with different allowed values.
      const modelOptions = Object.entries(VIDEO_MODELS).map(([key, info]) =>
        buildModelOption(
          key, info,
          info.tool_name === routedToolName ? routedParams : {},
          resolvedAssets, historyEntries,
        ),
      );

      // 6. Determine selected model
      const selectedModel = findSelectedModel(routedToolName) ?? "kling30";
      const selectedOption = modelOptions.find((o) => o.key === selectedModel) ?? modelOptions[0];

      // 7. Build resolved_assets output
      const assetDicts = resolvedAssets.map((a) => ({
        tag: a.tag,
        asset_id: a.asset_id,
        asset_type: a.asset_type,
        file_path: a.file_path,
      }));

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

export function registerPreviewVideoGenTool(server: McpServer, fs: ClipfirstFs): void {
  const def = previewVideoGenDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
