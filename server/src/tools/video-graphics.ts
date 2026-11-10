import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { BookManager } from "../book-manager.js";
import type { GraphicsEdit } from "../graphics/edits.js";
import { GraphicsServiceError } from "../graphics/errors.js";
import {
  GRAPHICS_ACCENTS,
  GRAPHICS_ALIGNS,
  GRAPHICS_ANCHORS,
  GRAPHICS_CASES,
  GRAPHICS_FONT_PRESETS,
  GRAPHICS_ICONS,
  GRAPHICS_QR_LEVELS,
  GRAPHICS_QR_SLOTS,
  GRAPHICS_QR_STYLES,
  GRAPHICS_SCRIM_EDGES,
  GRAPHICS_SPACES,
  GRAPHICS_TEXT_SLOTS,
} from "../graphics/model.js";
import { graphicsBurned, latestGraphicsRender, requestGraphicsRender } from "../graphics/render.js";
import { graphicsForTemplate, readGraphics, updateGraphics } from "../graphics/service.js";
import { DEFAULT_GRAPHICS_STARTER_ID } from "../graphics/starters.js";
import type { GraphicsTemplate } from "../graphics/templates.js";
import {
  copyGraphicsTemplates,
  deleteGraphicsTemplate,
  readGraphicsTemplates,
  renameGraphicsTemplate,
  saveGraphicsTemplate,
  setDefaultGraphicsTemplate,
} from "../graphics/templates.js";
import type { RenderOutput } from "../render-requests.js";
import { RENDER_OUTPUTS } from "../render-requests.js";
import type { WatermarkPlatform } from "../watermark-platform.js";
import { WATERMARK_PLATFORMS } from "../watermark-platform.js";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { advertisedAs } from "./tool-json-schema.js";
import { resolveVideoAssetReference } from "./video-source-reference.js";

const seconds = z.number().nullable();

const positionPatch = z.object({
  anchor: z.enum(GRAPHICS_ANCHORS),
  x: z.number(),
  y: z.number(),
  space: z.enum(GRAPHICS_SPACES),
}).partial().strict();

const timingPatch = z.object({ start: seconds, end: seconds, tail: seconds, fade: z.number() }).partial().strict();

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

const VIDEO_OPS = ["get", "update", "render"] as const;
const TEMPLATE_OPS = ["save_template", "rename_template", "delete_template", "set_default_template", "copy_templates"] as const;

type VideoOp = typeof VIDEO_OPS[number];
type TemplateOp = typeof TEMPLATE_OPS[number];

const schema = {
  book_id: z.string().describe("Book id"),
  asset_id: z.string().min(1).optional()
    .describe("Video artifact UUID or notebook address such as @a1. Required for get, update, render and save_template"),
  notebook_id: z.string().uuid().optional().describe("Notebook that resolves an @address and reports the video's cell address"),
  op: z.enum([...VIDEO_OPS, ...TEMPLATE_OPS]).optional()
    .describe("get (default) reads the saved graphics, or the book's default look for a video without any, with fill values, starters, the book's saved templates, the latest render and any graphics already burned in, and never writes; update saves edits or a replacement document against expected_revision; render queues the graphics of exactly that revision as a background job and returns at once; save_template saves the video's current graphics as a named template of this book (slot text such as the headline is left empty), or over template_id; rename_template and delete_template change a saved template; set_default_template makes template_id (a saved template or a starter) the look a video without graphics starts from, or restores the built-in default with null; copy_templates copies from_book's saved templates into this book together with the images their layers use, skipping names already taken here"),
  platform: z.enum(WATERMARK_PLATFORMS).optional()
    .describe("Watermark profile whose handle and profile URL fill the handle and QR slots of the default look and starters (default tiktok)"),
  expected_revision: z.string().optional().describe("update and render: the revision from get that these changes apply to or that was reviewed"),
  source_hash: z.string().optional().describe("render: source.source_hash from the get that was reviewed"),
  request_id: z.string().uuid().optional().describe("render: stable request UUID; reuse it when retrying the same render"),
  output: z.enum(RENDER_OUTPUTS).optional()
    .describe("render: new (default) writes a copy with the graphics into a new video cell below the source, a version of the earlier copy when one exists; replace burns the graphics into the source video itself, keeping its earlier version in history, and clears the saved graphics"),
  edits: z.array(editSchema).max(200).optional()
    .describe("update: edits applied in order. Sizes, gaps and paddings are fractions of the frame's short side, text width a fraction of the positioning space, positions 0..1 inside the space, times in seconds"),
  document: advertisedAs(z.unknown(), {
    type: "object",
    description: "update: a full replacement document (version, layers, nextId) in the shape get returns",
  }).optional(),
  template_id: z.string().min(1).nullable().optional()
    .describe("save_template: a saved template to save over; rename_template and delete_template: the template to change; set_default_template: a saved template or starter id, or null for the built-in default"),
  name: z.string().optional().describe("save_template and rename_template: the template's name"),
  from_book: z.string().min(1).optional().describe("copy_templates: the book id or name to copy saved templates from"),
  template_ids: z.array(z.string().min(1)).max(50).optional().describe("copy_templates: only these templates of from_book (default all)"),
};

type VideoGraphicsArgs = {
  book_id: string;
  asset_id?: string;
  notebook_id?: string;
  op?: VideoOp | TemplateOp;
  platform?: WatermarkPlatform;
  expected_revision?: string;
  source_hash?: string;
  request_id?: string;
  output?: RenderOutput;
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
  const body = error instanceof GraphicsServiceError
    ? { status: error.code, message: error.message, ...error.details }
    : { status: "error", message: error instanceof Error ? error.message : String(error) };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] };
}

async function update(engine: Engine, args: VideoGraphicsArgs, artifactId: string, platform: WatermarkPlatform) {
  if (!args.expected_revision) throw new GraphicsServiceError("invalid", "update needs expected_revision from get.");
  if ((args.edits === undefined) === (args.document === undefined)) {
    throw new GraphicsServiceError("invalid", "update takes exactly one of edits or document.");
  }
  const draft = await updateGraphics(engine, artifactId, {
    expectedRevision: args.expected_revision,
    platform,
    ...(args.edits ? { edits: args.edits } : { document: args.document }),
  });
  return { asset_id: artifactId, status: "saved", saved: true, revision: draft.revision, updated_at: draft.updatedAt, document: draft.document };
}

async function render(engine: Engine, args: VideoGraphicsArgs, artifactId: string, platform: WatermarkPlatform) {
  if (!args.expected_revision || !args.source_hash || !args.request_id) {
    throw new GraphicsServiceError("invalid", "render needs expected_revision, source_hash and request_id from the reviewed get.");
  }
  const status = await requestGraphicsRender(engine, args.book_id, artifactId, {
    requestId: args.request_id,
    expectedRevision: args.expected_revision,
    sourceHash: args.source_hash,
    notebookId: args.notebook_id ?? null,
    output: args.output ?? "new",
    platform,
  });
  return { asset_id: artifactId, job_id: status.job_id, status: status.status, output_artifact_id: status.output_asset_id, render: status };
}

async function read(engine: Engine, args: VideoGraphicsArgs, artifactId: string, platform: WatermarkPlatform) {
  const model = await readGraphics(engine, artifactId, { notebookId: args.notebook_id ?? null, platform });
  return { ...model, render: latestGraphicsRender(engine, artifactId), burned: await graphicsBurned(engine, artifactId) };
}

function videoArtifactId(engine: Engine, args: VideoGraphicsArgs, op: VideoOp | "save_template"): string {
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
  };
}

function savedTemplate(template: GraphicsTemplate) {
  return { id: template.id, name: template.name, updated_at: template.updatedAt };
}

async function saveTemplate(engine: Engine, args: VideoGraphicsArgs, platform: WatermarkPlatform) {
  const document = await graphicsForTemplate(engine, videoArtifactId(engine, args, "save_template"), platform, args.expected_revision);
  const template = await saveGraphicsTemplate(engine, {
    document,
    ...(args.name === undefined ? {} : { name: args.name }),
    ...(typeof args.template_id === "string" ? { templateId: args.template_id } : {}),
  });
  return { status: "saved", template: savedTemplate(template), ...templateList(engine) };
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

async function templateOperation(engine: Engine, books: BookManager | undefined, args: VideoGraphicsArgs, op: TemplateOp, platform: WatermarkPlatform) {
  switch (op) {
    case "save_template": return saveTemplate(engine, args, platform);
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
  }
}

function isTemplateOp(op: VideoOp | TemplateOp): op is TemplateOp {
  return (TEMPLATE_OPS as readonly string[]).includes(op);
}

async function videoOperation(engine: Engine, args: VideoGraphicsArgs, op: VideoOp, platform: WatermarkPlatform) {
  const artifactId = videoArtifactId(engine, args, op);
  if (op === "get") return read(engine, args, artifactId, platform);
  if (op === "render") return render(engine, args, artifactId, platform);
  return update(engine, args, artifactId, platform);
}

export function videoGraphicsDef(engine: Engine, books?: BookManager): ToolDef {
  return {
    name: "video_graphics",
    description:
      "On-screen graphics drawn over a video: text blocks, images, QR codes and shades, each with a position, size, opacity and time window. get reads the saved layers, or the book's default look for a video without any (built in: the TikTok handle, an empty Thai title and an English line, no QR code), with the handle, profile URL and source credit to fill slots, the starter layouts, the book's saved templates, the latest render and any graphics already burned in; update saves edits or a replacement document against the revision from get; render burns the reviewed revision in the background into a new connected video cell (the source is kept) or into the source video in place. Templates are named layouts saved per book: save_template, rename_template, delete_template, set_default_template (the look videos without graphics start from) and copy_templates (from another book, with the images they use). Videos only.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    schema,
    handler: async (input) => {
      const args = input as unknown as VideoGraphicsArgs;
      try {
        const platform = args.platform ?? "tiktok";
        const op = args.op ?? "get";
        if (isTemplateOp(op)) return json(await templateOperation(engine, books, args, op, platform));
        return json(await videoOperation(engine, args, op, platform));
      } catch (error) {
        return failure(error);
      }
    },
  };
}
