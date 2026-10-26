import { LIGHTNING_VIDEO_MODEL } from "./lightning-defaults.js";
import type { ToolDef } from "./tools/tool-def.js";
import { CHAIN_TOOL_CATALOG, planStackedChainFromQuery } from "./chain-plan.js";
import { CHAT_VIEW_ACTIONS } from "./chat-view-actions.js";
import {
  zodEnumOptionsOrNull,
  zodIsRequired,
  zodUnionEnumOptions,
} from "./zod-slots.js";

type RoutableToolInfo = {
  name: string;
  actualTool: string;
  description: string;
  params: string[];
  requiredParams: string[];
  constraints: string[];
  category: "action" | "generation";
  effect: "read" | "mutation" | "generation" | "view";
  autoApply: boolean;
};

const AUTO_APPLY_TOOL_NAMES = new Set([
  "duplicate_asset",
  "extract_audio",
  "extract_frame",
]);

type ChatRoutingNotebookContext = {
  id: string;
  name: string;
  cells: Array<{
    address: string;
    cellId: string;
    label?: string;
    type: string;
    outputAsset: string | null;
  }>;
};

type ChatRoutingUserMessageContext = {
  query: string;
  assetContext: Array<Record<string, unknown>>;
  imageFiles: unknown[];
  videoFiles: unknown[];
  scriptContents: Array<{ tag: string; content: string }>;
  notebookContext: ChatRoutingNotebookContext | null;
};

type ZodConstraintSchema = { _def?: unknown; unwrap?: () => unknown };

const TIMESTAMP_PARAMS: Record<string, string[]> = {
  trim_video: ["trim_start", "trim_end", "cut_start", "cut_end"],
  download_video: ["start_time", "end_time"],
  split_video: ["chunk_a_end", "chunk_b_start"],
  extract_video_clip: ["start_time", "end_time"],
  extract_frame: ["timestamp"],
  timewarp_video: ["start_seconds", "end_seconds"],
};

const NESTED_TIMESTAMP_PARAMS: Record<string, Record<string, string[]>> = {
  sync_video_to_audio: {
    anchors: ["video_seconds", "audio_seconds"],
  },
};

const READ_ONLY_TOOL_NAMES = new Set([
  "asset_history",
  "asset_manifest",
  "slash_commands",
  "storage_status",
  "service_status",
]);

const READ_ONLY_TOOL_PREFIXES = [
  "check_",
  "estimate_",
  "get_",
  "inspect_",
  "list_",
  "plan_",
  "prepare_",
  "preview_",
  "read_",
  "search_",
  "wait_",
];

function categoryForTool(name: string): RoutableToolInfo["category"] {
  return /^(?:generate|extend|upscale)_/u.test(name)
    || name === "concat_images"
    ? "generation"
    : "action";
}

function effectForTool(
  name: string,
  category: RoutableToolInfo["category"],
): Exclude<RoutableToolInfo["effect"], "view"> {
  if (category === "generation") return "generation";
  if (name === "prepare_cold_open") return "mutation";
  if (
    READ_ONLY_TOOL_NAMES.has(name)
    || READ_ONLY_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))
  ) return "read";
  return "mutation";
}

type RoutableDefinition = Pick<ToolDef, "name" | "description" | "schema">;

function paramsForTool(definition: RoutableDefinition): string[] {
  return Object.keys(definition.schema).filter((name) => name !== "book_id");
}

function requiredParamsForTool(definition: RoutableDefinition): string[] {
  return Object.entries(definition.schema)
    .filter(([name, schema]) =>
      name !== "book_id"
      && zodIsRequired(schema as unknown as ZodConstraintSchema))
    .map(([name]) => name);
}

function constraintsForTool(definition: RoutableDefinition): string[] {
  return Object.entries(definition.schema).flatMap(([name, schema]) => {
    if (name === "book_id") return [];
    const constraintSchema = schema as unknown as ZodConstraintSchema;
    const values = zodEnumOptionsOrNull(constraintSchema)
      ?? zodUnionEnumOptions(constraintSchema);
    return values
      ? [`${name}=${values.map((value) => JSON.stringify(value)).join("|")}`]
      : [];
  });
}

const EDITOR_ONLY_TOOL_NAMES = new Set(["caption_video"]);

function buildRoutableTools(definitions: ToolDef[]): RoutableToolInfo[] {
  const tools = definitions
    .filter((definition) => definition.name !== "chat" && !EDITOR_ONLY_TOOL_NAMES.has(definition.name))
    .map((definition) => {
      const category = categoryForTool(definition.name);
      return {
        name: definition.name,
        actualTool: definition.name,
        description: definition.description,
        params: paramsForTool(definition),
        requiredParams: requiredParamsForTool(definition),
        constraints: constraintsForTool(definition),
        category,
        effect: effectForTool(definition.name, category),
        autoApply: AUTO_APPLY_TOOL_NAMES.has(definition.name),
      };
    });
  // Views run in the app, never on the server, so they need no review.
  const views = CHAT_VIEW_ACTIONS.map((action) => ({
    name: action.name,
    actualTool: action.name,
    description: action.description,
    params: paramsForTool(action),
    requiredParams: requiredParamsForTool(action),
    constraints: constraintsForTool(action),
    category: "action" as const,
    effect: "view" as const,
    autoApply: true,
  }));
  return [...views, ...tools];
}

const SEEDREAM_IMAGE_EDIT_MODEL = "kie:seedream/5-lite-image-to-image";
const SEEDANCE_SUBSTITUTION_NOTE =
  "Using Seedream for this image edit (Seedance is video).";

const MENTION_PATTERN = /@([a-z]{1,2}\d{1,2}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/gi;

type ChatAssetMediaType = "image" | "video" | "audio" | "script";

type BytedanceRouteInput = {
  query: string;
  tool: string;
  params: Record<string, unknown>;
  message: string;
  assetContext: Array<Record<string, unknown>>;
};

type VideoJoinRouteInput = BytedanceRouteInput & {
  notebookContext?: ChatRoutingNotebookContext | null;
};

type BytedanceRouteResult = {
  tool: string;
  params: Record<string, unknown>;
  message: string;
  substituted: boolean;
};

function mentionsBytedanceFamily(query: string): boolean {
  return /seedance|seedream|bytedance/i.test(query);
}

function mentionsSeedanceFiveAlias(query: string): boolean {
  return /seedance\s*5(?:\.0)?(?:\s*edit)?/i.test(query)
    || /seedream\s*5/i.test(query);
}

function normalizeMention(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => typeof entry === "string" && entry.trim()
    ? [entry.trim()]
    : []);
}

function queryMentions(query: string): string[] {
  return [...query.matchAll(MENTION_PATTERN)].map((match) => `@${match[1]}`);
}

function assetMediaType(
  asset: Record<string, unknown>,
): ChatAssetMediaType | null {
  const type = typeof asset.type === "string"
    ? asset.type
    : typeof asset.artifact_type === "string"
      ? asset.artifact_type
      : null;
  return type === "image" || type === "video" || type === "audio" || type === "script"
    ? type
    : null;
}

function assetMentionKeys(asset: Record<string, unknown>): string[] {
  const keys = [
    typeof asset.tag === "string" ? asset.tag : "",
    typeof asset.asset_id === "string" ? asset.asset_id : "",
  ];
  if (Array.isArray(asset.notebook_references)) {
    for (const reference of asset.notebook_references) {
      if (typeof reference === "string") keys.push(reference);
    }
  }
  return keys.filter(Boolean).map(normalizeMention);
}

function mediaTypeForMention(
  mention: string,
  assetContext: Array<Record<string, unknown>>,
): ChatAssetMediaType | null {
  const needle = normalizeMention(mention);
  const match = assetContext.find((asset) => assetMentionKeys(asset).includes(needle));
  return match ? assetMediaType(match) : null;
}

function mentionWithAt(mention: string): string {
  return mention.startsWith("@") ? mention : `@${mention}`;
}

function sceneTargetMention(query: string): string | null {
  const match = query.match(
    /\b(?:in|on|across|from|of)\s+(@[a-z]{1,2}\d{1,2}|@[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/i,
  );
  return match?.[1] ? mentionWithAt(match[1]) : null;
}

function withClauseMentions(query: string): string[] {
  const match = query.match(
    /\bwith\s+((?:@[a-z]{1,2}\d{1,2}|@[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\s+(?:and|,)?\s*(?:@[a-z]{1,2}\d{1,2}|@[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}))*)/i,
  );
  return match?.[1] ? queryMentions(match[1]) : [];
}

function uniqueMentions(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const key = normalizeMention(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(mentionWithAt(value));
  }
  return unique;
}

function applyBytedanceNamedModelRoute(input: BytedanceRouteInput): BytedanceRouteResult {
  if (!mentionsBytedanceFamily(input.query)) {
    return {
      tool: input.tool,
      params: input.params,
      message: input.message,
      substituted: false,
    };
  }
  const mentions = queryMentions(input.query);
  const target = sceneTargetMention(input.query) ?? mentions[0] ?? null;
  const targetType = target ? mediaTypeForMention(target, input.assetContext) : null;
  const mentionedTypes = mentions.map((mention) => mediaTypeForMention(mention, input.assetContext));
  const hasImage = mentionedTypes.includes("image") || targetType === "image";
  const hasVideo = mentionedTypes.includes("video") || targetType === "video";
  const imageTarget = targetType === "image"
    || (hasImage && targetType !== "video" && !hasVideo)
    || (mentionsSeedanceFiveAlias(input.query) && hasImage && targetType !== "video");
  const replacements = uniqueMentions(withClauseMentions(input.query))
    .filter((mention) => mentionWithAt(mention).toLowerCase() !== target?.toLowerCase());
  const imageMentions = uniqueMentions(mentions.filter((mention) =>
    mediaTypeForMention(mention, input.assetContext) === "image"));
  const videoMentions = uniqueMentions(mentions.filter((mention) =>
    mediaTypeForMention(mention, input.assetContext) === "video"));
  const prompt = typeof input.params.prompt === "string" && input.params.prompt.trim()
    ? input.params.prompt
    : input.query;

  if (imageTarget && (target || imageMentions.length > 0)) {
    const editTarget = target && targetType === "image" ? target : imageMentions[0]!;
    const rest = uniqueMentions([
      ...replacements.filter((mention) =>
        mediaTypeForMention(mention, input.assetContext) !== "video"),
      ...imageMentions,
    ]).filter((mention) => normalizeMention(mention) !== normalizeMention(editTarget));
    const imageRefs = uniqueMentions([editTarget, ...rest]);
    const saidSeedance = /seedance|bytedance/i.test(input.query);
    const message = saidSeedance
      ? (input.message.trim()
        ? `${input.message.trim().replace(/[.!]?$/, "")}. ${SEEDANCE_SUBSTITUTION_NOTE}`
        : SEEDANCE_SUBSTITUTION_NOTE)
      : input.message;
    const { video_refs: _videoRefs, image_refs: _imageRefs, refs: _refs, ...imageParams } = input.params;
    return {
      tool: "generate_image",
      params: {
        ...imageParams,
        model: SEEDREAM_IMAGE_EDIT_MODEL,
        prompt,
        refs: { image: imageRefs },
      },
      message,
      substituted: saidSeedance,
    };
  }

  if (hasVideo) {
    const routedRefs = input.params.refs !== null && typeof input.params.refs === "object" && !Array.isArray(input.params.refs)
      ? input.params.refs as Record<string, unknown>
      : {};
    const videoRefs = uniqueMentions([
      ...(target && targetType === "video" ? [target] : []),
      ...videoMentions,
      ...stringList(input.params.video_refs),
      ...stringList(routedRefs.video),
    ]).filter((mention) => mediaTypeForMention(mention, input.assetContext) !== "image");
    const imageRefs = uniqueMentions([
      ...replacements.filter((mention) =>
        mediaTypeForMention(mention, input.assetContext) === "image"),
      ...imageMentions,
      ...stringList(input.params.image_refs),
      ...stringList(routedRefs.image),
    ]).filter((mention) => mediaTypeForMention(mention, input.assetContext) !== "video");
    const { video_refs: _videoRefs, image_refs: _imageRefs, refs: _refs, ...videoParams } = input.params;
    return {
      tool: "generate_video",
      params: {
        ...videoParams,
        model: LIGHTNING_VIDEO_MODEL,
        prompt,
        refs: {
          ...(videoRefs.length > 0 ? { video: videoRefs } : {}),
          ...(imageRefs.length > 0 ? { image: imageRefs } : {}),
        },
        mode: "r2v",
      },
      message: input.message,
      substituted: false,
    };
  }

  return {
    tool: input.tool,
    params: input.params,
    message: input.message,
    substituted: false,
  };
}

const NOTEBOOK_VIDEO_CELL_TYPES = new Set([
  "video",
  "generate_video",
  "splice",
  "concat",
  "split_video",
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function isVideoJoinQuery(query: string): boolean {
  if (/\b(?:splice\s+out|apply[\s-]?cuts|cut\s+out)\b/iu.test(query)) return false;
  return /\b(?:splice(?:\s+together)?|concat(?:enate)?|stitch(?:\s+together)?)\b/iu.test(query)
    || /\bjoin(?:ing)?\s+(?:(?:these|the|all)\s+)?(?:\d+\s+)?(?:video|clip|scene)s?\b/iu.test(query);
}

function overlapFromParams(params: Record<string, unknown>): number {
  const raw = params.overlap;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

function rawMediaContextEntries(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function artifactTokenFromUnknown(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of [
    "artifact_id",
    "asset_id",
    "outputAsset",
    "output_artifact_id",
    "address",
    "tag",
  ]) {
    if (typeof record[key] === "string" && record[key].trim()) {
      return record[key].trim();
    }
  }
  return null;
}

function uniqueAssetIds(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const stripped = value.replace(/^@/u, "").trim();
    const key = stripped.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(stripped);
  }
  return unique;
}

function notebookVideoAssetId(
  token: string,
  notebookContext: ChatRoutingNotebookContext | null | undefined,
): string | null {
  if (!notebookContext) return null;
  const needle = normalizeMention(token);
  const cell = notebookContext.cells.find((candidate) =>
    normalizeMention(candidate.address) === needle
    || normalizeMention(candidate.cellId) === needle
    || (
      candidate.outputAsset !== null
      && normalizeMention(candidate.outputAsset) === needle
    ));
  if (!cell || !cell.outputAsset) return null;
  if (cell.type && !NOTEBOOK_VIDEO_CELL_TYPES.has(cell.type)) return null;
  return cell.outputAsset.replace(/^@/u, "");
}

function resolveVideoAssetId(
  token: string,
  input: Pick<VideoJoinRouteInput, "assetContext" | "notebookContext">,
): string | null {
  const mention = mentionWithAt(token);
  const mentionedType = mediaTypeForMention(mention, input.assetContext);
  if (mentionedType && mentionedType !== "video") return null;
  if (mentionedType === "video") {
    const needle = normalizeMention(token);
    const asset = input.assetContext.find((candidate) =>
      assetMentionKeys(candidate).includes(needle));
    const assetId = typeof asset?.asset_id === "string" ? asset.asset_id.trim() : "";
    return assetId || null;
  }
  const fromNotebook = notebookVideoAssetId(token, input.notebookContext);
  if (fromNotebook) return fromNotebook;
  const stripped = token.replace(/^@/u, "").trim();
  return UUID_PATTERN.test(stripped) ? stripped : null;
}

function collectJoinAssetIds(input: VideoJoinRouteInput): string[] {
  const fromMentions = uniqueAssetIds(
    queryMentions(input.query).flatMap((mention) => {
      const resolved = resolveVideoAssetId(mention, input);
      return resolved ? [resolved] : [];
    }),
  );
  const fromMediaContext = uniqueAssetIds(
    rawMediaContextEntries(input.params.media_context).flatMap((entry) => {
      const token = artifactTokenFromUnknown(entry);
      if (!token) return [];
      const resolved = resolveVideoAssetId(token, input);
      return resolved ? [resolved] : [];
    }),
  );
  const fromAssetIds = uniqueAssetIds(
    stringList(input.params.asset_ids).flatMap((token) => {
      const resolved = resolveVideoAssetId(token, input);
      return resolved ? [resolved] : [];
    }),
  );
  const fromPair = uniqueAssetIds([
    ...(typeof input.params.first_asset_id === "string"
      ? [input.params.first_asset_id]
      : []),
    ...(typeof input.params.second_asset_id === "string"
      ? [input.params.second_asset_id]
      : []),
    ...stringList(input.params.additional_asset_ids),
  ].flatMap((token) => {
    const resolved = resolveVideoAssetId(token, input);
    return resolved ? [resolved] : [];
  }));
  if (fromMentions.length >= 2) return fromMentions;
  if (fromMediaContext.length >= 2) return fromMediaContext;
  if (fromAssetIds.length >= 2) return fromAssetIds;
  if (fromPair.length >= 2) return fromPair;
  return [];
}

function planBackgroundAudioFromQuery(
  input: Pick<VideoJoinRouteInput, "query" | "assetContext" | "notebookContext">,
): BytedanceRouteResult | null {
  if (!/^(?:(?:please|can you|could you|would you)\s+)*(?:add|mix|layer|overlay|put)\b/iu.test(input.query.trim())) return null;
  if (!/\b(?:ambience|ambient|foley|sfx|sound effects?|asmr)\b/iu.test(input.query)) return null;
  if (/\b(?:replace|remove|delete|trim|crop|speed|reverse|narration|voiceover|using|model)\b|\b(?:at|after|from|until)\s+\d/iu.test(input.query)) return null;
  const soundRequest = input.query.replace(/\b(?:no|without)\s+(?:any\s+)?(?:music|speech)\b/giu, "");
  if (/\b(?:music|speech|score|fal|kie|acestep)\b/iu.test(soundRequest)) return null;
  const mentions = uniqueMentions(queryMentions(input.query));
  if (mentions.length === 0 || mentions.some((mention) => mediaTypeForMention(mention, input.assetContext) !== "video")) return null;
  const targets = uniqueAssetIds(mentions.flatMap((mention) => {
    const asset = resolveVideoAssetId(mention, input);
    return asset ? [asset] : [];
  }));
  if (targets.length !== 1) return null;
  const prompt = input.query.replace(/\b(?:to|on|onto|for)\s+(?=@)/giu, "")
    .replace(MENTION_PATTERN, "").replace(/\s+/gu, " ").replace(/\s+([,.;:])/gu, "$1").trim();
  const durationMatch = input.query.match(/\b(?:for|lasting|duration(?: of)?)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?)\b/iu)
    ?? input.query.match(/\b(\d+(?:\.\d+)?)[\s-]*(seconds?|secs?|s|minutes?|mins?)[\s-]+(?:of\s+)?(?:background|ambience|ambient|foley|sfx|sound|asmr)\b/iu);
  const duration = durationMatch ? Number(durationMatch[1]) * (/^m/iu.test(durationMatch[2]!) ? 60 : 1) : undefined;
  const volumeMatch = input.query.match(/\b(?:volume|at)\s+(\d+(?:\.\d+)?)\s*%/iu)
    ?? input.query.match(/\b(\d+(?:\.\d+)?)\s*%\s*(?:volume|level)\b/iu);
  return {
    tool: "chain",
    params: {
      action: "run",
      version: 1,
      steps: [
        {
          id: "ambience", tool: "generate_audio",
          params: {
            model: "elevenlabs:sound-generation", prompt,
            ...(duration !== undefined ? { options: { duration_seconds: duration } } : {}),
          },
        },
        {
          id: "mix", tool: "audio_mix",
          params: { target_asset_id: targets[0], layer_asset_id: { $ref: { step_id: "ambience", output: "asset_id" } }, volume: volumeMatch ? Number(volumeMatch[1]) : 50 },
        },
      ],
    },
    message: "Adding ambience and sound effects.",
    substituted: true,
  };
}

function applyBackgroundAudioRoute(input: VideoJoinRouteInput): BytedanceRouteResult {
  const unchanged = { tool: input.tool, params: input.params, message: input.message, substituted: false };
  if (input.tool !== "analyze_video" && effectForTool(input.tool, categoryForTool(input.tool)) !== "read") return unchanged;
  return planBackgroundAudioFromQuery(input) ?? unchanged;
}

function applyStackedChainRoute(input: VideoJoinRouteInput): BytedanceRouteResult {
  const planned = planStackedChainFromQuery(input.query);
  if (!planned) {
    return {
      tool: input.tool,
      params: input.params,
      message: input.message,
      substituted: false,
    };
  }
  return {
    tool: "chain",
    params: {
      action: "run",
      version: 1,
      steps: planned.steps,
      ...(input.notebookContext?.id
        ? { notebook_id: input.notebookContext.id }
        : {}),
    },
    message: planned.message,
    substituted: true,
  };
}

function applyVideoJoinRoute(input: VideoJoinRouteInput): BytedanceRouteResult {
  if (input.tool === "apply_cuts" || input.tool === "smooth_scene_concat") {
    return {
      tool: input.tool,
      params: input.params,
      message: input.message,
      substituted: false,
    };
  }
  const joinQuery = isVideoJoinQuery(input.query);
  if (!joinQuery && input.tool !== "splice_video") {
    return {
      tool: input.tool,
      params: input.params,
      message: input.message,
      substituted: false,
    };
  }
  const assetIds = collectJoinAssetIds(input);
  if (assetIds.length < 2) {
    return {
      tool: input.tool,
      params: input.params,
      message: input.message,
      substituted: false,
    };
  }
  const additional = assetIds.slice(2);
  return {
    tool: "splice_video",
    params: {
      first_asset_id: assetIds[0],
      second_asset_id: assetIds[1],
      ...(additional.length > 0 ? { additional_asset_ids: additional } : {}),
      overlap: overlapFromParams(input.params),
    },
    message: input.message.trim() || "Splicing videos.",
    substituted: input.tool !== "splice_video",
  };
}

function routingArgument(tool: RoutableToolInfo, param: string): string {
  const required = tool.requiredParams.includes(param) ? "*" : "";
  const allowed = tool.constraints.find((constraint) => constraint.startsWith(`${param}=`));
  return allowed ? `${allowed.replace("=", `${required}=`)}` : `${param}${required}`;
}

function routingToolLine(tool: RoutableToolInfo): string {
  const args = tool.params.map((param) => routingArgument(tool, param)).join(", ");
  return `- ${tool.name}: ${tool.description}${args ? ` (${args})` : ""}`;
}

function buildChatRoutingPrompt(
  bookName: string,
  tools: RoutableToolInfo[],
  historyContext?: string,
): string {
  const toolLines = tools.map(routingToolLine).join("\n");
  const chainTools = tools.filter((tool) => CHAIN_TOOL_CATALOG[tool.name])
    .map((tool) => `${tool.name} -> ${Object.keys(CHAIN_TOOL_CATALOG[tool.name]!.outputs).join(", ")}`)
    .join("; ");

  const historyBlock = historyContext
    ? `\n${historyContext}\n\nUse conversation history to resolve pronouns and follow-up references (e.g. "reverse it" refers to the asset from the previous turn).\n`
    : "";

  return `You are a routing assistant for the Videobook media system.

Available tools (arguments in parentheses; * marks a required argument and name="a"|"b" lists its allowed values):
${toolLines}

Current book: ${bookName}
${historyBlock}
Given a user query (possibly with @asset references), determine:
1. tool: Which tool to use
2. params: Parameters to pass
3. message: A brief present-progressive status message (2-5 words, e.g. "Trimming video.")

Parameter guidelines:
- Route the current request to the action or chain that delivers its requested result. This is a single routing decision, not an agent loop: an exploratory read will end the turn. Use list_jobs only when the user asks about jobs or progress, and analyze_video only when analysis itself is requested. Repeating an edit request asks for that edit again, not a status check on an earlier attempt
- Generate images, video and audio with generate_image, generate_video and generate_audio. Omit model unless the user names a model or provider; the default model is applied automatically. When the user names one, pick its id from list_generation_models (for example kie:bytedance/seedance-2-5, kie:nano-banana-2-1, fal:fal-ai/nano-banana-pro). Put media inputs in refs by role (image, first_frame, last_frame, video, audio) and model settings in options
- Include every required parameter. Omit optional parameters unless the user explicitly requests them so the tool can apply its defaults
- For parameters with listed allowed values, use exactly one listed value and never borrow an option from another tool
- For asset_id: use the resolved asset ID from the referenced @tag (e.g., @vid-foo → asset_id: "vid-foo")
- Use the current notebook ID for notebook_id. Resolve notebook addresses through the supplied notebook context and use cell UUIDs for cell ID parameters
- For duplicate_asset, use asset_id for the source, pass an explicit empty grid address as destination without @, and omit destination when the copy should go directly below the source
- When the user wants a first clip of a stated length plus the remaining/rest/remainder, use split_video with chunk_a_end set to that length and omit chunk_b_start
- When the user asks for a cold open or an exciting highlight before the full clip, use prepare_cold_open. The user reviews its range before edit_cold_open creates the copy. Never invent source hashes or request IDs.
- When the user wants to send, deliver, or save a Post to the phone or iPhone, or deliver a Post without naming a service, use save_post_to_icloud. Use upload_post_to_dropbox only when the user says Dropbox
- When the user asks to cut, extract, or create a new clip from a start time to an end time, use extract_video_clip; use trim_video only when the existing source should be changed in place
- When the user asks to trim or tighten a video for better pacing, timing or transitions without specifying cut ranges, use suggest_cuts and preserve the editing goal in instructions. It can assess visual pacing without a transcript. Never invent trim timestamps
- For timestamps (trim_start, trim_end, cut_start, cut_end, chunk_a_end, chunk_b_start, start_time, end_time, start_seconds, end_seconds, timestamp): parse to seconds as a number (e.g., "1:30" → 90, "2m20s" → 140)
- For timewarp_video: stretch_factor is a duration multiplier; values above 1 slow and lengthen the selected picture, while values below 1 accelerate and shorten it
- For sync_video_to_audio: anchors is an ordered array. Each anchor has video_seconds plus exactly one target: audio_seconds for an explicit audio time or audio_cue for transcript words. Convert nested timestamp values to seconds and preserve audio_cue text exactly. The original audio stays fixed; only the picture is retimed
- For every image or video generation tool, build the initial prompt from the user's requested result plus every consumed notebook cell and referenced media input
- Write generation prompts in smart Caveman style: short, concrete, role-based fragments; drop filler, hedging, pleasantries, articles, and preambles such as "Create an image of"; preserve the user's language plus exact names, technical terms, negation, numbers, units, and @addresses
- Prefer the pattern "thing, role, action. Next visual fact." and compact clauses such as "scene @a5, character @a1, fluffy kitten standing"
- Preserve every consumed notebook @address in the generation prompt at the semantic position where it belongs. Do not strip, rename, or expand notebook references into prose
- For generate_video: put the compact generation description in "prompt" and preserve every consumed @ reference
- For generate_image: put the compact image description in "prompt" and preserve every consumed image @address there; use refs.image ONLY for the corresponding resolved asset tags whose asset context type is "image", in the same order (include @ prefix). Never put a video or audio asset tag in refs.image — if the user wants an image inspired by a video, describe that source without connecting it as an image
- ByteDance naming: Seedance is video, Seedream is image. Users often say Seedance for both. When the query names seedance, bytedance, or seedream: if the edit/replace target is an image, use generate_image with model kie:seedream/5-lite-image-to-image and put the edit-target image first in refs.image, followed by replacement image refs. If the target is a video, use generate_video with model kie:bytedance/seedance-2-5, mode v2v, one 4–30 second clip in refs.video and replacement stills in refs.image. Edit mode follows the source aspect ratio and duration. Never route an image-target Seedance ask to a video model or to Nano Banana Pro
- Treat "Seedance 5.0 edit", "Seedance 5", and "Seedream 5" as Seedream 5. Generic chat uses Seedream 5 Lite image-to-image; Seedream 5 Pro edit lives in the subject/region pipeline. When Seedream is used for an image ask that said Seedance, the status message must note that substitution
- For create_watermark_card (QR code / watermark card): use this tool for real scannable QR codes — never generate_image. Pass url from the referenced asset's source_url/webpage_url when the user says "from the url in @vid-…" or similar; optional handle is an X or TikTok alias without @; set platform to "tiktok" for TikTok or "x" for X. apply_watermark uses the same platform field for its alias, icon, and default QR destination
- For create_qart (artistic / picture QR): use when turning an image asset into scan-safe color and monochrome QR mosaics; pass image_ref and value (URL/text). Prefer over create_watermark_card when the user wants a photo integrated into the QR modules
- For create_qrbtf (parametric / styled QR): use when the user wants a stylized QR code (normal, line, dsj, bubble, or func styles) from the qrbtf library; pass value (URL/text) and optional style. No source image needed — the QR is generated parametrically with a black background by default
- For create_qr_outro: use when the user asks for an animated QR outro video from one to four QR images. Pass every referenced QR image in order through qr_image_refs (array of image asset ids), plus sound_effect_ref only for an explicit audio asset override and aspect_ratio ("16:9", "9:16", or "1:1"). Without an audio override, the bundled impact sound is used. This creates a video asset, it is NOT generate_video or create_watermark_card.
- For speech, voiceover, narration, or text-to-speech requests use generate_audio and put the exact words to speak in "prompt" (write out the words even when the user paraphrases them); omit options.voice_id unless the user supplies a specific ElevenLabs voice id
- For sound effects, foley, or background ambience (rain, crowd, whoosh, door slam) use generate_audio with model elevenlabs:sound-generation and the sound described in "prompt". For background music, a score, or a music bed use generate_audio with model elevenlabs:music and the music described in "prompt"; set options.generation_mode "ambience" for atmospheric beds and "loop" for seamless loops. To score an existing video use generate_audio with model elevenlabs:video-to-music and that clip's asset tag in refs.video
- For concat_images: use image_refs for the referenced image assets; a single ref leaves the second two-slot cell empty, and null explicitly leaves a slot empty. Use aspect_ratio 16:9 or 9:16; layout is automatic unless overridden
- For splice_video: join two or more videos into one new asset. Use this for splice, concat, or stitch requests, not plan_chat_command. Pass first_asset_id and second_asset_id in playback order, additional_asset_ids for any further clips in that same order, and overlap 0 to concatenate complete clips
- For chain: use when one request stacks two or more supported actions in order, including extract audio then replace another clip's soundtrack. Pass action "run", version 1, and ordered steps. Each step is {"id","tool","params"}. id is required and unique, starts with a letter (extract, replace, step1). Point a later step at an earlier output with {"$ref":{"step_id":"<that id>","output":"<field>"}} and never interpolate a ref inside a string. Do not nest chain or chat. Leave book_id out of step params
- Use only these chain step tools and their listed output fields: ${chainTools}
- To add background ambience or generated sound to an existing video, chain generate_audio with audio_mix; pass the generated asset_id as layer_asset_id and preserve the target's existing sound. Use replace_video_audio only when replacing the soundtrack is requested. Use apply_sfx for additional timed cues, taking asset_id from the preceding edit's output (audio_mix returns target_asset_id). After editing an asset, reference that step's output for further edits instead of the original grid address
- Background ambience should cover the target clip. A generate_audio step consumed by audio_mix or replace_video_audio automatically inherits the target duration when omitted; do not add a metadata lookup or invent duration references. Use options.duration_seconds or options.music_length_ms only for an explicitly requested length, preserving shorter cues
- For show_media_fullscreen: use when the user asks to show, open, view, or enlarge one cell's image or video (full screen, fullscreen, bigger). Pass that cell's resolved asset ID as asset_id
- plan_chat_command is only for timeline sequence edits such as trim, move, split, insert at a frame, or captions. media_context is an optional single object {notebook_id, cell_id, artifact_id} for one fullscreen clip — never an array of clips
- Timeline audio positions (start_frame, duration_frames) are in frames at 30 fps — convert seconds to frames (e.g., "at 5 seconds" → start_frame: 150)
- Do NOT include book_id in params — it is injected automatically
- Asset @tags are opaque artifact ids; the asset context lists each tag's media type ("image", "video", "audio", "script"). Use that type — never the tag text — to decide which parameter an asset belongs in
- When a referenced asset has type "script", use its script content as the prompt for generation tools

Respond with JSON only (strict JSON: double-quoted keys/strings, no trailing commas, no comments):
{"tool": "tool_name", "params": {"param1": "value1"}, "message": "Status message."}`;
}

function buildChatRoutingUserMessage(
  context: ChatRoutingUserMessageContext,
): string {
  return `User query: ${context.query}

Referenced assets:
${JSON.stringify(context.assetContext, null, 2)}

Available file paths:
- Image files: ${JSON.stringify(context.imageFiles)}
- Video files: ${JSON.stringify(context.videoFiles)}

Script contents:
${context.scriptContents.length > 0
    ? JSON.stringify(context.scriptContents, null, 2)
    : "None"}

Current notebook:
${context.notebookContext
    ? JSON.stringify(context.notebookContext, null, 2)
    : "None"}

Determine which tool to use and what parameters to pass. Return the routing decision as a JSON object.`;
}

function getRoutableTool(
  tools: RoutableToolInfo[],
  name: string,
): RoutableToolInfo | undefined {
  return tools.find((tool) => tool.name === name);
}

export {
  AUTO_APPLY_TOOL_NAMES,
  EDITOR_ONLY_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
  TIMESTAMP_PARAMS,
  NESTED_TIMESTAMP_PARAMS,
  applyBackgroundAudioRoute,
  planBackgroundAudioFromQuery,
  applyBytedanceNamedModelRoute,
  applyStackedChainRoute,
  applyVideoJoinRoute,
  buildRoutableTools,
  buildChatRoutingPrompt,
  buildChatRoutingUserMessage,
  effectForTool,
  getRoutableTool,
};
export type { ChatRoutingNotebookContext };
