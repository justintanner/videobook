import { draftLanguages, readCaptionDraft } from "../captions/drafts.js";
import { latestStackedCaptionRender, requestCaptionRender } from "../captions/render.js";
import { CaptionServiceError } from "../captions/service.js";
import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { BookManager } from "../book-manager.js";
import type { GraphicsEdit } from "../graphics/edits.js";
import type { GraphicsRect } from "../graphics/layout.js";
import { GraphicsServiceError } from "../graphics/errors.js";
import {
  GRAPHICS_ACCENTS,
  GRAPHICS_ALIGNS,
  GRAPHICS_ANCHORS,
  GRAPHICS_CASES,
  GRAPHICS_FONT_PRESETS,
  GRAPHICS_ICONS,
  GRAPHICS_MOTIONS,
  GRAPHICS_QR_LEVELS,
  GRAPHICS_QR_SLOTS,
  GRAPHICS_QR_STYLES,
  GRAPHICS_SCRIM_EDGES,
  GRAPHICS_SPACES,
  GRAPHICS_TEXT_SLOTS,
  MAX_GRAPHICS_TEXT_LENGTH,
} from "../graphics/model.js";
import type { GraphicsPlacementInput } from "../graphics/regions.js";
import { checkGraphicsPlacement, detectGraphicsRegions } from "../graphics/regions.js";
import { graphicsBurned, latestGraphicsRender, requestGraphicsRender } from "../graphics/render.js";
import type { GraphicsLook } from "../graphics/service.js";
import { graphicsForTemplate, readGraphics, rememberWatermarkSlots, updateGraphics } from "../graphics/service.js";
import type { GraphicsSuggestKind, GraphicsSuggestLanguage } from "../graphics/slots.js";
import { GRAPHICS_SUGGEST_KINDS, GRAPHICS_SUGGEST_LANGUAGES } from "../graphics/slots.js";
import { requestGraphicsSuggestions } from "../graphics/suggest.js";
import { DEFAULT_GRAPHICS_STARTER_ID } from "../graphics/starters.js";
import type { GraphicsTemplate } from "../graphics/templates.js";
import {
  copyGraphicsTemplates,
  deleteGraphicsTemplate,
  readGraphicsTemplates,
  renameGraphicsTemplate,
  saveGraphicsTemplate,
  saveWatermarkGraphicsTemplate,
  setDefaultGraphicsTemplate,
  setWatermarkGraphicsTemplate,
} from "../graphics/templates.js";
import type { RenderOutput } from "../render-requests.js";
import { RENDER_OUTPUTS } from "../render-requests.js";
import type { WatermarkPlatform } from "../watermark-platform.js";
import { WATERMARK_PLATFORMS } from "../watermark-platform.js";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { advertisedAs } from "./tool-json-schema.js";
import { resolveVideoAssetReference } from "./video-source-reference.js";

const seconds = z.number().nullable();
const rect = z.object({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() }).strict();

const positionPatch = z.object({
  anchor: z.enum(GRAPHICS_ANCHORS),
  x: z.number(),
  y: z.number(),
  space: z.enum(GRAPHICS_SPACES),
}).partial().strict();

const timingPatch = z.object({ start: seconds, end: seconds, tail: seconds, fade: z.number(), enter: z.enum(GRAPHICS_MOTIONS), exit: z.enum(GRAPHICS_MOTIONS) }).partial().strict();

const platePatch = z.object({
  color: z.string(),
  opacity: z.number(),
  paddingX: z.number(),
  paddingY: z.number(),
  radius: z.number(),
  border: z.boolean(),
}).partial().strict();

const itemPatch = z.object({
  text: z.string(),
  slot: z.enum(GRAPHICS_TEXT_SLOTS).nullable(),
  font: z.enum(GRAPHICS_FONT_PRESETS),
  size: z.number(),
  color: z.string(),
  case: z.enum(GRAPHICS_CASES),
  maxLines: z.number(),
  icon: z.enum(GRAPHICS_ICONS).nullable(),
  accent: z.enum(GRAPHICS_ACCENTS),
  outline: z.boolean(),
  shadow: z.boolean(),
}).partial().strict();

const layerPatch = z.object({ name: z.string(), visible: z.boolean(), opacity: z.number() }).partial().strict();
const blockPatch = z.object({ width: z.number(), align: z.enum(GRAPHICS_ALIGNS), gap: z.number(), plate: platePatch.nullable() }).partial().strict();
const imagePatch = z.object({ artifactId: z.string(), size: z.number() }).partial().strict();

const qrPatch = z.object({
  url: z.string(),
  slot: z.enum(GRAPHICS_QR_SLOTS).nullable(),
  size: z.number(),
  style: z.enum(GRAPHICS_QR_STYLES),
  dark: z.string(),
  light: z.string(),
  level: z.enum(GRAPHICS_QR_LEVELS),
}).partial().strict();

const scrimPatch = z.object({ edge: z.enum(GRAPHICS_SCRIM_EDGES), height: z.number(), color: z.string(), strength: z.number() }).partial().strict();

const commonLayer = { ...layerPatch.shape, timing: timingPatch.optional() };
const placed = { position: positionPatch.optional() };

const layerInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), ...commonLayer, ...placed, ...blockPatch.shape, items: z.array(itemPatch).optional() }).strict(),
  z.object({ kind: z.literal("image"), ...commonLayer, ...placed, artifactId: z.string().min(1), size: z.number().optional() }).strict(),
  z.object({ kind: z.literal("qr"), ...commonLayer, ...placed, ...qrPatch.shape }).strict(),
  z.object({ kind: z.literal("scrim"), ...commonLayer, ...scrimPatch.shape }).strict(),
]);

const layerId = z.string().describe("Layer id such as l2");
const itemId = z.string().describe("Text item id such as t3");

const editSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_layer"), layer: layerInput, index: z.number().optional() }).strict(),
  z.object({ op: z.literal("remove_layer"), layer_id: layerId }).strict(),
  z.object({ op: z.literal("duplicate_layer"), layer_id: layerId }).strict(),
  z.object({ op: z.literal("move_layer"), layer_id: layerId, index: z.number() }).strict(),
  z.object({ op: z.literal("set_layer"), layer_id: layerId, layer: layerPatch }).strict(),
  z.object({ op: z.literal("set_position"), layer_id: layerId, position: positionPatch }).strict(),
  z.object({ op: z.literal("set_timing"), layer_id: layerId, timing: timingPatch }).strict(),
  z.object({ op: z.literal("set_text_block"), layer_id: layerId, block: blockPatch }).strict(),
  z.object({ op: z.literal("add_item"), layer_id: layerId, item: itemPatch.optional(), index: z.number().optional() }).strict(),
  z.object({ op: z.literal("remove_item"), layer_id: layerId, item_id: itemId }).strict(),
  z.object({ op: z.literal("move_item"), layer_id: layerId, item_id: itemId, index: z.number() }).strict(),
  z.object({ op: z.literal("set_item"), layer_id: layerId, item_id: itemId, item: itemPatch }).strict(),
  z.object({ op: z.literal("set_image"), layer_id: layerId, image: imagePatch }).strict(),
  z.object({ op: z.literal("set_qr"), layer_id: layerId, qr: qrPatch }).strict(),
  z.object({ op: z.literal("set_scrim"), layer_id: layerId, scrim: scrimPatch }).strict(),
  z.object({ op: z.literal("set_slot_text"), slot: z.enum([...GRAPHICS_TEXT_SLOTS, ...GRAPHICS_QR_SLOTS]), text: z.string() }).strict(),
  z.object({
    op: z.literal("apply_template"),
    template: advertisedAs(z.unknown(), { type: "object", description: "A graphics document, such as one of the starters from get; typed slot text is kept" }),
  }).strict(),
]);

const VIDEO_OPS = ["get", "update", "render", "suggest", "check_placement", "detect_regions"] as const;
const TEMPLATE_OPS = ["save_template", "rename_template", "delete_template", "set_default_template", "copy_templates", "save_watermark", "set_watermark_template"] as const;

type VideoOp = typeof VIDEO_OPS[number];
type TemplateOp = typeof TEMPLATE_OPS[number];

const schema = {
  book_id: z.string().describe("Book id"),
  asset_id: z.string().min(1).optional()
    .describe("Video artifact UUID or notebook address such as @a1. Required for get, update, render, suggest, check_placement, detect_regions, save_template and save_watermark"),
  notebook_id: z.string().uuid().optional().describe("Notebook that resolves an @address and reports the video's cell address"),
  op: z.enum([...VIDEO_OPS, ...TEMPLATE_OPS]).optional()
    .describe("get (default) reads the saved graphics, or the book's default look for a video without any, with fill values, starters, the book's saved templates, the latest render and any graphics already burned in, and never writes; update saves edits or a replacement document against expected_revision; render queues the graphics of exactly that revision as a background job and returns at once; suggest calls a paid language model once and returns 3 to 5 options for the operator to pick from without saving anything: kind headline writes headlines from the video's existing analysis, transcript and download title and description (it never starts transcription or analysis, and answers no_context when the video has none of them), kind translate translates the headline for the second line under it; check_placement answers for free, from faces and on-screen text already found in the video, whether layer_id's drawn box covers one during the layer's time window and, when every frame of that window was already checked, the clearest of the nine anchor spots (it never calls a model and never moves the layer); detect_regions first finds faces and on-screen text in the window's unchecked frames with a paid vision model call (none when all were checked), then answers as check_placement does and returns the found regions; save_template saves the video's current graphics as a named template of this book (slot text such as the headline is left empty), or over template_id; rename_template and delete_template change a saved template; set_default_template makes template_id (a saved template or a starter) the look a video without graphics starts from, or restores the built-in default with null; copy_templates copies from_book's saved templates into this book together with the images their layers use, skipping names already taken here; save_watermark saves the video's current graphics, read in watermark mode, as the platform's watermark template that apply_watermark and goal finishing burn (over the current one, named after the platform unless name is given; slot text such as the title is left empty) and remembers the handle and QR link drawn there; set_watermark_template makes template_id (a saved template) the platform's watermark template, or null goes back to the watermark profile's look"),
  platform: z.enum(WATERMARK_PLATFORMS).optional()
    .describe("Watermark profile whose handle and profile URL fill the handle and QR slots of the default look and starters, and the watermark that watermark mode works with (default tiktok)"),
  watermark: z.boolean().optional()
    .describe("Watermark mode, for editing the platform's watermark: get, update, render and save_template start a video without saved graphics from what apply_watermark burns with no options, the platform's saved watermark template or else the watermark profile's look (for TikTok the handle, an empty Thai title and an English line, no QR code); get also returns watermark with that look, the saved watermark template and the profile's QR layer; render draws a shade only while title text is drawn, as apply_watermark does"),
  kind: z.enum(GRAPHICS_SUGGEST_KINDS).optional()
    .describe("suggest: headline (default) for options for the big title, or translate for translations of the headline for the second line"),
  language: z.enum(GRAPHICS_SUGGEST_LANGUAGES).optional()
    .describe("suggest: the language of the options, th (Thai) or en (English). Headlines default to Thai; a translation defaults to English, or Thai when the headline has no Thai text"),
  text: z.string().max(MAX_GRAPHICS_TEXT_LENGTH).optional()
    .describe("suggest with kind translate: the headline to translate (default the headline in the saved graphics)"),
  layer_id: z.string().optional().describe("check_placement and detect_regions: the layer, as saved, whose spot is checked"),
  box: rect.optional().describe("check_placement (required) and detect_regions: the layer's drawn box in frame pixels, as laid out by the editor"),
  block: rect.optional().describe("check_placement and detect_regions: the layer's whole block box in frame pixels when it is larger than the drawn box (default box)"),
  avoid: z.array(rect).max(50).optional().describe("check_placement and detect_regions: drawn boxes of other layers shown at the same time, which the clearest spot keeps off"),
  expected_revision: z.string().optional().describe("update and render: the revision from get that these changes apply to or that was reviewed"),
  source_hash: z.string().optional().describe("render: source.source_hash from the get that was reviewed"),
  request_id: z.string().uuid().optional().describe("render: stable request UUID; reuse it when retrying the same render"),
  with_subtitles: z.string().regex(/^(original|[a-z]{2})$/u).optional().describe("render: include the saved subtitle draft in this language in one encode, using its aspect and background"),
  subtitles_revision: z.string().optional().describe("render with_subtitles: reviewed revision from subtitles in get"),
  output: z.enum(RENDER_OUTPUTS).optional()
    .describe("render: new (default) writes a copy with the graphics into a new video cell below the source, a version of the earlier copy when one exists; replace burns the graphics into the source video itself, keeping its earlier version in history, and clears the saved graphics"),
  edits: z.array(editSchema).max(200).optional()
    .describe("update: edits applied in order. Sizes, gaps and paddings are fractions of the frame's short side, text width a fraction of the positioning space, positions 0..1 inside the space, times in seconds"),
  document: advertisedAs(z.unknown(), {
    type: "object",
    description: "update: a full replacement document (version, layers, nextId) in the shape get returns",
  }).optional(),
  template_id: z.string().min(1).nullable().optional()
    .describe("save_template: a saved template to save over; rename_template and delete_template: the template to change; set_default_template: a saved template or starter id, or null for the built-in default; set_watermark_template: a saved template, or null for the watermark profile's look"),
  name: z.string().optional().describe("save_template, save_watermark and rename_template: the template's name"),
  from_book: z.string().min(1).optional().describe("copy_templates: the book id or name to copy saved templates from"),
  template_ids: z.array(z.string().min(1)).max(50).optional().describe("copy_templates: only these templates of from_book (default all)"),
};

type VideoGraphicsArgs = {
  book_id: string;
  asset_id?: string;
  notebook_id?: string;
  op?: VideoOp | TemplateOp;
  platform?: WatermarkPlatform;
  watermark?: boolean;
  kind?: GraphicsSuggestKind;
  language?: GraphicsSuggestLanguage;
  text?: string;
  layer_id?: string;
  box?: GraphicsRect;
  block?: GraphicsRect;
  avoid?: GraphicsRect[];
  expected_revision?: string;
  source_hash?: string;
  request_id?: string;
  output?: RenderOutput;
  with_subtitles?: string;
  subtitles_revision?: string;
  edits?: GraphicsEdit[];
  document?: unknown;
  template_id?: string | null;
  name?: string;
  from_book?: string;
  template_ids?: string[];
};

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(error: unknown): ToolResult {
  if (error instanceof CaptionServiceError) return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: error.code === "conflict" ? "invalid" : error.code, message: error.message }) }] };
  const body = error instanceof GraphicsServiceError
    ? { status: error.code, message: error.message, ...error.details }
    : { status: "error", message: error instanceof Error ? error.message : String(error) };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] };
}

async function update(engine: Engine, args: VideoGraphicsArgs, artifactId: string, look: GraphicsLook) {
  if (!args.expected_revision) throw new GraphicsServiceError("invalid", "update needs expected_revision from get.");
  if ((args.edits === undefined) === (args.document === undefined)) {
    throw new GraphicsServiceError("invalid", "update takes exactly one of edits or document.");
  }
  const draft = await updateGraphics(engine, artifactId, {
    expectedRevision: args.expected_revision,
    look,
    ...(args.edits ? { edits: args.edits } : { document: args.document }),
  });
  return { asset_id: artifactId, status: "saved", saved: true, revision: draft.revision, updated_at: draft.updatedAt, document: draft.document };
}

async function render(engine: Engine, args: VideoGraphicsArgs, artifactId: string, look: GraphicsLook) {
  if (!args.expected_revision || !args.source_hash || !args.request_id) {
    throw new GraphicsServiceError("invalid", "render needs expected_revision, source_hash and request_id from the reviewed get.");
  }
  const subtitle = args.with_subtitles ? readCaptionDraft(engine, artifactId, args.with_subtitles) : null;
  if (args.with_subtitles && !subtitle) throw new GraphicsServiceError("not_ready", "Save a subtitle draft in this language before rendering with subtitles.");
  const status = args.with_subtitles && subtitle
    ? await requestCaptionRender(engine, args.book_id, artifactId, args.with_subtitles, {
      requestId: args.request_id,
      expectedRevision: args.subtitles_revision ?? subtitle.revision,
      sourceHash: args.source_hash,
      notebookId: args.notebook_id ?? null,
      output: args.output ?? "new",
      withGraphics: true,
      graphicsRevision: args.expected_revision,
      graphicsLook: look,
    })
    : await requestGraphicsRender(engine, args.book_id, artifactId, {
        requestId: args.request_id,
        expectedRevision: args.expected_revision,
        sourceHash: args.source_hash,
        notebookId: args.notebook_id ?? null,
        output: args.output ?? "new",
        look,
      });
  return { asset_id: artifactId, job_id: status.job_id, status: status.status, output_artifact_id: status.output_asset_id, render: status };
}

function suggest(engine: Engine, args: VideoGraphicsArgs, artifactId: string) {
  return requestGraphicsSuggestions(engine, args.book_id, artifactId, {
    ...(args.kind ? { kind: args.kind } : {}),
    ...(args.language ? { language: args.language } : {}),
    ...(args.text === undefined ? {} : { text: args.text }),
  });
}

function placementInput(args: VideoGraphicsArgs, op: "check_placement" | "detect_regions"): GraphicsPlacementInput {
  if (!args.layer_id) throw new GraphicsServiceError("invalid", `${op} needs layer_id, the layer whose spot is checked.`);
  return {
    layerId: args.layer_id,
    ...(args.box ? { box: args.box } : {}),
    ...(args.block ? { block: args.block } : {}),
    ...(args.avoid ? { avoid: args.avoid } : {}),
  };
}

async function read(engine: Engine, args: VideoGraphicsArgs, artifactId: string, look: GraphicsLook) {
  const model = await readGraphics(engine, artifactId, { notebookId: args.notebook_id ?? null, look });
  const subtitles = draftLanguages(engine, artifactId).flatMap((language) => {
    const draft = readCaptionDraft(engine, artifactId, language);
    return draft ? [{ language, revision: draft.revision }] : [];
  });
  const graphicsRender = latestGraphicsRender(engine, artifactId);
  const stackedRender = latestStackedCaptionRender(engine, artifactId);
  const render = stackedRender && (!graphicsRender || (stackedRender.job_id ?? 0) > (graphicsRender.job_id ?? 0)) ? stackedRender : graphicsRender;
  return { ...model, subtitles, render, burned: await graphicsBurned(engine, artifactId) };
}

function videoArtifactId(engine: Engine, args: VideoGraphicsArgs, op: VideoOp | "save_template" | "save_watermark"): string {
  if (!args.asset_id) throw new GraphicsServiceError("invalid", `${op} needs asset_id, the video whose graphics it uses.`);
  return resolveVideoAssetReference(engine, args.asset_id, args.notebook_id);
}

function requiredTemplateId(args: VideoGraphicsArgs, op: TemplateOp): string {
  if (typeof args.template_id !== "string") throw new GraphicsServiceError("invalid", `${op} needs template_id.`);
  return args.template_id;
}

function templateList(engine: Engine) {
  const store = readGraphicsTemplates(engine);
  return {
    templates: store.templates.map((template) => ({ id: template.id, name: template.name, updated_at: template.updatedAt })),
    default_template_id: store.defaultId ?? DEFAULT_GRAPHICS_STARTER_ID,
    watermark_template_ids: store.watermark,
  };
}

function savedTemplate(template: GraphicsTemplate) {
  return { id: template.id, name: template.name, updated_at: template.updatedAt };
}

async function saveWatermark(engine: Engine, args: VideoGraphicsArgs, platform: WatermarkPlatform) {
  const document = await graphicsForTemplate(engine, videoArtifactId(engine, args, "save_watermark"), { platform, watermark: true }, args.expected_revision);
  const template = await saveWatermarkGraphicsTemplate(engine, platform, { document, ...(args.name === undefined ? {} : { name: args.name }) });
  await rememberWatermarkSlots(engine, platform, document);
  return { status: "saved", template: savedTemplate(template), watermark: { platform, template_id: template.id }, ...templateList(engine) };
}

async function saveTemplate(engine: Engine, args: VideoGraphicsArgs, look: GraphicsLook) {
  const document = await graphicsForTemplate(engine, videoArtifactId(engine, args, "save_template"), look, args.expected_revision);
  const template = await saveGraphicsTemplate(engine, {
    document,
    ...(args.name === undefined ? {} : { name: args.name }),
    ...(typeof args.template_id === "string" ? { templateId: args.template_id } : {}),
  });
  return { status: "saved", template: savedTemplate(template), ...templateList(engine) };
}

async function setWatermarkTemplate(engine: Engine, args: VideoGraphicsArgs, platform: WatermarkPlatform) {
  if (args.template_id === undefined) {
    throw new GraphicsServiceError("invalid", "set_watermark_template needs template_id: a saved template, or null for the watermark profile's look.");
  }
  const templateId = await setWatermarkGraphicsTemplate(engine, platform, args.template_id);
  return { status: "saved", watermark: { platform, template_id: templateId }, ...templateList(engine) };
}

async function setDefaultTemplate(engine: Engine, args: VideoGraphicsArgs) {
  if (args.template_id === undefined) {
    throw new GraphicsServiceError("invalid", "set_default_template needs template_id: a saved template, a starter, or null for the built-in default.");
  }
  await setDefaultGraphicsTemplate(engine, args.template_id);
  return { status: "saved", ...templateList(engine) };
}

async function copyTemplates(engine: Engine, books: BookManager | undefined, args: VideoGraphicsArgs) {
  if (!args.from_book) throw new GraphicsServiceError("invalid", "copy_templates needs from_book, the book to copy templates from.");
  if (!books) throw new GraphicsServiceError("invalid", "Copying templates between books needs the book library.");
  const copy = await copyGraphicsTemplates(engine, {
    books,
    fromBook: args.from_book,
    ...(args.template_ids ? { templateIds: args.template_ids } : {}),
  });
  return {
    status: "copied",
    from_book_id: copy.fromBookId,
    from_book_name: copy.fromBookName,
    copied: copy.copied.map((template) => ({ id: template.id, name: template.name, source_id: template.sourceId })),
    skipped: copy.skipped,
    images: copy.images.map((image) => ({ source_asset_id: image.sourceId, asset_id: image.assetId })),
    missing_images: copy.missingImages,
    ...templateList(engine),
  };
}

async function templateOperation(engine: Engine, books: BookManager | undefined, args: VideoGraphicsArgs, op: TemplateOp, look: GraphicsLook) {
  switch (op) {
    case "save_template": return saveTemplate(engine, args, look);
    case "rename_template": {
      const template = await renameGraphicsTemplate(engine, requiredTemplateId(args, op), args.name);
      return { status: "renamed", template: savedTemplate(template), ...templateList(engine) };
    }
    case "delete_template": {
      const template = await deleteGraphicsTemplate(engine, requiredTemplateId(args, op));
      return { status: "deleted", template: savedTemplate(template), ...templateList(engine) };
    }
    case "set_default_template": return setDefaultTemplate(engine, args);
    case "copy_templates": return copyTemplates(engine, books, args);
    case "save_watermark": return saveWatermark(engine, args, look.platform);
    case "set_watermark_template": return setWatermarkTemplate(engine, args, look.platform);
  }
}

function isTemplateOp(op: VideoOp | TemplateOp): op is TemplateOp {
  return (TEMPLATE_OPS as readonly string[]).includes(op);
}

async function videoOperation(engine: Engine, args: VideoGraphicsArgs, op: VideoOp, look: GraphicsLook) {
  const artifactId = videoArtifactId(engine, args, op);
  if (op === "get") return read(engine, args, artifactId, look);
  if (op === "render") return render(engine, args, artifactId, look);
  if (op === "suggest") return suggest(engine, args, artifactId);
  if (op === "check_placement") return checkGraphicsPlacement(engine, artifactId, look, placementInput(args, op));
  if (op === "detect_regions") return detectGraphicsRegions(engine, args.book_id, artifactId, look, placementInput(args, op));
  return update(engine, args, artifactId, look);
}

export function videoGraphicsDef(engine: Engine, books?: BookManager): ToolDef {
  return {
    name: "video_graphics",
    description:
      "On-screen graphics drawn over a video: text blocks, images, QR codes and shades, each with a position, size, opacity and time window. get reads the saved layers, or the book's default look for a video without any (built in: the TikTok handle, an empty Thai title and an English line, no QR code), with the handle, profile URL and source credit to fill slots, the starter layouts, the book's saved templates, the latest render and any graphics already burned in; update saves edits or a replacement document against the revision from get; render burns the reviewed revision in the background into a new connected video cell (the source is kept) or into the source video in place; suggest (paid, one model call) offers headline options from the video's existing analysis, transcript and download text, or translations of the headline for the second line, for the operator to pick; check_placement says for free whether a layer covers a face or on-screen text already found in the video and where the clearest spot is, and detect_regions (paid when frames are unchecked) finds them first. Templates are named layouts saved per book: save_template, rename_template, delete_template, set_default_template (the look videos without graphics start from) and copy_templates (from another book, with the images they use). watermark: true edits the platform's watermark, what apply_watermark and goal finishing burn; save_watermark saves it as their watermark template and set_watermark_template picks a saved template instead. Videos only.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    schema,
    handler: async (input) => {
      const args = input as unknown as VideoGraphicsArgs;
      try {
        const look: GraphicsLook = { platform: args.platform ?? "tiktok", watermark: args.watermark ?? false };
        const op = args.op ?? "get";
        if (isTemplateOp(op)) return json(await templateOperation(engine, books, args, op, look));
        return json(await videoOperation(engine, args, op, look));
      } catch (error) {
        return failure(error);
      }
    },
  };
}
