export const KLING_OMNI_TEXT_TO_VIDEO_TOOL =
  "generate_kie_kling_3_0_omni_text_to_video";
export const KLING_OMNI_IMAGE_TO_VIDEO_TOOL =
  "generate_kie_kling_3_0_omni_image_to_video";
export const KLING_OMNI_REFERENCE_TO_VIDEO_TOOL =
  "generate_kie_kling_3_0_omni_reference_to_video";
export const KLING_OMNI_TRANSFORMATION_TOOL =
  "generate_kie_kling_3_0_omni_transformation";

export const KLING_OMNI_TOOLS = [
  KLING_OMNI_TEXT_TO_VIDEO_TOOL,
  KLING_OMNI_IMAGE_TO_VIDEO_TOOL,
  KLING_OMNI_REFERENCE_TO_VIDEO_TOOL,
  KLING_OMNI_TRANSFORMATION_TOOL,
] as const;

type KlingOmniToolName = (typeof KLING_OMNI_TOOLS)[number];

export type KlingOmniMode = "text" | "image" | "reference" | "transformation";

export const KLING_OMNI_MODE_TOOLS: Record<KlingOmniMode, KlingOmniToolName> = {
  text: KLING_OMNI_TEXT_TO_VIDEO_TOOL,
  image: KLING_OMNI_IMAGE_TO_VIDEO_TOOL,
  reference: KLING_OMNI_REFERENCE_TO_VIDEO_TOOL,
  transformation: KLING_OMNI_TRANSFORMATION_TOOL,
};

export const KLING_OMNI_API_MODELS = {
  text: "kling-3.0-omni/text-to-video",
  image: "kling-3.0-omni/image-to-video",
  reference: "kling-3.0-omni/reference-to-video",
  transformation: "kling-3.0-omni/transformation",
} as const;

export const KLING_OMNI_JOB_TYPE = "generate_kling30_omni_video";
export const KLING_OMNI_TASK_TYPE = "kling30_omni_video";

const KLING_OMNI_SHARED_PARAMS = [
  "prompt",
  "audio",
  "resolution",
  "aspect_ratio",
  "duration",
  "customize_multi_shots",
  "prefer_multi_shots",
  "multi_prompt",
] as const;

export const KLING_OMNI_TOOL_PARAMS: Record<KlingOmniToolName, string[]> = {
  [KLING_OMNI_TEXT_TO_VIDEO_TOOL]: [...KLING_OMNI_SHARED_PARAMS],
  [KLING_OMNI_IMAGE_TO_VIDEO_TOOL]: ["image_refs", ...KLING_OMNI_SHARED_PARAMS],
  [KLING_OMNI_REFERENCE_TO_VIDEO_TOOL]: [
    "image_refs",
    "video_refs",
    ...KLING_OMNI_SHARED_PARAMS,
  ],
  [KLING_OMNI_TRANSFORMATION_TOOL]: [
    "prompt",
    "image_refs",
    "video_refs",
    "audio",
    "resolution",
    "aspect_ratio",
    "duration",
  ],
};

export function isKlingOmniTool(toolName: string): toolName is KlingOmniToolName {
  return (KLING_OMNI_TOOLS as readonly string[]).includes(toolName);
}

function nonemptyRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string =>
    typeof item === "string" && item.trim() !== "");
}

export function inferKlingOmniMode(params: Record<string, unknown>): KlingOmniMode {
  const images = nonemptyRefs(params.image_refs);
  const videos = nonemptyRefs(params.video_refs);
  if (videos.length > 0 && images.length > 0) return "transformation";
  if (videos.length > 0) return "reference";
  if (images.length > 2) return "reference";
  if (images.length > 0) return "image";
  return "text";
}

export function klingOmniToolForMode(mode: KlingOmniMode): KlingOmniToolName {
  return KLING_OMNI_MODE_TOOLS[mode];
}

export function klingOmniToolForParams(
  params: Record<string, unknown>,
): KlingOmniToolName {
  return klingOmniToolForMode(inferKlingOmniMode(params));
}
