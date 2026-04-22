import type { ClipfirstFs } from "clipfirst-fs";
import { z, type ZodRawShape } from "zod";
import { openai, textPart, imageUrlPart, firstContent } from "@apicity/openai";
import type { OpenAiMessage, OpenAiContentPart } from "@apicity/openai";
import { platformGuidance, type Platform } from "../platform-guidance.js";
import type { SchemaArgs, ToolDef, ToolResult } from "./tool-def.js";
import { findImageFile } from "./_fal-shared.js";
import { generateNanoBananaProEditFalDef } from "./generate-nano-banana-pro-edit-fal.js";
import { generateQwenImageEditFalDef } from "./generate-qwen-image-edit-fal.js";
import { generateWan27ProEditFalDef } from "./generate-wan27-pro-edit-fal.js";
import { generateGrokImagineImageEditFalDef } from "./generate-grok-imagine-image-edit-fal.js";
import { generateNanoBananaImageDef } from "./generate-nano-banana-image.js";
import { generateQwen2ImageEditDef } from "./generate-qwen2-image-edit.js";
import { generateGptImageDef } from "./generate-gpt-image.js";
import { generateWan27ImageProDef } from "./generate-wan27-image-pro.js";
import { generateGrokImagineImageDef } from "./generate-grok-imagine-image.js";

const RESEARCH_MODEL = "gpt-5.2";
const DEFAULT_POSES_PER_PLATFORM = 3;
const MAX_POSES_PER_PLATFORM = 6;

export const POSE_PROVIDERS = ["kie", "fal"] as const;
export type PoseProvider = typeof POSE_PROVIDERS[number];

export const POSE_TYPES = [
  "selfie",
  "mirror_selfie",
  "portrait",
  "full_body",
  "candid",
  "action",
  "close_up",
  "pov",
  "group",
] as const;
export type PoseType = typeof POSE_TYPES[number];

const POSE_TYPE_GUIDANCE: Record<PoseType, string> = {
  selfie: "handheld selfies — arm's-length framing, direct eye contact with the lens, shallow depth",
  mirror_selfie: "mirror selfies — phone visible in frame, full/half body in a mirror, casual angle",
  portrait: "head-and-shoulder portraits — shot from just above waist, intentional framing, subject dominant",
  full_body: "full-body shots — subject from head to feet, framing that reads the outfit and stance",
  candid: "candid, off-guard moments — not looking at the lens, natural motion, unstaged feel",
  action: "action shots — movement, motion blur or freeze-motion, dynamic body language",
  close_up: "close-ups — tight crop on face or hands, textured detail, intimate feel",
  pov: "point-of-view shots — first-person perspective, hand/arm/feet visible, subject-as-camera",
  group: "group shots — subject plus additional people/context, layered composition",
};

const POSE_TYPE_LABELS: Record<PoseType, string> = {
  selfie: "Selfie",
  mirror_selfie: "Mirror Selfie",
  portrait: "Portrait",
  full_body: "Full Body",
  candid: "Candid",
  action: "Action",
  close_up: "Close-up",
  pov: "POV",
  group: "Group",
};

export function poseTypeOptions(): Array<{ key: PoseType; label: string }> {
  return POSE_TYPES.map((k) => ({ key: k, label: POSE_TYPE_LABELS[k] }));
}

export const SUPPORTED_POSE_MODELS = [
  "nano_banana_pro",
  "qwen_image_edit",
  "gpt_image_2",
  "wan27_pro",
  "grok_imagine",
] as const;
export type PoseModelKey = typeof SUPPORTED_POSE_MODELS[number];

const POSE_MODEL_LABELS: Record<PoseModelKey, string> = {
  nano_banana_pro: "Nano Banana Pro",
  qwen_image_edit: "Qwen Image Edit",
  gpt_image_2: "GPT Image 2.0",
  wan27_pro: "Wan 2.7 Pro",
  grok_imagine: "Grok Imagine",
};

export function poseModelOptions(): Array<{ key: PoseModelKey; label: string }> {
  return SUPPORTED_POSE_MODELS.map((k) => ({ key: k, label: POSE_MODEL_LABELS[k] }));
}

const schema = {
  project_slug: z.string().describe("Project slug"),
  source_slugs: z
    .array(z.string())
    .min(1)
    .describe("One or more @img-* slugs to use as source references"),
  platforms: z
    .array(z.enum(["ig", "tiktok", "youtube"]))
    .min(1)
    .describe("Target platform aesthetics to generate poses for"),
  models: z
    .array(z.enum(SUPPORTED_POSE_MODELS))
    .min(1)
    .describe("Image edit models to use for generation"),
  provider: z
    .enum(POSE_PROVIDERS)
    .optional()
    .describe("Image-edit provider (kie | fal). Defaults to kie."),
  poses_per_platform: z
    .number()
    .int()
    .min(1)
    .max(MAX_POSES_PER_PLATFORM)
    .optional()
    .describe(`How many poses to research per (source × platform). 1-${MAX_POSES_PER_PLATFORM}, default ${DEFAULT_POSES_PER_PLATFORM}.`),
  pose_type: z
    .enum(POSE_TYPES)
    .optional()
    .describe("Optional pose-type bias for the researcher (selfie, portrait, full_body, candid, action, etc.)"),
  custom_prompt: z
    .string()
    .max(500)
    .optional()
    .describe("Optional free-form instruction appended to the researcher prompt (e.g. 'outdoor setting, no hat')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

function platformLabel(p: Platform): string {
  return p === "ig" ? "Instagram" : p === "tiktok" ? "TikTok" : "YouTube";
}

export interface PoseResearchExtras {
  poseType?: PoseType;
  customPrompt?: string;
}

export function buildPoseResearchText(
  platform: Platform,
  count: number,
  extras: PoseResearchExtras = {},
): string {
  const n = Math.max(1, Math.min(MAX_POSES_PER_PLATFORM, Math.floor(count)));
  const shapeExample = Array.from({ length: n }, (_, i) => `"prompt ${i + 1}"`).join(", ");
  const poseTypeSection = extras.poseType
    ? `\n--- POSE TYPE BIAS ---\nEvery pose MUST be a ${POSE_TYPE_LABELS[extras.poseType].toLowerCase()} — ${POSE_TYPE_GUIDANCE[extras.poseType]}.\n--- END POSE TYPE BIAS ---\n\n`
    : "";
  const customSection = extras.customPrompt && extras.customPrompt.trim()
    ? `\nADDITIONAL INSTRUCTION FROM USER: ${extras.customPrompt.trim()}\n\n`
    : "";
  return (
    `You are a visual culture expert. Look at the reference image and produce ${n} ` +
    `distinct, highly typical ${platformLabel(platform)} poses/shots that would feel native on the ` +
    "platform — the sort of thing an algorithm rewards. Use genre-savvy pose clichés (NOT just " +
    "aesthetic filters): selfie angles, gaze direction, hand/body gestures, framing, " +
    "interaction with the camera, context/location cues that are strongly associated with " +
    "the platform.\n\n" +
    "Preserve the identity, clothing silhouette, and setting vibe of the reference person/subject " +
    "from the source image — we're restyling pose + framing, not the person.\n\n" +
    "--- PLATFORM AESTHETIC ---\n" +
    platformGuidance(platform) +
    "\n--- END PLATFORM AESTHETIC ---\n" +
    poseTypeSection +
    customSection +
    "RULES:\n" +
    "- Output ONLY a valid JSON object, no markdown fences, no prose.\n" +
    `- Shape: {"poses": [${shapeExample}]}\n` +
    `- Each prompt must be under 500 characters, describe ONE pose/shot, and respect the ${platformLabel(platform)} aesthetic.\n` +
    "- Each prompt must be visually specific (pose, framing, gaze, hands, lighting, setting).\n" +
    `- Make the ${n} poses meaningfully different from each other.\n`
  );
}

export interface PoseResearchResult {
  poses: string[];
}

export function parsePoses(raw: string, count: number): string[] {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  const parsed = JSON.parse(text) as PoseResearchResult;
  if (!Array.isArray(parsed.poses)) {
    throw new Error("research response missing poses[]");
  }
  return parsed.poses.slice(0, count).map((p) => String(p).trim()).filter(Boolean);
}

async function readImageAsDataUri(
  fs: ClipfirstFs,
  assetId: string,
  projectSlug: string,
): Promise<string | null> {
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return null;
  const imageFile = findImageFile(manifest.value.files);
  if (!imageFile) return null;
  const read = await fs.readFile(assetId, imageFile.name, projectSlug);
  if (!read.ok) return null;
  const ext = imageFile.name.split(".").pop()?.toLowerCase() ?? "png";
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
  return `data:${mime};base64,${Buffer.from(read.value).toString("base64")}`;
}

async function researchPoses(
  fs: ClipfirstFs,
  apiKey: string,
  sourceSlug: string,
  platform: Platform,
  projectSlug: string,
  count: number,
  extras: PoseResearchExtras,
): Promise<{ ok: true; poses: string[] } | { ok: false; error: string }> {
  const assetId = sourceSlug.replace(/^@/, "");
  const dataUri = await readImageAsDataUri(fs, assetId, projectSlug);
  if (!dataUri) return { ok: false, error: `could not resolve image file for ${sourceSlug}` };

  const content: OpenAiContentPart[] = [imageUrlPart(dataUri), textPart(buildPoseResearchText(platform, count, extras))];
  const messages: OpenAiMessage[] = [{ role: "user", content }];

  const provider = openai({ apiKey, timeout: 60_000 });
  const result = await provider.post.v1.chat.completions({
    model: RESEARCH_MODEL,
    messages,
    temperature: 0.8,
    max_completion_tokens: 1024,
  });
  const raw = firstContent(result).trim();
  try {
    const poses = parsePoses(raw, count);
    if (poses.length === 0) return { ok: false, error: "research returned no poses" };
    return { ok: true, poses };
  } catch (e) {
    return { ok: false, error: `failed to parse pose JSON: ${(e as Error).message}` };
  }
}

interface EnqueueOutcome {
  source_slug: string;
  platform: Platform;
  model: PoseModelKey;
  provider: PoseProvider;
  pose_index: number;
  prompt: string;
  img_asset_id?: string;
  job_id?: string;
  error?: string;
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

type ToolDefFactory = (fs: ClipfirstFs) => { handler: (args: Record<string, unknown>) => Promise<ToolResult> };

const DISPATCH: Record<PoseProvider, Partial<Record<PoseModelKey, ToolDefFactory>>> = {
  kie: {
    nano_banana_pro: generateNanoBananaImageDef,
    qwen_image_edit: generateQwen2ImageEditDef,
    gpt_image_2: generateGptImageDef,
    wan27_pro: generateWan27ImageProDef,
    grok_imagine: generateGrokImagineImageDef,
  },
  fal: {
    nano_banana_pro: generateNanoBananaProEditFalDef,
    qwen_image_edit: generateQwenImageEditFalDef,
    wan27_pro: generateWan27ProEditFalDef,
    grok_imagine: generateGrokImagineImageEditFalDef,
  },
};

async function enqueueForModel(
  fs: ClipfirstFs,
  provider: PoseProvider,
  model: PoseModelKey,
  projectSlug: string,
  sourceSlug: string,
  prompt: string,
): Promise<{ assetId?: string; jobId?: string; error?: string }> {
  const args = {
    project_slug: projectSlug,
    prompt,
    image_slugs: [sourceSlug.startsWith("@") ? sourceSlug : `@${sourceSlug}`],
  };
  const factory = DISPATCH[provider][model];
  if (!factory) {
    return { error: `model ${model} is not available via provider ${provider}` };
  }
  const def = factory(fs);
  const res = await def.handler(args as unknown as Record<string, unknown>);
  return extractEnqueueResult(res);
}

export function generatePosesDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_poses",
    description:
      "Research N platform-typical poses per (source image × target platform) via GPT-5.2 vision, " +
      "then enqueue image-edit jobs through the selected provider (kie | fal) across the chosen models. " +
      "Produces sources × platforms × models × poses_per_platform images.",
    schema,
    handler: async (args) => {
      const { project_slug, source_slugs, platforms, models } = args as Args;
      const provider: PoseProvider = (args as Args).provider ?? "kie";
      const posesPerPlatform = (args as Args).poses_per_platform ?? DEFAULT_POSES_PER_PLATFORM;
      const researchExtras: PoseResearchExtras = {
        poseType: (args as Args).pose_type,
        customPrompt: (args as Args).custom_prompt,
      };

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "OPENAI_API_KEY environment variable is not set" }],
        };
      }
      const providerEnvKey = provider === "kie" ? "KIE_API_KEY" : "FAL_API_KEY";
      if (!process.env[providerEnvKey]) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `${providerEnvKey} environment variable is not set` }],
        };
      }

      const outcomes: EnqueueOutcome[] = [];
      const researchErrors: string[] = [];

      for (const sourceSlug of source_slugs) {
        for (const platform of platforms) {
          const research = await researchPoses(fs, apiKey, sourceSlug, platform, project_slug, posesPerPlatform, researchExtras);
          if (!research.ok) {
            researchErrors.push(`${sourceSlug} / ${platform}: ${research.error}`);
            continue;
          }
          for (let i = 0; i < research.poses.length; i++) {
            const prompt = research.poses[i];
            for (const model of models) {
              const outcome: EnqueueOutcome = {
                source_slug: sourceSlug,
                platform,
                model,
                provider,
                pose_index: i,
                prompt,
              };
              const r = await enqueueForModel(fs, provider, model, project_slug, sourceSlug, prompt);
              if (r.error) outcome.error = r.error;
              if (r.assetId) outcome.img_asset_id = r.assetId;
              if (r.jobId) outcome.job_id = r.jobId;
              outcomes.push(outcome);
            }
          }
        }
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
            research_errors: researchErrors,
            outcomes,
          }),
        }],
      };
    },
  };
}
