import type { Engine } from "videobook-engine";
import { z } from "zod";
import { rhythmSettingsSchema } from "../rhythm/model.js";
import { readSequenceRhythm, updateSequenceRhythm } from "../rhythm/sequence-rhythm.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function sequenceRhythmDefs(engine: Engine): ToolDef[] {
  const schema = { book_id: z.string().uuid(), sequence_id: z.string().uuid() };
  return [
    {
      name: "get_sequence_rhythm", description: "Read the selected master soundtrack and editable beat map with its revision and undo state",
      scope: "book", schema,
      handler: async (args) => {
        try { return json(await readSequenceRhythm(engine, String(args.sequence_id))); }
        catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
      },
    },
    {
      name: "update_sequence_rhythm", description: "Save or undo a soundtrack choice or corrected source-timed beat map without changing the audio",
      scope: "book", schema: {
        ...schema, expected_revision: z.string().min(1),
        operation: z.enum(["set", "undo", "redo"]), settings: rhythmSettingsSchema.optional(),
      },
      handler: async (args) => {
        try {
          const update = args.operation === "undo" || args.operation === "redo" ? args.operation : rhythmSettingsSchema.parse(args.settings);
          const state = await updateSequenceRhythm(engine, String(args.sequence_id), String(args.expected_revision), update);
          const sequence = engine.sequences.get(String(args.sequence_id));
          if (!sequence.ok) throw new Error(sequence.error.message);
          return json({ state, sequence: sequence.value });
        } catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
      },
    },
  ];
}
