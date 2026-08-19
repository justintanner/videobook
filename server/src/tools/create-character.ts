import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { findPrimaryMediaFile } from "videobook-engine";
import { resolveCharacterCreateName } from "../character-name.js";

export function createCharacterDef(engine: Engine): ToolDef {
  return {
    name: "create_character",
    description: "Create a new character artifact, optionally seeded from existing image artifacts",
    schema: {
      book_id: z.string().describe("Book id"),
      args: z.array(z.string()).describe("Name of the character, OR one or more image artifact ids"),
    },
    handler: async (payload) => {
      const { book_id: _book_id, args } = payload as { book_id: string; args: string[] };

      const imageSources: string[] = [];
      // Parallel to imageSources: the free-text label each source carries, used
      // as the character name stem when no explicit name is given.
      const imageLabels: string[] = [];
      const nameParts: string[] = [];

      for (let arg of args) {
        const isTagged = arg.startsWith("@");
        if (isTagged) arg = arg.slice(1);
        const artifact = engine.artifacts.get(arg);
        if (artifact.ok) {
          if (artifact.value.kind !== "image") {
            return {
              isError: true as const,
              content: [{ type: "text" as const, text: `Non-image source provided (${artifact.value.kind}): ${arg}` }],
            };
          }
          imageSources.push(arg);
          imageLabels.push(artifact.value.label ?? "");
        } else if (isTagged) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Unknown artifact reference: @${arg}` }],
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

      const displayName = resolveCharacterCreateName(nameParts, imageLabels);

      const uniqueSources = new Set(imageSources);
      if (uniqueSources.size !== imageSources.length) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Duplicate sources provided` }],
        };
      }

      const assetResult = await engine.artifacts.create("char", displayName);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create character: ${assetResult.error.message}` }],
        };
      }
      const asset_id = assetResult.value.artifactId;

      for (let i = 0; i < imageSources.length; i++) {
        const sourceId = imageSources[i];
        const manifestResult = await engine.files.manifest(sourceId);
        if (!manifestResult.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Missing source asset: ${sourceId}` }],
          };
        }

        const primaryFile = findPrimaryMediaFile(manifestResult.value.files, "image");
        if (!primaryFile) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Source asset has no primary media: ${sourceId}` }],
          };
        }

        const ext = primaryFile.name.split(".").pop();
        const destFilename = `source-${String(i + 1).padStart(2, "0")}.${ext}`;
        const copyResult = await engine.files.copy(sourceId, primaryFile.name, asset_id, destFilename);
        if (!copyResult.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Failed to copy file from ${sourceId}: ${copyResult.error.message}` }],
          };
        }
      }

      const metaResult = await engine.metadata.artifacts.write(asset_id, "character", { display_name: displayName }
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
