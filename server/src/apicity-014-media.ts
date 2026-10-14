import { z, type ZodRawShape, type ZodType } from "zod";
import type { FalEndpointId } from "@apicity/fal";
import type { GenerationActionSpec } from "./generation-registry.js";
import {
  FalBriaFiboEdit1p5ProductHoldingRequestSchema,
  FalBriaFiboEdit1p5VirtualTryOnRequestSchema,
  FalBytedanceSeedreamV5FlashEditRequestSchema,
  FalBytedanceSeedreamV5FlashLayerizeRequestSchema,
  FalBytedanceSeedreamV5FlashTextToImageRequestSchema,
  FalFlux3EditImageRequestSchema,
  FalFlux3TextToImageRequestSchema,
  FalIdeogramV4p5EditRequestSchema,
  FalIdeogramV4p5RequestSchema,
  FalMinimaxH3MaxInsertVideoRequestSchema,
  FalMinimaxH3MaxRecastRequestSchema,
  FalMinimaxH3MaxTurboExtendVideoRequestSchema,
  FalRecraftV4p1FlashTextToImageRequestSchema,
  FalXaiGrokImagineVideoV1p5LiteImageToVideoRequestSchema,
  FalXaiGrokImagineVideoV1p5LiteTextToVideoRequestSchema,
} from "@apicity/fal/zod";
import {
  NanoBanana21RequestSchema,
  SeedreamFlashImageToImageRequestSchema,
  SeedreamFlashLayerDecompositionRequestSchema,
  SeedreamFlashTextToImageRequestSchema,
  ViduQ4ImageToVideoRequestSchema,
  ViduQ4ReferenceToVideoRequestSchema,
} from "@apicity/kie/zod";
import { apicityField, apicityStringArrayField } from "./tools/schema-from-apicity.js";
import { DEFAULT_IMAGE_EDIT_MODEL_ID, NANO_BANANA_2_1_KEY, NANO_BANANA_2_1_TOOL } from "./image-edit-default.js";
import { buildNanoBanana21Payload } from "./nano-banana-2-1.js";
import {
  zodEnumOptionsOrNull,
  zodNumberRange,
  zodUnionEnumOptions,
} from "./zod-slots.js";

type ZodLike = { _def?: unknown; unwrap?: () => unknown };

type PickerParam = {
  type: string;
  description: string;
  enum?: (string | number | boolean)[];
  items?: { type: string };
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
};

export type Apicity014PickerSchema = {
  type: "object";
  properties: Record<string, PickerParam>;
  required: string[];
  defaults: Record<string, unknown>;
};

type MediaKind = "image" | "video";

type ImageSlots = { min: number; max: number | null };

type Apicity014Action = {
  canonicalName: string;
  provider: "fal" | "kie";
  endpointId: string;
  releaseName: string;
  label: string;
  description: string;
  listingKey: string;
  mediaType: MediaKind;
  operation: string;
  schemaOwner: "@apicity/fal/zod" | "@apicity/kie/zod";
  requestSchema: ZodType;
  taskType: string;
  jobType: string;
  provenanceModel: string;
  imageSlots: ImageSlots | null;
  textOnly: boolean;
  picker: Apicity014PickerSchema;
  toolShape: ZodRawShape;
  videoParams: string[];
  videoZod: Record<string, ZodLike>;
  videoImageField: ZodLike | null;
  build: (args: Record<string, unknown>) => Record<string, unknown>;
};

const FAL_PATH = "fal.post.v1.queue.submit()";
const KIE_PATH = "kie.post.api.v1.jobs.createTask(request, { otp })";

function falEndpoint(id: FalEndpointId): FalEndpointId {
  return id;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function flag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function copyText(target: Record<string, unknown>, key: string, value: unknown): void {
  const parsed = text(value);
  if (parsed !== undefined) target[key] = parsed;
}

function copyNumber(target: Record<string, unknown>, key: string, value: unknown): void {
  const parsed = finiteNumber(value);
  if (parsed !== undefined) target[key] = parsed;
}

function copyFlag(target: Record<string, unknown>, key: string, value: unknown): void {
  const parsed = flag(value);
  if (parsed !== undefined) target[key] = parsed;
}

function enumOptions(schema: ZodLike): string[] | null {
  return zodEnumOptionsOrNull(schema) ?? zodUnionEnumOptions(schema);
}

function stringParam(description: string, schema?: ZodLike): PickerParam {
  const options = schema ? enumOptions(schema) : null;
  const param: PickerParam = { type: "string", description };
  if (options && options.length > 0) param.enum = options;
  return param;
}

function numberParam(description: string, schema?: ZodLike): PickerParam {
  const range = schema ? zodNumberRange(schema) : null;
  const param: PickerParam = {
    type: range?.int ? "integer" : "number",
    description,
  };
  if (range?.min !== undefined) param.minimum = range.min;
  if (range?.max !== undefined) param.maximum = range.max;
  return param;
}

function imageRefsParam(description: string, slots: ImageSlots): PickerParam {
  const param: PickerParam = {
    type: "array",
    items: { type: "string" },
    description,
    minItems: slots.min,
  };
  if (slots.max !== null) param.maxItems = slots.max;
  return param;
}

function imageRefsZod(slots: ImageSlots, description: string): z.ZodArray<z.ZodString> {
  let schema = z.array(z.string()).min(slots.min);
  if (slots.max !== null) schema = schema.max(slots.max);
  return schema.describe(description);
}

function promptZod(minLength: number, description: string): z.ZodString {
  return z.string().min(minLength).describe(description);
}

function optionalString(description: string): z.ZodOptional<z.ZodString> {
  return z.string().optional().describe(description);
}

function optionalNumber(description: string) {
  return z.coerce.number().optional().describe(description);
}

function bookIdField(): z.ZodString {
  return z.string().describe("Book id");
}

function pickerSchema(
  properties: Record<string, PickerParam>,
  required: string[],
): Apicity014PickerSchema {
  return { type: "object", properties, required, defaults: {} };
}

function historyConsumers(): string[] {
  return ["notebook", "prompt_history", "project_activity", ".generation-request"];
}

const ONE_IMAGE: ImageSlots = { min: 1, max: 1 };
const FIBO_IMAGES: ImageSlots = { min: 2, max: 4 };
const TEN_IMAGES: ImageSlots = { min: 1, max: 10 };
const OPEN_EDIT_IMAGES: ImageSlots = { min: 1, max: null };
const RECAST_IMAGES: ImageSlots = { min: 1, max: 4 };

const productHolding = FalBriaFiboEdit1p5ProductHoldingRequestSchema;
const virtualTryOn = FalBriaFiboEdit1p5VirtualTryOnRequestSchema;
const recraftFlash = FalRecraftV4p1FlashTextToImageRequestSchema;
const seedreamFlashText = FalBytedanceSeedreamV5FlashTextToImageRequestSchema;
const seedreamFlashEdit = FalBytedanceSeedreamV5FlashEditRequestSchema;
const seedreamFlashLayer = FalBytedanceSeedreamV5FlashLayerizeRequestSchema;
const ideogram45 = FalIdeogramV4p5RequestSchema;
const ideogram45Edit = FalIdeogramV4p5EditRequestSchema;
const flux3Text = FalFlux3TextToImageRequestSchema;
const flux3Edit = FalFlux3EditImageRequestSchema;
const h3Insert = FalMinimaxH3MaxInsertVideoRequestSchema;
const h3Recast = FalMinimaxH3MaxRecastRequestSchema;
const h3Extend = FalMinimaxH3MaxTurboExtendVideoRequestSchema;
const grokLiteI2v = FalXaiGrokImagineVideoV1p5LiteImageToVideoRequestSchema;
const grokLiteT2v = FalXaiGrokImagineVideoV1p5LiteTextToVideoRequestSchema;
const kieFlashText = SeedreamFlashTextToImageRequestSchema;
const kieFlashEdit = SeedreamFlashImageToImageRequestSchema;
const kieFlashLayers = SeedreamFlashLayerDecompositionRequestSchema;
const viduImage = ViduQ4ImageToVideoRequestSchema.shape.input;
const viduReference = ViduQ4ReferenceToVideoRequestSchema.shape.input;
const VIDU_IMAGES: ImageSlots = { min: 1, max: 15 };

function fiboPayload(
  args: Record<string, unknown>,
  imagesKey: "product_image_urls" | "garment_image_urls",
): Record<string, unknown> {
  const images = strings(args.image_refs);
  const payload: Record<string, unknown> = {
    person_image_url: images[0] ?? "",
    [imagesKey]: images.slice(1),
  };
  copyText(payload, "instruction", args.prompt);
  copyText(payload, "aspect_ratio", args.aspect_ratio);
  copyNumber(payload, "seed", args.seed);
  return payload;
}

function kieFlashPayload(
  model: string,
  args: Record<string, unknown>,
  imageMode: "none" | "urls" | "url",
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const prompt = text(args.prompt);
  if (prompt !== undefined) input.prompt = prompt;
  copyText(input, "aspect_ratio", args.aspect_ratio);
  copyText(input, "size", args.size);
  copyText(input, "output_format", args.output_format);
  copyFlag(input, "nsfw_checker", args.nsfw_checker);
  if (imageMode === "urls") input.image_urls = strings(args.image_refs);
  if (imageMode === "url") input.image_url = strings(args.image_refs)[0] ?? "";
  return { model, input };
}

function viduPayload(
  model: "vidu-q4/image-to-video" | "vidu-q4/reference-to-video",
  args: Record<string, unknown>,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  copyText(input, "prompt", args.prompt);
  copyNumber(input, "duration", args.duration);
  copyText(input, "resolution", args.resolution);
  copyFlag(input, "audio", args.audio);
  if (model === "vidu-q4/image-to-video") {
    input.image_url = strings(args.image_refs)[0] ?? "";
  } else {
    input.reference_image_urls = strings(args.image_refs);
    if (args.audio_refs !== undefined) input.reference_audio_urls = strings(args.audio_refs);
    copyText(input, "aspect_ratio", args.aspect_ratio);
  }
  return { model, input };
}

const ACTIONS: Apicity014Action[] = [
  {
    canonicalName: "generate_kie_vidu_q4_image_to_video",
    provider: "kie",
    endpointId: "vidu-q4/image-to-video",
    releaseName: "Vidu Q4 image-to-video",
    label: "Vidu Q4 image-to-video",
    description: "Animate one image with Vidu Q4, with optional audio, 3-16 seconds and 540p to 4k output; aspect ratio follows the image",
    listingKey: "vidu_q4_i2v",
    mediaType: "video",
    operation: "image_to_video",
    schemaOwner: "@apicity/kie/zod",
    requestSchema: ViduQ4ImageToVideoRequestSchema,
    taskType: "vidu_q4_image_to_video",
    jobType: "generate_kie_vidu_q4_image_to_video",
    provenanceModel: "vidu-q4/image-to-video",
    imageSlots: ONE_IMAGE,
    textOnly: false,
    picker: pickerSchema({}, []),
    toolShape: {
      book_id: bookIdField(),
      prompt: viduImage.shape.prompt,
      image_refs: imageRefsZod(ONE_IMAGE, "Source image; output inherits its aspect ratio"),
      duration: apicityField(viduImage.shape.duration, "Duration in seconds (3-16)"),
      resolution: viduImage.shape.resolution,
      audio: viduImage.shape.audio,
    },
    videoParams: ["prompt", "image_refs", "duration", "resolution", "audio"],
    videoZod: {
      prompt: viduImage.shape.prompt,
      image_refs: imageRefsZod(ONE_IMAGE, "Source image; output inherits its aspect ratio"),
      duration: viduImage.shape.duration,
      resolution: viduImage.shape.resolution,
      audio: viduImage.shape.audio,
    },
    videoImageField: imageRefsZod(ONE_IMAGE, "Source image"),
    build: (args) => viduPayload("vidu-q4/image-to-video", args),
  },
  {
    canonicalName: "generate_kie_vidu_q4_reference_to_video",
    provider: "kie",
    endpointId: "vidu-q4/reference-to-video",
    releaseName: "Vidu Q4 reference-to-video",
    label: "Vidu Q4 reference-to-video",
    description: "Generate video with Vidu Q4 using 1-15 reference images and up to 3 audio references, with 3-16 seconds and 540p to 4k output",
    listingKey: "vidu_q4_r2v",
    mediaType: "video",
    operation: "reference_to_video",
    schemaOwner: "@apicity/kie/zod",
    requestSchema: ViduQ4ReferenceToVideoRequestSchema,
    taskType: "vidu_q4_reference_to_video",
    jobType: "generate_kie_vidu_q4_reference_to_video",
    provenanceModel: "vidu-q4/reference-to-video",
    imageSlots: VIDU_IMAGES,
    textOnly: false,
    picker: pickerSchema({}, []),
    toolShape: {
      book_id: bookIdField(),
      prompt: viduReference.shape.prompt,
      image_refs: apicityStringArrayField(viduReference.shape.reference_image_urls, "Reference images in prompt order (1-15)", { required: true }),
      audio_refs: apicityStringArrayField(viduReference.shape.reference_audio_urls, "MP3 audio references (up to 3, each 3-12 seconds and up to 50 MB)"),
      aspect_ratio: viduReference.shape.aspect_ratio,
      duration: apicityField(viduReference.shape.duration, "Duration in seconds (3-16)"),
      resolution: viduReference.shape.resolution,
      audio: viduReference.shape.audio,
    },
    videoParams: ["prompt", "image_refs", "audio_refs", "aspect_ratio", "duration", "resolution", "audio"],
    videoZod: {
      prompt: viduReference.shape.prompt,
      image_refs: viduReference.shape.reference_image_urls,
      audio_refs: viduReference.shape.reference_audio_urls,
      aspect_ratio: viduReference.shape.aspect_ratio,
      duration: viduReference.shape.duration,
      resolution: viduReference.shape.resolution,
      audio: viduReference.shape.audio,
    },
    videoImageField: viduReference.shape.reference_image_urls,
    build: (args) => viduPayload("vidu-q4/reference-to-video", args),
  },
  {
    canonicalName: NANO_BANANA_2_1_TOOL,
    provider: "kie",
    endpointId: DEFAULT_IMAGE_EDIT_MODEL_ID,
    releaseName: "KIE Nano Banana 2.1",
    label: "Nano Banana 2.1",
    description: "Generate or edit an image with Nano Banana 2.1 using up to 10 references",
    listingKey: NANO_BANANA_2_1_KEY,
    mediaType: "image",
    operation: "generate_image",
    schemaOwner: "@apicity/kie/zod",
    requestSchema: NanoBanana21RequestSchema,
    taskType: "nano_banana_2_1",
    jobType: NANO_BANANA_2_1_TOOL,
    provenanceModel: DEFAULT_IMAGE_EDIT_MODEL_ID,
    imageSlots: { min: 0, max: 10 },
    textOnly: false,
    picker: pickerSchema({}, []),
    toolShape: {
      book_id: bookIdField(),
      prompt: NanoBanana21RequestSchema.shape.input.shape.prompt,
      image_refs: z.array(z.string()).max(10).optional(),
      aspect_ratio: NanoBanana21RequestSchema.shape.input.shape.aspect_ratio,
      resolution: NanoBanana21RequestSchema.shape.input.shape.resolution,
      output_format: NanoBanana21RequestSchema.shape.input.shape.output_format,
    },
    videoParams: [], videoZod: {}, videoImageField: null,
    build: args => buildNanoBanana21Payload(args, strings(args.image_refs)),
  },
  {
    canonicalName: "generate_fal_bria_fibo_edit_1_5_product_holding",
    provider: "fal",
    endpointId: falEndpoint("bria/fibo-edit-1.5/product-holding"),
    releaseName: "fal Bria FIBO Edit 1.5 product holding",
    label: "fal Bria FIBO Edit 1.5 product holding",
    description: "Place a person holding 1-3 product images with Bria FIBO Edit 1.5 on fal",
    listingKey: "fibo_product_holding",
    mediaType: "image",
    operation: "product_holding",
    schemaOwner: "@apicity/fal/zod",
    requestSchema: productHolding,
    taskType: "fal_bria_fibo_edit_1_5_product_holding",
    jobType: "generate_fal_bria_fibo_edit_1_5_product_holding",
    provenanceModel: "bria/fibo-edit-1.5/product-holding",
    imageSlots: FIBO_IMAGES,
    textOnly: false,
    picker: pickerSchema({
      prompt: stringParam("Holding instruction", productHolding.shape.instruction),
      image_refs: imageRefsParam("Person image first, then 1-3 product images", FIBO_IMAGES),
      aspect_ratio: stringParam("Output aspect ratio", productHolding.shape.aspect_ratio),
      seed: numberParam("Random seed", productHolding.shape.seed),
    }, ["image_refs"]),
    toolShape: {
      book_id: bookIdField(),
      prompt: optionalString("Holding instruction"),
      image_refs: imageRefsZod(FIBO_IMAGES, "Person image first, then 1-3 product images"),
      aspect_ratio: optionalString("Output aspect ratio"),
      seed: optionalNumber("Random seed"),
    },
    videoParams: [],
    videoZod: {},
    videoImageField: null,
    build: (args) => fiboPayload(args, "product_image_urls"),
  },
  {
    canonicalName: "generate_fal_bria_fibo_edit_1_5_virtual_try_on",
    provider: "fal",
    endpointId: falEndpoint("bria/fibo-edit-1.5/virtual-try-on"),
    releaseName: "fal Bria FIBO Edit 1.5 virtual try-on",
    label: "fal Bria FIBO Edit 1.5 virtual try-on",
    description: "Dress a person in 1-3 garment images with Bria FIBO Edit 1.5 on fal",
    listingKey: "fibo_virtual_try_on",
    mediaType: "image",
    operation: "virtual_try_on",
    schemaOwner: "@apicity/fal/zod",
    requestSchema: virtualTryOn,
    taskType: "fal_bria_fibo_edit_1_5_virtual_try_on",
    jobType: "generate_fal_bria_fibo_edit_1_5_virtual_try_on",
    provenanceModel: "bria/fibo-edit-1.5/virtual-try-on",
    imageSlots: FIBO_IMAGES,
    textOnly: false,
    picker: pickerSchema({
      prompt: stringParam("Try-on instruction", virtualTryOn.shape.instruction),
      image_refs: imageRefsParam("Person image first, then 1-3 garment images", FIBO_IMAGES),
      aspect_ratio: stringParam("Output aspect ratio", virtualTryOn.shape.aspect_ratio),
      seed: numberParam("Random seed", virtualTryOn.shape.seed),
    }, ["image_refs"]),
    toolShape: {
      book_id: bookIdField(),
      prompt: optionalString("Try-on instruction"),
      image_refs: imageRefsZod(FIBO_IMAGES, "Person image first, then 1-3 garment images"),
      aspect_ratio: optionalString("Output aspect ratio"),
      seed: optionalNumber("Random seed"),
    },
    videoParams: [],
    videoZod: {},
    videoImageField: null,
    build: (args) => fiboPayload(args, "garment_image_urls"),
  },
  {
    canonicalName: "generate_fal_recraft_v4_1_flash_text_to_image",
    provider: "fal",
    endpointId: falEndpoint("recraft/v4.1/flash/text-to-image"),
    releaseName: "fal Recraft 4.1 Flash text-to-image",
    label: "fal Recraft 4.1 Flash text-to-image",
    description: "Text-to-image with Recraft 4.1 Flash on fal",
    listingKey: "recraft_v4_1_flash",
    mediaType: "image",
    operation: "text_to_image",
    schemaOwner: "@apicity/fal/zod",
    requestSchema: recraftFlash,
    taskType: "fal_recraft_v4_1_flash_text_to_image",
    jobType: "generate_fal_recraft_v4_1_flash_text_to_image",
    provenanceModel: "recraft/v4.1/flash/text-to-image",
    imageSlots: null,
    textOnly: true,
    picker: pickerSchema({
      prompt: stringParam("Text prompt", recraftFlash.shape.prompt),
      image_size: stringParam("Output size preset", recraftFlash.shape.image_size),
    }, ["prompt"]),
    toolShape: {
      book_id: bookIdField(),
      prompt: promptZod(1, "Text prompt"),
      image_size: optionalString("Output size preset"),
    },
    videoParams: [],
    videoZod: {},
    videoImageField: null,
    build: (args) => {
      const payload: Record<string, unknown> = { prompt: text(args.prompt) ?? "" };
      copyText(payload, "image_size", args.image_size);
      return payload;
    },
  },
  {
    canonicalName: "generate_fal_seedream_v5_flash_text_to_image",
    provider: "fal",
    endpointId: falEndpoint("bytedance/seedream/v5/flash/text-to-image"),
    releaseName: "fal Seedream 5 Flash text-to-image",
    label: "fal Seedream 5 Flash text-to-image",
    description: "Text-to-image with ByteDance Seedream 5 Flash on fal",
    listingKey: "seedream_v5_flash_text",
    mediaType: "image",
    operation: "text_to_image",
    schemaOwner: "@apicity/fal/zod",
    requestSchema: seedreamFlashText,
    taskType: "fal_seedream_v5_flash_text_to_image",
    jobType: "generate_fal_seedream_v5_flash_text_to_image",
    provenanceModel: "bytedance/seedream/v5/flash/text-to-image",
    imageSlots: null,
    textOnly: true,
    picker: pickerSchema({
      prompt: stringParam("Text prompt", seedreamFlashText.shape.prompt),
      image_size: stringParam("Output size preset", seedreamFlashText.shape.image_size),
      num_images: numberParam("Number of images", seedreamFlashText.shape.num_images),
      output_format: stringParam("Output format", seedreamFlashText.shape.output_format),
    }, ["prompt"]),
    toolShape: {
      book_id: bookIdField(),
      prompt: promptZod(1, "Text prompt"),
      image_size: optionalString("Output size preset"),
      num_images: optionalNumber("Number of images"),
      output_format: optionalString("Output format"),
    },
    videoParams: [],
    videoZod: {},
    videoImageField: null,
    build: (args) => {
      const payload: Record<string, unknown> = { prompt: text(args.prompt) ?? "" };
      copyText(payload, "image_size", args.image_size);
      copyNumber(payload, "num_images", args.num_images);
      copyText(payload, "output_format", args.output_format);
      return payload;
    },
  },
  {
    canonicalName: "generate_fal_seedream_v5_flash_edit_image",
    provider: "fal",
    endpointId: falEndpoint("bytedance/seedream/v5/flash/edit"),
    releaseName: "fal Seedream 5 Flash edit",
    label: "fal Seedream 5 Flash edit",
    description: "Edit images with ByteDance Seedream 5 Flash on fal",
    listingKey: "seedream_v5_flash_edit",
    mediaType: "image",
    operation: "edit_image",
    schemaOwner: "@apicity/fal/zod",
    requestSchema: seedreamFlashEdit,
    taskType: "fal_seedream_v5_flash_edit",
    jobType: "generate_fal_seedream_v5_flash_edit_image",
    provenanceModel: "bytedance/seedream/v5/flash/edit",
    imageSlots: OPEN_EDIT_IMAGES,
    textOnly: false,
    picker: pickerSchema({
      prompt: stringParam("Edit instruction", seedreamFlashEdit.shape.prompt),
      image_refs: imageRefsParam("Reference images to edit", OPEN_EDIT_IMAGES),
      image_size: stringParam("Output size preset", seedreamFlashEdit.shape.image_size),
      num_images: numberParam("Number of images", seedreamFlashEdit.shape.num_images),
      output_format: stringParam("Output format", seedreamFlashEdit.shape.output_format),
    }, ["prompt", "image_refs"]),
    toolShape: {
      book_id: bookIdField(),
      prompt: promptZod(1, "Edit instruction"),
      image_refs: imageRefsZod(OPEN_EDIT_IMAGES, "Reference images to edit"),
      image_size: optionalString("Output size preset"),
      num_images: optionalNumber("Number of images"),
      output_format: optionalString("Output format"),
    },
    videoParams: [],
    videoZod: {},
    videoImageField: null,
    build: (args) => {
      const payload: Record<string, unknown> = {
        prompt: text(args.prompt) ?? "",
        image_urls: strings(args.image_refs),
      };
      copyText(payload, "image_size", args.image_size);
      copyNumber(payload, "num_images", args.num_images);
      copyText(payload, "output_format", args.output_format);
      return payload;
    },
  },
  {
    canonicalName: "generate_fal_seedream_v5_flash_layerize",
    provider: "fal",
    endpointId: falEndpoint("bytedance/seedream/v5/flash/layerize"),
    releaseName: "fal Seedream 5 Flash layerize",
    label: "fal Seedream 5 Flash layerize",
    description: "Split one image into layers with ByteDance Seedream 5 Flash on fal",
    listingKey: "seedream_v5_flash_layerize",
    mediaType: "image",
    operation: "layerize",
    schemaOwner: "@apicity/fal/zod",
    requestSchema: seedreamFlashLayer,
    taskType: "fal_seedream_v5_flash_layerize",
    jobType: "generate_fal_seedream_v5_flash_layerize",
    provenanceModel: "bytedance/seedream/v5/flash/layerize",
    imageSlots: ONE_IMAGE,
    textOnly: false,
    picker: pickerSchema({
      prompt: stringParam("Layer instruction", seedreamFlashLayer.shape.prompt),
      image_refs: imageRefsParam("Image to split into layers", ONE_IMAGE),
      image_size: stringParam("Output size preset", seedreamFlashLayer.shape.image_size),
    }, ["image_refs"]),
    toolShape: {
      book_id: bookIdField(),
      prompt: optionalString("Layer instruction"),
      image_refs: imageRefsZod(ONE_IMAGE, "Image to split into layers"),
      image_size: optionalString("Output size preset"),
    },
    videoParams: [],
    videoZod: {},
    videoImageField: null,
    build: (args) => {
      const payload: Record<string, unknown> = {
        image_url: strings(args.image_refs)[0] ?? "",
      };
      copyText(payload, "prompt", args.prompt);
      copyText(payload, "image_size", args.image_size);
      return payload;
    },
  },
  {
    canonicalName: "generate_fal_ideogram_v4_5_text_to_image",
    provider: "fal",
    endpointId: falEndpoint("ideogram/v4.5"),
    releaseName: "fal Ideogram 4.5 text-to-image",
    label: "fal Ideogram 4.5 text-to-image",
    description: "Text-to-image with Ideogram 4.5 on fal",
    listingKey: "ideogram_v4_5",
    mediaType: "image",
    operation: "text_to_image",
    schemaOwner: "@apicity/fal/zod",
    requestSchema: ideogram45,
    taskType: "fal_ideogram_v4_5_text_to_image",
    jobType: "generate_fal_ideogram_v4_5_text_to_image",
    provenanceModel: "ideogram/v4.5",
    imageSlots: null,
    textOnly: true,
    picker: pickerSchema({
      prompt: stringParam("Text prompt", ideogram45.shape.prompt),
      image_size: stringParam("Output size preset", ideogram45.shape.image_size),
      quality: stringParam("Render quality", ideogram45.shape.quality),
      num_images: numberParam("Number of images", ideogram45.shape.num_images),
    }, ["prompt"]),
    toolShape: {
      book_id: bookIdField(),
      prompt: promptZod(1, "Text prompt"),
      image_size: optionalString("Output size preset"),
      quality: optionalString("Render quality"),
      num_images: optionalNumber("Number of images"),
    },
    videoParams: [],
    videoZod: {},
    videoImageField: null,
    build: (args) => {
      const payload: Record<string, unknown> = { prompt: text(args.prompt) ?? "" };
      copyText(payload, "image_size", args.image_size);
      copyText(payload, "quality", args.quality);
      copyNumber(payload, "num_images", args.num_images);
      return payload;
    },
  },
  {
    canonicalName: "generate_fal_ideogram_v4_5_edit_image",
    provider: "fal",
    endpointId: falEndpoint("ideogram/v4.5/edit"),
    releaseName: "fal Ideogram 4.5 image editing",
    label: "fal Ideogram 4.5 image editing",
    description: "Edit one image with Ideogram 4.5 on fal",
    listingKey: "ideogram_v4_5_edit",
    mediaType: "image",
    operation: "edit_image",
    schemaOwner: "@apicity/fal/zod",
    requestSchema: ideogram45Edit,
    taskType: "fal_ideogram_v4_5_edit",
    jobType: "generate_fal_ideogram_v4_5_edit_image",
    provenanceModel: "ideogram/v4.5/edit",
    imageSlots: ONE_IMAGE,
    textOnly: false,
    picker: pickerSchema({
      prompt: stringParam("Edit instruction", ideogram45Edit.shape.prompt),
      image_refs: imageRefsParam("Image to edit", ONE_IMAGE),
      quality: stringParam("Render quality", ideogram45Edit.shape.quality),
    }, ["prompt", "image_refs"]),
    toolShape: {
      book_id: bookIdField(),
      prompt: promptZod(1, "Edit instruction"),
      image_refs: imageRefsZod(ONE_IMAGE, "Image to edit"),
      quality: optionalString("Render quality"),
    },
    videoParams: [],
    videoZod: {},
    videoImageField: null,
    build: (args) => {
      const payload: Record<string, unknown> = {
        prompt: text(args.prompt) ?? "",
        image_url: strings(args.image_refs)[0] ?? "",
      };
      copyText(payload, "quality", args.quality);
      return payload;
    },
  },
  {
    canonicalName: "generate_fal_flux_3_text_to_image",
    provider: "fal",
    endpointId: falEndpoint("blackforestlabs/flux-3/text-to-image"),
    releaseName: "fal FLUX 3 text-to-image",
    label: "fal FLUX 3 text-to-image",
    description: "Text-to-image with FLUX 3 on fal",
    listingKey: "flux_3",
    mediaType: "image",
    operation: "text_to_image",
    schemaOwner: "@apicity/fal/zod",
    requestSchema: flux3Text,
    taskType: "fal_flux_3_text_to_image",
    jobType: "generate_fal_flux_3_text_to_image",
    provenanceModel: "blackforestlabs/flux-3/text-to-image",
    imageSlots: null,
    textOnly: true,
    picker: pickerSchema({
      prompt: stringParam("Text prompt", flux3Text.shape.prompt),
      aspect_ratio: stringParam("Output aspect ratio", flux3Text.shape.aspect_ratio),
      resolution: stringParam("Output resolution", flux3Text.shape.resolution),
      output_format: stringParam("Output format", flux3Text.shape.output_format),
    }, ["prompt"]),
    toolShape: {
      book_id: bookIdField(),
      prompt: promptZod(1, "Text prompt"),
      aspect_ratio: optionalString("Output aspect ratio"),
      resolution: optionalString("Output resolution"),
      output_format: optionalString("Output format"),
    },
    videoParams: [],
    videoZod: {},
    videoImageField: null,
    build: (args) => {
      const payload: Record<string, unknown> = { prompt: text(args.prompt) ?? "" };
      copyText(payload, "aspect_ratio", args.aspect_ratio);
      copyText(payload, "resolution", args.resolution);
      copyText(payload, "output_format", args.output_format);
      return payload;
    },
  },
  {
    canonicalName: "generate_fal_flux_3_edit_image",
    provider: "fal",
    endpointId: falEndpoint("blackforestlabs/flux-3/edit-image"),
    releaseName: "fal FLUX 3 image editing",
    label: "fal FLUX 3 image editing",
    description: "Edit 1-10 images with FLUX 3 on fal",
    listingKey: "flux_3_edit",
    mediaType: "image",
    operation: "edit_image",
    schemaOwner: "@apicity/fal/zod",
    requestSchema: flux3Edit,
    taskType: "fal_flux_3_edit",
    jobType: "generate_fal_flux_3_edit_image",
    provenanceModel: "blackforestlabs/flux-3/edit-image",
    imageSlots: TEN_IMAGES,
    textOnly: false,
    picker: pickerSchema({
      prompt: stringParam("Edit instruction", flux3Edit.shape.prompt),
      image_refs: imageRefsParam("Images to edit", TEN_IMAGES),
      aspect_ratio: stringParam("Output aspect ratio", flux3Edit.shape.aspect_ratio),
      resolution: stringParam("Output resolution", flux3Edit.shape.resolution),
      output_format: stringParam("Output format", flux3Edit.shape.output_format),
    }, ["prompt", "image_refs"]),
    toolShape: {
      book_id: bookIdField(),
      prompt: promptZod(1, "Edit instruction"),
      image_refs: imageRefsZod(TEN_IMAGES, "Images to edit"),
      aspect_ratio: optionalString("Output aspect ratio"),
      resolution: optionalString("Output resolution"),
      output_format: optionalString("Output format"),
    },
    videoParams: [],
    videoZod: {},
    videoImageField: null,
    build: (args) => {
      const payload: Record<string, unknown> = {
        prompt: text(args.prompt) ?? "",
        image_urls: strings(args.image_refs),
      };
      copyText(payload, "aspect_ratio", args.aspect_ratio);
      copyText(payload, "resolution", args.resolution);
      copyText(payload, "output_format", args.output_format);
      return payload;
    },
  },
  {
    canonicalName: "generate_kie_seedream_v5_flash_text_to_image",
    provider: "kie",
    endpointId: "seedream/5-flash-text-to-image",
    releaseName: "kie Seedream 5 Flash text-to-image",
    label: "kie Seedream 5 Flash text-to-image",
    description: "Text-to-image with ByteDance Seedream 5 Flash on kie",
    listingKey: "seedream_v5_flash_kie_text",
    mediaType: "image",
    operation: "text_to_image",
    schemaOwner: "@apicity/kie/zod",
    requestSchema: kieFlashText,
    taskType: "kie_seedream_v5_flash_text_to_image",
    jobType: "generate_kie_seedream_v5_flash_text_to_image",
    provenanceModel: "seedream/5-flash-text-to-image",
    imageSlots: null,
    textOnly: true,
    picker: pickerSchema({}, []),
    toolShape: {
      book_id: bookIdField(),
      prompt: promptZod(3, "Text prompt"),
      aspect_ratio: optionalString("Output aspect ratio"),
      size: optionalString("Output size"),
      output_format: optionalString("Output format"),
      nsfw_checker: z.boolean().optional().describe("Content safety filter"),
    },
    videoParams: [],
    videoZod: {},
    videoImageField: null,
    build: (args) => kieFlashPayload("seedream/5-flash-text-to-image", args, "none"),
  },
  {
    canonicalName: "generate_kie_seedream_v5_flash_image_to_image",
    provider: "kie",
    endpointId: "seedream/5-flash-image-to-image",
    releaseName: "kie Seedream 5 Flash image-to-image",
    label: "kie Seedream 5 Flash image-to-image",
    description: "Edit 1-10 images with ByteDance Seedream 5 Flash on kie",
    listingKey: "seedream_v5_flash_kie_edit",
    mediaType: "image",
    operation: "image_to_image",
    schemaOwner: "@apicity/kie/zod",
    requestSchema: kieFlashEdit,
    taskType: "kie_seedream_v5_flash_image_to_image",
    jobType: "generate_kie_seedream_v5_flash_image_to_image",
    provenanceModel: "seedream/5-flash-image-to-image",
    imageSlots: TEN_IMAGES,
    textOnly: false,
    picker: pickerSchema({}, []),
    toolShape: {
      book_id: bookIdField(),
      prompt: promptZod(3, "Edit instruction"),
      image_refs: imageRefsZod(TEN_IMAGES, "Images to edit"),
      aspect_ratio: optionalString("Output aspect ratio"),
      size: optionalString("Output size"),
      output_format: optionalString("Output format"),
      nsfw_checker: z.boolean().optional().describe("Content safety filter"),
    },
    videoParams: [],
    videoZod: {},
    videoImageField: null,
    build: (args) => kieFlashPayload("seedream/5-flash-image-to-image", args, "urls"),
  },
  {
    canonicalName: "generate_kie_seedream_v5_flash_layer_decomposition",
    provider: "kie",
    endpointId: "seedream/5-flash-layer-decomposition",
    releaseName: "kie Seedream 5 Flash layer decomposition",
    label: "kie Seedream 5 Flash layer decomposition",
    description: "Decompose one image into layers with ByteDance Seedream 5 Flash on kie",
    listingKey: "seedream_v5_flash_kie_layers",
    mediaType: "image",
    operation: "layer_decomposition",
    schemaOwner: "@apicity/kie/zod",
    requestSchema: kieFlashLayers,
    taskType: "kie_seedream_v5_flash_layer_decomposition",
    jobType: "generate_kie_seedream_v5_flash_layer_decomposition",
    provenanceModel: "seedream/5-flash-layer-decomposition",
    imageSlots: ONE_IMAGE,
    textOnly: false,
    picker: pickerSchema({}, []),
    toolShape: {
      book_id: bookIdField(),
      prompt: z.string().min(3).optional().describe("Layer instruction"),
      image_refs: imageRefsZod(ONE_IMAGE, "Image to decompose"),
      size: optionalString("Output size"),
      output_format: optionalString("Output format"),
      nsfw_checker: z.boolean().optional().describe("Content safety filter"),
    },
    videoParams: [],
    videoZod: {},
    videoImageField: null,
    build: (args) => kieFlashPayload("seedream/5-flash-layer-decomposition", args, "url"),
  },
  {
    canonicalName: "generate_fal_minimax_h3_max_insert_video",
    provider: "fal",
    endpointId: falEndpoint("minimax/h3-max/insert-video"),
    releaseName: "fal MiniMax H3 Max insert-video",
    label: "fal MiniMax H3 Max insert-video",
    description: "Insert a generated span into a source video with MiniMax H3 Max on fal",
    listingKey: "h3_max_insert",
    mediaType: "video",
    operation: "insert_video",
    schemaOwner: "@apicity/fal/zod",
    requestSchema: h3Insert,
    taskType: "fal_minimax_h3_max_insert_video",
    jobType: "generate_fal_minimax_h3_max_insert_video",
    provenanceModel: "minimax/h3-max/insert-video",
    imageSlots: null,
    textOnly: false,
    picker: pickerSchema({}, []),
    toolShape: {
      book_id: bookIdField(),
      prompt: optionalString("Insert instruction"),
      video_ref: z.string().min(1).describe("Source video"),
      image_refs: z.array(z.string()).optional().describe("Optional reference images"),
      video_refs: z.array(z.string()).optional().describe("Optional reference videos"),
      start_time: h3Insert.shape.start_time.describe(
        "Seconds into the source video where the generated insert starts (1.625–60)",
      ),
      resume_time: h3Insert.shape.resume_time.describe(
        "Seconds into the source video where the original footage resumes (greater than 1.625, at most 60)",
      ),
      duration: optionalNumber("Generated span duration in seconds"),
      resolution: optionalString("Output resolution"),
    },
    videoParams: ["prompt", "video_ref", "image_refs", "video_refs", "start_time", "resume_time", "duration", "resolution"],
    videoZod: {
      prompt: h3Insert.shape.prompt,
      video_ref: h3Insert.shape.video_url,
      image_refs: h3Insert.shape.reference_image_urls,
      video_refs: h3Insert.shape.reference_video_urls,
      start_time: h3Insert.shape.start_time,
      resume_time: h3Insert.shape.resume_time,
      duration: h3Insert.shape.duration,
      resolution: h3Insert.shape.resolution,
    },
    videoImageField: h3Insert.shape.reference_image_urls,
    build: (args) => {
      const startTime = finiteNumber(args.start_time);
      const resumeTime = finiteNumber(args.resume_time);
      const payload: Record<string, unknown> = {
        video_url: text(args.video_ref) ?? "",
        ...(startTime !== undefined ? { start_time: startTime } : {}),
        ...(resumeTime !== undefined ? { resume_time: resumeTime } : {}),
      };
      copyText(payload, "prompt", args.prompt);
      const images = strings(args.image_refs);
      const videos = strings(args.video_refs);
      if (images.length > 0) payload.reference_image_urls = images;
      if (videos.length > 0) payload.reference_video_urls = videos;
      copyNumber(payload, "duration", args.duration);
      copyText(payload, "resolution", args.resolution);
      return payload;
    },
  },
  {
    canonicalName: "generate_fal_grok_imagine_video_v1_5_lite_image_to_video",
    provider: "fal",
    endpointId: falEndpoint("xai/grok-imagine-video/v1.5/lite/image-to-video"),
    releaseName: "fal Grok 1.5 Lite image-to-video",
    label: "fal Grok 1.5 Lite image-to-video",
    description: "Animate one image with Grok Imagine Video 1.5 Lite on fal",
    listingKey: "grok_1_5_lite_i2v",
    mediaType: "video",
    operation: "image_to_video",
    schemaOwner: "@apicity/fal/zod",
    requestSchema: grokLiteI2v,
    taskType: "fal_grok_imagine_video_v15_lite_image_to_video",
    jobType: "generate_fal_grok_imagine_video_v1_5_lite_image_to_video",
    provenanceModel: "xai/grok-imagine-video/v1.5/lite/image-to-video",
    imageSlots: ONE_IMAGE,
    textOnly: false,
    picker: pickerSchema({}, []),
    toolShape: {
      book_id: bookIdField(),
      prompt: promptZod(1, "Motion prompt"),
      image_refs: imageRefsZod(ONE_IMAGE, "Start image"),
      duration: optionalNumber("Duration in seconds"),
      resolution: optionalString("Output resolution"),
    },
    videoParams: ["prompt", "image_refs", "duration", "resolution"],
    videoZod: {
      prompt: grokLiteI2v.shape.prompt,
      image_refs: z.array(z.string()).min(1).max(1),
      duration: grokLiteI2v.shape.duration,
      resolution: grokLiteI2v.shape.resolution,
    },
    videoImageField: z.array(z.string()).min(1).max(1),
    build: (args) => {
      const payload: Record<string, unknown> = {
        prompt: text(args.prompt) ?? "",
        image_url: strings(args.image_refs)[0] ?? "",
      };
      copyNumber(payload, "duration", args.duration);
      copyText(payload, "resolution", args.resolution);
      return payload;
    },
  },
  {
    canonicalName: "generate_fal_minimax_h3_max_recast",
    provider: "fal",
    endpointId: falEndpoint("minimax/h3-max/recast"),
    releaseName: "fal MiniMax H3 Max Recast",
    label: "fal MiniMax H3 Max Recast",
    description: "Recast a source video using 1-4 reference images with MiniMax H3 Max on fal",
    listingKey: "h3_max_recast",
    mediaType: "video",
    operation: "recast_video",
    schemaOwner: "@apicity/fal/zod",
    requestSchema: h3Recast,
    taskType: "fal_minimax_h3_max_recast",
    jobType: "generate_fal_minimax_h3_max_recast",
    provenanceModel: "minimax/h3-max/recast",
    imageSlots: RECAST_IMAGES,
    textOnly: false,
    picker: pickerSchema({}, []),
    toolShape: {
      book_id: bookIdField(),
      prompt: optionalString("Recast instruction"),
      video_ref: z.string().min(1).describe("Source video"),
      image_refs: imageRefsZod(RECAST_IMAGES, "Reference images"),
      resolution: optionalString("Output resolution"),
    },
    videoParams: ["prompt", "video_ref", "image_refs", "resolution"],
    videoZod: {
      prompt: h3Recast.shape.prompt,
      video_ref: h3Recast.shape.video_url,
      image_refs: h3Recast.shape.reference_image_urls,
      resolution: h3Recast.shape.resolution,
    },
    videoImageField: h3Recast.shape.reference_image_urls,
    build: (args) => {
      const payload: Record<string, unknown> = {
        video_url: text(args.video_ref) ?? "",
        reference_image_urls: strings(args.image_refs),
      };
      copyText(payload, "prompt", args.prompt);
      copyText(payload, "resolution", args.resolution);
      return payload;
    },
  },
  {
    canonicalName: "generate_fal_grok_imagine_video_v1_5_lite_text_to_video",
    provider: "fal",
    endpointId: falEndpoint("xai/grok-imagine-video/v1.5/lite/text-to-video"),
    releaseName: "fal Grok 1.5 Lite text-to-video",
    label: "fal Grok 1.5 Lite text-to-video",
    description: "Text-to-video with Grok Imagine Video 1.5 Lite on fal",
    listingKey: "grok_1_5_lite_t2v",
    mediaType: "video",
    operation: "text_to_video",
    schemaOwner: "@apicity/fal/zod",
    requestSchema: grokLiteT2v,
    taskType: "fal_grok_imagine_video_v15_lite_text_to_video",
    jobType: "generate_fal_grok_imagine_video_v1_5_lite_text_to_video",
    provenanceModel: "xai/grok-imagine-video/v1.5/lite/text-to-video",
    imageSlots: null,
    textOnly: true,
    picker: pickerSchema({}, []),
    toolShape: {
      book_id: bookIdField(),
      prompt: promptZod(1, "Text prompt"),
      duration: optionalNumber("Duration in seconds"),
      resolution: optionalString("Output resolution"),
      aspect_ratio: optionalString("Output aspect ratio"),
    },
    videoParams: ["prompt", "duration", "resolution", "aspect_ratio"],
    videoZod: {
      prompt: grokLiteT2v.shape.prompt,
      duration: grokLiteT2v.shape.duration,
      resolution: grokLiteT2v.shape.resolution,
      aspect_ratio: grokLiteT2v.shape.aspect_ratio,
    },
    videoImageField: null,
    build: (args) => {
      const payload: Record<string, unknown> = { prompt: text(args.prompt) ?? "" };
      copyNumber(payload, "duration", args.duration);
      copyText(payload, "resolution", args.resolution);
      copyText(payload, "aspect_ratio", args.aspect_ratio);
      return payload;
    },
  },
  {
    canonicalName: "extend_fal_minimax_h3_max_turbo_video",
    provider: "fal",
    endpointId: falEndpoint("minimax/h3-max-turbo/extend-video"),
    releaseName: "fal H3 Max Turbo video extension",
    label: "fal H3 Max Turbo video extension",
    description: "Extend a source video with MiniMax H3 Max Turbo on fal",
    listingKey: "h3_max_turbo_extend",
    mediaType: "video",
    operation: "extend_video",
    schemaOwner: "@apicity/fal/zod",
    requestSchema: h3Extend,
    taskType: "fal_minimax_h3_max_turbo_extend_video",
    jobType: "extend_fal_minimax_h3_max_turbo_video",
    provenanceModel: "minimax/h3-max-turbo/extend-video",
    imageSlots: null,
    textOnly: false,
    picker: pickerSchema({}, []),
    toolShape: {
      book_id: bookIdField(),
      prompt: promptZod(1, "Continuation prompt"),
      video_ref: z.string().min(1).describe("Source video to extend"),
      aspect_ratio: optionalString("Output aspect ratio"),
      resolution: optionalString("Output resolution"),
      duration: optionalNumber("Extension duration in seconds"),
    },
    videoParams: ["prompt", "video_ref", "aspect_ratio", "resolution", "duration"],
    videoZod: {
      prompt: h3Extend.shape.prompt,
      video_ref: h3Extend.shape.video_url,
      aspect_ratio: h3Extend.shape.aspect_ratio,
      resolution: h3Extend.shape.resolution,
      duration: h3Extend.shape.duration,
    },
    videoImageField: null,
    build: (args) => {
      const payload: Record<string, unknown> = {
        video_url: text(args.video_ref) ?? "",
        prompt: text(args.prompt) ?? "",
      };
      copyText(payload, "aspect_ratio", args.aspect_ratio);
      copyText(payload, "resolution", args.resolution);
      copyNumber(payload, "duration", args.duration);
      return payload;
    },
  },
];

const ACTIONS_BY_NAME = new Map(ACTIONS.map((action) => [action.canonicalName, action]));

export function apicity014Action(toolName: string): Apicity014Action | undefined {
  return ACTIONS_BY_NAME.get(toolName);
}

export function apicity014Actions(): readonly Apicity014Action[] {
  return ACTIONS;
}

const KIE_SCHEMA_NAMES: Record<string, string> = {
  generate_kie_vidu_q4_image_to_video: "ViduQ4ImageToVideoRequestSchema",
  generate_kie_vidu_q4_reference_to_video: "ViduQ4ReferenceToVideoRequestSchema",
  [NANO_BANANA_2_1_TOOL]: "NanoBanana21RequestSchema",
  generate_kie_seedream_v5_flash_text_to_image: "SeedreamFlashTextToImageRequestSchema",
  generate_kie_seedream_v5_flash_image_to_image: "SeedreamFlashImageToImageRequestSchema",
  generate_kie_seedream_v5_flash_layer_decomposition: "SeedreamFlashLayerDecompositionRequestSchema",
};

export const APICITY_014_GENERATION_ACTIONS: GenerationActionSpec[] = ACTIONS.map((action) => ({
  canonical_name: action.canonicalName,
  provider: action.provider,
  apicity_identifier: KIE_SCHEMA_NAMES[action.canonicalName] ?? action.endpointId,
  media_type: action.mediaType,
  operation: action.operation,
  picker_visibility: "visible",
  legacy_names: [],
  schema_owner: action.schemaOwner,
  job_task_discriminator: action.provider === "fal" ? "fal_gen" : `${action.taskType}_gen`,
  persisted_history_consumers: historyConsumers(),
}));

export type Apicity014ImageConfig = {
  key: string;
  kieModelId?: "seedream/5-flash-text-to-image" | "seedream/5-flash-image-to-image" | "seedream/5-flash-layer-decomposition" | "nano-banana-2-1";
  tool_name: string;
  label: string;
  description: string;
  imageFieldSchema: ZodLike | null;
  kieImageField?: string;
  falToolNames?: { noRefs?: string; withRefs?: string };
};

function imageArraySchema(slots: ImageSlots): ZodLike {
  let schema = z.array(z.string()).min(slots.min);
  if (slots.max !== null) schema = schema.max(slots.max);
  return schema;
}

export const APICITY_014_IMAGE_CONFIGS: Apicity014ImageConfig[] = ACTIONS
  .filter((action) => action.mediaType === "image")
  .map((action) => ({
    key: action.listingKey,
    tool_name: action.canonicalName,
    label: action.label,
    description: action.description,
    imageFieldSchema: action.imageSlots ? imageArraySchema(action.imageSlots) : null,
    ...(action.provider === "kie" ? {
      kieModelId: action.endpointId as Apicity014ImageConfig["kieModelId"],
      ...(action.imageSlots ? { kieImageField: action.canonicalName === NANO_BANANA_2_1_TOOL ? "image_input" : action.canonicalName.endsWith("layer_decomposition") ? "image_url" : "image_urls" } : {}),
    } : {
      falToolNames: action.textOnly
        ? { noRefs: action.canonicalName }
        : { withRefs: action.canonicalName },
    }),
  }));

export function apicity014FalImagePickerSchema(toolName: string): Apicity014PickerSchema | null {
  const action = ACTIONS_BY_NAME.get(toolName);
  if (!action || action.mediaType !== "image" || action.provider !== "fal") return null;
  return action.picker;
}

export type Apicity014VideoModel = {
  label: string;
  tool_name: string;
  description: string;
  params: string[];
  defaults: Record<string, unknown>;
  providers: Array<{ key: string; label: string; provider_path: string; envKey: string }>;
  falToolNames?: { noRefs?: string; withRefs?: string };
};

export const APICITY_014_VIDEO_MODELS: Record<string, Apicity014VideoModel> = Object.fromEntries(
  ACTIONS.filter((action) => action.mediaType === "video").map((action) => [
    action.listingKey,
    {
      label: action.label,
      tool_name: action.canonicalName,
      description: action.description,
      params: action.videoParams,
      defaults: {},
      providers: action.provider === "kie"
        ? [{ key: "kie", label: "Kie", provider_path: KIE_PATH, envKey: "KIE_API_KEY" }]
        : [],
      ...(action.provider === "fal" ? {
        falToolNames: action.textOnly
          ? { noRefs: action.canonicalName }
          : { withRefs: action.canonicalName },
      } : {}),
    },
  ]),
);

export const APICITY_014_VIDEO_PARAM_ZOD: Record<string, Record<string, ZodLike>> = Object.fromEntries(
  ACTIONS.filter((action) => action.mediaType === "video").map((action) => [action.canonicalName, action.videoZod]),
);

export const APICITY_014_VIDEO_IMAGE_FIELDS: Record<string, ZodLike> = Object.fromEntries(
  ACTIONS
    .filter((action) => action.mediaType === "video" && action.videoImageField)
    .map((action) => [action.canonicalName, action.videoImageField as ZodLike]),
);

export function buildApicity014Payload(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  const action = ACTIONS_BY_NAME.get(toolName);
  if (!action) return null;
  return action.build(args);
}

export function buildApicity014TranslateResult(
  toolName: string,
  args: Record<string, unknown>,
): { provider_path: string; payload: Record<string, unknown> } | null {
  const action = ACTIONS_BY_NAME.get(toolName);
  const payload = buildApicity014Payload(toolName, args);
  if (!action || !payload) return null;
  return {
    provider_path: action.provider === "fal" ? FAL_PATH : KIE_PATH,
    payload,
  };
}

export function apicity014ToolShape(toolName: string): ZodRawShape | null {
  return ACTIONS_BY_NAME.get(toolName)?.toolShape ?? null;
}

export const APICITY_014_IMAGE_TASK_TYPES: string[] = ACTIONS
  .filter((action) => action.mediaType === "image")
  .map((action) => action.taskType);

export const APICITY_014_VIDEO_TASK_TYPES: string[] = ACTIONS
  .filter((action) => action.mediaType === "video")
  .map((action) => action.taskType);

export type { Apicity014Action };
