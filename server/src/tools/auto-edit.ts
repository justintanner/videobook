import type { Engine } from "videobook-engine";
import { z } from "zod";
import { readAutoEditGet, requestAutoEditRender } from "../auto-edit/drafts.js";
import { segmentPlanSchema } from "../auto-edit/plan.js";
import {
  autoEditAnchorsSchema,
  autoEditCuesSchema,
  autoEditSectionsSchema,
} from "../auto-edit/style.js";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { advertisedAs } from "./tool-json-schema.js";
import { resolveVideoAssetReference } from "./video-source-reference.js";

const AUTO_EDIT_OPS = ["get", "render"] as const;

const schema = {
  book_id: z.string().uuid().describe("Book id"),
  asset_id: z.string().min(1).describe("Source video artifact UUID or notebook address such as @a1"),
  notebook_id: z.string().uuid().optional().describe("Notebook that resolves an @address and receives the new cell"),
  op: z.enum(AUTO_EDIT_OPS).optional().describe("get (default) reads the draft and plan; render queues a local render"),
  anchors: advertisedAs(autoEditAnchorsSchema, {
    type: "object",
    description: "render: hook, moment, focus, keep and cuts in source seconds; give anchors or plan, not both",
  }).optional(),
  sections: advertisedAs(autoEditSectionsSchema, {
    type: "object",
    description: "render: section switches (coldOpen, replays, pushIn, crash, sounds)",
  }).optional(),
  plan: advertisedAs(segmentPlanSchema, {
    type: "object",
    description: "render: explicit segment plan to render instead of building from anchors",
  }).optional(),
  cues: advertisedAs(autoEditCuesSchema, {
    type: "array",
    description: "render: optional built-in sound cues for an explicit plan (up to 16)",
  }).optional(),
  source_hash: z.string().min(1).optional().describe("render: source_hash returned by get"),
  request_id: z.string().uuid().optional().describe("render: stable request UUID for idempotent retries"),
};

const inputSchema = z.object(schema);

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function errorResult(error: unknown): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
  };
}

export function autoEditDef(engine: Engine): ToolDef {
  return {
    name: "auto_edit",
    description: "Read a video's auto-edit draft or render an auto-edit into a new cell. Rendering runs locally for free without changing the source video.",
    annotations: { destructiveHint: false, readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    schema,
    handler: async (rawInput) => {
      try {
        const args = inputSchema.parse(rawInput);
        const sourceArtifactId = resolveVideoAssetReference(engine, args.asset_id, args.notebook_id);
        const op = args.op ?? "get";
        if (op === "get") {
          return jsonResult(await readAutoEditGet(engine, sourceArtifactId));
        }
        if (!args.source_hash) {
          throw new Error("source_hash is required for auto_edit render.");
        }
        if (!args.request_id) {
          throw new Error("request_id is required for auto_edit render.");
        }
        const queued = await requestAutoEditRender(engine, {
          bookId: args.book_id,
          sourceArtifactId,
          notebookId: args.notebook_id ?? null,
          sourceHash: args.source_hash,
          requestId: args.request_id,
          anchors: args.anchors,
          sections: args.sections,
          plan: args.plan,
          cues: args.cues,
        });
        return jsonResult(queued);
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}
