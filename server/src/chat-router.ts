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
    name: "download_video",
    actualTool: "download_video",
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
  {
    name: "render_timeline",
    actualTool: "render_timeline",
    description: "Concatenate rendered timeline slots into the final project video (use for /final and 'render the timeline' requests)",
    params: [],
    category: "action",
  },
  {
    name: "split_video",
    actualTool: "split_video",
    description: "Split a video into two new assets at a timestamp (chunk_a_end seconds; optional chunk_b_start for overlap)",
    params: ["asset_id", "chunk_a_end", "chunk_b_start"],
    category: "action",
  },
  {
    name: "export_asset_to_project",
    actualTool: "export_asset_to_project",
    description: "Export/copy an asset into a different project",
    params: ["asset_id", "target_project", "new_name"],
    category: "action",
  },
  {
    name: "add_timeline_audio",
    actualTool: "add_timeline_audio",
    description: "Add an audio asset to the timeline audio lane (positions in frames at 30 fps)",
    params: ["asset_id", "start_frame", "duration_frames"],
    category: "action",
  },
  {
    name: "move_timeline_audio",
    actualTool: "move_timeline_audio",
    description: "Move a timeline audio clip to a new start position (frames at 30 fps)",
    params: ["audio_id", "start_frame"],
    category: "action",
  },
  {
    name: "remove_timeline_audio",
    actualTool: "remove_timeline_audio",
    description: "Remove an audio clip from the timeline audio lane",
    params: ["audio_id"],
    category: "action",
  },
  {
    name: "update_timeline_audio",
    actualTool: "update_timeline_audio",
    description: "Update a timeline audio clip's volume (0-100) or fade_in/fade_out (ms)",
    params: ["audio_id", "volume", "fade_in", "fade_out"],
    category: "action",
  },
  {
    name: "archive_clip",
    actualTool: "archive_clip",
    description: "Archive a video or audio asset to the global clip archive with optional topic tags",
    params: ["asset_id", "topics"],
    category: "action",
  },
  {
    name: "search_archive",
    actualTool: "search_archive",
    description: "Search the global clip archive by text query and/or topics",
    params: ["query", "topics"],
    category: "action",
  },
  {
    name: "restore_archive_clips",
    actualTool: "restore_archive_clips",
    description: "Restore archived clips into the current project by archive ID",
    params: ["archive_ids"],
    category: "action",
  },

  {
    name: "list_elevenlabs_voices",
    actualTool: "list_elevenlabs_voices",
    description: "List available ElevenLabs voices",
    params: [],
    category: "action",
  },
  {
    name: "create_project",
    actualTool: "create_project",
    description: "Create a new project",
    params: ["project_slug"],
    category: "action",
  },
  {
    name: "clear_failed_tasks",
    actualTool: "clear_failed_tasks",
    description: "Delete all assets with failed generations in the current project",
    params: [],
    category: "action",
  },
  // --- Generation tools ---
  {
    name: "generate_video",
    actualTool: "preview_video",
    description: "Generate a video from a text prompt or image references",
    params: ["prompt"],
    category: "generation",
  },
  {
    name: "generate_image",
    actualTool: "generate_nano_banana_image",
    description: "Generate an image from a text prompt, optionally with reference images",
    params: ["prompt", "image_slugs", "aspect_ratio"],
    category: "generation",
  },
  {
    name: "concat_images",
    actualTool: "concat_images",
    description: "Concatenate image assets into a single reference-sheet image while preserving each image's aspect ratio",
    params: ["image_slugs", "layout", "aspect_ratio"],
    category: "generation",
  },
  {
    name: "generate_elevenlabs_t2a",
    actualTool: "generate_elevenlabs_t2a",
    description: "Generate speech audio from text using an ElevenLabs voice ID",
    params: ["voice_id", "text"],
    category: "generation",
  },
];

const TIMESTAMP_PARAMS: Record<string, string[]> = {
  trim_video: ["trim_start", "trim_end", "cut_start", "cut_end"],
  download_video: ["start_time", "end_time"],
  split_video: ["chunk_a_end", "chunk_b_start"],
};

function buildChatRoutingPrompt(slug: string, historyContext?: string): string {
  const toolLines = ROUTABLE_TOOLS.map(
    (t) => `- ${t.name}: ${t.description} (params: ${t.params.join(", ")})`,
  ).join("\n");

  const historyBlock = historyContext
    ? `\n${historyContext}\n\nUse conversation history to resolve pronouns and follow-up references (e.g. "reverse it" refers to the asset from the previous turn).\n`
    : "";

  return `You are a routing assistant for the videocity media system.

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
- For generate_image: put the image description in "prompt"; use image_slugs ONLY for @img-* reference images (include @ prefix). Never put @vid-* or @aud-* in image_slugs — if the user wants an image inspired by a video, describe that in the text prompt instead
- For concat_images: use image_slugs for all referenced image asset IDs (include @ prefix); use layout horizontal for side-by-side requests
- Timeline audio positions (start_frame, duration_frames) are in frames at 30 fps — convert seconds to frames (e.g., "at 5 seconds" → start_frame: 150)
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
