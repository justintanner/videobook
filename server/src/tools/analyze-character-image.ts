import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "vc-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { extractCharacterFromBytes } from "../jobs/extract-character.js";
import { mimeForImageFilename } from "../jobs/describe-image.js";
import { findImageFile } from "./_image-inputs.js";

const schema = {
  project_slug: z.string().describe("Project slug"),
  image_slug: z.string().describe("@img-* slug of a portrait/photo to extract a character profile from"),
  subject_kind: z
    .enum(["female", "male", "animal", "other"])
    .optional()
    .describe(
      "Optional override. When set, the vision model commits to this subject kind (useful for androgynous or stylized images, or to re-extract with a different reading)."
    ),
};

export function analyzeCharacterImageDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "analyze_character_image",
    description:
      "Run vision on an image asset and return a structured Character profile. Subject kind is one of " +
      "'female' | 'male' | 'animal' | 'other'. For female/male the profile holds age, ethnicity, height, " +
      "build, body measurements (chest/waist/hips), face, hair, eyes, skin. For animal/other it collapses " +
      "into a single freeform 'other' description. Pass `subject_kind` to force a specific reading — " +
      "useful for androgynous or stylized images, or to re-extract after the user flips the toggle. " +
      "Synchronous — no jobs, no assets created. Used by the /character flow to seed the editable form before generating a character sheet.",
    schema,
    handler: async (args) => {
      if (!process.env.OPENAI_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "OPENAI_API_KEY environment variable is not set" }],
        };
      }
      const { project_slug, image_slug, subject_kind } = args as {
        project_slug: string;
        image_slug: string;
        subject_kind?: "female" | "male" | "animal" | "other";
      };
      const assetId = image_slug.replace(/^@/, "");

      const manifest = await fs.getManifest(assetId, project_slug);
      if (!manifest.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to read manifest for ${assetId}: ${manifest.error.message}` }],
        };
      }
      const imageFile = findImageFile(manifest.value.files);
      if (!imageFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No image file found in ${assetId}` }],
        };
      }
      const read = await fs.readFile(assetId, imageFile.name, project_slug);
      if (!read.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to read image ${imageFile.name}: ${read.error.message}` }],
        };
      }

      try {
        const profile = await extractCharacterFromBytes(
          Buffer.from(read.value),
          mimeForImageFilename(imageFile.name),
          assetId,
          { subjectKindOverride: subject_kind },
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ profile }) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Vision extraction failed: ${msg}` }],
        };
      }
    },
  };
}

export function registerAnalyzeCharacterImageTool(server: McpServer, fs: ClipfirstFs): void {
  const def = analyzeCharacterImageDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
