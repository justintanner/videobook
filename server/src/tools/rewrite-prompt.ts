/**
 * rewrite_prompt MCP tool — rewrites generation prompts using model-specific
 * prompting guides via GPT-5.2.
 */
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openai, textPart, imageUrlPart, firstContent } from "@apicity/openai";
import type { OpenAiContentPart, OpenAiMessage } from "@apicity/openai";
import { resolveAllAssets, expandSlotRefs } from "../asset-resolver.js";
import { platformGuidance, type Platform } from "../platform-guidance.js";
import type { ToolDef } from "./tool-def.js";

const REWRITE_MODEL = "gpt-5.2";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUIDES_DIR = join(__dirname, "../guides");

const GUIDE_FILES: Record<string, string> = {
  nano_banana: "nano_banana_pro_prompting_guide.md",
  gpt_image: "gpt_image_2_prompting_guide.md",
  kling30: "kling_3_0_prompting_guide.md",
  grok_imagine: "grok_imagine_prompting_guide.md",
  grok_image: "grok_imagine_prompting_guide.md",
};

const SUPPORTED_MODELS = Object.keys(GUIDE_FILES).sort();

// --- Pure helpers ---

export function loadGuide(model: string): Promise<string> {
  const filename = GUIDE_FILES[model];
  if (!filename) {
    throw new Error(
      `No prompting guide available for model: ${model}. Supported models: ${SUPPORTED_MODELS.join(", ")}`,
    );
  }
  return readFile(join(GUIDES_DIR, filename), "utf-8");
}

function guideFilename(model: string): string {
  return GUIDE_FILES[model] ?? "";
}

export interface BuildRewriteExtras {
  maxChars?: number;
  platform?: Platform;
  customPrompt?: string;
  hasImages?: boolean;
}

const IMAGE_CLEANUP_DIRECTIVE =
  "IMAGE CLEANUP: The reference image(s) may contain AI-generation artifacts " +
  "(plasticky skin, oversharpened or haloed edges, waxy textures, mushy background detail) " +
  "or low-resolution noise (blocking, chroma banding, jpeg ringing). Describe the intended " +
  "subject/scene rather than replicating these artifacts. Produce a prompt that guides the " +
  "target model to render the scene cleanly at full fidelity, honoring the platform aesthetic above.";

export function buildRewritePromptText(
  guide: string,
  prompt: string,
  extras: BuildRewriteExtras = {},
): string {
  const { maxChars, platform, customPrompt, hasImages } = extras;
  let charLimitRule = "";
  if (maxChars) {
    charLimitRule =
      `- HARD LIMIT: The rewritten prompt MUST be under ${maxChars} characters (API max is 500)\n` +
      "- Be concise and visually specific — cut filler words, focus on key actions and details\n";
  }
  const platformSection = platform
    ? `\n--- PLATFORM STYLE ---\n${platformGuidance(platform)}\n--- END PLATFORM STYLE ---\n` +
      (hasImages ? `\n${IMAGE_CLEANUP_DIRECTIVE}\n` : "")
    : "";
  const instructionSection = customPrompt
    ? `\nADDITIONAL INSTRUCTION: ${customPrompt}\n`
    : "";
  const userPromptBlock = prompt
    ? `USER PROMPT TO REWRITE:\n${prompt}`
    : "USER PROMPT TO REWRITE: (none — describe the reference image(s) directly, applying the guide above)";
  return (
    "You are a prompt engineering expert. Using the model-specific prompting guide below, " +
    "rewrite the user's prompt to follow best practices for this model.\n\n" +
    "RULES:\n" +
    "- Output ONLY the rewritten prompt text, nothing else\n" +
    "- Do not include explanations, labels, or commentary\n" +
    charLimitRule +
    "- Preserve the user's creative intent while improving structure and detail\n" +
    "- Apply the guide's recommended prompt structure and techniques\n" +
    "- If images are provided, incorporate visual details you observe into the prompt\n\n" +
    `--- PROMPTING GUIDE ---\n${guide}\n--- END GUIDE ---\n` +
    platformSection +
    instructionSection +
    `\n${userPromptBlock}`
  );
}

export function buildRewriteMessages(
  guide: string,
  prompt: string,
  extras: BuildRewriteExtras = {},
): OpenAiMessage[] {
  return [{ role: "user", content: buildRewritePromptText(guide, prompt, extras) }];
}

export function buildVisionMessages(
  guide: string,
  prompt: string,
  imageDataUris: string[],
  extras: BuildRewriteExtras = {},
): OpenAiMessage[] {
  const content: OpenAiContentPart[] = imageDataUris.map((uri) => imageUrlPart(uri));
  content.push(textPart(buildRewritePromptText(guide, prompt, { ...extras, hasImages: true })));
  return [{ role: "user", content }];
}

export function buildResult(
  model: string,
  originalPrompt: string,
  rewrittenPrompt: string,
  guideFile: string,
): Record<string, string> {
  return {
    model,
    original_prompt: originalPrompt,
    rewritten_prompt: rewrittenPrompt,
    guide_used: guideFile,
  };
}

type SceneDef = { prompt: string; duration: number };
type ElementDef = { name: string; desc: string; slugs: string[] };

export function extractSceneContext(
  toolParams: Record<string, unknown>,
): { scenes: SceneDef[]; elements: ElementDef[]; refSlugs: string[]; aspectRatio: string } {
  const multiPrompt = toolParams.multi_prompt as SceneDef[] | undefined;
  const scenes: SceneDef[] = multiPrompt
    ? multiPrompt
    : [{ prompt: (toolParams.prompt as string) ?? "", duration: Number(toolParams.duration ?? 8) }];

  const elements: ElementDef[] = [];
  for (let i = 1; i <= 3; i++) {
    const slugs = toolParams[`input_element${i}_slugs`] as string[] | undefined;
    if (!slugs) continue;
    elements.push({
      name: (toolParams[`element${i}_name`] as string) ?? "",
      desc: (toolParams[`element${i}_desc`] as string) ?? "",
      slugs,
    });
  }

  const refSlugs = (toolParams.input_image_slugs as string[]) ?? [];
  const aspectRatio = (toolParams.aspect_ratio as string) ?? "16:9";

  return { scenes, elements, refSlugs, aspectRatio };
}

export function validateSceneRewrite(
  toolParams: Record<string, unknown>,
  sceneIndex: number,
): void {
  const tool = toolParams.tool as string | undefined;
  if (tool !== "generate_kling30_video") {
    throw new Error(`Scene rewrite requires a Kling 3.0 asset, got tool: ${tool}`);
  }
  const multiPrompt = toolParams.multi_prompt as SceneDef[] | undefined;
  const nScenes = multiPrompt ? multiPrompt.length : 1;
  if (sceneIndex < 0 || sceneIndex >= nScenes) {
    throw new Error(`scene_index ${sceneIndex} out of range (0-${nScenes - 1})`);
  }
}

export function buildSceneRewriteText(
  guide: string,
  scenes: SceneDef[],
  elements: ElementDef[],
  sceneIndex: number,
  instruction?: string,
): string {
  const lines: string[] = [
    "You are a prompt engineering expert specializing in multi-shot video generation. " +
      "Using the model-specific prompting guide below, rewrite the TARGET scene prompt " +
      "to follow best practices.\n",
    "RULES:",
    "- Output ONLY the rewritten scene prompt text, nothing else",
    "- Do not include explanations, labels, scene numbers, or commentary",
    "- HARD LIMIT: The rewritten prompt MUST be under 400 characters (API max is 500)",
    "- Be concise and visually specific — cut filler words, focus on key actions and details",
    "- Preserve @element_name references exactly as they appear",
    "- Maintain narrative continuity with the other scenes",
    "- Preserve the user's creative intent while improving structure and detail",
    "- Apply the guide's recommended prompt structure and techniques",
    "- If images are provided, incorporate visual details you observe into the prompt\n",
    `--- PROMPTING GUIDE ---\n${guide}\n--- END GUIDE ---\n`,
  ];

  lines.push("--- ALL SCENES ---");
  for (let i = 0; i < scenes.length; i++) {
    const marker = i === sceneIndex ? " <<<< TARGET — REWRITE THIS SCENE" : "";
    lines.push(`Scene ${i} (${scenes[i].duration ?? "?"}s): ${scenes[i].prompt}${marker}`);
  }
  lines.push("--- END SCENES ---\n");

  if (elements.length > 0) {
    lines.push("--- ELEMENTS ---");
    for (const elem of elements) {
      lines.push(`@${elem.name}: ${elem.desc}`);
    }
    lines.push("--- END ELEMENTS ---\n");
  }

  if (instruction) {
    lines.push(`ADDITIONAL INSTRUCTION: ${instruction}\n`);
  }

  return lines.join("\n");
}

function buildSceneResult(
  sceneIndex: number,
  originalScenePrompt: string,
  rewritten: string,
  guideFile: string,
  scenes: SceneDef[],
): Record<string, unknown> {
  const updatedMultiPrompt = scenes.map((scene, i) =>
    i === sceneIndex ? { ...scene, prompt: rewritten } : { ...scene },
  );
  return {
    model: "kling30",
    scene_index: sceneIndex,
    original_scene_prompt: originalScenePrompt,
    rewritten_prompt: rewritten,
    guide_used: guideFile,
    updated_multi_prompt: updatedMultiPrompt,
  };
}

async function resolveImageDataUris(
  imageSlugs: string[],
  fs: ClipfirstFs,
  projectSlug: string,
): Promise<string[]> {
  const tagText = imageSlugs.map((s) => `@${s.replace(/^@/, "")}`).join(" ");
  const { resolved } = await resolveAllAssets(tagText, fs, projectSlug);

  const dataUris: string[] = [];
  for (const asset of resolved) {
    if (!asset.file_path) continue;
    const readResult = await fs.readFile(asset.asset_id, asset.file_path.split("/").pop()!, projectSlug);
    if (!readResult.ok) continue;
    const buf = Buffer.from(readResult.value);
    const ext = asset.file_path.split(".").pop()?.toLowerCase() ?? "png";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
    dataUris.push(`data:${mime};base64,${buf.toString("base64")}`);
  }
  return dataUris;
}

// --- Tool definition ---

export function rewritePromptDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "rewrite_prompt",
    description:
      "Rewrite a generation prompt using model-specific best practices. " +
      "Supports standard mode (rewrite any prompt) and scene mode (rewrite a " +
      "specific scene in a Kling 3.0 multi-shot asset).",
    schema: {
      prompt: z.string().optional().describe("Prompt to rewrite. In scene mode, serves as optional creative direction."),
      model: z
        .enum(["nano_banana", "gpt_image", "kling30", "grok_imagine", "grok_image"])
        .default("kling30")
        .describe("Target model for prompt optimization"),
      image_slugs: z
        .array(z.string())
        .optional()
        .describe("Optional image asset slugs for visual context (e.g. ['img-sunset'])"),
      project_slug: z.string().describe("Project slug"),
      asset_slug: z.string().optional().describe("Asset slug for scene-context rewrite (requires scene_index)"),
      scene_index: z.number().int().optional().describe("0-based scene index to rewrite (requires asset_slug)"),
      platform: z
        .enum(["ig", "tiktok", "youtube"])
        .optional()
        .describe("Optional platform aesthetic preset (Instagram/TikTok/YouTube)"),
      custom_prompt: z
        .string()
        .max(500)
        .optional()
        .describe("Optional free-form additional instruction (max 500 chars)"),
    },
    handler: async (args) => {
      const {
        prompt, model, image_slugs, project_slug,
        asset_slug, scene_index, platform, custom_prompt,
      } = args as {
        prompt?: string;
        model: string;
        image_slugs?: string[];
        project_slug: string;
        asset_slug?: string;
        scene_index?: number;
        platform?: Platform;
        custom_prompt?: string;
      };

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "OPENAI_API_KEY environment variable is not set" }],
        };
      }

      // Scene rewrite mode
      if (asset_slug !== undefined && scene_index !== undefined) {
        return handleSceneRewrite(fs, apiKey, asset_slug, scene_index, prompt, project_slug);
      }

      // Standard rewrite mode — require prompt OR reference images
      const hasImages = !!image_slugs && image_slugs.length > 0;
      if (!prompt && !hasImages) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: "Provide a prompt, or reference image_slugs (for vision-based description), or both.",
          }],
        };
      }

      // Expand @s01 slot refs → actual asset slugs
      let expandedPrompt = prompt ?? "";
      if (expandedPrompt) {
        const timelineResult = await fs.readProjectMeta<{ slots: Array<{ slug: string }> }>("timeline", project_slug);
        if (timelineResult.ok && timelineResult.value.slots) {
          expandedPrompt = expandSlotRefs(expandedPrompt, timelineResult.value.slots);
        }
      }

      return handleStandardRewrite(fs, apiKey, expandedPrompt, model, image_slugs, project_slug, platform, custom_prompt);
    },
  };
}

async function handleStandardRewrite(
  fs: ClipfirstFs,
  apiKey: string,
  prompt: string,
  model: string,
  imageSlugs: string[] | undefined,
  projectSlug: string,
  platform: Platform | undefined,
  customPrompt: string | undefined,
): Promise<{ isError?: true; content: Array<{ type: "text"; text: string }> }> {
  let guide: string;
  try {
    guide = await loadGuide(model);
  } catch (e) {
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: (e as Error).message }],
    };
  }

  const maxChars = model === "kling30" ? 400 : undefined;
  const provider = openai({ apiKey, timeout: 60_000 });
  const extras = { maxChars, platform, customPrompt };

  let messages: OpenAiMessage[];
  if (imageSlugs && imageSlugs.length > 0) {
    const dataUris = await resolveImageDataUris(imageSlugs, fs, projectSlug);
    if (dataUris.length === 0) {
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: "Could not resolve any image files from provided slugs" }],
      };
    }
    messages = buildVisionMessages(guide, prompt, dataUris, extras);
  } else {
    messages = buildRewriteMessages(guide, prompt, extras);
  }

  const result = await provider.post.v1.chat.completions({
    model: REWRITE_MODEL,
    messages,
    temperature: 0.7,
    max_completion_tokens: 1024,
  });

  const rewritten = firstContent(result).trim();
  const output = buildResult(model, prompt, rewritten, guideFilename(model));

  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
  };
}

async function handleSceneRewrite(
  fs: ClipfirstFs,
  apiKey: string,
  assetSlug: string,
  sceneIndex: number,
  instruction: string | undefined,
  projectSlug: string,
): Promise<{ isError?: true; content: Array<{ type: "text"; text: string }> }> {
  const assetId = assetSlug.replace(/^@/, "");

  const metaResult = await fs.readMetadata<Record<string, unknown>>(assetId, "tool.params", projectSlug);
  if (!metaResult.ok) {
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: `No .tool.params.json found for ${assetSlug}` }],
    };
  }

  const toolParams = metaResult.value;
  try {
    validateSceneRewrite(toolParams, sceneIndex);
  } catch (e) {
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: (e as Error).message }],
    };
  }

  const { scenes, elements } = extractSceneContext(toolParams);

  const guide = await loadGuide("kling30");
  const text = buildSceneRewriteText(guide, scenes, elements, sceneIndex, instruction);

  const provider = openai({ apiKey, timeout: 60_000 });
  const result = await provider.post.v1.chat.completions({
    model: REWRITE_MODEL,
    messages: [{ role: "user", content: text }],
    temperature: 0.7,
    max_completion_tokens: 1024,
  });

  const rewritten = firstContent(result).trim();
  const output = buildSceneResult(
    sceneIndex,
    scenes[sceneIndex].prompt,
    rewritten,
    guideFilename("kling30"),
    scenes,
  );

  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
  };
}
