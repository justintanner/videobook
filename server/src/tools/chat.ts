/**
 * chat MCP tool — natural language interface that routes to appropriate tools.
 */
import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { resolveAllAssets, expandSlotRefs } from "videocity-engine";
import { buildChatRoutingPrompt, getRoutableTool, TIMESTAMP_PARAMS } from "../chat-router.js";
import { getRecentHistory, formatHistoryForPrompt, logUserTurn, logAssistantTurn } from "videocity-engine";
import { parseTime } from "../time-parse.js";
import { withLogging } from "./log-wrapper.js";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { callGeminiFlashJson, geminiTextPart } from "../kie-gemini.js";
import { getApiKey } from "../api-key.js";
import { SCRIPT_FILENAME } from "../jobs/describe-image.js";

type ChatDecision = {
  tool: string;
  params: Record<string, unknown>;
  message: string;
};

// Thinking tokens count against maxOutputTokens on gemini-3.5-flash; 512 was
// too low and truncated routing JSON mid-string ("Unterminated string in JSON").
const CHAT_ROUTING_MAX_OUTPUT_TOKENS = 2048;

export type ChatResolvedAsset = {
  tag: string;
  asset_type: string;
  asset_id: string;
  file_path: string | null;
};

export async function loadScriptContentsForChat(
  fs: VideocityFs,
  resolvedAssets: ChatResolvedAsset[],
  slug: string,
): Promise<Array<{ tag: string; content: string }>> {
  const scriptContents: Array<{ tag: string; content: string }> = [];
  for (const asset of resolvedAssets) {
    if (asset.asset_type !== "script" || !asset.file_path) continue;
    const readResult = await fs.readFile(asset.asset_id, SCRIPT_FILENAME, slug);
    if (!readResult.ok) continue;
    const content = typeof readResult.value === "string"
      ? readResult.value
      : new TextDecoder().decode(readResult.value);
    scriptContents.push({ tag: asset.tag, content });
  }
  return scriptContents;
}

export function chatDef(fs: VideocityFs): ToolDef {
  return {
    name: "chat",
    description: "Natural language interface — routes free-form prompts to the appropriate tool. Supports @asset tags (e.g., @vid-foo, @img-bar).",
    schema: {
      prompt: z.string().describe("Natural language query with optional @asset tags"),
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

      if (unresolved.length > 0) {
        return error(`Asset not found: ${unresolved.map((t) => `@${t}`).join(", ")}`);
      }

      // 3. Build asset context for the LLM
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

      const scriptContents = await loadScriptContentsForChat(fs, resolvedAssets, slug);

      // 4. Read recent history for context
      const historyLines = await getRecentHistory(fs, slug);
      const historyContext = formatHistoryForPrompt(historyLines);

      const apiKey = getApiKey("KIE_API_KEY");
      if (!apiKey) {
        return error("KIE_API_KEY environment variable is not set");
      }

      const systemPrompt = buildChatRoutingPrompt(slug, historyContext || undefined);
      const userMessage = `User query: ${expandedPrompt}

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
        const outputText = await callGeminiFlashJson({
          apiKey,
          parts: [
            geminiTextPart(`Instructions:\n${systemPrompt}`),
            geminiTextPart(userMessage),
          ],
          temperature: 0.1,
          maxOutputTokens: CHAT_ROUTING_MAX_OUTPUT_TOKENS,
          timeout: 15_000,
          signal: AbortSignal.timeout(15_000),
        });

        decision = JSON.parse(outputText) as ChatDecision;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return error(`Routing failed: ${msg}`);
      }

      if (!decision.tool) {
        return error("Could not determine which tool to use. Please rephrase.");
      }

      // 6. Validate tool exists in routable registry
      const routableTool = getRoutableTool(decision.tool);
      if (!routableTool) {
        return error(`Unknown tool: ${decision.tool}. Please rephrase.`);
      }

      // 7. Apply fixups (spread to avoid mutating decision.params for logging)
      const params: Record<string, unknown> = { ...(decision.params ?? {}) };

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

      // 8. Look up handler from tool defs
      // Lazy import to avoid circular dependency at module load time
      const { getAllToolDefs } = await import("./index.js");
      const allDefs = getAllToolDefs(fs);
      const targetDef = allDefs.find((d) => d.name === routableTool.actualTool);

      if (!targetDef) {
        return error(`Tool handler not found: ${routableTool.actualTool}`);
      }

      // 9. Execute (wrapped so the routed tool writes its own action log entry)
      const wrappedDef = withLogging(targetDef, fs);
      const handlerResult = await wrappedDef.handler(params as Record<string, unknown>);

      // 10. Log chat history (fire-and-forget)
      logUserTurn(fs, slug, prompt);
      logAssistantTurn(fs, slug, decision.tool, decision.params, decision.message, Boolean(handlerResult.isError));

      // 11. Return based on category
      if (routableTool.category === "generation") {
        // Return the preview JSON from the generation handler
        return handlerResult;
      }

      // Action tools: return the LLM's brief message
      if (handlerResult.isError) {
        return handlerResult;
      }
      return { content: [{ type: "text" as const, text: decision.message ?? "Done." }] };
    },
  };
}

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}
