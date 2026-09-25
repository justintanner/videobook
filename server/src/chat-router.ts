import type { ToolDef } from "./tools/tool-def.js";
import { planStackedChainFromQuery } from "./chain-plan.js";
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
  effect: "read" | "mutation" | "generation";
  autoApply: boolean;
};

const AUTO_APPLY_TOOL_NAMES = new Set([
  "duplicate_asset",
  "extract_audio",
  "extract_first_frame",
  "extract_last_frame",
  "extract_frame",
]);

type ChatToolAlias = {
  name: string;
  actualTool: string;
  description: string;
};

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

const SEEDANCE_VIDEO_TOOL = "generate_kie_seedance_2_5_video";

const CHAT_TOOL_ALIASES: ChatToolAlias[] = [
  {
    name: "generate_video",
    actualTool: SEEDANCE_VIDEO_TOOL,
    description: "Generate a video from a text prompt or image references",
  },
  {
    name: "generate_image",
    actualTool: "generate_kie_nano_banana_pro_text_to_image",
    description: "Generate an image from a text prompt, optionally with reference images",
  },
];

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
  "commands",
  "project_activity",
  "project_history",
  "revision_history",
  "slash_commands",
  "storage_status",
  "x_connect_status",
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
    || name === "prepare_video_generation"
    || name === "prepare_image_generation"
    || name === "concat_images"
    || name === "gen_images_all"
    ? "generation"
    : "action";
}

function effectForTool(
  name: string,
  category: RoutableToolInfo["category"],
): RoutableToolInfo["effect"] {
  if (category === "generation") return "generation";
  if (
    READ_ONLY_TOOL_NAMES.has(name)
    || READ_ONLY_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))
  ) return "read";
  return "mutation";
}

function paramsForTool(definition: ToolDef): string[] {
  return Object.keys(definition.schema).filter((name) => name !== "book_id");
}

function requiredParamsForTool(definition: ToolDef): string[] {
  return Object.entries(definition.schema)
    .filter(([name, schema]) =>
      name !== "book_id"
      && zodIsRequired(schema as unknown as ZodConstraintSchema))
    .map(([name]) => name);
}

function constraintsForTool(definition: ToolDef): string[] {
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

function buildRoutableTools(definitions: ToolDef[]): RoutableToolInfo[] {
  const definitionByName = new Map(
    definitions.map((definition) => [definition.name, definition]),
  );
  const aliases = CHAT_TOOL_ALIASES.flatMap((alias) => {
    const target = definitionByName.get(alias.actualTool);
    if (!target) return [];
    const category = categoryForTool(alias.actualTool);
    return [{
      ...alias,
      params: paramsForTool(target),
      requiredParams: requiredParamsForTool(target),
      constraints: constraintsForTool(target),
      category,
      effect: effectForTool(alias.actualTool, category),
      autoApply: AUTO_APPLY_TOOL_NAMES.has(alias.name)
        || AUTO_APPLY_TOOL_NAMES.has(alias.actualTool),
    }];
  });
  const tools = definitions
    .filter((definition) => definition.name !== "chat")
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
  return [...aliases, ...tools];
}

const SEEDREAM_IMAGE_I2I_TOOL = "generate_kie_seedream_v5_lite_image_to_image";
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
    const { video_refs: _droppedVideoRefs, ...imageParams } = input.params;
    return {
      tool: SEEDREAM_IMAGE_I2I_TOOL,
      params: {
        ...imageParams,
        prompt,
        image_refs: imageRefs,
      },
      message,
      substituted: saidSeedance,
    };
  }

  if (hasVideo) {
    const videoRefs = uniqueMentions([
      ...(target && targetType === "video" ? [target] : []),
      ...videoMentions,
      ...stringList(input.params.video_refs),
    ]).filter((mention) => mediaTypeForMention(mention, input.assetContext) !== "image");
    const imageRefs = uniqueMentions([
      ...replacements.filter((mention) =>
        mediaTypeForMention(mention, input.assetContext) === "image"),
      ...imageMentions,
      ...stringList(input.params.image_refs),
    ]).filter((mention) => mediaTypeForMention(mention, input.assetContext) !== "video");
    return {
      tool: SEEDANCE_VIDEO_TOOL,
      params: {
        ...input.params,
        prompt,
        ...(videoRefs.length > 0 ? { video_refs: videoRefs } : {}),
        ...(imageRefs.length > 0 ? { image_refs: imageRefs } : {}),
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
  input: VideoJoinRouteInput,
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

function buildChatRoutingPrompt(
  bookName: string,
  tools: RoutableToolInfo[],
  historyContext?: string,
): string {
  const toolLines = tools.map((tool) => {
    const required = tool.requiredParams.length > 0
      ? `; required: ${tool.requiredParams.join(", ")}`
      : "";
    const constraints = tool.constraints.length > 0
      ? `; allowed: ${tool.constraints.join(", ")}`
      : "";
    return `- ${tool.name}: ${tool.description} (params: ${tool.params.join(", ")}${required}${constraints})`;
  }).join("\n");

  const historyBlock = historyContext
    ? `\n${historyContext}\n\nUse conversation history to resolve pronouns and follow-up references (e.g. "reverse it" refers to the asset from the previous turn).\n`
    : "";

  return `You are a routing assistant for the Videobook media system.

Available tools:
${toolLines}

Current book: ${bookName}
${historyBlock}
Given a user query (possibly with @asset references), determine:
1. tool: Which tool to use
2. params: Parameters to pass
3. message: A brief present-progressive status message (2-5 words, e.g. "Trimming video.")

Parameter guidelines:
- For a generic video or image generation request that does not name a concrete model or provider, use generate_video or generate_image instead of a provider-specific generation tool
- Include every required parameter. Omit optional parameters unless the user explicitly requests them so the tool can apply its defaults
- For parameters with listed allowed values, use exactly one listed value and never borrow an option from another tool
- For asset_id: use the resolved asset ID from the referenced @tag (e.g., @vid-foo → asset_id: "vid-foo")
- Use the current notebook ID for notebook_id. Resolve notebook addresses through the supplied notebook context and use cell UUIDs for cell ID parameters
- For duplicate_asset, use asset_id for the source, pass an explicit empty grid address as destination without @, and omit destination when the copy should go directly below the source
- When the user wants a first clip of a stated length plus the remaining/rest/remainder, use split_video with chunk_a_end set to that length and omit chunk_b_start
- When the user asks to cut, extract, or create a new clip from a start time to an end time, use extract_video_clip; use trim_video only when the existing source should be changed in place
- For timestamps (trim_start, trim_end, cut_start, cut_end, chunk_a_end, chunk_b_start, start_time, end_time, start_seconds, end_seconds, timestamp): parse to seconds as a number (e.g., "1:30" → 90, "2m20s" → 140)
- For timewarp_video: stretch_factor is a duration multiplier; values above 1 slow and lengthen the selected picture, while values below 1 accelerate and shorten it
- For sync_video_to_audio: anchors is an ordered array. Each anchor has video_seconds plus exactly one target: audio_seconds for an explicit audio time or audio_cue for transcript words. Convert nested timestamp values to seconds and preserve audio_cue text exactly. The original audio stays fixed; only the picture is retimed
- For every image or video generation tool, build the initial prompt from the user's requested result plus every consumed notebook cell and referenced media input
- Write generation prompts in smart Caveman style: short, concrete, role-based fragments; drop filler, hedging, pleasantries, articles, and preambles such as "Create an image of"; preserve the user's language plus exact names, technical terms, negation, numbers, units, and @addresses
- Prefer the pattern "thing, role, action. Next visual fact." and compact clauses such as "scene @a5, character @a1, fluffy kitten standing"
- Preserve every consumed notebook @address in the generation prompt at the semantic position where it belongs. Do not strip, rename, or expand notebook references into prose
- For generate_video: put the compact generation description in "prompt" and preserve every consumed @ reference
- For generate_image: put the compact image description in "prompt" and preserve every consumed image @address there; use image_refs ONLY for the corresponding resolved asset tags whose asset context type is "image", in the same order (include @ prefix). Never put a video or audio asset tag in image_refs — if the user wants an image inspired by a video, describe that source without connecting it as an image
- ByteDance naming: Seedance is video, Seedream is image. Users often say Seedance for both. When the query names seedance, bytedance, or seedream: if the edit/replace target is an image, use generate_kie_seedream_v5_lite_image_to_image and put the edit-target image first in image_refs, followed by replacement image refs. If the target is a video, use generate_kie_seedance_2_5_video with that clip in video_refs and replacement stills in image_refs. Never route an image-target Seedance ask to a Seedance video tool or to Nano Banana Pro
- Treat "Seedance 5.0 edit", "Seedance 5", and "Seedream 5" as Seedream 5. Generic chat uses Seedream 5 Lite image-to-image; Seedream 5 Pro edit lives in the subject/region pipeline. When Seedream is used for an image ask that said Seedance, the status message must note that substitution
- For create_watermark_card (QR code / watermark card): use this tool for real scannable QR codes — never generate_image. Pass url from the referenced asset's source_url/webpage_url when the user says "from the url in @vid-…" or similar; optional handle is an X handle without @
- For create_qart (artistic / picture QR): use when turning an image asset into scan-safe color and monochrome QR mosaics; pass image_ref and value (URL/text). Prefer over create_watermark_card when the user wants a photo integrated into the QR modules
- For create_qrbtf (parametric / styled QR): use when the user wants a stylized QR code (normal, line, dsj, bubble, or func styles) from the qrbtf library; pass value (URL/text) and optional style. No source image needed — the QR is generated parametrically with a black background by default
- For create_qr_outro: use when the user asks for an animated QR outro video from one to four QR images. Pass every referenced QR image in order through qr_image_refs (array of image asset ids), plus sound_effect_ref only for an explicit audio asset override and aspect_ratio ("16:9", "9:16", or "1:1"). Without an audio override, the bundled impact sound is used. This creates a video asset, it is NOT generate_video or create_watermark_card.
- For speech, voiceover, narration, or text-to-speech requests use generate_elevenlabs_text_to_audio: put the exact words to speak in "text" (write out the words even when the user paraphrases them) and omit voice_id unless the user supplies a specific ElevenLabs voice id
- For concat_images: use image_refs for the referenced image assets; a single ref leaves the second two-slot cell empty, and null explicitly leaves a slot empty. Use aspect_ratio 16:9 or 9:16; layout is automatic unless overridden
- For splice_video: join two or more videos into one new asset. Use this for splice, concat, or stitch requests, not plan_chat_command. Pass first_asset_id and second_asset_id in playback order, additional_asset_ids for any further clips in that same order, and overlap 0 to concatenate complete clips
- For chain: use when one request stacks two or more supported actions in order, including extract audio then replace another clip's soundtrack. Pass action "run", version 1, and ordered steps. Each step is {"id","tool","params"}. id is required and unique, starts with a letter (extract, replace, step1). Point a later step at an earlier output with {"$ref":{"step_id":"<that id>","output":"<field>"}} and never interpolate a ref inside a string. Do not nest chain or chat. Leave book_id out of step params
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
  CHAT_TOOL_ALIASES,
  TIMESTAMP_PARAMS,
  NESTED_TIMESTAMP_PARAMS,
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
