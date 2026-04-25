import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
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
import { CHARACTER_METADATA_KEY } from "../jobs/extract-character.js";

const CHARACTER_PROFILE_SCHEMA = z.object({
  name: z.string().optional(),
  age: z.string(),
  gender_presentation: z.string(),
  ethnicity: z.string(),
  height: z.string(),
  build: z.string(),
  face: z.string(),
  hair: z.string(),
  eyes: z.string(),
  skin: z.string(),
  distinguishing_features: z.string(),
  wardrobe_style: z.string().optional(),
  vibe: z.string().optional(),
  backstory: z.string().optional(),
  source_image_asset_id: z.string(),
});

type CharacterProfile = z.infer<typeof CHARACTER_PROFILE_SCHEMA>;

const schema = {
  project_slug: z.string().describe("Project slug"),
  source_image_slug: z.string().describe("@img-* slug of the identity reference photo (used as the visual anchor for the generated character sheet)"),
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
    .describe("Optional free-text override of the wardrobe to render the body shots in (e.g. 'plain white t-shirt and dark jeans'). When unset, the model picks neutral form-fitting clothing."),
  outfit_image_slug: z
    .string()
    .optional()
    .describe("Optional @img-* slug of a garment reference. When supplied, the body shots in the sheet will dress the subject in this clothing. Passed as a second reference image."),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

type ToolDefFactory = (fs: ClipfirstFs) => { handler: (args: Record<string, unknown>) => Promise<ToolResult> };

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
  error?: string;
}

function profileSubjectSentence(p: CharacterProfile): string {
  const bits: string[] = [];
  bits.push(`${p.age} ${p.gender_presentation} of ${p.ethnicity} heritage`);
  bits.push(`${p.height}, ${p.build} build`);
  return bits.join(", ") + ".";
}

function profileDetailLines(p: CharacterProfile): string {
  const lines: string[] = [];
  lines.push(`Face: ${p.face}`);
  lines.push(`Hair: ${p.hair}`);
  lines.push(`Eyes: ${p.eyes}`);
  lines.push(`Skin: ${p.skin}`);
  lines.push(`Distinguishing features: ${p.distinguishing_features}`);
  if (p.wardrobe_style?.trim()) lines.push(`Wardrobe: ${p.wardrobe_style.trim()}`);
  return lines.join(". ") + ".";
}

const SHEET_LAYOUT =
  "A 2x2 character reference sheet on a clean white seamless studio background with even soft natural lighting. " +
  "Top-left quadrant: tight head-and-neck profile portrait, the subject's face in clean side view looking to the right; " +
  "tightly cropped just below the chin/neck so NO clothing, NO bra straps, NO necklines and NO shoulder garments are visible — only face, hair, ears and bare neck. " +
  "Top-right quadrant: tight head-and-neck front portrait, the subject's face directly to camera; " +
  "same tight head-and-neck crop — NO clothing, NO bra straps, NO necklines and NO shoulder garments visible, only face, hair, ears and bare neck. " +
  "Bottom-left quadrant: full-body 3/4 front angle, the subject standing, body rotated about 30 degrees to the camera's right while the face turns slightly back toward camera, arms relaxed at the sides — clearly showing the front-and-side silhouette so the 3D form of the body reads. " +
  "Bottom-right quadrant: full-body 3/4 back angle, the subject standing with their back largely toward camera but the body rotated about 30 degrees so the camera sees one side and the back together, arms relaxed at the sides, head looking away — clearly showing the back-and-side silhouette so the 3D form reads.";

const STYLE_TAIL =
  "Photographic, editorial fashion-documentation style. " +
  "Preserve the subject's identity from Reference Image 1 — face structure, hair texture, skin tone — exactly. " +
  "Render as one cohesive 1:1 square image with the four quadrants clearly separated by thin gutters of white background.";

function wardrobeClause(outfitText: string | undefined, hasOutfitImage: boolean): string {
  if (hasOutfitImage && outfitText?.trim()) {
    return (
      `Wardrobe for the body shots (bottom quadrants only): dress the subject in the clothing shown in Reference Image 2 (${outfitText.trim()}). ` +
      "Match the garment exactly — color, cut, fabric, prints. Top quadrants stay tightly cropped to bare head and neck."
    );
  }
  if (hasOutfitImage) {
    return (
      "Wardrobe for the body shots (bottom quadrants only): dress the subject in the clothing shown in Reference Image 2. " +
      "Match the garment exactly — color, cut, fabric, prints. Top quadrants stay tightly cropped to bare head and neck."
    );
  }
  if (outfitText?.trim()) {
    return (
      `Wardrobe for the body shots (bottom quadrants only): ${outfitText.trim()}. ` +
      "Top quadrants stay tightly cropped to bare head and neck."
    );
  }
  return (
    "Wardrobe for the body shots (bottom quadrants only): neutral form-fitting plain clothing — simple short-sleeve top and dark trousers. " +
    "Top quadrants stay tightly cropped to bare head and neck."
  );
}

function buildPrompt(
  p: CharacterProfile,
  model: OutfitModelKey,
  provider: OutfitProvider,
  outfitText: string | undefined,
  hasOutfitImage: boolean,
): string {
  const subject = profileSubjectSentence(p);
  const details = profileDetailLines(p);
  const wardrobe = wardrobeClause(outfitText, hasOutfitImage);
  const base =
    `${SHEET_LAYOUT}\n\n` +
    `Subject: ${subject} ${details}\n\n` +
    `${wardrobe}\n\n` +
    `${STYLE_TAIL}`;
  // Wan/Qwen on kie need the avoid clause baked in.
  if (provider === "kie" && (model === "wan27_pro" || model === "qwen_image_edit")) {
    return `${base} Avoid: ${WAN_QWEN_NEGATIVE}.`;
  }
  return base;
}

function withAt(slug: string): string {
  if (slug.startsWith("http://") || slug.startsWith("https://")) return slug;
  return slug.startsWith("@") ? slug : `@${slug}`;
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

export function generateCharacterDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_character",
    description:
      "Generate a 4-up character reference sheet (face profile, face front, body front, body back) " +
      "from a structured Character profile and a source identity image. Creates one new char-* asset " +
      "per selected model and writes the profile to that asset's .character.json metadata. The " +
      "source image is passed as the identity reference. Aspect ratio is fixed at 1:1.",
    schema,
    handler: async (args) => {
      const a = args as Args;
      const provider: OutfitProvider = a.provider ?? "kie";
      const providerEnvKey = provider === "kie" ? "KIE_API_KEY" : "FAL_API_KEY";
      if (!process.env[providerEnvKey]) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `${providerEnvKey} environment variable is not set` }],
        };
      }

      const sourceRef = withAt(a.source_image_slug);
      const outfitRef = a.outfit_image_slug ? withAt(a.outfit_image_slug) : null;
      const imageRefs = outfitRef ? [sourceRef, outfitRef] : [sourceRef];
      const outcomes: CharacterOutcome[] = [];

      for (const model of a.models) {
        const factory = DISPATCH[provider][model];
        const prompt = buildPrompt(a.profile, model, provider, a.outfit_text, !!outfitRef);
        const outcome: CharacterOutcome = { model, provider, prompt };
        if (!factory) {
          outcome.error = `model ${model} is not available via provider ${provider}`;
          outcomes.push(outcome);
          continue;
        }
        const def = factory(fs);
        const nativeNegative =
          provider === "fal" && (model === "qwen_image_edit" || model === "wan27_pro");
        const seedreamKieQuality =
          provider === "kie" && model === "seedream_v5_lite";
        const res = await def.handler({
          project_slug: a.project_slug,
          prompt,
          image_slugs: imageRefs,
          output_prefix: "char",
          ...aspectRatioArgs(provider, model),
          ...(nativeNegative ? { negative_prompt: WAN_QWEN_NEGATIVE } : {}),
          ...(seedreamKieQuality ? { quality: "high" } : {}),
        } as unknown as Record<string, unknown>);
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
            ...a.profile,
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
            console.warn(
              `[generate_character] Failed to write profile to ${r.assetId}: ${writeRes.error.message}`,
            );
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

export function registerGenerateCharacterTool(server: McpServer, fs: ClipfirstFs): void {
  const def = generateCharacterDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
