import type { VideocityFs } from "vc-engine";
import { z, type ZodRawShape } from "zod";
import type { SchemaArgs, ToolDef, ToolResult } from "./tool-def.js";
import { generateNanoBananaProEditFalDef } from "./generate-nano-banana-pro-edit-fal.js";
import { generateQwenImageEditFalDef } from "./generate-qwen-image-edit-fal.js";
import { generateWan27ProEditFalDef } from "./generate-wan27-pro-edit-fal.js";
import { generateSeedreamV5LiteEditFalDef } from "./generate-seedream-v5-lite-edit-fal.js";
import { generateNanoBananaImageDef } from "./generate-nano-banana-image.js";
import { generateQwen2ImageEditDef } from "./generate-qwen2-image-edit.js";
import { generateGptImageDef } from "./generate-gpt-image.js";
import { generateWan27ImageProDef } from "./generate-wan27-image-pro.js";
import { generateSeedreamImageDef } from "./generate-seedream-image.js";
import {
  SUPPORTED_OUTFIT_MODELS,
  OUTFIT_PROVIDERS,
  WAN_QWEN_NEGATIVE,
  type OutfitModelKey,
  type OutfitProvider,
} from "./generate-outfit.js";
import {
  CHARACTER_METADATA_KEY,
  isAnimalSubject,
  isFreeformSubject,
  isOtherSubject,
  normalizeCharacterProfile,
  type Character,
  type CharacterSubjectKind,
} from "../jobs/extract-character.js";

const CHARACTER_PROFILE_SCHEMA = z.object({
  name: z.string().optional(),
  subject_kind: z.enum(["female", "male", "animal", "other"]).optional(),
  age: z.string().optional(),
  ethnicity: z.string().optional(),
  height: z.string().optional(),
  build: z.string().optional(),
  bust: z.string().optional(),
  waist: z.string().optional(),
  hips: z.string().optional(),
  face: z.string().optional(),
  hair: z.string().optional(),
  eyes: z.string().optional(),
  skin: z.string().optional(),
  other: z.string().optional(),
  source_image_asset_id: z.string(),
}).passthrough();

export type CharacterPromptProfile = z.infer<typeof CHARACTER_PROFILE_SCHEMA>;
type CharacterProfile = Character & { subject_kind: CharacterSubjectKind };

const schema = {
  project_slug: z.string().describe("Project slug"),
  source_image_slug: z.string().describe("@img-* slug of the identity reference photo (used as the visual anchor for the generated character sheet)"),
  additional_reference_image_slugs: z
    .array(z.string())
    .max(2)
    .optional()
    .describe("Optional additional @img-* identity/reference images. Up to 2 extra images are accepted, for 3 total identity references including source_image_slug."),
  profile: CHARACTER_PROFILE_SCHEMA.describe("Structured Character profile. Drives the generation prompt; user-edited values override what vision extracted."),
  models: z
    .array(z.enum(SUPPORTED_OUTFIT_MODELS))
    .min(1)
    .describe("Image-edit models to run. One char-* asset enqueued per model."),
  provider: z
    .enum(OUTFIT_PROVIDERS)
    .optional()
    .describe("Image-edit provider (kie | fal). Defaults to kie."),
  outfit_text: z
    .string()
    .optional()
    .describe("Optional free-text override of the wardrobe to render the body shots in (e.g. 'plain white t-shirt and dark jeans'). For animals/other subjects, use only explicit accessories/costumes. When unset, humans default to a sex-appropriate skin-tone baseline garment, animals render natural, and 'other' subjects render as-is."),
  outfit_image_slug: z
    .string()
    .optional()
    .describe("Optional @img-* slug of a garment/accessory reference. When supplied, the body shots in the sheet will dress the subject in this clothing or adapt the accessory/costume for animals/other subjects."),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

type ToolDefFactory = (fs: VideocityFs) => { handler: (args: Record<string, unknown>) => Promise<ToolResult> };

const DISPATCH: Record<OutfitProvider, Partial<Record<OutfitModelKey, ToolDefFactory>>> = {
  kie: {
    nano_banana_pro: generateNanoBananaImageDef,
    qwen_image_edit: generateQwen2ImageEditDef,
    gpt_image_2: generateGptImageDef,
    wan27_pro: generateWan27ImageProDef,
    seedream_v5_lite: generateSeedreamImageDef,
  },
  fal: {
    nano_banana_pro: generateNanoBananaProEditFalDef,
    qwen_image_edit: generateQwenImageEditFalDef,
    wan27_pro: generateWan27ProEditFalDef,
    seedream_v5_lite: generateSeedreamV5LiteEditFalDef,
  },
};

interface CharacterOutcome {
  model: OutfitModelKey;
  provider: OutfitProvider;
  prompt: string;
  char_asset_id?: string;
  job_id?: string;
  /** Hard failure — no job was enqueued for this slot. */
  error?: string;
  /** Soft failure — the job is running, but the embedded character profile
   *  sidecar wasn't written. CharacterDialog will fall back to re-extracting
   *  on next open instead of seeding from cached metadata. */
  profile_error?: string;
}

const HUMAN_BODY_FIELDS: Array<keyof CharacterProfile> = [
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

function normalizeProfile(p: CharacterPromptProfile): CharacterProfile {
  const base = normalizeCharacterProfile(p, p.source_image_asset_id);
  if (isFreeformSubject(base.subject_kind)) {
    if (!base.other || !base.other.trim()) {
      throw new Error(`profile.other is required for ${base.subject_kind} profiles`);
    }
  } else {
    for (const field of HUMAN_BODY_FIELDS) {
      const value = base[field];
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(`profile.${field} is required for ${base.subject_kind} profiles`);
      }
    }
  }
  return base as CharacterProfile;
}

function profileSubjectSentence(p: CharacterProfile): string {
  if (isFreeformSubject(p.subject_kind)) {
    return `${p.other}.`;
  }
  return `${p.age} ${p.subject_kind} of ${p.ethnicity} heritage, ${p.height}, ${p.build} build.`;
}

function profileDetailLines(p: CharacterProfile): string {
  if (isFreeformSubject(p.subject_kind)) {
    return "";
  }
  const chestLabel = p.subject_kind === "male" ? "chest" : "bust";
  const lines = [
    `Body: ${chestLabel} ${p.bust}; waist ${p.waist}; hips ${p.hips}`,
    `Face: ${p.face}`,
    `Hair: ${p.hair}`,
    `Eyes: ${p.eyes}`,
    `Skin: ${p.skin}`,
  ];
  return lines.join(". ") + ".";
}

const HUMAN_FEMALE_SHEET_LAYOUT =
  "A 2x2 character reference sheet on a clean white seamless studio background with even soft natural lighting. " +
  "Top-left quadrant: tight head-and-neck profile portrait, the subject's face in clean side view looking to the right; " +
  "tightly cropped just below the chin/neck so NO clothing, NO bra straps, NO necklines and NO shoulder garments are visible — only face, hair, ears and bare neck. " +
  "HAIR DOWN in this quadrant: hair worn loose, falling naturally past the shoulders so its length, texture and natural fall are visible. " +
  "Top-right quadrant: tight head-and-neck front portrait, the subject's face directly to camera; " +
  "same tight head-and-neck crop — NO clothing, NO bra straps, NO necklines and NO shoulder garments visible, only face, hair, ears and bare neck. " +
  "HAIR UP in this quadrant: hair pulled back into a clean low tie that fully exposes the ears, jawline and hairline so face structure reads cleanly. " +
  "Bottom-left quadrant: full-body 3/4 front angle, the subject standing, body rotated about 30 degrees to the camera's right while the face turns slightly back toward camera, arms relaxed at the sides — clearly showing the front-and-side silhouette so the 3D form of the body reads. " +
  "HAIR DOWN in this quadrant: hair worn loose over the shoulders. " +
  "Bottom-right quadrant: full-body 3/4 back angle, the subject standing with their back largely toward camera but the body rotated about 30 degrees so the camera sees one side and the back together, arms relaxed at the sides, head looking away — clearly showing the back-and-side silhouette so the 3D form reads. " +
  "HAIR UP in this quadrant: hair pulled back into a clean tie that exposes the nape and the line of the neck and shoulders. " +
  "The four quadrants must show the same person with the same hair color/length/texture; only the styling (down vs. tied back) differs across quadrants — half of the sheet shows the hair down, half shows it up.";

const HUMAN_MALE_SHEET_LAYOUT =
  "A 2x2 character reference sheet on a clean white seamless studio background with even soft natural lighting. " +
  "Top-left quadrant: tight head-and-neck profile portrait, the subject's face in clean side view looking to the right; tightly cropped just below the chin/neck so NO clothing, NO straps, NO necklines and NO shoulder garments are visible — only face, ears, bare neck, facial hair if present, and the exact hairstyle from Reference Image 1. " +
  "Top-right quadrant: tight head-and-neck front portrait, the subject's face directly to camera with the exact same hairstyle, hairline, length, volume, part, facial hair, and grooming from Reference Image 1. " +
  "Bottom-left quadrant: full-body 3/4 front angle, the subject standing, body rotated about 30 degrees to the camera's right while the face turns slightly back toward camera, arms relaxed at the sides — clearly showing the front-and-side silhouette so the 3D form of the body reads. " +
  "Bottom-right quadrant: full-body 3/4 back angle, the subject standing with their back largely toward camera but the body rotated about 30 degrees so the camera sees one side and the back together, arms relaxed at the sides, head looking away — clearly showing the back-and-side silhouette so the 3D form reads. " +
  "All four quadrants must keep the same hairstyle from Reference Image 1 exactly; do not tie back, restyle, lengthen, shorten, add bangs, remove bangs, change the part, or change facial hair.";

const ANIMAL_SHEET_LAYOUT =
  "A 2x2 animal character reference sheet on a clean white seamless studio background with even soft natural lighting. " +
  "Top-left quadrant: tight side head profile, the animal's head in clean side view looking to the right, showing muzzle or beak shape, ears, whisker pads if present, and coat/fur markings. " +
  "Top-right quadrant: tight front head portrait, the animal facing directly toward camera, showing eyes, ears, muzzle, facial markings, and head symmetry. " +
  "Bottom-left quadrant: full-body 3/4 front view in a natural standing pose appropriate to the species, showing chest/torso, legs, paws or hooves if present, tail if visible, and front-and-side body silhouette. " +
  "Bottom-right quadrant: full-body 3/4 rear view in a natural standing pose appropriate to the species, showing back, hindquarters, tail or tail base, coat/fur markings, and rear-and-side body silhouette. " +
  "The four quadrants must show the same animal with the same coat/fur color, markings, length, texture, eye color, ear shape, tail shape, and body proportions. Use natural species-appropriate posture in every quadrant.";

const OTHER_SHEET_LAYOUT =
  "A 2x2 subject reference sheet on a clean white seamless studio background with even soft natural lighting. " +
  "Top-left quadrant: tight head/upper-section side profile of the subject in clean side view looking to the right, showing top contour, surface detail, material structure and any face/feature elements. " +
  "Top-right quadrant: tight head/upper-section front view of the subject directly to camera, showing front-facing structure, symmetry, surface texture and any face/feature elements. " +
  "Bottom-left quadrant: full-body 3/4 front angle, the subject in its natural standing/upright orientation rotated about 30 degrees to the camera's right — clearly showing the front-and-side silhouette so the 3D form of the subject reads. " +
  "Bottom-right quadrant: full-body 3/4 back angle, the subject rotated about 30 degrees so the camera sees one side and the back together — clearly showing the back-and-side silhouette so the 3D form reads. " +
  "The four quadrants must show the same subject with the same form, materials, surface, color, markings, and proportions as Reference Image 1.";

const HUMAN_STYLE_TAIL =
  "Photographic, editorial fashion-documentation style. " +
  "Preserve the subject's identity from Reference Image 1 — face structure, hair texture, skin tone — exactly. " +
  "Render as one cohesive 1:1 square image with the four quadrants clearly separated by thin gutters of white background.";

const ANIMAL_STYLE_TAIL =
  "Photographic, natural-history reference style. " +
  "Preserve the animal's identity from Reference Image 1 — head shape, coat/fur texture, markings, eye color, ear shape, tail shape, and body proportions — exactly. " +
  "Render as one cohesive 1:1 square image with the four quadrants clearly separated by thin gutters of white background.";

const OTHER_STYLE_TAIL =
  "Photographic reference style. " +
  "Preserve the subject's identity from Reference Image 1 — overall form, materials, surface texture, color, markings, structural detail, and proportions — exactly. " +
  "Render as one cohesive 1:1 square image with the four quadrants clearly separated by thin gutters of white background.";

function identityReferenceClause(identityRefCount: number): string {
  if (identityRefCount <= 1) {
    return "Reference Image 1 is the primary identity reference.";
  }
  return (
    `Reference Images 1-${identityRefCount} are identity references for the same subject. ` +
    "Use them together for face/head structure, body proportions, surface texture, markings and identity consistency. " +
    "Reference Image 1 remains the primary reference for hairstyle or coat/fur appearance when references conflict."
  );
}

function sheetLayout(p: CharacterProfile): string {
  switch (p.subject_kind) {
    case "female":
      return HUMAN_FEMALE_SHEET_LAYOUT;
    case "male":
      return HUMAN_MALE_SHEET_LAYOUT;
    case "animal":
      return ANIMAL_SHEET_LAYOUT;
    case "other":
      return OTHER_SHEET_LAYOUT;
  }
}

function styleTail(p: CharacterProfile): string {
  if (isAnimalSubject(p.subject_kind)) return ANIMAL_STYLE_TAIL;
  if (isOtherSubject(p.subject_kind)) return OTHER_STYLE_TAIL;
  return HUMAN_STYLE_TAIL;
}

export function defaultCharacterWardrobeClause(subjectKind: CharacterSubjectKind): string {
  if (subjectKind === "male") {
    return (
      "Wardrobe for the body shots (bottom quadrants only): smooth skin-tone fitted boxer briefs or athletic trunks, color closely matched to the subject's own skin tone, no patterns, no logos. " +
      "The upper torso is bare natural skin with visible chest and shoulders; no bra, no chest binder, no camisole, no crop top, no straps and no breast-covering garment. " +
      "The garments should read as a clean baseline so the body's silhouette is the dominant signal. Top quadrants stay tightly cropped to bare head and neck."
    );
  }
  return (
    "Wardrobe for the body shots (bottom quadrants only): a smooth skin-tone undergarment set — a plain bra top with thick straps and matching high-waist briefs, " +
    "color closely matched to the subject's own skin tone, no patterns, no logos, no lace. The garments should read as a clean baseline so the body's silhouette is the dominant signal. " +
    "Top quadrants stay tightly cropped to bare head and neck."
  );
}

function freeformWardrobeClause(
  outfitText: string | undefined,
  outfitRefIndex: number | null,
  subjectKind: CharacterSubjectKind,
): string {
  const outfitRef = outfitRefIndex ? `Reference Image ${outfitRefIndex}` : "the accessory/costume reference";
  const preserveLine = isAnimalSubject(subjectKind)
    ? "Preserve the animal's anatomy, coat/fur markings, and species-appropriate posture."
    : "Preserve the subject's core form, materials, surface, and structural proportions.";
  if (outfitRefIndex && outfitText?.trim()) {
    const noun = isAnimalSubject(subjectKind) ? "animal accessory or costume" : "accessory or modification";
    return (
      `Optional ${noun} for the body shots only: adapt the item shown in ${outfitRef} (${outfitText.trim()}) to the subject only if it can fit naturally. ` +
      preserveLine
    );
  }
  if (outfitRefIndex) {
    const noun = isAnimalSubject(subjectKind) ? "animal accessory or costume" : "accessory or modification";
    return (
      `Optional ${noun} for the body shots only: adapt the item shown in ${outfitRef} to the subject only if it can fit naturally. ` +
      preserveLine
    );
  }
  if (outfitText?.trim()) {
    const noun = isAnimalSubject(subjectKind) ? "animal accessory or costume" : "accessory or modification";
    return (
      `Optional ${noun} for the body shots only: ${outfitText.trim()}. ` +
      preserveLine
    );
  }
  return isAnimalSubject(subjectKind)
    ? "No wardrobe: render the animal natural with no clothing or accessories."
    : "No wardrobe: render the subject as-is with no added clothing or accessories.";
}

function wardrobeClause(outfitText: string | undefined, outfitRefIndex: number | null, p: CharacterProfile): string {
  if (isFreeformSubject(p.subject_kind)) {
    return freeformWardrobeClause(outfitText, outfitRefIndex, p.subject_kind);
  }
  const outfitRef = outfitRefIndex ? `Reference Image ${outfitRefIndex}` : "the clothing reference";
  if (outfitRefIndex && outfitText?.trim()) {
    return (
      `Wardrobe for the body shots (bottom quadrants only): dress the subject in the clothing shown in ${outfitRef} (${outfitText.trim()}). ` +
      "Match the garment exactly — color, cut, fabric, prints. Top quadrants stay tightly cropped to bare head and neck."
    );
  }
  if (outfitRefIndex) {
    return (
      `Wardrobe for the body shots (bottom quadrants only): dress the subject in the clothing shown in ${outfitRef}. ` +
      "Match the garment exactly — color, cut, fabric, prints. Top quadrants stay tightly cropped to bare head and neck."
    );
  }
  if (outfitText?.trim()) {
    return (
      `Wardrobe for the body shots (bottom quadrants only): ${outfitText.trim()}. ` +
      "Top quadrants stay tightly cropped to bare head and neck."
    );
  }
  return defaultCharacterWardrobeClause(p.subject_kind);
}

function buildPrompt(
  p: CharacterProfile,
  model: OutfitModelKey,
  provider: OutfitProvider,
  outfitText: string | undefined,
  identityRefCount: number,
  outfitRefIndex: number | null,
): string {
  const subject = profileSubjectSentence(p);
  const details = profileDetailLines(p);
  const wardrobe = wardrobeClause(outfitText, outfitRefIndex, p);
  const subjectBlock = details ? `Subject: ${subject} ${details}` : `Subject: ${subject}`;
  const base =
    `${sheetLayout(p)}\n\n` +
    `${identityReferenceClause(identityRefCount)}\n\n` +
    `${subjectBlock}\n\n` +
    `${wardrobe}\n\n` +
    `${styleTail(p)}`;
  if (provider === "kie" && (model === "wan27_pro" || model === "qwen_image_edit")) {
    return `${base} Avoid: ${WAN_QWEN_NEGATIVE}.`;
  }
  return base;
}

export function buildCharacterPrompt(
  p: CharacterPromptProfile,
  model: OutfitModelKey,
  provider: OutfitProvider,
  outfitText: string | undefined,
  identityRefCount = 1,
  outfitRefIndex: number | null = null,
): string {
  return buildPrompt(normalizeProfile(p), model, provider, outfitText, identityRefCount, outfitRefIndex);
}

function withAt(slug: string): string {
  if (slug.startsWith("http://") || slug.startsWith("https://")) return slug;
  return slug.startsWith("@") ? slug : `@${slug}`;
}

function slugKey(slug: string): string {
  return slug.replace(/^@/, "");
}

function uniqueAdditionalRefs(sourceRef: string, refs: string[] | undefined): string[] {
  const seen = new Set([slugKey(sourceRef)]);
  const unique: string[] = [];
  for (const ref of refs ?? []) {
    const normalized = withAt(ref);
    const key = slugKey(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
    if (unique.length >= 2) break;
  }
  return unique;
}

function imageRefLimitError(provider: OutfitProvider, model: OutfitModelKey, imageRefCount: number): string | null {
  if (provider === "kie" && model === "qwen_image_edit" && imageRefCount > 3) {
    return "Kie Qwen Image Edit supports at most 3 total input images. Remove an extra identity reference or the outfit image, or choose another model.";
  }
  if (provider === "fal" && model === "qwen_image_edit" && imageRefCount > 1) {
    return "Fal Qwen Image Edit uses only one input image. Remove extra references/outfit images or choose another model.";
  }
  if (provider === "fal" && model === "wan27_pro" && imageRefCount > 4) {
    return "Fal Wan 2.7 Pro supports at most 4 total input images.";
  }
  return null;
}

function extractEnqueueResult(res: ToolResult): { assetId?: string; jobId?: string; error?: string } {
  if (res.isError) {
    const content = res.content as Array<{ type: string; text: string }>;
    return { error: content[0]?.text ?? "enqueue failed" };
  }
  const content = res.content as Array<{ type: string; text: string }>;
  try {
    const parsed = JSON.parse(content[0].text) as { img_asset_id?: string; job_id?: string };
    return { assetId: parsed.img_asset_id, jobId: parsed.job_id };
  } catch {
    return { error: "could not parse enqueue response" };
  }
}

function aspectRatioArgs(provider: OutfitProvider, model: OutfitModelKey): Record<string, string> {
  // Character sheet is always 1:1. Map to each model's expected key.
  if (provider === "kie" && model !== "qwen_image_edit") return { aspect_ratio: "1:1" };
  if (model === "qwen_image_edit") return { image_size: "1:1" };
  if (provider === "fal" && model === "nano_banana_pro") return { aspect_ratio: "1:1" };
  if (provider === "fal" && model === "wan27_pro") return { image_size: "square_hd" };
  if (provider === "fal" && model === "seedream_v5_lite") return { image_size: "square_hd" };
  return {};
}

export function generateCharacterDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_character",
    description:
      "Generate a 4-up character reference sheet (female | male | animal | other) from a structured Character profile " +
      "and one to three identity reference images. Creates one new char-* asset " +
      "per selected model and writes the profile to that asset's .character.json metadata. The " +
      "source image is passed as the primary identity reference. Aspect ratio is fixed at 1:1.",
    schema,
    handler: async (args) => {
      const a = args as Args;
      let profile: CharacterProfile;
      try {
        profile = normalizeProfile(a.profile);
      } catch (error) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
        };
      }
      const provider: OutfitProvider = a.provider ?? "kie";
      const providerEnvKey = provider === "kie" ? "KIE_API_KEY" : "FAL_API_KEY";
      if (!process.env[providerEnvKey]) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `${providerEnvKey} environment variable is not set` }],
        };
      }

      const sourceRef = withAt(a.source_image_slug);
      const additionalRefs = uniqueAdditionalRefs(sourceRef, a.additional_reference_image_slugs);
      const identityRefs = [sourceRef, ...additionalRefs];
      const identityRefKeys = new Set(identityRefs.map(slugKey));
      const requestedOutfitRef = a.outfit_image_slug ? withAt(a.outfit_image_slug) : null;
      const outfitRef = requestedOutfitRef && !identityRefKeys.has(slugKey(requestedOutfitRef))
        ? requestedOutfitRef
        : null;
      const outfitRefIndex = outfitRef ? identityRefs.length + 1 : null;
      const imageRefs = outfitRef ? [...identityRefs, outfitRef] : identityRefs;
      const outcomes: CharacterOutcome[] = [];

      for (const model of a.models) {
        const factory = DISPATCH[provider][model];
        const prompt = buildPrompt(profile, model, provider, a.outfit_text, identityRefs.length, outfitRefIndex);
        const outcome: CharacterOutcome = { model, provider, prompt };
        if (!factory) {
          outcome.error = `model ${model} is not available via provider ${provider}`;
          outcomes.push(outcome);
          continue;
        }
        const limitError = imageRefLimitError(provider, model, imageRefs.length);
        if (limitError) {
          outcome.error = limitError;
          outcomes.push(outcome);
          continue;
        }
        const def = factory(fs);
        const nativeNegative =
          provider === "fal" && (model === "qwen_image_edit" || model === "wan27_pro");
        const seedreamKieQuality =
          provider === "kie" && model === "seedream_v5_lite";
        let res: ToolResult;
        try {
          res = await def.handler({
            project_slug: a.project_slug,
            prompt,
            image_slugs: imageRefs,
            output_prefix: "char",
            ...aspectRatioArgs(provider, model),
            ...(nativeNegative ? { negative_prompt: WAN_QWEN_NEGATIVE } : {}),
            ...(seedreamKieQuality ? { quality: "high" } : {}),
          } as unknown as Record<string, unknown>);
        } catch (error: unknown) {
          // writePendingTask now throws on metadata-write failure (e.g. SQLite
          // readonly). Catch per-model so one failed slot doesn't kill the
          // whole sheet, and surface the message in the response.
          outcome.error = error instanceof Error ? error.message : String(error);
          outcomes.push(outcome);
          continue;
        }
        const r = extractEnqueueResult(res);
        if (r.error) {
          outcome.error = r.error;
          outcomes.push(outcome);
          continue;
        }
        if (r.assetId) {
          outcome.char_asset_id = r.assetId;
          // Persist the profile alongside the generated image so the asset is
          // self-describing. The CharacterDialog reads this back via
          // read_asset_metadata to seed the editable form on next open.
          const profileWithSlots = {
            ...profile,
            wardrobe: [],
            poses: [],
            outfits: [],
          };
          const writeRes = await fs.writeMetadata(
            r.assetId,
            CHARACTER_METADATA_KEY,
            profileWithSlots,
            a.project_slug,
          );
          if (!writeRes.ok) {
            // Job is already enqueued at this point — don't flip the slot to
            // "failed" (which would mask a running generation). Surface the
            // profile-write failure separately so the caller can warn without
            // losing track of the in-flight job.
            outcome.profile_error = `Failed to write character profile for ${r.assetId}: ${writeRes.error.message}`;
          }
        }
        if (r.jobId) outcome.job_id = r.jobId;
        outcomes.push(outcome);
      }

      const enqueued = outcomes.filter((o) => !o.error).length;
      const failed = outcomes.filter((o) => !!o.error).length;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: enqueued > 0 ? "enqueued" : "failed",
            enqueued,
            failed,
            outcomes,
          }),
        }],
      };
    },
  };
}
