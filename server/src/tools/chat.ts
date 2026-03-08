/**
 * chat MCP tool — natural language interface that routes to appropriate tools.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { openai } from "@nakedapi/openai";
import { resolveAllAssets } from "../asset-resolver.js";
import { buildChatRoutingPrompt, getRoutableTool, TIMESTAMP_PARAMS } from "../chat-router.js";
import { parseTime } from "../time-parse.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

type ChatDecision = {
  tool: string;
  params: Record<string, unknown>;
  message: string;
};

export function chatDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "chat",
    description: "Natural language interface — routes free-form prompts to the appropriate tool. Supports @asset tags (e.g., @vid-foo, @img-bar).",
    schema: {
      prompt: z.string().describe("Natural language query with optional @asset tags"),
      project_slug: z.string().optional().describe("Project slug (defaults to 'default')"),
    },
    handler: async (args) => {
      const { prompt, project_slug } = args as {
        prompt: string;
        project_slug?: string;
      };
      const slug = project_slug ?? "default";

      // 1. Resolve @asset tags
      const { resolved: resolvedAssets, unresolved } = await resolveAllAssets(prompt, fs, slug);

      if (unresolved.length > 0) {
        return error(`Asset not found: ${unresolved.map((t) => `@${t}`).join(", ")}`);
      }

      // 2. Build asset context for the LLM
      const assetContext = resolvedAssets.map((a) => ({
        tag: a.tag,
        type: a.asset_type,
        asset_id: a.asset_id,
        has_file: a.file_path !== null,
      }));

      const imageFiles = resolvedAssets
        .filter((a) => a.asset_type === "image")
        .map((a) => a.file_path)
        .filter(Boolean);
      const videoFiles = resolvedAssets
        .filter((a) => a.asset_type === "video")
        .map((a) => a.file_path)
        .filter(Boolean);

      const scriptContents: Array<{ tag: string; content: string }> = [];
      for (const asset of resolvedAssets) {
        if (asset.asset_type === "script" && asset.file_path) {
          const readResult = await fs.readFile(asset.asset_id, "index.md", slug);
          if (readResult.ok) {
            scriptContents.push({ tag: asset.tag, content: readResult.value });
          }
        }
      }

      // 3. Call GPT 5.4 for routing
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return error("OPENAI_API_KEY environment variable is not set");
      }

      const systemPrompt = buildChatRoutingPrompt(slug);
      const userMessage = `User query: ${prompt}

Referenced assets:
${JSON.stringify(assetContext, null, 2)}

Available file paths:
- Image files: ${JSON.stringify(imageFiles)}
- Video files: ${JSON.stringify(videoFiles)}

Script contents:
${scriptContents.length > 0 ? JSON.stringify(scriptContents, null, 2) : "None"}

Determine which tool to use and what parameters to pass.`;

      let decision: ChatDecision;
      try {
        const provider = openai({ apiKey, timeout: 15_000 });
        const result = await provider.chat({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          response_format: { type: "json_object" },
          temperature: 0.1,
          max_completion_tokens: 512,
        });

        decision = JSON.parse(result.content) as ChatDecision;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return error(`Routing failed: ${msg}`);
      }

      if (!decision.tool) {
        return error("Could not determine which tool to use. Please rephrase.");
      }

      // 4. Validate tool exists in routable registry
      const routableTool = getRoutableTool(decision.tool);
      if (!routableTool) {
        return error(`Unknown tool: ${decision.tool}. Please rephrase.`);
      }

      // 5. Apply fixups
      const params = decision.params ?? {};

      // Inject project_slug
      params.project_slug = slug;

      // Safety-net parseTime on timestamp params
      const tsParams = TIMESTAMP_PARAMS[decision.tool];
      if (tsParams) {
        for (const paramName of tsParams) {
          if (paramName in params) {
            try {
              params[paramName] = parseTime(params[paramName] as string | number | undefined);
            } catch {
              // Leave as-is if parsing fails — the downstream tool will validate
            }
          }
        }
      }

      // Inject script content as prompt for generation tools
      if (scriptContents.length > 0 && routableTool.category === "generation") {
        const combinedScript = scriptContents.map((s) => s.content).join("\n\n");
        params.prompt = combinedScript;
      }

      // 6. Look up handler from tool defs
      // Lazy import to avoid circular dependency at module load time
      const { getAllToolDefs } = await import("./index.js");
      const allDefs = getAllToolDefs(fs);
      const targetDef = allDefs.find((d) => d.name === routableTool.actualTool);

      if (!targetDef) {
        return error(`Tool handler not found: ${routableTool.actualTool}`);
      }

      // 7. Execute
      const handlerResult = await targetDef.handler(params as Record<string, unknown>);

      // 8. Return based on category
      if (routableTool.category === "generation") {
        // Return the preview JSON from the generation handler
        return handlerResult;
      }

      // Action tools: return the LLM's brief message
      if (handlerResult.isError) {
        return handlerResult;
      }
      return { content: [{ type: "text" as const, text: decision.message }] };
    },
  };
}

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

export function registerChatTool(server: McpServer, fs: ClipfirstFs): void {
  const def = chatDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
