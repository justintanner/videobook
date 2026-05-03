import type { ClipfirstFs } from "clipfirst-engine";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { withLocalLease } from "./_lease.js";
import {
  buildResponses,
  firstResponseText,
  mimeForImageFilename,
  type ResponsesFn,
} from "./describe-image.js";
import { findImageFile } from "../tools/_image-inputs.js";

export type CharacterSubjectKind = "female" | "male" | "animal" | "other";

export type Character = {
  name?: string;
  subject_kind: CharacterSubjectKind;
  // female / male only
  age?: string;
  ethnicity?: string;
  height?: string;
  build?: string;
  bust?: string;
  waist?: string;
  hips?: string;
  face?: string;
  hair?: string;
  eyes?: string;
  skin?: string;
  // animal / other only
  other?: string;
  source_image_asset_id: string;
  wardrobe?: string[];
  poses?: string[];
  backdrop?: string[];
  outfits?: string[];
};

type HumanStringField =
  | "age"
  | "ethnicity"
  | "height"
  | "build"
  | "bust"
  | "waist"
  | "hips"
  | "face"
  | "hair"
  | "eyes"
  | "skin";

const HUMAN_REQUIRED_FIELDS: HumanStringField[] = [
  "age",
  "ethnicity",
  "height",
  "build",
  "bust",
  "waist",
  "hips",
  "face",
  "hair",
  "eyes",
  "skin",
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
export const VISION_MODEL = "gpt-5.4";

export const isHumanSubject = (k: CharacterSubjectKind): boolean =>
  k === "female" || k === "male";

export const isAnimalSubject = (k: CharacterSubjectKind): boolean =>
  k === "animal";

export const isOtherSubject = (k: CharacterSubjectKind): boolean =>
  k === "other";

export const isFreeformSubject = (k: CharacterSubjectKind): boolean =>
  k === "animal" || k === "other";

export function normalizeCharacterSubjectKind(
  obj: { subject_kind?: unknown },
): CharacterSubjectKind {
  const rawKind = typeof obj.subject_kind === "string" ? obj.subject_kind.trim().toLowerCase() : "";
  if (rawKind === "female" || rawKind === "male" || rawKind === "animal" || rawKind === "other") {
    return rawKind;
  }
  return "male";
}

function strField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v.trim() : "";
}

function passthroughSlots(src: Record<string, unknown>, dst: Character): void {
  for (const k of ["wardrobe", "poses", "backdrop", "outfits"] as const) {
    const v = src[k];
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      dst[k] = v as string[];
    }
  }
}

export function normalizeCharacterProfile(
  raw: unknown,
  sourceAssetId: string,
): Character {
  const obj: Record<string, unknown> = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const subjectKind = normalizeCharacterSubjectKind(obj);
  const sourceId = strField(obj, "source_image_asset_id") || sourceAssetId;
  const character: Character = {
    subject_kind: subjectKind,
    source_image_asset_id: sourceId,
  };
  const name = strField(obj, "name");
  if (name) character.name = name;
  passthroughSlots(obj, character);

  if (isFreeformSubject(subjectKind)) {
    const other = strField(obj, "other");
    if (other) character.other = other;
    return character;
  }

  for (const k of HUMAN_REQUIRED_FIELDS) {
    const v = strField(obj, k);
    if (v) character[k] = v;
  }
  return character;
}

function subjectKindOverrideClause(kind: CharacterSubjectKind): string {
  switch (kind) {
    case "male":
      return (
        "SUBJECT KIND OVERRIDE: the user has chosen `male`. Set `subject_kind` to `male` and describe the subject as a human male. " +
        "Body fields must use male anatomy descriptors: `bust` is chest width, pectoral fullness and ribcage taper (NEVER bra cup sizes); " +
        "`hips` is hip width and seat without bust/cup language. Adjust `face`, `hair`, `build` accordingly. " +
        "If the photograph is androgynous or stylized, commit to a plausible male reading rather than refusing."
      );
    case "female":
      return (
        "SUBJECT KIND OVERRIDE: the user has chosen `female`. Set `subject_kind` to `female` and describe the subject as a human female. " +
        "Use the female body field rules from the guide. If the photograph is androgynous or stylized, commit to a plausible female reading."
      );
    case "animal":
      return (
        "SUBJECT KIND OVERRIDE: the user has chosen `animal`. Set `subject_kind` to `animal` and fill ONLY the freeform `other` field per the guide."
      );
    case "other":
      return (
        "SUBJECT KIND OVERRIDE: the user has chosen `other`. Set `subject_kind` to `other` and fill ONLY the freeform `other` field per the guide."
      );
  }
}

function buildSystemPrompt(guide: string, subjectKindOverride?: CharacterSubjectKind): string {
  const override = subjectKindOverride ? `\n\n${subjectKindOverrideClause(subjectKindOverride)}` : "";
  return (
    "You are an expert visual analyst extracting a structured character profile from a photograph. " +
    "Follow the guide exactly. Return ONLY a JSON object matching the schema. No markdown fences, no prose.\n\n" +
    `--- CHARACTER SCHEMA GUIDE ---\n${guide}\n--- END GUIDE ---${override}`
  );
}

function validateCharacter(parsed: unknown, sourceAssetId: string): Character {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Vision model did not return a JSON object");
  }
  const character = normalizeCharacterProfile(parsed, sourceAssetId);
  if (isFreeformSubject(character.subject_kind)) {
    if (!character.other || !character.other.trim()) {
      throw new Error(
        `Vision model returned missing/empty required field: other (subject_kind=${character.subject_kind})`,
      );
    }
    return character;
  }
  for (const field of HUMAN_REQUIRED_FIELDS) {
    const value = character[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Vision model returned missing/empty required field: ${field}`);
    }
  }
  return character;
}

export interface ExtractCharacterOptions {
  responses?: ResponsesFn;
  subjectKindOverride?: CharacterSubjectKind;
}

export async function extractCharacterFromBytes(
  bytes: Buffer,
  mime: "image/jpeg" | "image/png" | "image/webp",
  sourceAssetId: string,
  options: ExtractCharacterOptions = {},
): Promise<Character> {
  const fn = options.responses ?? buildResponses(requireApiKey("OPENAI_API_KEY"));
  const guide = await readFile(GUIDE_PATH, "utf-8");
  const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
  const userText = options.subjectKindOverride
    ? `Extract the character profile as a JSON object matching the schema in the guide. The user has explicitly chosen subject_kind = '${options.subjectKindOverride}'; honor that override.`
    : "Extract the character profile as a JSON object matching the schema in the guide.";
  const response = await fn({
    model: VISION_MODEL,
    instructions: buildSystemPrompt(guide, options.subjectKindOverride),
    input: [{
      role: "user",
      content: [
        { type: "input_image", image_url: dataUrl, detail: "high" },
        { type: "input_text", text: userText },
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
  registerJobHandler("extract_character", async (payload, ctx) => {
    const {
      charAssetId,
      sourceAssetId,
      sourceImageFilename,
      projectSlug,
    } = payload as ExtractCharacterPayload;

    return withLocalLease(fs, projectSlug, charAssetId, ctx, "extract", async () => {
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

    return { success: true, charAssetId, sourceAssetId };
    });
  });
}
