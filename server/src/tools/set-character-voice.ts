import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { CHARACTER_METADATA_KEY, type Character } from "../jobs/extract-character.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

function stripAt(slug: string): string {
  return slug.startsWith("@") ? slug.slice(1) : slug;
}

export function setCharacterVoiceDef(fs: VideocityFs): ToolDef {
  return {
    name: "set_character_voice",
    description: "Set or clear the ElevenLabs voice ID on an existing char-* asset's character profile metadata",
    schema: {
      project_slug: z.string().describe("Project slug"),
      char_asset_id: z.string().describe("char-* asset id"),
      elevenlabs_voice_id: z.string().optional().describe("ElevenLabs voice ID. Empty or omitted clears the selected voice."),
    },
    handler: async (args): Promise<ToolResult> => {
      const { project_slug, char_asset_id, elevenlabs_voice_id } = args as {
        project_slug: string;
        char_asset_id: string;
        elevenlabs_voice_id?: string;
      };
      const charId = stripAt(char_asset_id);
      if (!charId.startsWith("char-")) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `char_asset_id must start with "char-"; got "${charId}"` }],
        };
      }

      const read = await fs.readMetadata<Character>(charId, CHARACTER_METADATA_KEY, project_slug);
      if (!read.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to read .character.json for ${charId}: ${read.error.message}` }],
        };
      }

      const voiceId = elevenlabs_voice_id?.trim() ?? "";
      const profile: Character = { ...read.value };
      if (voiceId) profile.elevenlabs_voice_id = voiceId;
      else delete profile.elevenlabs_voice_id;

      const write = await fs.writeMetadata(charId, CHARACTER_METADATA_KEY, profile, project_slug);
      if (!write.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to write .character.json for ${charId}: ${write.error.message}` }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: voiceId ? "set" : "cleared",
            char_asset_id: charId,
            elevenlabs_voice_id: voiceId || null,
            profile,
          }),
        }],
      };
    },
  };
}
