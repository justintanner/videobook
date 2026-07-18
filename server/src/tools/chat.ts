/**
 * chat MCP tool — natural language interface that routes to appropriate tools.
 */
import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { resolveAllAssets, expandSlotRefs } from "videocity-engine";
import { buildChatRoutingPrompt, getRoutableTool, NESTED_TIMESTAMP_PARAMS, TIMESTAMP_PARAMS } from "../chat-router.js";
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
// Live routing can exceed 15s under Kie load even with low thinking; 15s aborts
// surfaced as "Routing failed: ... AbortError" before any decision JSON arrived.
const CHAT_ROUTING_TIMEOUT_MS = 45_000;

export type ChatResolvedAsset = {
  tag: string;
  asset_type: string;
  asset_id: string;
  file_path: string | null;
};

/** Drop non-@img refs from generate_image params; fold them into prompt text. */
export function sanitizeGenerateImageParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(params.image_slugs)) return params;
  const slugs = params.image_slugs.map(String);
  const imageOnly = slugs.filter((s) => /^@?img-/.test(s));
  const dropped = slugs.filter((s) => !/^@?img-/.test(s));
  const next: Record<string, unknown> = { ...params, image_slugs: imageOnly };
  if (dropped.length > 0) {
    const base = typeof params.prompt === "string" ? params.prompt : "";
    const note = `from source ${dropped.join(", ")}`;
    next.prompt = base ? `${base} (${note})` : note;
  }
  return next;
}

export function normalizeChatTimestampParams(
  tool: string,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const params: Record<string, unknown> = { ...source };
  const timestampParams = TIMESTAMP_PARAMS[tool];
  if (timestampParams) {
    for (const paramName of timestampParams) {
      if (!(paramName in params)) continue;
      try {
        params[paramName] = parseTime(params[paramName] as string | number | undefined);
      } catch {
        continue;
      }
    }
  }

  const nestedTimestampParams = NESTED_TIMESTAMP_PARAMS[tool];
  if (!nestedTimestampParams) return params;
  for (const [collectionName, fieldNames] of Object.entries(nestedTimestampParams)) {
    const collection = params[collectionName];
    if (!Array.isArray(collection)) continue;
    params[collectionName] = collection.map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
      const normalized: Record<string, unknown> = { ...(item as Record<string, unknown>) };
      for (const fieldName of fieldNames) {
        if (!(fieldName in normalized)) continue;
        try {
          normalized[fieldName] = parseTime(normalized[fieldName] as string | number | undefined);
        } catch {
          continue;
        }
      }
      return normalized;
    });
  }
  return params;
}

/** Close open strings / braces / brackets so truncated Gemini JSON can parse. */
export function closeTruncatedJson(text: string): string {
  let inString = false;
  let escape = false;
  const stack: string[] = [];

  for (const ch of text) {
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.length > 0 && stack[stack.length - 1] === ch) stack.pop();
    }
  }

  let out = text;
  if (inString) out += "\"";
  // Drop a trailing incomplete property fragment: , "key or , "key": value-less
  out = out.replace(/,\s*"[^"]*"\s*:\s*$/u, "");
  out = out.replace(/,\s*"[^"]*$/u, "");
  out = out.replace(/,\s*$/u, "");

  // Re-scan stack after stripping incomplete tails
  inString = false;
  escape = false;
  stack.length = 0;
  for (const ch of out) {
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.length > 0 && stack[stack.length - 1] === ch) stack.pop();
    }
  }
  if (inString) out += "\"";
  while (stack.length > 0) out += stack.pop();
  return out;
}

/** Best-effort repairs for common Gemini JSON glitches before JSON.parse. */
export function repairChatRoutingJson(text: string): string {
  let out = text.trim();
  // Strip trailing commas before } or ]
  out = out.replace(/,(\s*[}\]])/g, "$1");
  // Quote bare http(s) URLs used as property values
  out = out.replace(
    /(:\s*)(https?:\/\/[^\s,"}\]]+)/g,
    (_m, prefix: string, url: string) => `${prefix}${JSON.stringify(url)}`,
  );
  // Quote bare @slug tokens used as property values
  out = out.replace(
    /(:\s*)(@[\w-]+)/g,
    (_m, prefix: string, slug: string) => `${prefix}${JSON.stringify(slug)}`,
  );
  // Close truncated objects (missing final } / message field) — the live
  // failure mode for create_watermark routing under Kie load.
  out = closeTruncatedJson(out);
  return out;
}

export function parseChatDecision(outputText: string): ChatDecision {
  const attempts = [outputText, repairChatRoutingJson(outputText)];
  let lastError: unknown;
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate) as ChatDecision;
      if (parsed && typeof parsed === "object" && typeof parsed.tool === "string") {
        return {
          tool: parsed.tool,
          params: (parsed.params && typeof parsed.params === "object"
            ? parsed.params
            : {}) as Record<string, unknown>,
          message: typeof parsed.message === "string" ? parsed.message : "",
        };
      }
      lastError = new Error("Routing decision missing tool field");
    } catch (e) {
      lastError = e;
    }
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  const snippet = outputText.length > 200 ? `${outputText.slice(0, 200)}…` : outputText;
  throw new Error(`${msg} (raw: ${JSON.stringify(snippet)})`);
}

type AssetOriginMeta = {
  source_url?: unknown;
  webpage_url?: unknown;
};

export async function enrichAssetContext(
  fs: VideocityFs,
  resolvedAssets: ChatResolvedAsset[],
  slug: string,
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const a of resolvedAssets) {
    const row: Record<string, unknown> = {
      tag: a.tag,
      type: a.asset_type,
      asset_id: a.asset_id,
      has_file: a.file_path !== null,
    };
    const metaResult = await fs.readMetadata<AssetOriginMeta>(a.asset_id, "original", slug);
    if (metaResult.ok) {
      const sourceUrl =
        typeof metaResult.value.source_url === "string"
          ? metaResult.value.source_url
          : typeof metaResult.value.webpage_url === "string"
            ? metaResult.value.webpage_url
            : null;
      if (sourceUrl) row.source_url = sourceUrl;
    }
    rows.push(row);
  }
  return rows;
}

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

      // 3. Build asset context for the LLM (include source_url when known)
      const assetContext = await enrichAssetContext(fs, resolvedAssets, slug);

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
        // One retry: Gemini occasionally returns brace-balanced but invalid JSON
        // (unquoted URLs, trailing commas). repairChatRoutingJson covers common
        // cases; a second call recovers from rarer corruption.
        let lastError: unknown;
        decision = { tool: "", params: {}, message: "" };
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const outputText = await callGeminiFlashJson({
              apiKey,
              parts: [
                geminiTextPart(`Instructions:\n${systemPrompt}`),
                geminiTextPart(userMessage),
              ],
              temperature: 0.1,
              maxOutputTokens: CHAT_ROUTING_MAX_OUTPUT_TOKENS,
              // Do not pass responseSchema: Kie gemini-3.5-flash + open-ended
              // params objects frequently truncates to incomplete JSON
              // (e.g. `{"tool":"...","params": {`). application/json + normalize is enough.
              thinkingConfig: { includeThoughts: false, thinkingLevel: "low" },
              timeout: CHAT_ROUTING_TIMEOUT_MS,
              signal: AbortSignal.timeout(CHAT_ROUTING_TIMEOUT_MS),
            });
            decision = parseChatDecision(outputText);
            lastError = null;
            break;
          } catch (e) {
            lastError = e;
          }
        }
        if (lastError) {
          const msg = lastError instanceof Error ? lastError.message : String(lastError);
          return error(`Routing failed: ${msg}`);
        }
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
      const params = normalizeChatTimestampParams(decision.tool, decision.params ?? {});

      // Inject project_slug
      params.project_slug = slug;

      // generate_image only accepts @img-* refs; models often put @vid-* in
      // image_slugs for "from the source of @vid-…". Drop non-image slugs and
      // fold them into the text prompt so generation still has the intent.
      if (decision.tool === "generate_image") {
        Object.assign(params, sanitizeGenerateImageParams(params));
      }

      // create_watermark needs a URL; if the model omitted it, take source_url
      // from a referenced asset (e.g. "QR from the url in @vid-og").
      if (decision.tool === "create_watermark" && (params.url === undefined || params.url === "")) {
        const fromAsset = assetContext.find((a) => typeof a.source_url === "string");
        if (fromAsset) params.url = fromAsset.source_url;
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

      // Action tools: return the LLM's brief message. create_watermark is an
      // exception — surface the created asset_id JSON so the client can use it.
      if (handlerResult.isError || decision.tool === "create_watermark") {
        return handlerResult;
      }
      return { content: [{ type: "text" as const, text: decision.message ?? "Done." }] };
    },
  };
}

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}
