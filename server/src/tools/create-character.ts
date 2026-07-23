import type { VideocityFs } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { findPrimaryMediaFile } from "videobook-engine";
import { resolveCharacterCreateName } from "../character-name.js";

export function createCharacterDef(fs: VideocityFs): ToolDef {
  return {
    name: "create_character",
    description: "Create a new character folder (char-*), optionally seeded from existing image assets",
    schema: {
      project_slug: z.string().describe("Project slug"),
      args: z.array(z.string()).describe("Name of the character, OR one or more image asset slugs"),
    },
    handler: async (payload) => {
      const { project_slug, args } = payload as { project_slug: string; args: string[] };

      const imageSources: string[] = [];
      const nameParts: string[] = [];

      for (let arg of args) {
        if (arg.startsWith("@")) arg = arg.slice(1);
        if (arg.startsWith("img-")) {
          imageSources.push(arg);
        } else if (arg.startsWith("vid-") || arg.startsWith("aud-") || arg.startsWith("char-") || arg.startsWith("script-")) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Non-image source provided: ${arg}` }],
          };
        } else {
          nameParts.push(arg);
        }
      }

      if (nameParts.length === 0 && imageSources.length === 0) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Provide a name or at least one image source.` }],
        };
      }

      const displayName = resolveCharacterCreateName(nameParts, imageSources);

      const uniqueSources = new Set(imageSources);
      if (uniqueSources.size !== imageSources.length) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Duplicate sources provided` }],
        };
      }

      const assetResult = await fs.createAsset("char", displayName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create character: ${assetResult.error.message}` }],
        };
      }
      const asset_id = assetResult.value.assetId;

      for (let i = 0; i < imageSources.length; i++) {
        const sourceId = imageSources[i];
        const manifestResult = await fs.getManifest(sourceId, project_slug);
        if (!manifestResult.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Missing source asset: ${sourceId}` }],
          };
        }

        const primaryFile = findPrimaryMediaFile(manifestResult.value.files, sourceId);
        if (!primaryFile) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Source asset has no primary media: ${sourceId}` }],
          };
        }

        const ext = primaryFile.name.split(".").pop();
        const destFilename = `source-${String(i + 1).padStart(2, "0")}.${ext}`;
        const copyResult = await fs.copyFile(sourceId, primaryFile.name, asset_id, destFilename, project_slug);
        if (!copyResult.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Failed to copy file from ${sourceId}: ${copyResult.error.message}` }],
          };
        }
      }

      const metaResult = await fs.writeMetadata(
        asset_id,
        "character",
        { display_name: displayName },
        project_slug,
      );
      if (!metaResult.ok) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Created ${asset_id} but failed to write display_name: ${metaResult.error.message}`,
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id,
            display_name: displayName,
            message: `Created character folder ${asset_id}${imageSources.length > 0 ? ` seeded from ${imageSources.length} images` : ""}`,
          }),
        }],
      };
    },
  };
}
