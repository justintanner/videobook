import type { ToolDef } from "./tools/tool-def.js";

type RoutableToolInfo = {
  name: string;
  actualTool: string;
  description: string;
  params: string[];
  category: "action" | "generation";
  effect: "read" | "mutation" | "generation";
};

type ChatToolAlias = {
  name: string;
  actualTool: string;
  description: string;
};

type ChatRoutingUserMessageContext = {
  query: string;
  assetContext: Array<Record<string, unknown>>;
  imageFiles: unknown[];
  videoFiles: unknown[];
  scriptContents: Array<{ tag: string; content: string }>;
};

const CHAT_TOOL_ALIASES: ChatToolAlias[] = [
  {
    name: "generate_video",
    actualTool: "prepare_video_generation",
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
      category,
      effect: effectForTool(alias.actualTool, category),
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
        category,
        effect: effectForTool(definition.name, category),
      };
    });
  return [...aliases, ...tools];
}

function buildChatRoutingPrompt(
  slug: string,
  tools: RoutableToolInfo[],
  historyContext?: string,
): string {
  const toolLines = tools.map(
    (tool) => `- ${tool.name}: ${tool.description} (params: ${tool.params.join(", ")})`,
  ).join("\n");

  const historyBlock = historyContext
    ? `\n${historyContext}\n\nUse conversation history to resolve pronouns and follow-up references (e.g. "reverse it" refers to the asset from the previous turn).\n`
    : "";

  return `You are a routing assistant for the Videobook media system.

Available tools:
${toolLines}

Current book: ${slug}
${historyBlock}
Given a user query (possibly with @asset references), determine:
1. tool: Which tool to use
2. params: Parameters to pass
3. message: A brief present-progressive status message (2-5 words, e.g. "Trimming video.")

Parameter guidelines:
- For asset_id: use the resolved asset ID from the referenced @tag (e.g., @vid-foo → asset_id: "vid-foo")
- For timestamps (trim_start, trim_end, cut_start, cut_end, start_time, end_time, start_seconds, end_seconds): parse to seconds as a number (e.g., "1:30" → 90, "2m20s" → 140)
- For timewarp_video: stretch_factor is a duration multiplier; values above 1 slow and lengthen the selected picture, while values below 1 accelerate and shorten it
- For sync_video_to_audio: anchors is an ordered array. Each anchor has video_seconds plus exactly one target: audio_seconds for an explicit audio time or audio_cue for transcript words. Convert nested timestamp values to seconds and preserve audio_cue text exactly. The original audio stays fixed; only the picture is retimed
- For generate_video: put the generation description in "prompt"
- For generate_image: put the image description in "prompt"; use image_slugs ONLY for @img-* reference images (include @ prefix). Never put @vid-* or @aud-* in image_slugs — if the user wants an image inspired by a video, describe that in the text prompt instead
- For create_watermark_card (QR code / watermark card): use this tool for real scannable QR codes — never generate_image. Pass url from the referenced asset's source_url/webpage_url when the user says "from the url in @vid-…" or similar; optional handle is an X handle without @
- For create_qart (artistic / picture QR): use when turning an @img-* into scan-safe color and monochrome QR mosaics; pass image_slug and value (URL/text). Prefer over create_watermark_card when the user wants a photo integrated into the QR modules
- For create_qrbtf (parametric / styled QR): use when the user wants a stylized QR code (normal, line, dsj, bubble, or func styles) from the qrbtf library; pass value (URL/text) and optional style. No source image needed — the QR is generated parametrically with a black background by default
- For create_qr_outro: use when the user asks for an animated QR outro video from one to four QR images. Pass every referenced QR image in order through qr_image_slugs (array of img- IDs), plus sound_effect_slug only for an explicit aud-* override and aspect_ratio ("16:9", "9:16", or "1:1"). Without an audio override, the bundled impact sound is used. This creates a vid-* asset, it is NOT generate_video or create_watermark_card.
- For concat_images: use image_slugs for the referenced @img-* assets; one slug leaves the second two-slot cell empty, and null explicitly leaves a slot empty. Use aspect_ratio 16:9 or 9:16; layout is automatic unless overridden
- Timeline audio positions (start_frame, duration_frames) are in frames at 30 fps — convert seconds to frames (e.g., "at 5 seconds" → start_frame: 150)
- Do NOT include book_id in params — it is injected automatically
- When @script- tags are referenced, use the script content as the prompt for generation tools

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

Determine which tool to use and what parameters to pass. Return the routing decision as a JSON object.`;
}

function getRoutableTool(
  tools: RoutableToolInfo[],
  name: string,
): RoutableToolInfo | undefined {
  return tools.find((tool) => tool.name === name);
}

export {
  CHAT_TOOL_ALIASES,
  TIMESTAMP_PARAMS,
  NESTED_TIMESTAMP_PARAMS,
  buildRoutableTools,
  buildChatRoutingPrompt,
  buildChatRoutingUserMessage,
  effectForTool,
  getRoutableTool,
};
export type { RoutableToolInfo };
