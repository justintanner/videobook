import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

/**
 * Normalize the metadata arg into a plain object.
 * - Objects pass through (agents often send structured JSON, not a string).
 * - Valid JSON object strings parse as expected.
 * - Free-form notes (no leading `{`/`[`) are stored as `{ notes: "..." }`.
 */
export function parseCharacterMetadata(
  input: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return { ok: true, value: input as Record<string, unknown> };
  }

  if (typeof input !== "string") {
    return { ok: false, error: "Metadata must be a JSON object or string" };
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: true, value: {} };
  }

  // Plain notes / prose — not JSON. Keep them without forcing users to quote keys.
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return { ok: true, value: { notes: trimmed } };
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Metadata must be a JSON object" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error:
        `Invalid JSON metadata: ${message}. ` +
        `Use double-quoted keys (e.g. {"display_name":"Ada"}) or free-form notes without braces.`,
    };
  }
}

export function setCharacterMetadataDef(fs: Engine): ToolDef {
  return {
    name: "set_character_metadata",
    description:
      "Write free-form native metadata for a character. " +
      "Accepts a JSON object, a JSON-stringified object, or plain-text notes " +
      "(stored as { notes: \"...\" }).",
    schema: {
      book_id: z.string().describe("Project slug"),
      char_asset_id: z.string().describe("Character asset ID (must start with char-)"),
      metadata: z
        .union([z.string(), z.record(z.string(), z.unknown())])
        .describe(
          "JSON object (or stringified object) of character metadata, or free-form notes",
        ),
    },
    handler: async (args) => {
      const { book_id: _book_id, char_asset_id, metadata } = args as {
        book_id: string;
        char_asset_id: string;
        metadata: string | Record<string, unknown>;
      };

      const parsed = parseCharacterMetadata(metadata);
      if (!parsed.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: parsed.error }],
        };
      }

      const id = char_asset_id.replace(/^@/, "").trim();
      if (!id.startsWith("char-")) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Asset ID must start with char-, got: ${id}` }],
        };
      }

      const writeResult = await fs.metadata.artifacts.write(id, "character", parsed.value);
      if (!writeResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to write character metadata: ${writeResult.error.message}` }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id: id,
            message: "Metadata successfully written",
          }),
        }],
      };
    },
  };
}
