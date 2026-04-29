import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-engine";
import { z } from "zod";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { CHARACTER_METADATA_KEY, type Character } from "../jobs/extract-character.js";

const SLOT_KINDS = ["wardrobe", "poses", "backdrop", "outfits"] as const;
type SlotKind = (typeof SLOT_KINDS)[number];

function stripAt(slug: string): string {
  return slug.startsWith("@") ? slug.slice(1) : slug;
}

async function readCharacter(
  fs: ClipfirstFs,
  charAssetId: string,
  projectSlug: string,
): Promise<{ ok: true; value: Character } | { ok: false; error: string }> {
  const result = await fs.readMetadata<Character>(charAssetId, CHARACTER_METADATA_KEY, projectSlug);
  if (!result.ok) return { ok: false, error: result.error.message };
  return { ok: true, value: result.value };
}

async function writeCharacter(
  fs: ClipfirstFs,
  charAssetId: string,
  projectSlug: string,
  character: Character,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await fs.writeMetadata(charAssetId, CHARACTER_METADATA_KEY, character, projectSlug);
  if (!result.ok) return { ok: false, error: result.error.message };
  return { ok: true };
}

function getSlotArray(character: Character, slot: SlotKind): string[] {
  return character[slot] ?? [];
}

function setSlotArray(character: Character, slot: SlotKind, value: string[]): Character {
  return { ...character, [slot]: value };
}

const pinSchema = {
  project_slug: z.string().describe("Project slug"),
  char_asset_id: z.string().describe("char-* asset id (no @ prefix)"),
  slot: z.enum(SLOT_KINDS).describe("Which slot row to pin into"),
  asset_id: z.string().describe("Asset id to pin (img-*; @ prefix is stripped)"),
} as const;

const unpinSchema = pinSchema;

export function pinCharacterSlotDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "pin_character_slot",
    description:
      "Pin an asset reference into one of a char-*'s slot arrays in .character.json. " +
      "wardrobe, poses, and backdrop are SINGLE-SLOT (replacing any existing pin); outfits accumulates. " +
      "No-op if the asset is already pinned.",
    schema: pinSchema,
    handler: async (args): Promise<ToolResult> => {
      const { project_slug, char_asset_id, slot, asset_id } = args as {
        project_slug: string;
        char_asset_id: string;
        slot: SlotKind;
        asset_id: string;
      };
      const charId = stripAt(char_asset_id);
      const pinId = stripAt(asset_id);
      if (!charId.startsWith("char-")) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `char_asset_id must start with "char-"; got "${charId}"` }],
        };
      }

      const read = await readCharacter(fs, charId, project_slug);
      if (!read.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to read .character.json for ${charId}: ${read.error}` }],
        };
      }
      const current = getSlotArray(read.value, slot);
      if (current.includes(pinId) && (slot === "outfits" || current.length === 1)) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ status: "already_pinned", slot, asset_id: pinId, length: current.length }),
          }],
        };
      }
      const next = slot === "outfits" ? [...current, pinId] : [pinId];
      const write = await writeCharacter(fs, charId, project_slug, setSlotArray(read.value, slot, next));
      if (!write.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to write .character.json: ${write.error}` }],
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ status: "pinned", slot, asset_id: pinId, length: next.length }),
        }],
      };
    },
  };
}

export function unpinCharacterSlotDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "unpin_character_slot",
    description:
      "Remove an asset reference from one of a char-*'s slot arrays in .character.json " +
      "(wardrobe | poses | backdrop | outfits). No-op if the asset is not currently pinned.",
    schema: unpinSchema,
    handler: async (args): Promise<ToolResult> => {
      const { project_slug, char_asset_id, slot, asset_id } = args as {
        project_slug: string;
        char_asset_id: string;
        slot: SlotKind;
        asset_id: string;
      };
      const charId = stripAt(char_asset_id);
      const unpinId = stripAt(asset_id);
      if (!charId.startsWith("char-")) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `char_asset_id must start with "char-"; got "${charId}"` }],
        };
      }

      const read = await readCharacter(fs, charId, project_slug);
      if (!read.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to read .character.json for ${charId}: ${read.error}` }],
        };
      }
      const current = getSlotArray(read.value, slot);
      if (!current.includes(unpinId)) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ status: "not_pinned", slot, asset_id: unpinId, length: current.length }),
          }],
        };
      }
      const next = current.filter((id) => id !== unpinId);
      const write = await writeCharacter(fs, charId, project_slug, setSlotArray(read.value, slot, next));
      if (!write.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to write .character.json: ${write.error}` }],
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ status: "unpinned", slot, asset_id: unpinId, length: next.length }),
        }],
      };
    },
  };
}

export function registerCharacterSlotTools(server: McpServer, fs: ClipfirstFs): void {
  for (const def of [pinCharacterSlotDef(fs), unpinCharacterSlotDef(fs)]) {
    server.tool(def.name, def.description, def.schema, def.handler);
  }
}
