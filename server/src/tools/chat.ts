/**
 * chat MCP tool — natural language interface that routes to appropriate tools.
 */
import type { ChatLogEntry, Engine, ResolvedArtifact } from "videobook-engine";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import {
  buildChatRoutingPrompt,
  buildChatRoutingUserMessage,
  buildRoutableTools,
  getRoutableTool,
  NESTED_TIMESTAMP_PARAMS,
  TIMESTAMP_PARAMS,
} from "../chat-router.js";
import { parseTime } from "../time-parse.js";
import { withLogging } from "./log-wrapper.js";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { getApiKey } from "../api-key.js";
import { SCRIPT_FILENAME } from "../jobs/describe-image.js";
import { timelineSlotSlugs } from "../timeline-helpers.js";
import {
  buildIntelligenceResponses,
  firstResponseText,
  intelligenceRequest,
} from "../openai-intelligence.js";

type ChatDecision = {
  tool: string;
  params: Record<string, unknown>;
  message: string;
};

type ChatActionPlan = {
  kind: "chat-action-plan";
  planId: string;
  bookId: string;
  prompt: string;
  routedTool: string;
  tool: string;
  params: Record<string, unknown>;
  message: string;
  summary: string;
  effect: "mutation" | "generation";
  confirmation: {
    required: true;
    reason: string;
  };
};

const chatActionPlanSchema = z.object({
  kind: z.literal("chat-action-plan"),
  planId: z.string().uuid(),
  bookId: z.string().uuid(),
  prompt: z.string().min(1),
  routedTool: z.string().min(1),
  tool: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  message: z.string(),
  summary: z.string().min(1),
  effect: z.enum(["mutation", "generation"]),
  confirmation: z.object({
    required: z.literal(true),
    reason: z.string().min(1),
  }),
});

const CHAT_ROUTING_MAX_OUTPUT_TOKENS = 2048;
const CHAT_ROUTING_TIMEOUT_MS = 45_000;

export type ChatResolvedAsset = ResolvedArtifact;

function formatHistoryForPrompt(lines: ChatLogEntry[]): string {
  if (lines.length === 0) return "";
  const formatted = lines.map((line) =>
    line.role === "user"
      ? `User: ${line.text ?? ""}`
      : `Assistant: ${line.tool ? `[${line.tool}] ` : ""}${line.message ?? ""}`,
  );
  return `Recent conversation:\n${formatted.join("\n")}`;
}

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
  // failure mode for create_watermark_card routing under Kie load.
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
  fs: Engine,
  resolvedAssets: ChatResolvedAsset[],
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const a of resolvedAssets) {
    const row: Record<string, unknown> = {
      tag: a.tag,
      type: a.artifactType,
      asset_id: a.artifactSlug,
      has_file: a.filePath !== null,
    };
    const metaResult = await fs.metadata.artifacts.read<AssetOriginMeta>(a.artifactId, "original"
    );
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
  fs: Engine,
  resolvedAssets: ChatResolvedAsset[],
): Promise<Array<{ tag: string; content: string }>> {
  const scriptContents: Array<{ tag: string; content: string }> = [];
  for (const asset of resolvedAssets) {
    if (asset.artifactType !== "script" || !asset.filePath) continue;
    const readResult = await fs.files.read(asset.artifactId, SCRIPT_FILENAME
    );
    if (!readResult.ok) continue;
    const content = typeof readResult.value === "string"
      ? readResult.value
      : new TextDecoder().decode(readResult.value);
    scriptContents.push({ tag: asset.tag, content });
  }
  return scriptContents;
}

function appendChatHistory(
  fs: Engine,
  input: {
    prompt: string;
    tool: string;
    params: Record<string, unknown>;
    message: string;
    failed: boolean;
  },
): void {
  void fs.logs
    .append("chat", { role: "user", text: input.prompt, ts: Date.now() })
    .catch(() => {});
  void fs.logs
    .append(
      "chat",
      {
        role: "assistant",
        tool: input.tool,
        params: input.params,
        message: input.message,
        error: input.failed,
        ts: Date.now(),
      },
    )
    .catch(() => {});
}

async function applyChatActionPlan(
  fs: Engine,
  bookId: string,
  plan: ChatActionPlan,
): Promise<ToolResult> {
  if (plan.bookId !== bookId) {
    return error("The chat action belongs to a different book");
  }
  if (plan.tool === "chat") return error("Chat cannot route to itself");
  const { getAllToolDefs } = await import("./index.js");
  const targetDef = getAllToolDefs(fs).find((definition) =>
    definition.name === plan.tool);
  if (!targetDef) return error(`Tool handler not found: ${plan.tool}`);
  const params = { ...plan.params, book_id: bookId };
  const validated = z.object(targetDef.schema).safeParse(params);
  if (!validated.success) {
    return error(
      `Invalid parameters for ${plan.routedTool}: ${z.prettifyError(validated.error)}`,
    );
  }
  const wrappedDef = withLogging(targetDef, fs);
  let result: ToolResult;
  try {
    result = await wrappedDef.handler(validated.data);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    result = error(`${plan.routedTool} failed: ${message}`);
  }
  appendChatHistory(fs, {
    prompt: plan.prompt,
    tool: plan.routedTool,
    params: plan.params,
    message: plan.message,
    failed: Boolean(result.isError),
  });
  return result;
}

export function chatDef(fs: Engine): ToolDef {
  return {
    name: "chat",
    description: "Natural language interface — executes reads and previews mutations or generation for explicit application. Supports @asset tags (e.g., @vid-foo, @img-bar).",
    schema: {
      prompt: z.string().min(1).optional().describe("Natural language query with optional @asset tags"),
      book_id: z.string().uuid().describe("Book UUID"),
      action_plan: chatActionPlanSchema.optional().describe("Previously previewed action to apply"),
    },
    handler: async (args) => {
      const { prompt, book_id: bookId, action_plan: actionPlan } = args as {
        prompt?: string;
        book_id: string;
        action_plan?: ChatActionPlan;
      };
      if (actionPlan) return await applyChatActionPlan(fs, bookId, actionPlan);
      if (!prompt) return error("A chat prompt is required");
      const book = fs.book.get();

      // 1. Expand @s01 slot refs → actual asset slugs
      let expandedPrompt = prompt;
      expandedPrompt = fs.resolver.expandSlotRefs(prompt, timelineSlotSlugs(fs));

      // 2. Resolve @asset tags
      const resolvedResult = await fs.resolver.resolveAll(expandedPrompt);
      if (!resolvedResult.ok) return error(resolvedResult.error.message);
      const { resolved: resolvedAssets, unresolved } = resolvedResult.value;

      if (unresolved.length > 0) {
        return error(`Asset not found: ${unresolved.map((t) => `@${t}`).join(", ")}`);
      }

      // 3. Build asset context for the LLM (include source_url when known)
      const assetContext = await enrichAssetContext(fs, resolvedAssets);

      const imageFiles = resolvedAssets
        .filter((a) => a.artifactType === "image")
        .map((a) => a.filePath)
        .filter(Boolean);
      const videoFiles = resolvedAssets
        .filter((a) => a.artifactType === "video")
        .map((a) => a.filePath)
        .filter(Boolean);

      const scriptContents = await loadScriptContentsForChat(fs, resolvedAssets);

      // 4. Read recent history for context
      const historyLines = fs.logs.read("chat", {
        limit: 10,
      }) as unknown as ChatLogEntry[];
      const historyContext = formatHistoryForPrompt(historyLines);

      const apiKey = getApiKey("OPENAI_API_KEY");
      if (!apiKey) {
        return error("OPENAI_API_KEY environment variable is not set");
      }

      const { getAllToolDefs } = await import("./index.js");
      const allDefs = getAllToolDefs(fs);
      const routableTools = buildRoutableTools(allDefs);
      const systemPrompt = buildChatRoutingPrompt(
        book.slug,
        routableTools,
        historyContext || undefined,
      );
      const userMessage = buildChatRoutingUserMessage({
        query: expandedPrompt,
        assetContext,
        imageFiles,
        videoFiles,
        scriptContents,
      });

      let decision: ChatDecision;
      try {
        const responses = buildIntelligenceResponses(apiKey, {
          timeout: CHAT_ROUTING_TIMEOUT_MS,
        });
        let lastError: unknown;
        decision = { tool: "", params: {}, message: "" };
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response = await responses(intelligenceRequest({
              instructions: systemPrompt,
              input: userMessage,
              text: { format: { type: "json_object" } },
              max_output_tokens: CHAT_ROUTING_MAX_OUTPUT_TOKENS,
            }), AbortSignal.timeout(CHAT_ROUTING_TIMEOUT_MS));
            const outputText = firstResponseText(response);
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
      const routableTool = getRoutableTool(routableTools, decision.tool);
      if (!routableTool) {
        return error(`Unknown tool: ${decision.tool}. Please rephrase.`);
      }

      // 7. Apply fixups (spread to avoid mutating decision.params for logging)
      const params = normalizeChatTimestampParams(decision.tool, decision.params ?? {});

      // Inject book_id
      params.book_id = bookId;

      // generate_image only accepts @img-* refs; models often put @vid-* in
      // image_slugs for "from the source of @vid-…". Drop non-image slugs and
      // fold them into the text prompt so generation still has the intent.
      if (decision.tool === "generate_image") {
        Object.assign(params, sanitizeGenerateImageParams(params));
      }

      // create_watermark_card needs a URL; if the model omitted it, take source_url
      // from a referenced asset (e.g. "QR from the url in @vid-og").
      if (decision.tool === "create_watermark_card" && (params.url === undefined || params.url === "")) {
        const fromAsset = assetContext.find((a) => typeof a.source_url === "string");
        if (fromAsset) params.url = fromAsset.source_url;
      }

      // Inject script content as prompt for generation tools
      if (scriptContents.length > 0 && routableTool.category === "generation") {
        const combinedScript = scriptContents.map((s) => s.content).join("\n\n");
        params.prompt = combinedScript;
      }

      // 8. Look up handler from tool defs
      const targetDef = allDefs.find((d) => d.name === routableTool.actualTool);

      if (!targetDef) {
        return error(`Tool handler not found: ${routableTool.actualTool}`);
      }

      const validated = z.object(targetDef.schema).safeParse(params);
      if (!validated.success) {
        return error(
          `Invalid parameters for ${decision.tool}: ${z.prettifyError(validated.error)}`,
        );
      }

      if (routableTool.effect !== "read") {
        const effect = routableTool.effect;
        const summary = decision.message.trim()
          || `${effect === "generation" ? "Generate" : "Apply"} with ${decision.tool}`;
        return json({
          kind: "chat-action-plan",
          planId: uuidv7(),
          bookId,
          prompt,
          routedTool: decision.tool,
          tool: targetDef.name,
          params: validated.data,
          message: decision.message,
          summary,
          effect,
          confirmation: {
            required: true,
            reason: effect === "generation"
              ? "This request creates generated media and may incur provider spend"
              : "This request changes the current book",
          },
        } satisfies ChatActionPlan);
      }

      // 9. Execute (wrapped so the routed tool writes its own action log entry)
      const wrappedDef = withLogging(targetDef, fs);
      let handlerResult: ToolResult;
      try {
        handlerResult = await wrappedDef.handler(validated.data);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return error(`${decision.tool} failed: ${message}`);
      }

      appendChatHistory(fs, {
        prompt,
        tool: decision.tool,
        params: decision.params,
        message: decision.message,
        failed: Boolean(handlerResult.isError),
      });

      return handlerResult;
    },
  };
}

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

function json(value: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
