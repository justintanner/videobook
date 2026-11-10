import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { GraphicsEdit } from "../graphics/edits.js";
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
import { GraphicsServiceError, readGraphics, updateGraphics } from "../graphics/service.js";
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

const schema = {
  book_id: z.string().describe("Book id"),
  asset_id: z.string().min(1).describe("Video artifact UUID or notebook address such as @a1"),
  notebook_id: z.string().uuid().optional().describe("Notebook that resolves an @address and reports the video's cell address"),
  op: z.enum(["get", "update"]).optional()
    .describe("get (default) reads the saved graphics, or the default look for a video without any, with fill values and starters, and never writes; update saves edits or a replacement document against expected_revision"),
  platform: z.enum(WATERMARK_PLATFORMS).optional()
    .describe("Watermark profile whose handle and profile URL fill the handle and QR slots of the default look and starters (default tiktok)"),
  expected_revision: z.string().optional().describe("update: the revision from get that these changes apply to"),
  edits: z.array(editSchema).max(200).optional()
    .describe("update: edits applied in order. Sizes, gaps and paddings are fractions of the frame's short side, text width a fraction of the positioning space, positions 0..1 inside the space, times in seconds"),
  document: advertisedAs(z.unknown(), {
    type: "object",
    description: "update: a full replacement document (version, layers, nextId) in the shape get returns",
  }).optional(),
};

type VideoGraphicsArgs = {
  book_id: string;
  asset_id: string;
  notebook_id?: string;
  op?: "get" | "update";
  platform?: WatermarkPlatform;
  expected_revision?: string;
  edits?: GraphicsEdit[];
  document?: unknown;
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

export function videoGraphicsDef(engine: Engine): ToolDef {
  return {
    name: "video_graphics",
    description:
      "On-screen graphics drawn over a video: text blocks, images, QR codes and shades, each with a position, size, opacity and time window. get reads the saved layers, or the default look (the TikTok handle, an empty Thai title and an English line, no QR code) for a video without any, with the handle, profile URL and source credit to fill slots and the starter layouts; update saves edits or a replacement document against the revision from get. Videos only; nothing is rendered.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    schema,
    handler: async (input) => {
      const args = input as unknown as VideoGraphicsArgs;
      try {
        const artifactId = resolveVideoAssetReference(engine, args.asset_id, args.notebook_id);
        const platform = args.platform ?? "tiktok";
        if ((args.op ?? "get") === "get") {
          return json(await readGraphics(engine, artifactId, { notebookId: args.notebook_id ?? null, platform }));
        }
        return json(await update(engine, args, artifactId, platform));
      } catch (error) {
        return failure(error);
      }
    },
  };
}
