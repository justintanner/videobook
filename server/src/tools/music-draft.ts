import { z } from "zod";
import type { Engine, EditIntent } from "videobook-engine";
import type { ToolDef } from "./tool-def.js";
import { musicDraftOptionsSchema } from "../rhythm/draft-model.js";
import { planMusicVideo, commitMusicVideo } from "../rhythm/music-draft.js";

const schema = z.object({ book_id: z.string().uuid(), expected_revision: z.string().min(1), rhythm_revision: z.string().min(1),
  actor: z.string().default("videobook-user"), source_surface: z.enum(["ui", "slash", "chat", "system"]).default("ui"), options: musicDraftOptionsSchema });

export function musicDraftDefs(engine: Engine): ToolDef[] {
  return [{ name: "plan_music_video", description: "Draft a beat-aligned music video from selected sources without saving it. Review the returned sequence, then apply it with commit_music_video using the returned intent, preview hash and revisions.", scope: "book", schema: schema.shape,
    annotations: { readOnlyHint: true }, handler: async (input) => {
      try {
        const args = schema.parse(input);
        return { content: [{ type: "text", text: JSON.stringify(await planMusicVideo(engine, args.options, args.expected_revision, args.rhythm_revision, args.actor, args.source_surface)) }] };
      } catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
    } }, {
      name: "commit_music_video", description: "Apply a reviewed music-video draft once, checking its timeline, source and beat-map revisions. Returns the previous action on a retry.", scope: "book",
      schema: { book_id: z.string().uuid(), intent: z.record(z.string(), z.unknown()), preview_hash: z.string().min(1), rhythm_revision: z.string().min(1), sequence_content_revision: z.string().min(1) },
      annotations: { idempotentHint: true }, handler: async (args) => {
        try {
          const result = await commitMusicVideo(engine, args.intent as unknown as EditIntent, String(args.preview_hash), String(args.rhythm_revision), String(args.sequence_content_revision));
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
      },
    }];
}
