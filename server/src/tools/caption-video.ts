import type { Engine } from "videobook-engine";
import { z } from "zod";
import { CAPTION_COMPONENTS } from "../captions/analysis.js";
import type { CaptionEdit } from "../captions/edits.js";
import { CAPTION_ASPECTS, CAPTION_BACKGROUNDS, CAPTION_MOTIONS, CAPTION_PRESETS, ORIGINAL_CAPTION_LANGUAGE } from "../captions/model.js";
import type { CaptionResolution } from "../captions/service.js";
import { CaptionServiceError, prepareCaptions, readCaptions, updateCaptions } from "../captions/service.js";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { advertisedAs } from "./tool-json-schema.js";
import { resolveVideoAssetReference } from "./video-source-reference.js";

const aspect = z.enum(CAPTION_ASPECTS);
const position = z.number().min(0).max(1).nullable();

const styleSchema = z.object({
  preset: z.enum(CAPTION_PRESETS),
  motion: z.enum(CAPTION_MOTIONS),
  fontScale: z.number(),
  textColor: z.string(),
  highlightColor: z.string(),
  outlineColor: z.string(),
  outlineWidth: z.number(),
  shadow: z.boolean(),
  background: z.enum(CAPTION_BACKGROUNDS),
  uppercase: z.boolean(),
  snapToOnsets: z.boolean(),
  energySizing: z.boolean(),
  avoidFaces: z.boolean(),
  avoidText: z.boolean(),
  offsetMs: z.number().int(),
}).partial().strict();

const editSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_word_text"), word_id: z.string(), text: z.string() }),
  z.object({ op: z.literal("set_word_timing"), word_id: z.string(), start: z.number(), end: z.number() }),
  z.object({ op: z.literal("hide_word"), word_id: z.string(), hidden: z.boolean() }),
  z.object({ op: z.literal("insert_word"), after_word_id: z.string(), text: z.string(), start: z.number(), end: z.number() }),
  z.object({ op: z.literal("reset_word"), word_id: z.string() }),
  z.object({ op: z.literal("split_phrase"), word_id: z.string() }),
  z.object({ op: z.literal("merge_phrase"), phrase_id: z.string() }),
  z.object({ op: z.literal("set_phrase_position"), phrase_id: z.string(), aspect: aspect.optional(), y: position }),
  z.object({ op: z.literal("set_position"), aspect: aspect.optional(), y: position }),
  z.object({ op: z.literal("set_style"), style: styleSchema }),
  z.object({ op: z.literal("set_aspect"), aspect }),
]);

const schema = {
  book_id: z.string().describe("Book id"),
  asset_id: z.string().min(1).describe("Video artifact UUID or notebook address such as @a1"),
  notebook_id: z.string().uuid().optional().describe("Notebook that resolves an @address"),
  op: z.enum(["get", "prepare", "update"]).optional()
    .describe("get (default) reads the draft and preparation status without starting work; prepare starts missing transcription, vocal timing, face/text placement or translation (transcription, placement and translation are paid); update saves edits against expected_revision"),
  language: z.string().regex(/^(original|[a-z]{2})$/u).optional()
    .describe("original (default) for the spoken language with real word timings, or an ISO 639-1 code for translated subtitles with estimated timing"),
  detail: z.enum(["summary", "full"]).optional().describe("summary (default) omits the document, regions and loudness envelope"),
  regions: z.boolean().optional().describe("prepare: also detect faces and on-screen text so subtitles avoid them (default true)"),
  force: z.array(z.enum(CAPTION_COMPONENTS)).optional().describe("prepare: re-run these components even when cached results exist"),
  expected_revision: z.string().optional().describe("update: the draft revision these edits apply to, from get"),
  edits: z.array(editSchema).max(500).optional()
    .describe("update: edit operations applied in order (word text/timing, hide/insert/reset words, split/merge phrases, positions 0..1 of the frame height, style, aspect)"),
  document: advertisedAs(z.unknown(), {
    type: "object",
    description: "update: a full replacement of the document returned by get with detail full; keep its source, bindings and language",
  }).optional(),
  resolve: z.enum(["reseed", "realign", "keep_timings", "discard"]).optional()
    .describe("update: reseed applies newer analysis keeping corrections; after the video changed, realign maps corrections onto it, keep_timings rebinds unchanged timings, discard drops the draft"),
};

type CaptionVideoArgs = {
  book_id: string;
  asset_id: string;
  notebook_id?: string;
  op?: "get" | "prepare" | "update";
  language?: string;
  detail?: "summary" | "full";
  regions?: boolean;
  force?: Array<typeof CAPTION_COMPONENTS[number]>;
  expected_revision?: string;
  edits?: CaptionEdit[];
  document?: unknown;
  resolve?: CaptionResolution;
};

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(error: unknown): ToolResult {
  if (error instanceof CaptionServiceError) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: error.code, message: error.message, revision: error.revision }) }] };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "error", message }) }] };
}

async function update(engine: Engine, args: CaptionVideoArgs, artifactId: string, language: string) {
  if (!args.expected_revision) throw new CaptionServiceError("invalid", "update needs expected_revision from get.");
  const inputs = [args.edits !== undefined, args.document !== undefined, args.resolve !== undefined].filter(Boolean).length;
  if (inputs !== 1) throw new CaptionServiceError("invalid", "update takes exactly one of edits, document or resolve.");
  const result = await updateCaptions(engine, args.book_id, artifactId, language, {
    expectedRevision: args.expected_revision,
    ...(args.edits ? { edits: args.edits } : {}),
    ...(args.document !== undefined ? { document: args.document } : {}),
    ...(args.resolve ? { resolve: args.resolve } : {}),
  });
  return {
    asset_id: artifactId,
    language,
    status: "saved",
    revision: result.revision,
    saved: result.saved,
    reseed: result.reseed,
    ...(args.detail === "full" ? { document: result.document } : {}),
  };
}

export function captionVideoDef(engine: Engine): ToolDef {
  return {
    name: "caption_video",
    description:
      "Subtitles for a video in the TikTok style: read the editable draft and its preparation status, prepare word-timed transcription with vocal timing and face/text placement, or save word, timing, phrase, position and style edits against the draft revision.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    schema,
    handler: async (input) => {
      const args = input as unknown as CaptionVideoArgs;
      try {
        const artifactId = resolveVideoAssetReference(engine, args.asset_id, args.notebook_id);
        const language = args.language ?? ORIGINAL_CAPTION_LANGUAGE;
        const detail = args.detail ?? "summary";
        const op = args.op ?? "get";
        if (op === "get") return json(await readCaptions(engine, artifactId, language, detail));
        if (op === "prepare") {
          return json(await prepareCaptions(engine, args.book_id, artifactId, language, { regions: args.regions ?? true, force: args.force ?? [], detail }));
        }
        return json(await update(engine, args, artifactId, language));
      } catch (error) {
        return failure(error);
      }
    },
  };
}
