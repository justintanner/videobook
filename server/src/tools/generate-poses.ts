import type { ClipfirstFs } from "clipfirst-fs";
import { z, type ZodRawShape } from "zod";
import { openai, textPart, imageUrlPart, firstContent } from "@apicity/openai";
import type { OpenAiMessage, OpenAiContentPart } from "@apicity/openai";
import { platformGuidance, type Platform } from "../platform-guidance.js";
import type { SchemaArgs, ToolDef, ToolResult } from "./tool-def.js";
import { findImageFile } from "./_fal-shared.js";
import { generateNanoBananaProEditFalDef } from "./generate-nano-banana-pro-edit-fal.js";
import { generateQwenImageEditFalDef } from "./generate-qwen-image-edit-fal.js";
import { generateGptImage1p5EditFalDef } from "./generate-gpt-image-1-5-edit-fal.js";

const RESEARCH_MODEL = "gpt-5.2";
const POSES_PER_PLATFORM = 3;

export const SUPPORTED_POSE_MODELS = [
  "nano_banana_pro",
  "qwen_image_edit",
  "gpt_image_1_5",
] as const;
export type PoseModelKey = typeof SUPPORTED_POSE_MODELS[number];

const POSE_MODEL_LABELS: Record<PoseModelKey, string> = {
  nano_banana_pro: "Nano Banana Pro",
  qwen_image_edit: "Qwen Image Edit",
  gpt_image_1_5: "GPT Image 1.5",
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
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

function platformLabel(p: Platform): string {
  return p === "ig" ? "Instagram" : p === "tiktok" ? "TikTok" : "YouTube";
}

export function buildPoseResearchText(platform: Platform): string {
  return (
    "You are a visual culture expert. Look at the reference image and produce three (3) " +
    `distinct, highly typical ${platformLabel(platform)} poses/shots that would feel native on the ` +
    "platform — the sort of thing an algorithm rewards. Use genre-savvy pose clichés (NOT just " +
    "aesthetic filters): selfie angles, gaze direction, hand/body gestures, framing, " +
    "interaction with the camera, context/location cues that are strongly associated with " +
    "the platform.\n\n" +
    "Preserve the identity, clothing silhouette, and setting vibe of the reference person/subject " +
    "from the source image — we're restyling pose + framing, not the person.\n\n" +
    "--- PLATFORM AESTHETIC ---\n" +
    platformGuidance(platform) +
    "\n--- END PLATFORM AESTHETIC ---\n\n" +
    "RULES:\n" +
    "- Output ONLY a valid JSON object, no markdown fences, no prose.\n" +
    "- Shape: {\"poses\": [\"prompt 1\", \"prompt 2\", \"prompt 3\"]}\n" +
    `- Each prompt must be under 500 characters, describe ONE pose/shot, and respect the ${platformLabel(platform)} aesthetic.\n` +
    "- Each prompt must be visually specific (pose, framing, gaze, hands, lighting, setting).\n" +
    "- Make the three poses meaningfully different from each other.\n"
  );
}

export interface PoseResearchResult {
  poses: string[];
}

export function parsePoses(raw: string): string[] {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  const parsed = JSON.parse(text) as PoseResearchResult;
  if (!Array.isArray(parsed.poses)) {
    throw new Error("research response missing poses[]");
  }
  return parsed.poses.slice(0, POSES_PER_PLATFORM).map((p) => String(p).trim()).filter(Boolean);
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
): Promise<{ ok: true; poses: string[] } | { ok: false; error: string }> {
  const assetId = sourceSlug.replace(/^@/, "");
  const dataUri = await readImageAsDataUri(fs, assetId, projectSlug);
  if (!dataUri) return { ok: false, error: `could not resolve image file for ${sourceSlug}` };

  const content: OpenAiContentPart[] = [imageUrlPart(dataUri), textPart(buildPoseResearchText(platform))];
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
    const poses = parsePoses(raw);
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

async function enqueueForModel(
  fs: ClipfirstFs,
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
  const def =
    model === "nano_banana_pro" ? generateNanoBananaProEditFalDef(fs)
    : model === "qwen_image_edit" ? generateQwenImageEditFalDef(fs)
    : generateGptImage1p5EditFalDef(fs);
  const res = await def.handler(args as unknown as Record<string, unknown>);
  return extractEnqueueResult(res);
}

export function generatePosesDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_poses",
    description:
      "Research 3 platform-typical poses per (source image × target platform) via GPT-5.2 vision, " +
      "then enqueue image-edit jobs across the selected models. Produces sources × platforms × models × 3 images.",
    schema,
    handler: async (args) => {
      const { project_slug, source_slugs, platforms, models } = args as Args;

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "OPENAI_API_KEY environment variable is not set" }],
        };
      }
      if (!process.env.FAL_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }],
        };
      }

      const outcomes: EnqueueOutcome[] = [];
      const researchErrors: string[] = [];

      for (const sourceSlug of source_slugs) {
        for (const platform of platforms) {
          const research = await researchPoses(fs, apiKey, sourceSlug, platform, project_slug);
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
                pose_index: i,
                prompt,
              };
              const r = await enqueueForModel(fs, model, project_slug, sourceSlug, prompt);
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
