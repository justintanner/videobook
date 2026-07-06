/**
 * Image model registry, schemas, validation, and option builder.
 *
 * Parameter schemas and enums come from @apicity provider packages:
 *   - Kie: kie.modelInputSchemas (static prop, per-model input field schemas)
 *
 * Only identity, labels, and image slot limits are configured here.
 */
import type { ResolvedAsset } from "videocity-engine";
import { createKie } from "@apicity/kie";
import type { KieMediaModel, PayloadFieldSchema } from "@apicity/kie";
import {
  GptImage2ImageToImageRequestSchema,
  GptImage2TextToImageRequestSchema,
  GrokImageToImageRequestSchema,
  GrokTextToImageRequestSchema,
  NanoBananaProRequestSchema,
  Qwen2ImageEditRequestSchema,
  SeedreamImageToImageRequestSchema,
  SeedreamTextToImageRequestSchema,
  Wan27ImageInputSchema,
  Wan27ImageProRequestSchema,
  Wan27ImageRequestSchema,
} from "@apicity/kie/zod";
import {
  AlibabaImageReferenceSlotsSchema,
  AlibabaQwenImageEditImageSlotsSchema,
  AlibabaQwenImageGenerationImageSlotsSchema,
} from "@apicity/alibaba/zod";
import { readSlotConstraints, zodDefault, type SlotConstraints } from "./zod-slots.js";

// Qwen multimodal endpoint accepts 0-3 reference images for qwen-image-2.0*
// generation, and 1-3 required for qwen-image-edit*. Slot constraints come from
// @apicity/alibaba (AlibabaQwenImageGenerationImageSlotsSchema = .max(3),
// AlibabaQwenImageEditImageSlotsSchema = .min(1).max(3)).
const QWEN_GENERATION_MODEL_VALUES = ["qwen-image-2.0-pro", "qwen-image-2.0"] as const;
const QWEN_EDIT_MODEL_VALUES = ["qwen-image-edit-plus", "qwen-image-edit-max", "qwen-image-edit"] as const;

// ---------------------------------------------------------------------------
// Provider route shape consumed by the model-listing tool.
// ---------------------------------------------------------------------------

type ProviderRoute = {
  key: string;
  label: string;
  provider_path: string;
  envKey: string;
};

// ---------------------------------------------------------------------------
// Slim config — only what providers can't tell us
// ---------------------------------------------------------------------------

type XaiSchemaField = {
  type: string;
  required?: boolean;
  description?: string;
  enum?: readonly (string | number | boolean)[];
  items?: { type: string };
};

type ZodLike = { _def?: unknown; unwrap?: () => unknown };

type ImageModelConfig = {
  key: string;
  kieModelId?: KieMediaModel;
  xaiEndpoint?: "generations" | "edits";
  xaiSchemaOverride?: Record<string, XaiSchemaField>;
  tool_name: string;
  label: string;
  description: string;
  /** Apicity Zod schema for the image-asset input field, or null if the tool takes no image input. */
  imageFieldSchema: ZodLike | null;
  kieImageField?: string;
  defaultSchemas?: Record<string, ZodLike>;
  /** Optional fal.ai routing — when set, adds "fal" as a provider option.
   *  Tool name is picked by image-slug count at submit time: withRefs when
   *  one or more reference images are present, noRefs otherwise. */
  falToolNames?: { noRefs?: string; withRefs?: string };
  /** Optional Google Flow (useapi.net) routing — when set, adds "google" as a
   *  provider option, resolved like falToolNames. */
  googleToolNames?: { noRefs?: string; withRefs?: string };
};

const IMAGE_MODEL_CONFIGS: ImageModelConfig[] = [
  {
    key: "nano_banana",
    kieModelId: "nano-banana-pro",
    tool_name: "generate_nano_banana_image",
    label: "Nano Banana Pro",
    description: "Text-to-image with optional reference images, aspect ratio, resolution, and format control",
    imageFieldSchema: NanoBananaProRequestSchema.shape.input.shape.image_input,
    kieImageField: "image_input",
    defaultSchemas: {
      aspect_ratio: NanoBananaProRequestSchema.shape.input.shape.aspect_ratio,
      resolution: NanoBananaProRequestSchema.shape.input.shape.resolution,
      output_format: NanoBananaProRequestSchema.shape.input.shape.output_format,
    },
    falToolNames: { noRefs: "generate_nano_banana_pro_fal", withRefs: "generate_nano_banana_pro_edit_fal" },
    googleToolNames: { noRefs: "generate_nano_banana_pro_google", withRefs: "generate_nano_banana_pro_google" },
  },
  {
    key: "grok_imagine_image",
    kieModelId: "grok-imagine/image-to-image",
    xaiEndpoint: "edits",
    tool_name: "generate_grok_imagine_image",
    label: "Grok Imagine Edit",
    description: "Image-to-image transformation (requires exactly 1 reference image)",
    imageFieldSchema: GrokImageToImageRequestSchema.shape.input.shape.image_urls,
    kieImageField: "image_urls",
    defaultSchemas: { nsfw_checker: GrokImageToImageRequestSchema.shape.input.shape.nsfw_checker },
    falToolNames: { withRefs: "generate_grok_imagine_image_edit_fal" },
  },
  {
    key: "gpt_image",
    kieModelId: "gpt-image-2-image-to-image",
    tool_name: "generate_gpt_image",
    label: "GPT Image 2.0 Edit",
    description: "Image editing with 1-16 reference images, aspect ratio, resolution (1K/2K/4K), and NSFW filter",
    imageFieldSchema: GptImage2ImageToImageRequestSchema.shape.input.shape.input_urls,
    kieImageField: "input_urls",
    defaultSchemas: {
      aspect_ratio: GptImage2ImageToImageRequestSchema.shape.input.shape.aspect_ratio,
      resolution: GptImage2ImageToImageRequestSchema.shape.input.shape.resolution,
      nsfw_checker: GptImage2ImageToImageRequestSchema.shape.input.shape.nsfw_checker,
    },
  },
  {
    key: "gpt_image_text",
    kieModelId: "gpt-image-2-text-to-image",
    tool_name: "generate_gpt_image_text",
    label: "GPT Image 2.0",
    description: "Text-to-image generation (no reference images needed), with optional aspect ratio and resolution (1K/2K/4K)",
    imageFieldSchema: null,
    defaultSchemas: {
      aspect_ratio: GptImage2TextToImageRequestSchema.shape.input.shape.aspect_ratio,
      resolution: GptImage2TextToImageRequestSchema.shape.input.shape.resolution,
      nsfw_checker: GptImage2TextToImageRequestSchema.shape.input.shape.nsfw_checker,
    },
  },
  {
    key: "grok_imagine_text",
    kieModelId: "grok-imagine/text-to-image",
    xaiEndpoint: "generations",
    tool_name: "generate_grok_imagine_text_image",
    label: "Grok Imagine",
    description: "Text-to-image generation (no reference images needed), with optional aspect ratio",
    imageFieldSchema: null,
    defaultSchemas: {
      aspect_ratio: GrokTextToImageRequestSchema.shape.input.shape.aspect_ratio,
      nsfw_checker: GrokTextToImageRequestSchema.shape.input.shape.nsfw_checker,
    },
    falToolNames: { noRefs: "generate_grok_imagine_image_fal" },
  },
  {
    key: "qwen2_image_edit",
    kieModelId: "qwen2/image-edit",
    tool_name: "generate_qwen2_image_edit",
    label: "Qwen2 Image Edit",
    description: "Prompt-driven image edit using Qwen2 (requires exactly 1 reference image)",
    imageFieldSchema: Qwen2ImageEditRequestSchema.shape.input.shape.image_url,
    kieImageField: "image_url",
    defaultSchemas: {
      image_size: Qwen2ImageEditRequestSchema.shape.input.shape.image_size,
      output_format: Qwen2ImageEditRequestSchema.shape.input.shape.output_format,
      nsfw_checker: Qwen2ImageEditRequestSchema.shape.input.shape.nsfw_checker,
    },
    falToolNames: { withRefs: "generate_qwen_image_edit_fal" },
  },
  {
    key: "seedream_text",
    kieModelId: "seedream/5-lite-text-to-image",
    tool_name: "generate_seedream_text_image",
    label: "Seedream 5 Lite",
    description: "Text-to-image generation with ByteDance Seedream 5 Lite (basic=2K, high=4K), with aspect ratio and content-safety control",
    imageFieldSchema: null,
    defaultSchemas: {
      aspect_ratio: SeedreamTextToImageRequestSchema.shape.input.shape.aspect_ratio,
      quality: SeedreamTextToImageRequestSchema.shape.input.shape.quality,
      nsfw_checker: SeedreamTextToImageRequestSchema.shape.input.shape.nsfw_checker,
    },
    falToolNames: { noRefs: "generate_seedream_v5_lite_fal" },
  },
  {
    key: "seedream_image",
    kieModelId: "seedream/5-lite-image-to-image",
    tool_name: "generate_seedream_image",
    label: "Seedream 5 Lite Edit",
    description: "Image-to-image edit with ByteDance Seedream 5 Lite (1-14 reference images), aspect ratio, and quality/safety control",
    imageFieldSchema: SeedreamImageToImageRequestSchema.shape.input.shape.image_urls,
    kieImageField: "image_urls",
    defaultSchemas: {
      aspect_ratio: SeedreamImageToImageRequestSchema.shape.input.shape.aspect_ratio,
      quality: SeedreamImageToImageRequestSchema.shape.input.shape.quality,
      nsfw_checker: SeedreamImageToImageRequestSchema.shape.input.shape.nsfw_checker,
    },
    falToolNames: { withRefs: "generate_seedream_v5_lite_edit_fal" },
  },
  {
    key: "wan27_image",
    kieModelId: "wan/2-7-image",
    tool_name: "generate_wan27_image",
    label: "Wan 2.7 Image",
    description: "Text-to-image or image editing with optional reference images, aspect ratio, resolution, and thinking mode",
    imageFieldSchema: Wan27ImageInputSchema.shape.input_urls,
    kieImageField: "input_urls",
    defaultSchemas: {
      aspect_ratio: Wan27ImageRequestSchema.shape.input.shape.aspect_ratio,
      resolution: Wan27ImageRequestSchema.shape.input.shape.resolution,
      nsfw_checker: Wan27ImageRequestSchema.shape.input.shape.nsfw_checker,
    },
    falToolNames: { noRefs: "generate_wan27_fal", withRefs: "generate_wan27_edit_fal" },
  },
  {
    key: "wan27_image_pro",
    kieModelId: "wan/2-7-image-pro",
    tool_name: "generate_wan27_image_pro",
    label: "Wan 2.7 Image Pro",
    description: "Pro text-to-image or image editing with optional reference images, aspect ratio, resolution, and thinking mode",
    imageFieldSchema: Wan27ImageInputSchema.shape.input_urls,
    kieImageField: "input_urls",
    defaultSchemas: {
      aspect_ratio: Wan27ImageProRequestSchema.shape.input.shape.aspect_ratio,
      resolution: Wan27ImageProRequestSchema.shape.input.shape.resolution,
      nsfw_checker: Wan27ImageProRequestSchema.shape.input.shape.nsfw_checker,
    },
    falToolNames: { noRefs: "generate_wan27_pro_fal", withRefs: "generate_wan27_pro_edit_fal" },
  },
  {
    key: "alibaba_image",
    tool_name: "generate_alibaba_image",
    label: "Alibaba Wan 2.7 Image",
    description: "Alibaba Cloud image generation using Wan 2.7 with optional reference images, size, thinking mode, and color palette control",
    imageFieldSchema: AlibabaImageReferenceSlotsSchema,
  },
  {
    key: "alibaba_image_pro",
    tool_name: "generate_alibaba_image_pro",
    label: "Alibaba Wan 2.7 Image Pro",
    description: "Alibaba Cloud pro image generation using Wan 2.7 Pro with optional reference images, size, thinking mode, and color palette control",
    imageFieldSchema: AlibabaImageReferenceSlotsSchema,
  },
  {
    key: "alibaba_qwen_image",
    tool_name: "generate_alibaba_qwen_image",
    label: "Alibaba Qwen Image",
    description: "Alibaba Cloud Qwen text-to-image (qwen-image-2.0 family) with 0-3 optional reference images, via the synchronous multimodal endpoint",
    imageFieldSchema: AlibabaQwenImageGenerationImageSlotsSchema,
  },
  {
    key: "alibaba_qwen_image_edit",
    tool_name: "generate_alibaba_qwen_image_edit",
    label: "Alibaba Qwen Image Edit",
    description: "Alibaba Cloud Qwen image editing (qwen-image-edit family) with 1-3 required reference images, via the synchronous multimodal endpoint",
    imageFieldSchema: AlibabaQwenImageEditImageSlotsSchema,
  },
];

function getImageSlotsForConfig(config: ImageModelConfig): SlotConstraints | null {
  return readSlotConstraints(config.imageFieldSchema);
}

function getImageDefaultsForConfig(config: ImageModelConfig): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [fieldName, schema] of Object.entries(config.defaultSchemas ?? {})) {
    const result = zodDefault(schema);
    if (result.hasDefault) defaults[fieldName] = result.value;
  }
  return defaults;
}

// ---------------------------------------------------------------------------
// Provider schemas (read once at module load — no API calls)
// ---------------------------------------------------------------------------

const kieModelSchemas = createKie({ apiKey: "" }).modelInputSchemas;

// ---------------------------------------------------------------------------
// Schema types describing each tool's input parameters.
// ---------------------------------------------------------------------------

type ParamSchema = {
  type: string;
  description: string;
  enum?: (string | number | boolean)[];
  default?: unknown;
  items?: Record<string, unknown>;
  minimum?: number;
  maximum?: number;
};

type ToolSchema = {
  type: string;
  properties: Record<string, ParamSchema>;
  required: string[];
  defaults: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Convert Kie field to our ParamSchema
// ---------------------------------------------------------------------------

function kieFieldToParam(field: PayloadFieldSchema, config: ImageModelConfig, fieldName: string): ParamSchema {
  const isImageField = fieldName === config.kieImageField;
  const outputName = isImageField ? "image_slugs" : fieldName;
  const defaults = getImageDefaultsForConfig(config);

  const param: ParamSchema = {
    // Image fields are exposed to the frontend as `image_slugs: string[]` even
    // when the underlying provider takes a singular `image_url` string.
    type: isImageField ? "array" : field.type,
    description: isImageField
      ? imageSlotsDescription(getImageSlotsForConfig(config))
      : (field.description ?? ""),
  };

  if (field.enum) param.enum = [...field.enum];
  if (isImageField || field.items) param.items = { type: "string" };
  if (outputName in defaults) param.default = defaults[outputName];

  return param;
}

function imageSlotsDescription(slots: SlotConstraints | null): string {
  if (!slots || (slots.min === 0 && slots.max === 0)) return "No reference images";
  if (slots.max !== null && slots.min === slots.max) return `Reference image asset (exactly ${slots.min} required)`;
  if (slots.max === null) {
    return slots.min > 0
      ? `${slots.min}+ reference image assets`
      : "Reference image assets";
  }
  return `${slots.min}-${slots.max} reference image assets`;
}

// ---------------------------------------------------------------------------
// Schema builder (reads from Kie schemas — no switch statement)
// ---------------------------------------------------------------------------

function getImageToolSchema(toolName: string): ToolSchema | null {
  const config = IMAGE_MODEL_CONFIGS.find((c) => c.tool_name === toolName);
  if (!config) return null;
  const defaults = getImageDefaultsForConfig(config);

  // Try Kie schema first
  const modelSchema = config.kieModelId ? kieModelSchemas[config.kieModelId] : null;

  if (modelSchema) {
    const properties: Record<string, ParamSchema> = {};
    const required: string[] = [];
    for (const [fieldName, field] of Object.entries(modelSchema.fields) as [string, PayloadFieldSchema][]) {
      const outputName = fieldName === config.kieImageField ? "image_slugs" : fieldName;
      properties[outputName] = kieFieldToParam(field, config, fieldName);
      if (field.required) required.push(outputName);
    }
    return { type: "object", properties, required, defaults };
  }

  // Fallback: use xaiSchemaOverride for xAI-only models
  if (config.xaiSchemaOverride) {
    const properties: Record<string, ParamSchema> = {};
    const required: string[] = [];
    for (const [fieldName, field] of Object.entries(config.xaiSchemaOverride)) {
      const isImageField = fieldName === config.kieImageField;
      const param: ParamSchema = {
        type: field.type,
        description: isImageField ? imageSlotsDescription(getImageSlotsForConfig(config)) : (field.description ?? ""),
      };
      if (field.enum) param.enum = [...field.enum];
      if (isImageField || field.items) param.items = { type: "string" };
      if (fieldName in defaults) param.default = defaults[fieldName];
      properties[fieldName] = param;
      if (field.required) required.push(fieldName);
    }
    return { type: "object", properties, required, defaults };
  }

  // Alibaba image models — custom schema
  if (config.tool_name === "generate_alibaba_image" || config.tool_name === "generate_alibaba_image_pro") {
    const properties: Record<string, ParamSchema> = {
      prompt: { type: "string", description: "Text prompt for image generation (max 5000 chars)" },
      image_slugs: {
        type: "array",
        items: { type: "string" },
        description: imageSlotsDescription(getImageSlotsForConfig(config)),
      },
      size: { type: "string", description: "Output size (e.g., '1024*1024', '720*1280', '1280*720')" },
      n: { type: "integer", description: "Number of images to generate (1-12)", minimum: 1, maximum: 12 },
      watermark: { type: "boolean", description: "Add watermark to generated image" },
      thinking_mode: { type: "boolean", description: "Enable thinking mode for better quality" },
      seed: { type: "integer", description: "Random seed for reproducibility (0-2147483647)", minimum: 0, maximum: 2147483647 },
    };
    return { type: "object", properties, required: ["prompt"], defaults };
  }

  // Alibaba Qwen image models — custom schema (sync multimodal endpoint)
  if (config.tool_name === "generate_alibaba_qwen_image" || config.tool_name === "generate_alibaba_qwen_image_edit") {
    const isEdit = config.tool_name === "generate_alibaba_qwen_image_edit";
    const modelEnum = isEdit ? [...QWEN_EDIT_MODEL_VALUES] : [...QWEN_GENERATION_MODEL_VALUES];
    const properties: Record<string, ParamSchema> = {
      prompt: { type: "string", description: isEdit ? "Edit instruction text" : "Text prompt for image generation" },
      image_slugs: {
        type: "array",
        items: { type: "string" },
        description: imageSlotsDescription(getImageSlotsForConfig(config)),
      },
      model: { type: "string", description: "Qwen model variant", enum: modelEnum },
      size: { type: "string", description: "Output size (e.g., '1024*1024'). Not allowed for qwen-image-edit." },
      n: { type: "integer", description: "Number of images (1-6). qwen-image-edit supports only n=1", minimum: 1, maximum: 6 },
      negative_prompt: { type: "string", description: "Negative prompt (max 500 chars)" },
      prompt_extend: { type: "boolean", description: "Let the model expand the prompt. Not allowed for qwen-image-edit." },
      watermark: { type: "boolean", description: "Add watermark to generated image" },
      seed: { type: "integer", description: "Random seed for reproducibility (0-2147483647)", minimum: 0, maximum: 2147483647 },
    };
    const required = isEdit ? ["prompt", "image_slugs", "model"] : ["prompt", "model"];
    return { type: "object", properties, required, defaults };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public ImageModelInfo shape: built from config + provider schemas, returned
// by list_image_models for the FE generation panel.
// ---------------------------------------------------------------------------

type ImageModelInfo = {
  label: string;
  tool_name: string;
  description: string;
  params: string[];
  defaults: Record<string, unknown>;
  providers: ProviderRoute[];
};

function buildProvidersForConfig(config: ImageModelConfig): ProviderRoute[] {
  const providers: ProviderRoute[] = [];

  if (config.kieModelId && kieModelSchemas[config.kieModelId]) {
    providers.push({
      key: "kie",
      label: "Kie",
      provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })",
      envKey: "KIE_API_KEY",
    });
  }

  if (config.xaiEndpoint) {
    providers.push({
      key: "xai",
      label: "xAI",
      provider_path: `xai.post.v1.images.${config.xaiEndpoint}(request, { otp })`,
      envKey: "XAI_API_KEY",
    });
  }

  if (config.tool_name === "generate_alibaba_qwen_image" || config.tool_name === "generate_alibaba_qwen_image_edit") {
    providers.push({
      key: "alibaba",
      label: "Alibaba",
      provider_path: "alibaba.post.api.v1.services.aigc.multimodalGeneration.generation()",
      envKey: "DASHSCOPE_API_KEY",
    });
  } else if (config.tool_name.startsWith("generate_alibaba_")) {
    providers.push({
      key: "alibaba",
      label: "Alibaba",
      provider_path: "alibaba.post.api.v1.services.aigc.imageGeneration.generation()",
      envKey: "DASHSCOPE_API_KEY",
    });
  }

  if (config.falToolNames) {
    providers.push({
      key: "fal",
      label: "Fal",
      provider_path: "fal.post.v1.queue.submit()",
      envKey: "FAL_API_KEY",
    });
  }

  if (config.googleToolNames) {
    providers.push({
      key: "google",
      label: "Google Flow",
      provider_path: "google.v1.googleFlow.images()",
      envKey: "GOOGLE_FLOW_API_KEY",
    });
  }

  return providers;
}

function resolveSwapToolName(names: { noRefs?: string; withRefs?: string } | undefined, imageSlugCount: number): string | null {
  if (!names) return null;
  if (imageSlugCount > 0 && names.withRefs) return names.withRefs;
  if (imageSlugCount === 0 && names.noRefs) return names.noRefs;
  return names.withRefs ?? names.noRefs ?? null;
}

function resolveFalToolName(config: ImageModelConfig, imageSlugCount: number): string | null {
  return resolveSwapToolName(config.falToolNames, imageSlugCount);
}

function resolveGoogleToolName(config: ImageModelConfig, imageSlugCount: number): string | null {
  return resolveSwapToolName(config.googleToolNames, imageSlugCount);
}

function getImageModels(): Record<string, ImageModelInfo> {
  const result: Record<string, ImageModelInfo> = {};

  for (const config of IMAGE_MODEL_CONFIGS) {
    const modelSchema = config.kieModelId ? kieModelSchemas[config.kieModelId] : null;
    const params: string[] = [];

    if (modelSchema) {
      for (const fieldName of Object.keys(modelSchema.fields)) {
        params.push(fieldName === config.kieImageField ? "image_slugs" : fieldName);
      }
    } else if (config.xaiSchemaOverride) {
      params.push(...Object.keys(config.xaiSchemaOverride));
    } else {
      const schema = getImageToolSchema(config.tool_name);
      if (schema) params.push(...Object.keys(schema.properties));
    }

    const defaults = getImageDefaultsForConfig(config);
    result[config.key] = {
      label: config.label,
      tool_name: config.tool_name,
      description: config.description,
      params,
      defaults,
      providers: buildProvidersForConfig(config),
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type ValidationResult = {
  valid: boolean;
  missing_required: string[];
  warnings: string[];
  image_slots: SlotConstraints | null;
};

function validateImageParams(toolName: string, params: Record<string, unknown>): ValidationResult {
  const schema = getImageToolSchema(toolName);
  const config = IMAGE_MODEL_CONFIGS.find((c) => c.tool_name === toolName);
  if (!schema) return { valid: false, missing_required: [], warnings: ["Unknown tool"], image_slots: null };

  const missing: string[] = [];
  const warnings: string[] = [];

  for (const req of schema.required) {
    if (!(req in params) || params[req] === null || params[req] === undefined) {
      missing.push(req);
    }
  }

  for (const [key, value] of Object.entries(params)) {
    const prop = schema.properties[key];
    if (!prop) continue;
    if (prop.enum && value !== null && value !== undefined) {
      if (!prop.enum.includes(value as string | number | boolean)) {
        warnings.push(`${key}: '${String(value)}' not in allowed values [${prop.enum.join(", ")}]`);
      }
    }
  }

  const imageSlots = config ? getImageSlotsForConfig(config) : null;
  const imageSlugs = params.image_slugs as string[] | undefined;
  const totalImages = imageSlugs?.length ?? 0;

  if (imageSlots && imageSlots.min > 0 && totalImages < imageSlots.min) {
    warnings.push(`${config!.label} requires at least ${imageSlots.min} reference image${imageSlots.min > 1 ? "s" : ""}`);
  }
  if (imageSlots && imageSlots.max !== null && totalImages > imageSlots.max) {
    const range = imageSlots.min === imageSlots.max ? `${imageSlots.max}` : `${imageSlots.min}-${imageSlots.max}`;
    warnings.push(`${config!.label} supports ${range} images (got ${totalImages})`);
  }

  return { valid: missing.length === 0, missing_required: missing, warnings, image_slots: imageSlots };
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
  return IMAGE_MODEL_CONFIGS.some((c) => c.tool_name === toolName) ? toolName : null;
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

function extractLastUsedImageModel(log: ActionLogEntry[]): string | null {
  for (const entry of log) {
    const toolName = imageActionNameToToolName(entry.action);
    if (!toolName) continue;
    if (typeof entry.payload === "string") continue;
    const config = IMAGE_MODEL_CONFIGS.find((c) => c.tool_name === toolName);
    if (config) return config.key;
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
  image_slots: SlotConstraints | null;
  providers: Array<{ key: string; label: string }>;
  selected_provider: string;
};

function filterInvalidSlugs(
  params: Record<string, unknown>,
  validTags: Set<string>,
): void {
  for (const [k, v] of Object.entries(params)) {
    if (k.endsWith("_slug") && typeof v === "string" && v.startsWith("@") && !validTags.has(v)) {
      params[k] = "";
    }
    if (k.endsWith("_slugs") && Array.isArray(v)) {
      params[k] = v.filter(
        (s) => typeof s === "string" && (!s.startsWith("@") || validTags.has(s)),
      );
    }
  }
}

function buildImageModelOption(
  modelKey: string,
  modelInfo: ImageModelInfo,
  baseParams: Record<string, unknown>,
  resolvedAssets: ResolvedAsset[],
  historyEntries?: ActionLogEntry[],
  providerOverride?: string,
  projectAssetTags?: Set<string>,
): ModelOption {
  const toolName = modelInfo.tool_name;
  const allowedParams = new Set(modelInfo.params);
  const params: Record<string, unknown> = {};

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

  for (const [k, v] of Object.entries(baseParams)) {
    if (allowedParams.has(k)) params[k] = v;
  }

  const imageTags = resolvedAssets
    .filter((a) => a.asset_type === "image" && a.file_path)
    .map((a) => a.tag);
  params.image_slugs = imageTags.length > 0 ? imageTags : [];

  for (const [k, v] of Object.entries(modelInfo.defaults)) {
    params[k] ??= v;
  }

  // Strip slug references that don't exist in the current project
  if (projectAssetTags) {
    filterInvalidSlugs(params, projectAssetTags);
  }

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

  const availableProviders = modelInfo.providers.filter((p) => process.env[p.envKey]);
  const providerList = availableProviders.length > 0 ? availableProviders : modelInfo.providers;
  const selectedProvider = (providerOverride && providerList.some((p) => p.key === providerOverride))
    ? providerOverride
    : (historicalProvider && providerList.some((p) => p.key === historicalProvider))
      ? historicalProvider
      : providerList[0].key;

  let effectiveToolName = toolName;
  if (selectedProvider === "fal" || selectedProvider === "google") {
    const config = IMAGE_MODEL_CONFIGS.find((c) => c.tool_name === toolName);
    const slugCount = Array.isArray(params.image_slugs) ? (params.image_slugs as unknown[]).length : 0;
    const swapName = config
      ? (selectedProvider === "fal" ? resolveFalToolName(config, slugCount) : resolveGoogleToolName(config, slugCount))
      : null;
    if (swapName) effectiveToolName = swapName;
  }

  return {
    key: modelKey,
    label: modelInfo.label,
    tool_name: effectiveToolName,
    description: modelInfo.description,
    schema,
    prefilled_values: params,
    validation,
    image_slots: validation.image_slots,
    providers: providerList.map((p) => ({ key: p.key, label: p.label })),
    selected_provider: selectedProvider,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  getImageModels,
  getImageToolSchema,
  validateImageParams,
  buildImageModelOption,
  extractLastImageSettingsPerModel,
  extractLastUsedImageModel,
};
export type { ImageModelInfo, ImageModelConfig, ToolSchema, ValidationResult, ModelOption, ActionLogEntry, ProviderRoute };
