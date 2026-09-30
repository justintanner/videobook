/**
 * chat MCP tool — natural language interface that routes to appropriate tools.
 */
import type {
  ChatLogEntry,
  Engine,
  NotebookDocument,
} from "videobook-engine";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import {
  applyBytedanceNamedModelRoute,
  applyStackedChainRoute,
  applyVideoJoinRoute,
  AUTO_APPLY_TOOL_NAMES,
  buildChatRoutingPrompt,
  buildChatRoutingUserMessage,
  buildRoutableTools,
  effectForTool,
  getRoutableTool,
  NESTED_TIMESTAMP_PARAMS,
  TIMESTAMP_PARAMS,
} from "../chat-router.js";
import {
  ensureChainStepIds,
  planStackedChainFromQuery,
  preflightChainPlan,
} from "../chain-plan.js";
import { withoutUnrequestedSettings } from "../chat-generation-settings.js";
import { resolveChatViewAction } from "../chat-view-actions.js";
import { rewriteChatGenerationPrompt } from "../chat-prompt-rewrite.js";
import type { ChatRoutingNotebookContext } from "../chat-router.js";
import { parseTime } from "../time-parse.js";
import { withLogging } from "./log-wrapper.js";
import { listElevenLabsVoices } from "./list-elevenlabs-voices.js";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { getApiKey } from "../api-key.js";
import { SCRIPT_FILENAME } from "../jobs/describe-image.js";
import { timelineSlotArtifactIds } from "../timeline-helpers.js";
import {
  expandSlotRefs,
  parseArtifactIdTags,
  resolveArtifactRefs,
  type ResolvedArtifactRef,
} from "../artifact-refs.js";
import {
  buildIntelligenceResponses,
  firstResponseText,
  intelligenceRequest,
} from "../openai-intelligence.js";
import {
  chatIntelligenceRequestOptions,
  chatModelSchema,
  type ChatModelId,
} from "../chat-models.js";
import {
  notebookGridAddress,
} from "videobook-engine/notebook-grid";
import {
  NOTEBOOK_GRID_ADDRESS_SOURCE,
  replaceNotebookMentions,
} from "videobook-engine/notebook-mentions";
import {
  notebookMediaAddresses,
  resolveNotebookPromptReferences,
  tagNotebookGridAddresses,
} from "../notebook-reference-resolver.js";

export type ChatDecision = {
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
  effect: "mutation" | "generation" | "view";
  confirmation: {
    required: boolean;
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
  effect: z.enum(["mutation", "generation", "view"]),
  confirmation: z.object({
    required: z.boolean(),
    reason: z.string().min(1),
  }),
});

const CHAT_ROUTING_MAX_OUTPUT_TOKENS = 2048;
const CHAT_ROUTING_TIMEOUT_MS = 45_000;
const NOTEBOOK_DESTINATION_SOURCE = NOTEBOOK_GRID_ADDRESS_SOURCE;

function duplicateDestinationReference(prompt: string): string | null {
  if (!/\b(?:copy|duplicate)\b/iu.test(prompt)) return null;
  const explicit = new RegExp(
    `\\b(?:at|in|into|to)\\s+@(${NOTEBOOK_DESTINATION_SOURCE})(?![\\w-])`,
    "iu",
  ).exec(prompt);
  if (explicit?.[1]) return explicit[1].toLowerCase();
  const mentions = [...prompt.matchAll(new RegExp(
    `@(${NOTEBOOK_DESTINATION_SOURCE})(?![\\w-])`,
    "giu",
  ))];
  return mentions.length > 1
    ? mentions.at(-1)?.[1]?.toLowerCase() ?? null
    : null;
}

type ChatResolvedAsset = ResolvedArtifactRef;

function buildChatNotebookContext(
  engine: Engine,
  notebook: NotebookDocument | null,
): ChatRoutingNotebookContext | null {
  if (!notebook) return null;
  return {
    id: notebook.id,
    name: notebook.name,
    cells: notebook.cells.map((cell) => {
      const artifact = cell.outputArtifactId
        ? engine.artifacts.get(cell.outputArtifactId)
        : null;
      return {
        address: `@${notebookGridAddress(cell.slot)}`,
        cellId: cell.id,
        ...(cell.label === undefined ? {} : { label: cell.label }),
        type: cell.type,
        outputAsset: artifact?.ok ? `@${artifact.value.artifactId}` : null,
      };
    }),
  };
}

function attachNotebookReferences(
  assetContext: Array<Record<string, unknown>>,
  notebookContext: ChatRoutingNotebookContext | null,
): Array<Record<string, unknown>> {
  if (!notebookContext) return assetContext;
  return assetContext.map((asset) => {
    const assetId = typeof asset.asset_id === "string" ? asset.asset_id : "";
    const references = notebookContext.cells
      .filter((cell) => cell.outputAsset === `@${assetId}`)
      .map((cell) => cell.address);
    return references.length > 0
      ? { ...asset, notebook_references: references }
      : asset;
  });
}

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
  if (!Array.isArray(params.image_refs)) return params;
  const slugs = params.image_refs.map(String);
  const imageOnly = slugs.filter((s) => /^@?img-/.test(s));
  const dropped = slugs.filter((s) => !/^@?img-/.test(s));
  const next: Record<string, unknown> = { ...params, image_refs: imageOnly };
  if (dropped.length > 0) {
    const base = typeof params.prompt === "string" ? params.prompt : "";
    const note = `from source ${dropped.join(", ")}`;
    next.prompt = base ? `${base} (${note})` : note;
  }
  return next;
}

/**
 * Fill speech-routing gaps for generate_elevenlabs_text_to_audio: the words to
 * speak may arrive in prompt instead of text, and the router model cannot know
 * ElevenLabs voice ids, so an omitted voice_id gets the catalog default
 * (custom voices first). The client review drawer lets the user change it.
 */
export async function applySpeechRoutingDefaults(
  tool: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (tool !== "generate_elevenlabs_text_to_audio") return params;
  const next: Record<string, unknown> = { ...params };
  const text = typeof next.text === "string" ? next.text.trim() : "";
  const prompt = typeof next.prompt === "string" ? next.prompt.trim() : "";
  if (!text && prompt) next.text = prompt;
  const voiceId = typeof next.voice_id === "string" ? next.voice_id.trim() : "";
  if (!voiceId) {
    const catalog = await listElevenLabsVoices();
    const fallback = catalog.voices[0]?.voice_id;
    if (fallback) next.voice_id = fallback;
  }
  return next;
}

function isMediaContextObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripAssetToken(value: string): string {
  return value.replace(/^@/u, "").trim();
}

function stringAssetIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => typeof entry === "string" && entry.trim()
    ? [stripAssetToken(entry)]
    : []);
}

function overlapNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

export function normalizeChatRoutedParams(
  tool: string,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const params: Record<string, unknown> = { ...source };
  if (tool === "plan_chat_command") {
    const context = params.media_context;
    if (Array.isArray(context)) {
      if (context.length === 1 && isMediaContextObject(context[0])) {
        params.media_context = context[0];
      } else {
        delete params.media_context;
      }
    }
    return params;
  }
  if (tool === "chain") {
    if ("steps" in params) params.steps = ensureChainStepIds(params.steps);
    return params;
  }
  if (tool !== "splice_video") return params;
  const assetIds = stringAssetIds(params.asset_ids);
  if (
    typeof params.first_asset_id !== "string"
    && assetIds.length >= 2
  ) {
    params.first_asset_id = assetIds[0];
    params.second_asset_id = assetIds[1];
    if (assetIds.length > 2) params.additional_asset_ids = assetIds.slice(2);
  }
  if (typeof params.first_asset_id === "string") {
    params.first_asset_id = stripAssetToken(params.first_asset_id);
  }
  if (typeof params.second_asset_id === "string") {
    params.second_asset_id = stripAssetToken(params.second_asset_id);
  }
  const additional = stringAssetIds(params.additional_asset_ids);
  if (additional.length > 0) params.additional_asset_ids = additional;
  const overlap = overlapNumber(params.overlap);
  if (overlap !== undefined) params.overlap = overlap;
  else if (params.overlap === undefined) params.overlap = 0;
  delete params.asset_ids;
  delete params.media_context;
  return params;
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
function closeTruncatedJson(text: string): string {
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
  engine: Engine,
  resolvedAssets: ChatResolvedAsset[],
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const a of resolvedAssets) {
    const row: Record<string, unknown> = {
      tag: a.tag,
      type: a.artifactType,
      asset_id: a.artifactId,
      has_file: a.filePath !== null,
    };
    const metaResult = await engine.metadata.artifacts.read<AssetOriginMeta>(a.artifactId, "original"
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
  engine: Engine,
  resolvedAssets: ChatResolvedAsset[],
): Promise<Array<{ tag: string; content: string }>> {
  const scriptContents: Array<{ tag: string; content: string }> = [];
  for (const asset of resolvedAssets) {
    if (asset.artifactType !== "script" || !asset.filePath) continue;
    const readResult = await engine.files.read(asset.artifactId, SCRIPT_FILENAME
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
  engine: Engine,
  input: {
    prompt: string;
    tool: string;
    params: Record<string, unknown>;
    message: string;
    failed: boolean;
  },
): void {
  void engine.logs
    .append("chat", { role: "user", text: input.prompt, ts: Date.now() })
    .catch(() => {});
  void engine.logs
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

function autoApplyReason(tool: string, chainPausesPerStep = false): string {
  return tool === "duplicate_asset"
    ? "Duplication is reversible and only adds a copied asset and cell"
    : tool === "extract_audio"
    ? "Audio extraction is free, local, and only adds derived media"
    : tool === "chain"
    ? chainPausesPerStep
      ? "Every step that spends money stops for its own review before it runs"
      : "This chain only reads or auto-applies existing local actions"
    : "Frame extraction is free and only adds a new image cell";
}

async function applyChatActionPlan(
  engine: Engine,
  bookId: string,
  plan: ChatActionPlan,
): Promise<ToolResult> {
  if (plan.bookId !== bookId) {
    return error("The chat action belongs to a different book");
  }
  if (plan.tool === "chat") return error("Chat cannot route to itself");
  if (plan.effect === "view") return error("View actions open in the app and have nothing to apply");
  const { getAllToolDefs } = await import("./index.js");
  const targetDef = getAllToolDefs(engine).find((definition) =>
    definition.name === plan.tool);
  if (!targetDef) return error(`Tool handler not found: ${plan.tool}`);
  const params = { ...plan.params, book_id: bookId };
  if (plan.tool === "chain" && "steps" in params) {
    params.steps = ensureChainStepIds(params.steps);
  }
  const validated = z.object(targetDef.schema).safeParse(params);
  if (!validated.success) {
    return error(
      `Invalid parameters for ${plan.routedTool}: ${z.prettifyError(validated.error)}`,
    );
  }
  const wrappedDef = withLogging(targetDef, engine);
  let result: ToolResult;
  try {
    result = await wrappedDef.handler(validated.data);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    result = error(`${plan.routedTool} failed: ${message}`);
  }
  appendChatHistory(engine, {
    prompt: plan.prompt,
    tool: plan.routedTool,
    params: plan.params,
    message: plan.message,
    failed: Boolean(result.isError),
  });
  return result;
}

export { chatActionPlanSchema, duplicateDestinationReference };


export function chatDef(engine: Engine): ToolDef {
  return {
    name: "chat",
    description: "LLM-backed router for the Videobook app composer. It executes reads and previews mutations or generation for explicit application. ChatGPT and other LLM hosts should call the specific media tools directly instead of calling this nested router.",
    schema: {
      prompt: z.string().min(1).optional().describe("Natural language query with optional @asset tags"),
      book_id: z.string().uuid().describe("Book UUID"),
      notebook_id: z.string().uuid().optional().describe("Open notebook UUID for resolving grid addresses"),
      model: chatModelSchema.optional().describe("Chat routing model"),
      action_plan: chatActionPlanSchema.optional().describe("Previously previewed action to apply"),
    },
    handler: (args) => handleChatRequest(engine, args),
  };
}

export function prepareVoiceChatAction(
  engine: Engine,
  input: { book_id: string; notebook_id?: string; prompt: string },
  decision: ChatDecision,
): Promise<ToolResult> {
  return handleChatRequest(engine, input, decision);
}

async function handleChatRequest(
  engine: Engine,
  args: Record<string, unknown>,
  proposedDecision?: ChatDecision,
): Promise<ToolResult> {
  const { prompt, book_id: bookId, notebook_id: notebookId, model, action_plan: actionPlan } = args as {
    prompt?: string;
    book_id: string;
    notebook_id?: string;
    model?: ChatModelId;
    action_plan?: ChatActionPlan;
  };
  if (actionPlan) return await applyChatActionPlan(engine, bookId, actionPlan);
  if (!prompt) return error("A chat prompt is required");
  const chatRequest = chatIntelligenceRequestOptions(model);
  const book = engine.book.get();
  let notebookDocument: NotebookDocument | null = null;
  try {
    if (notebookId) {
      const notebook = engine.notebooks.read(notebookId);
      if (!notebook.ok) throw new Error(notebook.error.message);
      notebookDocument = notebook.value;
    }
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : String(cause));
  }
  const notebookContext = buildChatNotebookContext(engine, notebookDocument);
  const notebookAddresses = notebookDocument
    ? notebookMediaAddresses(notebookDocument)
    : new Set<string>();

  // 0. Tag bare grid addresses ("the image at A1") so the steps below see the
  // reference the speaker meant instead of prose.
  const taggedPrompt = tagNotebookGridAddresses(prompt, notebookAddresses);

  // 1. Expand @s01 slot refs → the artifact ids they occupy
  const expandedPrompt = expandSlotRefs(
    taggedPrompt,
    timelineSlotArtifactIds(engine),
  );
  const stackedPlan = planStackedChainFromQuery(expandedPrompt);
  if (stackedPlan) {
    const { getAllToolDefs } = await import("./index.js");
    const allDefs = getAllToolDefs(engine);
    const targetDef = allDefs.find((definition) => definition.name === "chain");
    if (!targetDef) return error("Tool handler not found: chain");
    const preflight = await preflightChainPlan({
      action: "run",
      version: 1,
      book_id: bookId,
      ...(notebookId ? { notebook_id: notebookId } : {}),
      steps: stackedPlan.steps,
    }, {
      engine,
      bookId,
      notebookId,
      toolSchemas: new Map(
        allDefs.map((definition) => [definition.name, definition.schema]),
      ),
      autoApplyTools: AUTO_APPLY_TOOL_NAMES,
      effectForTool: (name) => effectForTool(
        name,
        /^(?:generate|extend|upscale)_/u.test(name) ? "generation" : "action",
      ),
    });
    if (!preflight.ok) return error(preflight.error);
    const params: Record<string, unknown> = {
      action: "run",
      version: 1,
      book_id: bookId,
      ...(notebookId ? { notebook_id: notebookId } : {}),
      steps: stackedPlan.steps,
    };
    const validated = z.object(targetDef.schema).safeParse(params);
    if (!validated.success) {
      return error(
        `Invalid parameters for chain: ${z.prettifyError(validated.error)}`,
      );
    }
    const effect = preflight.plan.effect === "generation"
      ? "generation"
      : "mutation";
    const autoApply = preflight.plan.autoApply;
    return json({
      kind: "chat-action-plan",
      planId: uuidv7(),
      bookId,
      prompt: taggedPrompt,
      routedTool: "chain",
      tool: "chain",
      params: validated.data,
      message: stackedPlan.message,
      summary: stackedPlan.message,
      effect,
      confirmation: {
        required: !autoApply,
        reason: autoApply
          ? "This chain only reads or auto-applies existing local actions"
          : "This request changes the current book",
      },
    } satisfies ChatActionPlan);
  }
  const notebookResolution = notebookDocument
    ? resolveNotebookPromptReferences({
        engine: engine,
        document: notebookDocument,
        prompt: expandedPrompt,
        requireMedia: false,
      })
    : null;
  const duplicateDestination = duplicateDestinationReference(expandedPrompt);
  const resolutionPrompt = notebookResolution && duplicateDestination
    ? replaceNotebookMentions(
        expandedPrompt,
        notebookResolution.resolved
          .filter((item) => item.reference !== duplicateDestination)
          .map((item) => ({
            reference: item.reference,
            replacement: `@${item.artifactId}`,
          })),
      )
    : notebookResolution?.prompt ?? expandedPrompt;
  const unresolvedNotebookReferences = notebookResolution?.unresolved
    .filter((issue) => issue.reference !== duplicateDestination)
    ?? [];

  if (unresolvedNotebookReferences.length > 0) {
    return error(`Asset not found: ${
      unresolvedNotebookReferences
        .map((issue) => `${issue.mention} (${issue.code})`)
        .join(", ")
    }`);
  }

  // 2. Resolve @<artifact-id> tags
  const { resolved: resolvedAssets, unresolved } = await resolveArtifactRefs(
    engine,
    parseArtifactIdTags(resolutionPrompt),
  );

  if (unresolved.length > 0) {
    return error(`Asset not found: ${unresolved.join(", ")}`);
  }

  // 3. Build asset context for the LLM (include source_url when known)
  const assetContext = attachNotebookReferences(
    await enrichAssetContext(engine, resolvedAssets),
    notebookContext,
  );

  const imageFiles = resolvedAssets
    .filter((asset) => asset.artifactType === "image")
    .map((asset) => asset.filePath)
    .filter((path): path is string => path !== null);
  const videoFiles = resolvedAssets
    .filter((asset) => asset.artifactType === "video")
    .map((asset) => asset.filePath)
    .filter((path): path is string => path !== null);

  const scriptContents = await loadScriptContentsForChat(engine, resolvedAssets);

  // 4. Read recent history for context
  const historyLines = engine.logs.read("chat", {
    limit: 10,
  }) as unknown as ChatLogEntry[];
  const historyContext = formatHistoryForPrompt(historyLines);

  const apiKey = getApiKey("OPENAI_API_KEY");
  if (!apiKey && !proposedDecision) {
    return error("OPENAI_API_KEY environment variable is not set");
  }

  const { getAllToolDefs } = await import("./index.js");
  const allDefs = getAllToolDefs(engine);
  const routableTools = buildRoutableTools(allDefs);
  const systemPrompt = buildChatRoutingPrompt(
    book.name,
    routableTools,
    historyContext || undefined,
  );
  const userMessage = buildChatRoutingUserMessage({
    query: expandedPrompt,
    assetContext,
    imageFiles,
    videoFiles,
    scriptContents,
    notebookContext,
  });

  let decision: ChatDecision;
  if (proposedDecision) {
    decision = proposedDecision;
  } else try {
    const responses = buildIntelligenceResponses(apiKey ?? undefined, {
      timeout: CHAT_ROUTING_TIMEOUT_MS,
      model: chatRequest.model,
      reasoningEffort: chatRequest.reasoningEffort,
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
        }, chatRequest), AbortSignal.timeout(CHAT_ROUTING_TIMEOUT_MS));
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

  const bytedanceRoute = applyBytedanceNamedModelRoute({
    query: expandedPrompt,
    tool: decision.tool,
    params: decision.params ?? {},
    message: decision.message,
    assetContext,
  });
  const joinRoute = bytedanceRoute.substituted
    ? bytedanceRoute
    : applyVideoJoinRoute({
      query: expandedPrompt,
      tool: bytedanceRoute.tool,
      params: bytedanceRoute.params,
      message: bytedanceRoute.message,
      assetContext,
      notebookContext,
    });
  const stackedRoute = joinRoute.substituted
    ? joinRoute
    : applyStackedChainRoute({
      query: expandedPrompt,
      tool: joinRoute.tool,
      params: joinRoute.params,
      message: joinRoute.message,
      assetContext,
      notebookContext,
    });
  decision = {
    tool: stackedRoute.tool,
    params: stackedRoute.params,
    // The voice path routes the spoken sentence here, so the sheet's title
    // reads in the same vocabulary as the prompt beneath it.
    message: tagNotebookGridAddresses(stackedRoute.message, notebookAddresses),
  };

  // 6. Validate tool exists in routable registry
  const routableTool = getRoutableTool(routableTools, decision.tool);
  if (!routableTool) {
    return error(`Unknown tool: ${decision.tool}. Please rephrase.`);
  }

  // A view opens in the app, so the plan carries the resolved target back
  // instead of running a handler here.
  if (routableTool.effect === "view") {
    const view = resolveChatViewAction(
      engine,
      notebookDocument,
      routableTool.actualTool,
      decision.params ?? {},
    );
    if (!view.ok) return error(view.message);
    if (!proposedDecision) appendChatHistory(engine, {
      prompt: taggedPrompt,
      tool: decision.tool,
      params: view.params,
      message: decision.message,
      failed: false,
    });
    return json({
      kind: "chat-action-plan",
      planId: uuidv7(),
      bookId,
      prompt: taggedPrompt,
      routedTool: decision.tool,
      tool: routableTool.actualTool,
      params: view.params,
      message: decision.message,
      summary: decision.message.trim() || "Show media fullscreen",
      effect: "view",
      confirmation: {
        required: false,
        reason: "Opening a view changes nothing in the book",
      },
    } satisfies ChatActionPlan);
  }

  // 7. Apply fixups (spread to avoid mutating decision.params for logging)
  const routedParams = normalizeChatRoutedParams(
    decision.tool,
    normalizeChatTimestampParams(decision.tool, decision.params ?? {}),
  );

  // The routing prompt asks the model to omit optional parameters so each tool
  // can apply its defaults; enforce that for generation rather than trusting
  // it, since an invented duration or a muted soundtrack costs a real
  // generation. Reads the query, not the routed prompt, so only what the
  // person actually said counts as asking.
  const params = routableTool.category === "generation"
    ? withoutUnrequestedSettings({
      query: expandedPrompt,
      params: routedParams,
      requiredParams: routableTool.requiredParams,
    }).params
    : routedParams;

  // Inject book_id
  params.book_id = bookId;
  if (
    notebookId
    && routableTool.params.includes("notebook_id")
    && params.notebook_id === undefined
  ) {
    params.notebook_id = notebookId;
  }

  // generate_image only accepts @img-* refs; models often put @vid-* in
  // image_refs for "from the source of @vid-…". Drop non-image slugs and
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
  const scriptIsPrompt = scriptContents.length > 0
    && routableTool.category === "generation";
  if (scriptIsPrompt) {
    const combinedScript = scriptContents.map((s) => s.content).join("\n\n");
    params.prompt = combinedScript;
  }

  // Speech requests: fold prompt into text and default the voice, since
  // the router model cannot know ElevenLabs voice ids. Runs after the
  // script injection above so script content reaches the spoken text.
  if (decision.tool === "generate_elevenlabs_text_to_audio") {
    Object.assign(params, await applySpeechRoutingDefaults(decision.tool, params));
  }

  // The voice model writes its own params, so a bare address can survive there
  // even when the query carried none.
  if (typeof params.prompt === "string") {
    params.prompt = tagNotebookGridAddresses(params.prompt, notebookAddresses);
  }

  // Rewrite the routed prompt against the target model's guide, so the sheet
  // reviews the prompt the provider will see rather than the sentence that
  // picked the tool. A script the speaker attached is their own wording and
  // stands as written. Runs last: the rewrite has to see resolved mentions to
  // hand them back intact.
  if (
    routableTool.category === "generation"
    && !scriptIsPrompt
    && typeof params.prompt === "string"
  ) {
    params.prompt = await rewriteChatGenerationPrompt(engine, {
      bookId,
      tool: routableTool.actualTool,
      prompt: params.prompt,
    });
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
    let autoApply = routableTool.autoApply;
    let chainPausesPerStep = false;
    if (targetDef.name === "chain") {
      const preflight = await preflightChainPlan({
        action: "run",
        version: 1,
        ...params,
        book_id: bookId,
      }, {
        engine,
        bookId,
        notebookId,
        toolSchemas: new Map(
          allDefs.map((definition) => [definition.name, definition.schema]),
        ),
        autoApplyTools: AUTO_APPLY_TOOL_NAMES,
        effectForTool: (name) => effectForTool(
          name,
          /^(?:generate|extend|upscale)_/u.test(name) ? "generation" : "action",
        ),
      });
      if (!preflight.ok) return error(preflight.error);
      autoApply = preflight.plan.autoApply;
      chainPausesPerStep = preflight.plan.steps.some((step) => step.requiresApproval);
    }
    return json({
      kind: "chat-action-plan",
      planId: uuidv7(),
      bookId,
      prompt: taggedPrompt,
      routedTool: decision.tool,
      tool: targetDef.name,
      params: validated.data,
      message: decision.message,
      summary,
      effect,
      confirmation: {
        required: !autoApply,
        reason: autoApply
          ? autoApplyReason(targetDef.name, chainPausesPerStep)
          : effect === "generation"
          ? "This request creates generated media and may incur provider spend"
          : "This request changes the current book",
      },
    } satisfies ChatActionPlan);
  }

  // 9. Execute (wrapped so the routed tool writes its own action log entry)
  const wrappedDef = withLogging(targetDef, engine);
  let handlerResult: ToolResult;
  try {
    handlerResult = await wrappedDef.handler(validated.data);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return error(`${decision.tool} failed: ${message}`);
  }

  if (!proposedDecision) appendChatHistory(engine, {
    prompt: taggedPrompt,
    tool: decision.tool,
    params: decision.params,
    message: decision.message,
    failed: Boolean(handlerResult.isError),
  });

  return handlerResult;
}


function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

function json(value: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
