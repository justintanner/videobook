/**
 * Chat routing: routable tool registry, routing prompt builder, and timestamp param registry.
 */

type RoutableToolInfo = {
  name: string;
  actualTool: string;
  description: string;
  params: string[];
  category: "action" | "generation";
};

const ROUTABLE_TOOLS: RoutableToolInfo[] = [
  // --- Action tools ---
  {
    name: "trim_video",
    actualTool: "trim_video",
    description: "Trim a video: keep a time range (trim_start/trim_end) or cut out a middle section (cut_start/cut_end)",
    params: ["asset_id", "trim_start", "trim_end", "cut_start", "cut_end"],
    category: "action",
  },
  {
    name: "download_video_file",
    actualTool: "download_video_file",
    description: "Download a video from a URL (YouTube, Twitter/X, Instagram, TikTok, etc.)",
    params: ["url", "start_time", "end_time"],
    category: "action",
  },
  {
    name: "change_video_speed",
    actualTool: "change_video_speed",
    description: "Change video playback speed (speed up or slow down, 0.25-4.0x)",
    params: ["asset_id", "speed"],
    category: "action",
  },
  {
    name: "reverse_video",
    actualTool: "reverse_video",
    description: "Reverse video playback (play backwards)",
    params: ["asset_id"],
    category: "action",
  },
  {
    name: "extract_first_frame",
    actualTool: "extract_first_frame",
    description: "Extract the first frame of a video as a new image asset",
    params: ["asset_id"],
    category: "action",
  },
  {
    name: "extract_last_frame",
    actualTool: "extract_last_frame",
    description: "Extract the last frame of a video as a new image asset",
    params: ["asset_id"],
    category: "action",
  },
  {
    name: "extract_audio",
    actualTool: "extract_audio",
    description: "Extract the audio track from a video as a new audio asset",
    params: ["asset_id"],
    category: "action",
  },
  {
    name: "transcribe",
    actualTool: "transcribe",
    description: "Transcribe audio from a video or audio asset using speech-to-text",
    params: ["asset_id"],
    category: "action",
  },
  {
    name: "whitelist",
    actualTool: "whitelist",
    description: "Whitelist a video asset for transcription pipeline",
    params: ["asset_id"],
    category: "action",
  },
  {
    name: "asset_manifest",
    actualTool: "asset_manifest",
    description: "Show all files and details of a specific asset",
    params: ["asset_id"],
    category: "action",
  },
  {
    name: "list_assets",
    actualTool: "list_assets",
    description: "List all assets in the current project",
    params: ["sort"],
    category: "action",
  },
  {
    name: "list_projects",
    actualTool: "list_projects",
    description: "List all projects",
    params: ["sort"],
    category: "action",
  },
  // --- Generation tools ---
  {
    name: "generate_video",
    actualTool: "preview_video_gen",
    description: "Generate a video from a text prompt or image references",
    params: ["prompt"],
    category: "generation",
  },
  {
    name: "generate_image",
    actualTool: "generate_nano_banana_image",
    description: "Generate an image from a text prompt, optionally with reference images",
    params: ["prompt", "image_asset_ids", "aspect_ratio"],
    category: "generation",
  },
];

const TIMESTAMP_PARAMS: Record<string, string[]> = {
  trim_video: ["trim_start", "trim_end", "cut_start", "cut_end"],
  download_video_file: ["start_time", "end_time"],
};

function buildChatRoutingPrompt(slug: string, historyContext?: string): string {
  const toolLines = ROUTABLE_TOOLS.map(
    (t) => `- ${t.name}: ${t.description} (params: ${t.params.join(", ")})`,
  ).join("\n");

  const historyBlock = historyContext
    ? `\n${historyContext}\n\nUse conversation history to resolve pronouns and follow-up references (e.g. "reverse it" refers to the asset from the previous turn).\n`
    : "";

  return `You are a routing assistant for the clipfirst media system.

Available tools:
${toolLines}

Current project: ${slug}
${historyBlock}
Given a user query (possibly with @asset references), determine:
1. tool: Which tool to use
2. params: Parameters to pass
3. message: A brief present-progressive status message (2-5 words, e.g. "Trimming video.")

Parameter guidelines:
- For asset_id: use the resolved asset ID from the referenced @tag (e.g., @vid-foo → asset_id: "vid-foo")
- For timestamps (trim_start, trim_end, cut_start, cut_end, start_time, end_time): parse to seconds as a number (e.g., "1:30" → 90, "2m20s" → 140)
- For generate_video: put the generation description in "prompt"
- For generate_image: put the image description in "prompt"; use image_asset_ids for reference image asset IDs
- Do NOT include project_slug in params — it is injected automatically
- When @script- tags are referenced, use the script content as the prompt for generation tools

Respond with JSON only:
{"tool": "tool_name", "params": {"param1": "value1", ...}, "message": "Status message."}`;
}

function getRoutableTool(name: string): RoutableToolInfo | undefined {
  return ROUTABLE_TOOLS.find((t) => t.name === name);
}

export { ROUTABLE_TOOLS, TIMESTAMP_PARAMS, buildChatRoutingPrompt, getRoutableTool };
export type { RoutableToolInfo };
