/**
 * Image model registry, schemas, validation, and routing prompt.
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

type ImageModelInfo = {
  label: string;
  tool_name: string;
  description: string;
  params: string[];
  defaults: Record<string, unknown>;
  providers: ProviderRoute[];
};

const IMAGE_MODELS: Record<string, ImageModelInfo> = {
  nano_banana: {
    label: "Nano Banana Pro",
    tool_name: "generate_nano_banana_image",
    description: "Text-to-image with optional reference images, aspect ratio, resolution, and format control",
    params: ["prompt", "image_slugs", "aspect_ratio", "resolution", "output_format"],
    defaults: { aspect_ratio: "1:1", resolution: "2K", output_format: "png" },
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.api.v1.jobs.createTask()", envKey: "KIE_API_KEY" },
    ],
  },
  grok_imagine_image: {
    label: "Grok Imagine",
    tool_name: "generate_grok_imagine_image",
    description: "Image-to-image transformation (requires exactly 1 reference image)",
    params: ["prompt", "image_slugs"],
    defaults: {},
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.api.v1.jobs.createTask()", envKey: "KIE_API_KEY" },
      { key: "xai", label: "xAI", provider_path: "xai.v1.images.edits()", envKey: "XAI_API_KEY" },
    ],
  },
  gpt_image: {
    label: "GPT Image",
    tool_name: "generate_gpt_image",
    description: "Image editing with reference images, aspect ratio and quality control",
    params: ["prompt", "image_slugs", "aspect_ratio", "quality"],
    defaults: { aspect_ratio: "1:1", quality: "high" },
    providers: [
      { key: "kie", label: "Kie", provider_path: "kie.api.v1.jobs.createTask()", envKey: "KIE_API_KEY" },
    ],
  },
};

// ---------------------------------------------------------------------------
// Image slot limits
// ---------------------------------------------------------------------------

const IMAGE_SLOT_LIMITS: Record<string, { min: number; max: number }> = {
  generate_nano_banana_image: { min: 0, max: 8 },
  generate_grok_imagine_image: { min: 1, max: 1 },
  generate_gpt_image: { min: 1, max: 4 },
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
};

const IMAGE_PARAM_SCHEMAS: Record<string, ParamSchema> = {
  prompt: { type: "string", description: "Text description of what to generate" },
  image_slugs: {
    type: "array",
    items: { type: "string" },
    description: "Reference image assets",
  },
  aspect_ratio: { type: "string", description: "Output aspect ratio" },
  resolution: { type: "string", description: "Output resolution" },
  output_format: { type: "string", description: "Output image format" },
  quality: { type: "string", description: "Output quality level" },
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

function getImageToolSchema(toolName: string): ToolSchema | null {
  const model = Object.values(IMAGE_MODELS).find((m) => m.tool_name === toolName);
  if (!model) return null;

  const properties: Record<string, ParamSchema> = {};
  const required: string[] = [];

  for (const param of model.params) {
    const base = IMAGE_PARAM_SCHEMAS[param];
    if (!base) continue;

    const prop = { ...base };

    if (param in model.defaults) {
      prop.default = model.defaults[param];
    }

    // Tool-specific overrides
    if (toolName === "generate_nano_banana_image") {
      if (param === "aspect_ratio") { prop.enum = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "auto"]; }
      if (param === "resolution") { prop.enum = ["1K", "2K", "4K"]; }
      if (param === "output_format") { prop.enum = ["png", "jpg"]; }
      if (param === "image_slugs") prop.description = "0-8 reference image assets (e.g., @img-sunset)";
    }
    if (toolName === "generate_grok_imagine_image") {
      if (param === "prompt") prop.description = "Optional text to guide transformation";
      if (param === "image_slugs") prop.description = "Reference image asset (exactly 1 required, e.g., @img-sunset)";
    }
    if (toolName === "generate_gpt_image") {
      if (param === "aspect_ratio") { prop.enum = ["1:1", "2:3", "3:2"]; }
      if (param === "quality") { prop.enum = ["medium", "high"]; }
      if (param === "image_slugs") prop.description = "1-4 reference image assets (e.g., @img-sunset)";
    }

    properties[param] = prop;

    // Required fields
    if (param === "prompt" && toolName !== "generate_grok_imagine_image") required.push(param);
    if (param === "image_slugs" && toolName === "generate_grok_imagine_image") required.push(param);
    if (param === "image_slugs" && toolName === "generate_gpt_image") required.push(param);
    if (param === "prompt" && toolName === "generate_gpt_image" && !required.includes(param)) required.push(param);
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
};

function validateImageParams(toolName: string, params: Record<string, unknown>): ValidationResult {
  const schema = getImageToolSchema(toolName);
  if (!schema) return { valid: false, missing_required: [], warnings: ["Unknown tool"], image_slots: null };

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

  if (toolName === "generate_grok_imagine_image") {
    if (totalImages === 0) warnings.push("Grok Imagine requires at least one reference image");
    if (totalImages > 1) warnings.push(`Grok Imagine only supports 1 reference image (got ${totalImages})`);
  }

  if (toolName === "generate_gpt_image") {
    if (totalImages > 4) warnings.push(`GPT Image supports 1-4 images (got ${totalImages})`);
  }

  const imageSlots = IMAGE_SLOT_LIMITS[toolName] ?? null;

  return { valid: missing.length === 0, missing_required: missing, warnings, image_slots: imageSlots };
}

// ---------------------------------------------------------------------------
// Routing prompt for GPT-4o-mini
// ---------------------------------------------------------------------------

const IMAGE_TOOL_NAMES = Object.values(IMAGE_MODELS).map((m) => m.tool_name);

function buildImageRoutingPrompt(): string {
  const toolLines: string[] = [];
  for (const model of Object.values(IMAGE_MODELS)) {
    const paramStr = model.params.filter((p) => p !== "project_slug").join(", ");
    const defaultStr = Object.entries(model.defaults).map(([k, v]) => `${k}=${String(v)}`).join(", ");
    toolLines.push(`- ${model.tool_name}: ${model.description}`);
    toolLines.push(`  Parameters: ${paramStr}`);
    if (defaultStr) toolLines.push(`  Defaults: ${defaultStr}`);
  }

  return `You are a routing assistant for an image generation system.
You ONLY route to these image generation tools:

${toolLines.join("\n")}

Given a user query (possibly with @asset references), determine:
1. tool: Which tool to use (MUST be one of: ${IMAGE_TOOL_NAMES.join(", ")})
2. params: Parameters to pass to the tool

ROUTING PREFERENCES:
- PREFER generate_nano_banana_image as the DEFAULT for ALL image generation requests
- Use generate_grok_imagine_image ONLY when user explicitly mentions "grok" for image
- Use generate_gpt_image ONLY when user explicitly mentions "gpt", "chatgpt", or "edit"

KEY CONSTRAINTS:
- For generate_nano_banana_image: aspect_ratio options include 1:1/2:3/3:2/3:4/4:3/4:5/5:4/9:16/16:9/21:9/auto, resolution 1K/2K/4K, output_format png/jpg
- For generate_grok_imagine_image: REQUIRES exactly 1 reference image
- For generate_gpt_image: REQUIRES 1-4 reference images, aspect_ratio 1:1/2:3/3:2, quality medium/high

PROMPT FIELD: Do NOT include "prompt" in params. Only return tool selection and non-prompt parameters.
DO NOT include project_slug in params.

If the user's intent doesn't match an image generation tool, respond with:
{"tool": null, "params": {}, "error": "Query does not match an image generation tool"}

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

function imageActionNameToToolName(action: string): string | null {
  if (!action.startsWith("tool-")) return null;
  const toolName = action.slice(5).replace(/-/g, "_");
  return Object.values(IMAGE_MODELS).some((m) => m.tool_name === toolName) ? toolName : null;
}

const NON_PARAM_KEYS = new Set(["project_slug"]);

function extractLastImageSettingsPerModel(
  log: ActionLogEntry[],
): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const entry of log) {
    const toolName = imageActionNameToToolName(entry.action);
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
 * Return the model key of the most recently used image generation tool,
 * or null if the log contains no image tool entries.
 */
function extractLastUsedImageModel(log: ActionLogEntry[]): string | null {
  for (const entry of log) {
    const toolName = imageActionNameToToolName(entry.action);
    if (!toolName) continue;
    if (typeof entry.payload === "string") continue;
    for (const [key, info] of Object.entries(IMAGE_MODELS)) {
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
  providers: Array<{ key: string; label: string }>;
  selected_provider: string;
};

function buildImageModelOption(
  modelKey: string,
  modelInfo: ImageModelInfo,
  baseParams: Record<string, unknown>,
  resolvedAssets: ResolvedAsset[],
  historyEntries?: ActionLogEntry[],
): ModelOption {
  const toolName = modelInfo.tool_name;
  const allowedParams = new Set(modelInfo.params);
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(baseParams)) {
    if (allowedParams.has(k)) params[k] = v;
  }

  // Prefill from most recent historical usage of this tool
  let historicalProvider: string | undefined;
  if (historyEntries) {
    const settingsMap = extractLastImageSettingsPerModel(historyEntries);
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

  // Apply model defaults where not already set
  for (const [k, v] of Object.entries(modelInfo.defaults)) {
    params[k] ??= v;
  }

  // Coerce numeric values to strings for params with string enums
  const schema = getImageToolSchema(toolName);
  if (schema) {
    for (const [k, v] of Object.entries(params)) {
      const prop = schema.properties[k];
      if (prop?.type === "string" && prop.enum && typeof v === "number") {
        params[k] = String(v);
      }
    }
  }

  const validation = validateImageParams(toolName, params);

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
    providers: providerList.map((p) => ({ key: p.key, label: p.label })),
    selected_provider: selectedProvider,
  };
}

export {
  IMAGE_MODELS,
  IMAGE_SLOT_LIMITS,
  IMAGE_PARAM_SCHEMAS,
  getImageToolSchema,
  validateImageParams,
  buildImageRoutingPrompt,
  buildImageModelOption,
  extractLastImageSettingsPerModel,
  extractLastUsedImageModel,
};
export type { ImageModelInfo, ToolSchema, ValidationResult, ModelOption, ActionLogEntry, ProviderRoute };
