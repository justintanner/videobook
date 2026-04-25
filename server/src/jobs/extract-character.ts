import type { ClipfirstFs } from "clipfirst-fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { registerJobHandler } from "../queue.js";
import {
  buildResponses,
  firstResponseText,
  mimeForImageFilename,
  type ResponsesFn,
} from "./describe-image.js";
import { findImageFile } from "../tools/_image-inputs.js";

export type Character = {
  name?: string;
  age: string;
  gender_presentation: string;
  ethnicity: string;
  height: string;
  build: string;
  bust: string;
  waist: string;
  hips: string;
  glutes: string;
  face: string;
  hair: string;
  eyes: string;
  skin: string;
  distinguishing_features: string;
  source_image_asset_id: string;
  wardrobe?: string[];
  poses?: string[];
  backdrop?: string[];
  outfits?: string[];
};

const REQUIRED_FIELDS: Array<keyof Character> = [
  "age",
  "gender_presentation",
  "ethnicity",
  "height",
  "build",
  "bust",
  "waist",
  "hips",
  "glutes",
  "face",
  "hair",
  "eyes",
  "skin",
  "distinguishing_features",
];

type ExtractCharacterPayload = {
  type: "extract_character";
  charAssetId: string;
  sourceAssetId: string;
  sourceImageFilename: string;
  projectSlug: string;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUIDE_PATH = join(__dirname, "../guides/character_schema_guide.md");

export const CHARACTER_METADATA_KEY = "character";
export const VISION_MODEL = "grok-4.20-reasoning";

function buildSystemPrompt(guide: string): string {
  return (
    "You are an expert visual analyst extracting a structured character profile from a photograph. " +
    "Follow the guide exactly. Return ONLY a JSON object matching the schema. No markdown fences, no prose.\n\n" +
    `--- CHARACTER SCHEMA GUIDE ---\n${guide}\n--- END GUIDE ---`
  );
}

function validateCharacter(parsed: unknown, sourceAssetId: string): Character {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Vision model did not return a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    const value = obj[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Vision model returned missing/empty required field: ${field}`);
    }
  }
  const character: Character = {
    age: String(obj.age),
    gender_presentation: String(obj.gender_presentation),
    ethnicity: String(obj.ethnicity),
    height: String(obj.height),
    build: String(obj.build),
    bust: String(obj.bust),
    waist: String(obj.waist),
    hips: String(obj.hips),
    glutes: String(obj.glutes),
    face: String(obj.face),
    hair: String(obj.hair),
    eyes: String(obj.eyes),
    skin: String(obj.skin),
    distinguishing_features: String(obj.distinguishing_features),
    source_image_asset_id: sourceAssetId,
  };
  if (typeof obj.name === "string" && obj.name.trim()) character.name = obj.name.trim();
  return character;
}

export async function extractCharacterFromBytes(
  bytes: Buffer,
  mime: "image/jpeg" | "image/png" | "image/webp",
  sourceAssetId: string,
  responses?: ResponsesFn,
): Promise<Character> {
  const fn = responses ?? buildResponses(process.env.XAI_API_KEY);
  const guide = await readFile(GUIDE_PATH, "utf-8");
  const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
  const response = await fn({
    model: VISION_MODEL,
    instructions: buildSystemPrompt(guide),
    input: [{
      role: "user",
      content: [
        { type: "input_image", image_url: dataUrl, detail: "high" },
        { type: "input_text", text: "Extract the character profile as specified." },
      ],
    }],
    text: { format: { type: "json_object" } },
    temperature: 0.4,
    max_output_tokens: 2048,
  });
  const content = firstResponseText(response);
  if (!content) {
    throw new Error(`Vision provider returned no content (status=${response.status})`);
  }
  const parsed = JSON.parse(content) as unknown;
  return validateCharacter(parsed, sourceAssetId);
}

export function registerExtractCharacterJob(fs: ClipfirstFs): void {
  registerJobHandler("extract_character", async (payload) => {
    const {
      charAssetId,
      sourceAssetId,
      sourceImageFilename,
      projectSlug,
    } = payload as ExtractCharacterPayload;

    console.log(
      `[extract_character] START char=${charAssetId} source=${sourceAssetId} project=${projectSlug}`,
    );

    let imageFilename = sourceImageFilename;
    if (!imageFilename) {
      const manifest = await fs.getManifest(sourceAssetId, projectSlug);
      if (!manifest.ok) {
        throw new Error(
          `Failed to read manifest for source ${sourceAssetId}: ${manifest.error.message}`,
        );
      }
      const imageFile = findImageFile(manifest.value.files);
      if (!imageFile) {
        throw new Error(`No image file found in source asset ${sourceAssetId}`);
      }
      imageFilename = imageFile.name;
    }

    const readResult = await fs.readFile(sourceAssetId, imageFilename, projectSlug);
    if (!readResult.ok) {
      throw new Error(
        `Failed to read image ${imageFilename} for ${sourceAssetId}: ${readResult.error.message}`,
      );
    }
    const buffer = Buffer.from(readResult.value);
    const mime = mimeForImageFilename(imageFilename);

    const character = await extractCharacterFromBytes(buffer, mime, sourceAssetId);

    const writeResult = await fs.writeMetadata(
      charAssetId,
      CHARACTER_METADATA_KEY,
      character,
      projectSlug,
    );
    if (!writeResult.ok) {
      throw new Error(
        `Failed to write character profile to ${charAssetId}: ${writeResult.error.message}`,
      );
    }

    await fs.writeMetadata(
      charAssetId,
      "character-extraction",
      {
        origin: "extract_character",
        sourceAssetId,
        model: VISION_MODEL,
        processed_at: new Date().toISOString(),
      },
      projectSlug,
    );

    console.log(
      `[extract_character] DONE char=${charAssetId} source=${sourceAssetId}`,
    );
    return { success: true, charAssetId, sourceAssetId };
  });
}
