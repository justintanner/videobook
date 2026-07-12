import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function setCharacterMetadataDef(fs: VideocityFs): ToolDef {
  return {
    name: "set_character_metadata",
    description: "Write arbitrary free-form JSON metadata to a character's .character.json sidecar",
    schema: {
      project_slug: z.string().describe("Project slug"),
      char_asset_id: z.string().describe("Character asset ID (must start with char-)"),
      metadata: z.string().describe("Arbitrary JSON stringified metadata object to write"),
    },
    handler: async (args) => {
      const { project_slug, char_asset_id, metadata } = args as {
        project_slug: string;
        char_asset_id: string;
        metadata: string;
      };
      
      let parsedMetadata: Record<string, unknown>;
      try {
        parsedMetadata = JSON.parse(metadata);
        if (!parsedMetadata || typeof parsedMetadata !== "object" || Array.isArray(parsedMetadata)) {
          throw new Error("Metadata must be a JSON object");
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Invalid JSON metadata: ${message}` }],
        };
      }
      
      const id = char_asset_id.replace(/^@/, "").trim();
      if (!id.startsWith("char-")) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Asset ID must start with char-, got: ${id}` }],
        };
      }
      
      const writeResult = await fs.writeMetadata(id, "character", parsedMetadata, project_slug);
      if (!writeResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to write .character.json: ${writeResult.error.message}` }],
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
