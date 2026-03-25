/**
 * Video model registry, schemas, validation, and routing prompt.
 */
import type { ResolvedAsset } from "./asset-resolver.js";

// ---------------------------------------------------------------------------
// Provider routes
// ---------------------------------------------------------------------------

type ProviderRoute = {
  key: string;
  label: string;
  provider_path: string;
  envKey: string;
};

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

type VideoModelInfo = {
  label: string;
  tool_name: string;
  description: string;
  params: string[];
  defaults: Record<string, unknown>;
  providers: ProviderRoute[];
};

const VIDEO_MODELS: Record<string, VideoModelInfo> = {
  kling30: {
    label: "Kling 3.0",
    tool_name: "generate_kling30_video",
    description: "Kling 3.0 text/image-to-video with duration, sound, and aspect ratio control",
    params: [
      "prompt", "mode", "image_slugs",
      "element1_slugs", "element1_name", "element1_desc",
      "element2_slugs", "element2_name", "element2_desc",
      "element3_slugs", "element3_name", "element3_desc",
      "multi_prompt", "multi_shots",
      "duration", "sound", "aspect_ratio", "image_orientation",
    ],
    defaults: { mode: "std", duration: "8", sound: true, aspect_ratio: "16:9", image_orientation: "auto" },
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.api.v1.jobs.createTask()", envKey: "KIE_API_KEY" },
    ],
  },
  veo31: {
    label: "Veo 3.1",
    tool_name: "generate_veo_video",
    description: "Video generation and extension with quality toggle",
    params: [
      "prompt", "generation_type", "image_slugs", "video_path", "frame_timestamps",
      "aspect_ratio", "model", "seeds", "watermark", "enable_translation", "image_orientation",
    ],
    defaults: { aspect_ratio: "16:9", model: "veo3_fast", enable_translation: true, image_orientation: "auto" },
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.veo.api.v1.veo.generate()", envKey: "KIE_API_KEY" },
    ],
  },
  veo31_extend: {
    label: "Veo 3.1 Extend",
    tool_name: "extend_veo_video",
    description: "Extend an existing Veo video with additional content",
    params: ["video_slug", "prompt", "model", "seeds", "watermark"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.veo.api.v1.veo.extend()", envKey: "KIE_API_KEY" },
    ],
  },
  seedance: {
    label: "Seedance 1.5 Pro",
    tool_name: "generate_seedance_video",
    description: "ByteDance video generation with audio support",
    params: [
      "prompt", "image_slugs", "aspect_ratio", "resolution",
      "duration", "fixed_lens", "generate_audio", "image_orientation",
    ],
    defaults: { aspect_ratio: "16:9", resolution: "1080p", duration: "8", generate_audio: true, image_orientation: "auto" },
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.api.v1.jobs.createTask()", envKey: "KIE_API_KEY" },
    ],
  },
  grok_imagine: {
    label: "Grok Imagine",
    tool_name: "generate_grok_imagine_video",
    description: "Grok image-to-video with fun/normal/spicy modes",
    params: ["prompt", "image_slugs", "mode", "duration", "resolution", "image_orientation"],
    defaults: { mode: "normal", duration: "6", resolution: "720p", image_orientation: "auto" },
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.api.v1.jobs.createTask()", envKey: "KIE_API_KEY" },
      { key: "xai", label: "xAI", provider_path: "xai.v1.videos.generations()", envKey: "XAI_API_KEY" },
    ],
  },
};

// ---------------------------------------------------------------------------
// Image slot limits
// ---------------------------------------------------------------------------

const IMAGE_SLOT_LIMITS: Record<string, { min: number; max: number }> = {
  generate_kling30_video: { min: 0, max: 2 },
  generate_veo_video: { min: 0, max: 3 },
  generate_seedance_video: { min: 0, max: 2 },
  generate_grok_imagine_video: { min: 1, max: 1 },
  extend_veo_video: { min: 0, max: 0 },
};

const VEO_IMAGE_SLOTS: Record<string, { min: number; max: number }> = {
  TEXT_2_VIDEO: { min: 0, max: 0 },
  FIRST_AND_LAST_FRAMES_2_VIDEO: { min: 1, max: 2 },
  REFERENCE_2_VIDEO: { min: 1, max: 3 },
};

// ---------------------------------------------------------------------------
// Parameter schemas (static JSON Schema defs)
// ---------------------------------------------------------------------------

type ParamSchema = {
  type: string;
  description: string;
  enum?: (string | number | boolean)[];
  default?: unknown;
  items?: Record<string, unknown>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
};

const PARAM_SCHEMAS: Record<string, ParamSchema> = {
  prompt: { type: "string", description: "Text description of what to generate" },
  image_slugs: {
    type: "array",
    items: { type: "string" },
    description: "List of asset slugs (e.g., '@img-sunset') for reference images",
  },
  aspect_ratio: { type: "string", description: "Output aspect ratio" },
  model: {
    type: "string",
    enum: ["veo3_fast", "veo3"],
    description: "Veo model - veo3_fast (default, cost-efficient) or veo3 (flagship, highest fidelity)",
  },
  generation_type: {
    type: "string",
    enum: ["TEXT_2_VIDEO", "FIRST_AND_LAST_FRAMES_2_VIDEO", "REFERENCE_2_VIDEO"],
    description: "Veo generation mode. Auto-inferred from image count if not specified.",
  },
  video_path: { type: "string", description: "Path to video file for frame extraction" },
  frame_timestamps: {
    type: "array",
    items: { type: "number" },
    description: "Timestamps in seconds for frame extraction from video",
  },
  seeds: { type: "integer", description: "Random seed (10000-99999) for reproducibility", minimum: 10000, maximum: 99999 },
  watermark: { type: "string", description: "Optional watermark text" },
  enable_translation: {
    type: "boolean",
    description: "Auto-translate prompt to English for better results (default: true)",
    default: true,
  },
  video_slug: { type: "string", description: "Video asset to extend (e.g., @vid-sunset-drone)" },
  duration: { type: "string", description: "Video duration in seconds" },
  mode: { type: "string", description: "Generation mode" },
  resolution: { type: "string", description: "Output resolution" },
  fixed_lens: { type: "boolean", description: "Enable static camera mode (Seedance)" },
  generate_audio: { type: "boolean", description: "Generate sound effects (Seedance)" },
  sound: { type: "boolean", description: "Generate audio for the video" },
  multi_shots: { type: "boolean", description: "Enable multi-shot mode" },
  multi_prompt: {
    type: "array",
    items: {
      type: "object",
      properties: { prompt: { type: "string" }, duration: { type: "integer" } },
      required: ["prompt", "duration"],
    },
    description: "List of scene dicts for multi-shot mode.",
  },
  element1_slugs: { type: "array", items: { type: "string" }, description: "1-4 image @slugs or 1 video @slug for element 1" },
  element1_name: { type: "string", description: "Name for element 1 (default: derived from first slug)" },
  element1_desc: { type: "string", description: "Description for element 1 (required when element1_slugs set)" },
  element2_slugs: { type: "array", items: { type: "string" }, description: "1-4 image @slugs or 1 video @slug for element 2" },
  element2_name: { type: "string", description: "Name for element 2 (default: derived from first slug)" },
  element2_desc: { type: "string", description: "Description for element 2 (required when element2_slugs set)" },
  element3_slugs: { type: "array", items: { type: "string" }, description: "1-4 image @slugs or 1 video @slug for element 3" },
  element3_name: { type: "string", description: "Name for element 3 (default: derived from first slug)" },
  element3_desc: { type: "string", description: "Description for element 3 (required when element3_slugs set)" },
  image_orientation: {
    type: "string",
    enum: ["auto", "original", "portrait", "landscape"],
    description: "Override which input image variant to select",
    default: "auto",
  },
};

// ---------------------------------------------------------------------------
// Schema builder
// ---------------------------------------------------------------------------

type ToolSchema = {
  type: string;
  properties: Record<string, ParamSchema>;
  required: string[];
  defaults: Record<string, unknown>;
};

function getVideoToolSchema(toolName: string): ToolSchema | null {
  const model = Object.values(VIDEO_MODELS).find((m) => m.tool_name === toolName);
  if (!model) return null;

  const properties: Record<string, ParamSchema> = {};
  const required: string[] = [];

  for (const param of model.params) {
    const base = PARAM_SCHEMAS[param];
    if (!base) continue;

    const prop = { ...base };

    // Apply default from model
    if (param in model.defaults) {
      prop.default = model.defaults[param];
    }

    // Tool-specific enum/description overrides
    if (toolName === "generate_kling30_video") {
      if (param === "prompt") prop.description = "Video description";
      if (param === "mode") { prop.enum = ["std", "pro"]; prop.description = "Resolution mode: std (standard) / pro (professional)"; }
      if (param === "duration") { prop.enum = Array.from({ length: 13 }, (_, i) => String(i + 3)); prop.description = "Video duration: 3s-15s"; }
      if (param === "aspect_ratio") { prop.enum = ["16:9", "9:16", "1:1"]; prop.description = "Video aspect ratio"; }
      if (param === "sound") prop.description = "Generate audio for the video (default: true)";
      if (param === "image_slugs") prop.description = "Reference image assets for start/end frames (0-2 slugs like @img-sunset)";
    }
    if (toolName === "generate_veo_video") {
      if (param === "aspect_ratio") { prop.enum = ["16:9", "9:16", "Auto"]; prop.description = "Video aspect ratio (Auto lets the system decide)"; }
      if (param === "model") { prop.enum = ["veo3_fast", "veo3"]; }
    }
    if (toolName === "extend_veo_video") {
      if (param === "prompt") prop.description = "Describe how to extend the video (actions, scenes, style)";
      if (param === "model") { prop.enum = ["fast", "quality"]; prop.description = "Extension model - fast (default) or quality"; prop.default = "fast"; }
    }
    if (toolName === "generate_seedance_video") {
      if (param === "prompt") { prop.description = "Video description (3-2500 characters)"; prop.minLength = 3; prop.maxLength = 2500; }
      if (param === "aspect_ratio") { prop.enum = ["1:1", "21:9", "4:3", "3:4", "16:9", "9:16"]; prop.description = "Frame dimensions"; }
      if (param === "resolution") { prop.enum = ["480p", "720p", "1080p"]; prop.description = "Standard (480p) / HD (720p) / Full HD (1080p)"; }
      if (param === "duration") { prop.enum = ["4", "8", "12"]; prop.description = "Video duration: 4s / 8s / 12s"; }
      if (param === "image_slugs") prop.description = "Reference image assets (0-2 slugs like @img-sunset)";
    }
    if (toolName === "generate_grok_imagine_video") {
      if (param === "prompt") { prop.description = "Video motion description (optional, max 5000 chars)"; prop.maxLength = 5000; }
      if (param === "mode") { prop.enum = ["fun", "normal", "spicy"]; prop.description = "Generation style: fun / normal / spicy"; }
      if (param === "duration") { prop.enum = ["6", "10"]; prop.description = "Video duration: 6s / 10s"; }
      if (param === "resolution") { prop.enum = ["480p", "720p"]; prop.description = "Video resolution: 480p / 720p"; }
      if (param === "image_slugs") prop.description = "Reference image asset (exactly 1 required, e.g., @img-sunset)";
    }

    properties[param] = prop;

    // Required fields
    if (param === "prompt" && toolName !== "generate_grok_imagine_video") required.push(param);
    if (param === "image_slugs" && toolName === "generate_grok_imagine_video") required.push(param);
    if (param === "video_slug" && toolName === "extend_veo_video") required.push(param);
    if (toolName === "generate_seedance_video" && (param === "aspect_ratio" || param === "duration")) required.push(param);
  }

  return { type: "object", properties, required, defaults: model.defaults };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type ValidationResult = {
  valid: boolean;
  missing_required: string[];
  warnings: string[];
  image_slots: { min: number; max: number } | null;
  multi_prompt_slots: number | null;
};

function validateVideoParams(toolName: string, params: Record<string, unknown>): ValidationResult {
  const schema = getVideoToolSchema(toolName);
  if (!schema) return { valid: false, missing_required: [], warnings: ["Unknown tool"], image_slots: null, multi_prompt_slots: null };

  const missing: string[] = [];
  const warnings: string[] = [];

  for (const req of schema.required) {
    if (!(req in params) || params[req] === null || params[req] === undefined) {
      missing.push(req);
    }
  }

  // Check enum constraints
  for (const [key, value] of Object.entries(params)) {
    const prop = schema.properties[key];
    if (!prop) continue;
    if (prop.enum && value !== null && value !== undefined) {
      if (!prop.enum.includes(value as string | number | boolean)) {
        warnings.push(`${key}: '${String(value)}' not in allowed values [${prop.enum.join(", ")}]`);
      }
    }
  }

  // Tool-specific validation
  const imageSlugs = params.image_slugs as string[] | undefined;
  const totalImages = imageSlugs?.length ?? 0;

  if (toolName === "generate_kling30_video") {
    if (totalImages > 2) warnings.push(`Kling 3.0 only supports 0-2 images (got ${totalImages})`);
    const multiPrompt = params.multi_prompt as unknown[] | undefined;
    if (multiPrompt && totalImages > 1) warnings.push(`Kling 3.0 multi-shot mode allows max 1 reference image (got ${totalImages})`);
  }

  if (toolName === "generate_veo_video") {
    const genType = params.generation_type as string | undefined;
    const effectiveGenType = genType
      ?? (totalImages === 0 ? "TEXT_2_VIDEO" : totalImages === 2 ? "FIRST_AND_LAST_FRAMES_2_VIDEO" : "REFERENCE_2_VIDEO");

    if (effectiveGenType === "REFERENCE_2_VIDEO") {
      if (params.model && params.model !== "veo3_fast") warnings.push(`REFERENCE_2_VIDEO mode requires model='veo3_fast' (got ${String(params.model)})`);
      if (params.aspect_ratio && !["16:9", "9:16"].includes(params.aspect_ratio as string))
        warnings.push(`REFERENCE_2_VIDEO mode requires 16:9 or 9:16 aspect ratio (got ${String(params.aspect_ratio)})`);
    }
  }

  if (toolName === "generate_grok_imagine_video") {
    if (totalImages === 0) warnings.push("Grok Imagine requires at least one reference image");
    if (totalImages > 1) warnings.push(`Grok Imagine only supports 1 reference image (got ${totalImages})`);
  }

  if (toolName === "generate_seedance_video") {
    if (totalImages > 2) warnings.push(`Seedance only supports 0-2 images (got ${totalImages})`);
  }

  // Image slots
  let imageSlots = IMAGE_SLOT_LIMITS[toolName] ?? null;
  if (toolName === "generate_veo_video") {
    const genType = (params.generation_type as string) ?? "TEXT_2_VIDEO";
    imageSlots = VEO_IMAGE_SLOTS[genType] ?? { min: 0, max: 3 };
  }

  const multiPromptSlots = toolName === "generate_kling30_video" ? 5 : null;

  return { valid: missing.length === 0, missing_required: missing, warnings, image_slots: imageSlots, multi_prompt_slots: multiPromptSlots };
}

// ---------------------------------------------------------------------------
// Tool constraints (mutative)
// ---------------------------------------------------------------------------

function applyVideoToolConstraints(
  toolName: string,
  schema: ToolSchema,
  params: Record<string, unknown>,
): void {
  if (toolName === "generate_veo_video") {
    const imageSlugs = params.image_slugs as string[] | undefined;
    const totalImages = imageSlugs?.length ?? 0;
    const genType = params.generation_type as string | undefined;
    const effectiveGenType = genType
      ?? (totalImages === 0 ? "TEXT_2_VIDEO" : totalImages === 2 ? "FIRST_AND_LAST_FRAMES_2_VIDEO" : "REFERENCE_2_VIDEO");

    if (effectiveGenType === "REFERENCE_2_VIDEO") {
      if (schema.properties.model) {
        schema.properties.model = {
          ...schema.properties.model,
          enum: ["veo3_fast"],
          description: "Veo model (REFERENCE_2_VIDEO mode only supports veo3_fast)",
          default: "veo3_fast",
        };
      }
      if (schema.properties.aspect_ratio) {
        schema.properties.aspect_ratio = {
          ...schema.properties.aspect_ratio,
          enum: ["16:9", "9:16"],
          description: "Aspect ratio (REFERENCE_2_VIDEO mode supports 16:9 and 9:16)",
          default: "16:9",
        };
      }
      params.model = "veo3_fast";
      if (!["16:9", "9:16"].includes(params.aspect_ratio as string)) {
        params.aspect_ratio = "16:9";
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Routing prompt for GPT-4o-mini
// ---------------------------------------------------------------------------

const VIDEO_TOOL_NAMES = Object.values(VIDEO_MODELS).map((m) => m.tool_name);

function buildVideoRoutingPrompt(): string {
  const toolLines: string[] = [];
  for (const model of Object.values(VIDEO_MODELS)) {
    const paramStr = model.params.filter((p) => p !== "project_slug").join(", ");
    const defaultStr = Object.entries(model.defaults).map(([k, v]) => `${k}=${String(v)}`).join(", ");
    toolLines.push(`- ${model.tool_name}: ${model.description}`);
    toolLines.push(`  Parameters: ${paramStr}`);
    if (defaultStr) toolLines.push(`  Defaults: ${defaultStr}`);
  }

  return `You are a routing assistant for a video generation system.
You ONLY route to these video generation tools:

${toolLines.join("\n")}

Given a user query (possibly with @asset references), determine:
1. tool: Which tool to use (MUST be one of: ${VIDEO_TOOL_NAMES.join(", ")})
2. params: Parameters to pass to the tool

ROUTING PREFERENCES:
- PREFER generate_kling30_video as the DEFAULT for ALL video generation requests
- Use generate_veo_video ONLY when user explicitly mentions "veo"
- Use generate_grok_imagine_video ONLY when user explicitly mentions "grok" for video
- Use generate_seedance_video ONLY when user explicitly mentions "seedance" or "bytedance"
- Use extend_veo_video ONLY when user explicitly wants to extend an existing video

KEY CONSTRAINTS:
- For generate_kling30_video: mode "std"/"pro", duration "3"-"15", aspect_ratio "16:9"/"9:16"/"1:1", sound boolean
- For generate_veo_video: mode auto-selected by image count (0=TEXT_2_VIDEO, 1=REFERENCE_2_VIDEO, 2=FIRST_AND_LAST_FRAMES_2_VIDEO)
- For generate_veo_video REFERENCE_2_VIDEO: REQUIRES model="veo3_fast" and 16:9/9:16 aspect_ratio
- For generate_seedance_video: duration "4"/"8"/"12", resolution "480p"/"720p"/"1080p"
- For generate_grok_imagine_video: REQUIRES at least one image, mode "fun"/"normal"/"spicy", duration "6"/"10"

PROMPT FIELD: Do NOT include "prompt" in params. Only return tool selection and non-prompt parameters.
DO NOT include project_slug in params.

If the user's intent doesn't match a video generation tool, respond with:
{"tool": null, "params": {}, "error": "Query does not match a video generation tool"}

Respond with JSON only:
{"tool": "tool_name", "params": {"param1": "value1", ...}}`;
}

// ---------------------------------------------------------------------------
// Extract last-used settings per model from action log
// ---------------------------------------------------------------------------

type ActionLogEntry = {
  hash: string;
  action: string;
  payload: string | Record<string, unknown>;
  date: string;
};

function actionNameToToolName(action: string): string | null {
  if (!action.startsWith("tool-")) return null;
  const toolName = action.slice(5).replace(/-/g, "_");
  return Object.values(VIDEO_MODELS).some((m) => m.tool_name === toolName) ? toolName : null;
}

const NON_PARAM_KEYS = new Set(["project_slug"]);

function extractLastSettingsPerModel(
  log: ActionLogEntry[],
): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const entry of log) {
    const toolName = actionNameToToolName(entry.action);
    if (!toolName || result.has(toolName)) continue;
    if (typeof entry.payload === "string") continue;
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry.payload)) {
      if (!NON_PARAM_KEYS.has(k)) params[k] = v;
    }
    result.set(toolName, params);
  }
  return result;
}

/**
 * Return the model key of the most recently used video generation tool,
 * or null if the log contains no video tool entries.
 */
function extractLastUsedModel(log: ActionLogEntry[]): string | null {
  for (const entry of log) {
    const toolName = actionNameToToolName(entry.action);
    if (!toolName) continue;
    if (typeof entry.payload === "string") continue;
    for (const [key, info] of Object.entries(VIDEO_MODELS)) {
      if (info.tool_name === toolName) return key;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Model option builder
// ---------------------------------------------------------------------------

type ModelOption = {
  key: string;
  label: string;
  tool_name: string;
  description: string;
  schema: ToolSchema | null;
  prefilled_values: Record<string, unknown>;
  validation: ValidationResult;
  image_slots: { min: number; max: number } | null;
  multi_prompt_slots: number | null;
  providers: Array<{ key: string; label: string }>;
  selected_provider: string;
};

function buildModelOption(
  modelKey: string,
  modelInfo: VideoModelInfo,
  baseParams: Record<string, unknown>,
  resolvedAssets: ResolvedAsset[],
  historyEntries?: ActionLogEntry[],
): ModelOption {
  const toolName = modelInfo.tool_name;
  // Only carry over base params that belong to this model's param list
  const allowedParams = new Set(modelInfo.params);
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(baseParams)) {
    if (allowedParams.has(k)) params[k] = v;
  }

  // Prefill from most recent historical usage of this tool —
  // historical settings OVERRIDE router params so the user's last-used
  // settings persist as defaults across sessions.
  let historicalProvider: string | undefined;
  if (historyEntries) {
    const settingsMap = extractLastSettingsPerModel(historyEntries);
    const historical = settingsMap.get(toolName);
    if (historical) {
      historicalProvider = historical._provider as string | undefined;
      for (const [k, v] of Object.entries(historical)) {
        if (allowedParams.has(k)) {
          params[k] = v;
        }
      }
    }
  }

  // Fill image_slugs from resolved assets
  const imageTags = resolvedAssets
    .filter((a) => a.asset_type === "image" && a.file_path)
    .map((a) => a.tag);
  params.image_slugs = imageTags.length > 0 ? imageTags : [];

  // Ensure Kling 3.0 element/multi-shot defaults
  if (toolName === "generate_kling30_video") {
    for (let slot = 1; slot <= 3; slot++) {
      params[`element${slot}_slugs`] ??= [];
      params[`element${slot}_name`] ??= "";
      params[`element${slot}_desc`] ??= "";
    }
    params.multi_prompt ??= [];
    params.multi_shots ??= false;
  }

  // For extend_veo_video, prefill video_slug from video assets
  if (toolName === "extend_veo_video") {
    const videoAssets = resolvedAssets.filter((a) => a.asset_type === "video");
    if (videoAssets.length > 0) {
      params.video_slug = videoAssets[0].tag;
    }
  }

  // Apply model defaults where not already set
  for (const [k, v] of Object.entries(modelInfo.defaults)) {
    params[k] ??= v;
  }

  // Coerce numeric values to strings for params with string enums
  const schema = getVideoToolSchema(toolName);
  if (schema) {
    for (const [k, v] of Object.entries(params)) {
      const prop = schema.properties[k];
      if (prop?.type === "string" && prop.enum && typeof v === "number") {
        params[k] = String(v);
      }
    }
    applyVideoToolConstraints(toolName, schema, params);
  }

  const validation = validateVideoParams(toolName, params);

  // Filter providers to those with available API keys
  const availableProviders = modelInfo.providers.filter((p) => process.env[p.envKey]);
  const providerList = availableProviders.length > 0 ? availableProviders : modelInfo.providers;
  const selectedProvider = (historicalProvider && providerList.some((p) => p.key === historicalProvider))
    ? historicalProvider
    : providerList[0].key;

  return {
    key: modelKey,
    label: modelInfo.label,
    tool_name: toolName,
    description: modelInfo.description,
    schema,
    prefilled_values: params,
    validation,
    image_slots: validation.image_slots,
    multi_prompt_slots: validation.multi_prompt_slots,
    providers: providerList.map((p) => ({ key: p.key, label: p.label })),
    selected_provider: selectedProvider,
  };
}

export {
  VIDEO_MODELS,
  IMAGE_SLOT_LIMITS,
  PARAM_SCHEMAS,
  getVideoToolSchema,
  validateVideoParams,
  applyVideoToolConstraints,
  buildVideoRoutingPrompt,
  buildModelOption,
  extractLastSettingsPerModel,
  extractLastUsedModel,
};
export type { VideoModelInfo, ToolSchema, ValidationResult, ModelOption, ActionLogEntry, ProviderRoute };
