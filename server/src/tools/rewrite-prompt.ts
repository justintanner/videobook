import type { Engine, GenerationError } from "videobook-engine";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { textPart, imageUrlPart } from "@apicity/openai";
import type { OpenAiContentPart, OpenAiMessage } from "@apicity/openai";
import { getCanonicalName } from "../generation-registry.js";
import { platformGuidance, type Platform } from "../platform-guidance.js";
import type { ToolDef } from "./tool-def.js";
import { expandTimelineSlotRefs, timelineSlotArtifactIds } from "../timeline-helpers.js";
import { resolveArtifactRefs } from "../artifact-refs.js";
import {
  buildIntelligenceResponses,
  firstResponseText,
  intelligenceRequest,
} from "../openai-intelligence.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUIDES_DIR = join(__dirname, "../guides");

const GUIDE_FILES: Record<string, string> = {
  nano_banana: "nano_banana_pro_prompting_guide.md",
  gpt_image: "gpt_image_2_prompting_guide.md",
  kling30: "kling_3_0_prompting_guide.md",
  grok_imagine: "grok_imagine_prompting_guide.md",
  grok_image: "grok_imagine_prompting_guide.md",
  seedance2: "seedance_2_prompting_guide.md",
};

const SUPPORTED_MODELS = Object.keys(GUIDE_FILES).sort();

const MODEL_CONTEXT: Record<string, string> = {
  gemini_omni: "omni-flash (Gemini Omni video via Google Flow)",
};

// Provider API documentation (useapi.net Google Flow v1). Used by the
// provider_docs rewrite mode, which follows the provider's own request contract
// (@-mention syntax, model vocab, reference budgets) instead of a social
// platform aesthetic. Covers Veo, Gemini Omni Flash, and Nano Banana models.
const USEAPI_GUIDE_FILE = "useapi_google_flow_v1_prompting_guide.md";

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

export function loadUseapiGuide(): Promise<string> {
  return readFile(join(GUIDES_DIR, USEAPI_GUIDE_FILE), "utf-8");
}

function guideFilename(model: string): string {
  return GUIDE_FILES[model] ?? "";
}

export interface PreviousError {
  message: string;
  failCode?: string;
}

export interface BuildRewriteExtras {
  maxChars?: number;
  platform?: Platform;
  customPrompt?: string;
  hasImages?: boolean;
  /** Provider-docs mode: rewrite against the useapi.net API documentation
   *  instead of a model guide + platform overlay. Mutually exclusive with
   *  `platform` (the platform section is omitted when true). */
  providerDocs?: boolean;
  /** Target model name surfaced to the rewriter in provider-docs mode so it can
   *  tailor to image (Nano Banana) vs video (Veo/Omni) vocabulary. */
  modelContext?: string;
  /** Previous generation error to adapt the rewritten prompt around. */
  previousError?: PreviousError;
}

const IMAGE_CLEANUP_DIRECTIVE =
  "IMAGE CLEANUP: The reference image(s) may contain AI-generation artifacts " +
  "(plasticky skin, oversharpened or haloed edges, waxy textures, mushy background detail) " +
  "or low-resolution noise (blocking, chroma banding, jpeg ringing). Describe the intended " +
  "subject/scene rather than replicating these artifacts. Produce a prompt that guides the " +
  "target model to render the scene cleanly at full fidelity, honoring the platform aesthetic above.";

const PROVIDER_DOCS_SYSTEM =
  "You are a prompt engineering expert. Using the provider's API documentation below " +
  "(useapi.net Google Flow v1), rewrite the user's prompt so it matches how this provider " +
  "expects prompts to be structured for the target model.\n\n" +
  "RULES:\n" +
  "- Output ONLY the rewritten prompt text, nothing else\n" +
  "- Do not include explanations, labels, or commentary\n" +
  "- Preserve the user's creative intent while improving structure and detail\n" +
  "- Follow the provider's @-mention grammar exactly: keep existing @character_N, " +
  "@referenceImage_N (video), @reference_N (image), and @referenceAudio_N markers in place; " +
  "do NOT invent markers that have no matching supplied reference (the API returns 400)\n" +
  "- Do NOT add a negative prompt — the field does not exist on this provider\n" +
  "- Use concrete subject/action/setting/camera/lighting language; keep it a single plain-text description\n" +
  "- If images are provided, incorporate visual details you observe into the prompt\n\n";

function previousErrorSection(error: PreviousError): string {
  const failCodeLine = error.failCode
    ? `Provider fail code: ${error.failCode}\n`
    : "";
  return (
    "\n--- PREVIOUS GENERATION ERROR ---\n" +
    "A previous generation attempt with this exact prompt FAILED with the provider error below.\n" +
    failCodeLine +
    `Error message: ${error.message}\n` +
    "Rework the prompt so it will not trigger this failure again, while preserving the creative intent:\n" +
    "- Infer which element of the prompt (or its references) most plausibly triggered the error and rewrite or generalize that element (e.g. a PROMINENT_PEOPLE / celebrity-likeness filter -> describe a generic fictional person; a sensitive-content filter -> reframe or tone down the flagged concept)\n" +
    "- Keep every part of the prompt unrelated to the failure intact in spirit\n" +
    "- Do NOT mention the error, the filter, the provider, or these instructions in the rewritten prompt text\n" +
    "--- END PREVIOUS GENERATION ERROR ---\n"
  );
}

export function buildRewritePromptText(
  guide: string,
  prompt: string,
  extras: BuildRewriteExtras = {},
): string {
  const { maxChars, platform, customPrompt, hasImages, providerDocs, modelContext, previousError } = extras;

  // Provider-docs mode: rewrite against the useapi.net docs. No platform overlay
  // (this mode is the alternative to the IG/TikTok/YouTube aesthetic).
  if (providerDocs) {
    let charLimitRule = "";
    if (maxChars) {
      charLimitRule =
        `- HARD LIMIT: The rewritten prompt MUST be under ${maxChars} characters\n` +
        "- Be concise and visually specific — cut filler words, focus on key actions and details\n";
    }
    const modelLine = modelContext
      ? `TARGET MODEL: ${modelContext}\n\n`
      : "";
    const instructionSection = customPrompt
      ? `\nADDITIONAL INSTRUCTION: ${customPrompt}\n`
      : "";
    const errorSection = previousError ? previousErrorSection(previousError) : "";
    const userPromptBlock = prompt
      ? `USER PROMPT TO REWRITE:\n${prompt}`
      : "USER PROMPT TO REWRITE: (none — describe the reference image(s) directly, applying the documentation above)";
    return (
      PROVIDER_DOCS_SYSTEM +
      charLimitRule +
      `--- PROVIDER API DOCUMENTATION ---\n${guide}\n--- END DOCUMENTATION ---\n` +
      modelLine +
      instructionSection +
      errorSection +
      `\n${userPromptBlock}`
    );
  }

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
  const errorSection = previousError ? previousErrorSection(previousError) : "";
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
    errorSection +
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
  previousError?: PreviousError,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    model,
    original_prompt: originalPrompt,
    rewritten_prompt: rewrittenPrompt,
    guide_used: guideFile,
  };
  if (previousError) {
    result.previous_error = {
      message: previousError.message,
      ...(previousError.failCode ? { fail_code: previousError.failCode } : {}),
    };
  }
  return result;
}

export function normalizePromptForMatch(p: string): string {
  return p.replace(/\s+/g, " ").trim();
}

const ERROR_RECENCY_MS = 7 * 24 * 60 * 60 * 1000;

export async function findPreviousErrorForPrompt(
  fs: Engine,
  bookId: string,
  prompt: string,
): Promise<GenerationError | null> {
  const result = await fs.jobs.failures.findAll();
  if (!result.ok) return null;
  const normalized = normalizePromptForMatch(prompt);
  const cutoff = Date.now() - ERROR_RECENCY_MS;
  const matching = result.value.filter(
    (e): e is GenerationError & { prompt: string } =>
      typeof e.prompt === "string" &&
      normalizePromptForMatch(e.prompt) === normalized &&
      e.failedAt > cutoff,
  );
  if (matching.length === 0) return null;
  return matching.reduce((latest, current) =>
    current.failedAt > latest.failedAt ? current : latest,
  );
}

type SceneDef = { prompt: string; duration: number };
type ElementDef = { name: string; desc: string; refs: string[] };

export function extractSceneContext(
  toolParams: Record<string, unknown>,
): { scenes: SceneDef[]; elements: ElementDef[]; refs: string[]; aspectRatio: string } {
  const multiPrompt = toolParams.multi_prompt as SceneDef[] | undefined;
  const scenes: SceneDef[] = multiPrompt
    ? multiPrompt
    : [{ prompt: (toolParams.prompt as string) ?? "", duration: Number(toolParams.duration ?? 8) }];

  const elements: ElementDef[] = [];
  for (let i = 1; i <= 3; i++) {
    const refs = toolParams[`input_element${i}_refs`] as string[] | undefined;
    if (!refs) continue;
    elements.push({
      name: (toolParams[`element${i}_name`] as string) ?? "",
      desc: (toolParams[`element${i}_desc`] as string) ?? "",
      refs,
    });
  }

  const refs = (toolParams.input_image_refs as string[]) ?? [];
  const aspectRatio = (toolParams.aspect_ratio as string) ?? "16:9";

  return { scenes, elements, refs, aspectRatio };
}

export function validateSceneRewrite(
  toolParams: Record<string, unknown>,
  sceneIndex: number,
): void {
  const tool = toolParams.tool as string | undefined;
  if (tool === undefined || getCanonicalName(tool) !== "generate_kie_kling_3_0_video") {
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
  imageRefs: string[],
  fs: Engine,
  _bookId: string,
): Promise<string[]> {
  const { resolved } = await resolveArtifactRefs(fs, imageRefs);

  const dataUris: string[] = [];
  for (const asset of resolved) {
    if (!asset.filePath) continue;
    const readResult = await fs.files.read(asset.artifactId, asset.filePath.split("/").pop()!
    );
    if (!readResult.ok) continue;
    const buf = Buffer.from(readResult.value);
    const ext = asset.filePath.split(".").pop()?.toLowerCase() ?? "png";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
    dataUris.push(`data:${mime};base64,${buf.toString("base64")}`);
  }
  return dataUris;
}

// --- Tool definition ---

export function rewritePromptDef(fs: Engine): ToolDef {
  return {
    name: "rewrite_prompt",
    description:
      "Rewrite a generation prompt using model-specific best practices. " +
      "Supports standard mode (rewrite any prompt) and scene mode (rewrite a " +
      "specific scene in a Kling 3.0 multi-shot asset).",
    schema: {
      prompt: z.string().optional().describe("Prompt to rewrite. In scene mode, serves as optional creative direction."),
      model: z
        .enum(["nano_banana", "gpt_image", "kling30", "grok_imagine", "grok_image", "seedance2", "gemini_omni"])
        .default("kling30")
        .describe("Target model for prompt optimization"),
      image_refs: z
        .array(z.string())
        .optional()
        .describe("Optional image artifact ids for visual context"),
      book_id: z.string().describe("Book id"),
      asset_ref: z.string().optional().describe("Artifact id for scene-context rewrite (requires scene_index)"),
      scene_index: z.number().int().optional().describe("0-based scene index to rewrite (requires asset_ref)"),
      platform: z
        .enum(["ig", "tiktok", "youtube"])
        .optional()
        .describe("Optional platform aesthetic preset (Instagram/TikTok/YouTube)"),
      custom_prompt: z
        .string()
        .max(500)
        .optional()
        .describe("Optional free-form additional instruction (max 500 chars)"),
      provider_docs: z
        .boolean()
        .optional()
        .describe(
          "Provider-docs mode: rewrite against the useapi.net Google Flow API documentation " +
            "(@-mention grammar, model vocab, reference budgets) instead of a model guide + " +
            "platform overlay. Mutually exclusive with platform.",
        ),
      previous_error: z
        .string()
        .max(2000)
        .min(1)
        .optional()
        .describe(
          "Explicit error message to adapt the rewritten prompt around. When omitted, " +
            "the tool auto-looks up the latest matching generation error by prompt text.",
        ),
    },
    handler: async (args) => {
      const {
        prompt, model, image_refs, book_id,
        asset_ref, scene_index, platform, custom_prompt, provider_docs, previous_error,
      } = args as {
        prompt?: string;
        model: string;
        image_refs?: string[];
        book_id: string;
        asset_ref?: string;
        scene_index?: number;
        platform?: Platform;
        custom_prompt?: string;
        provider_docs?: boolean;
        previous_error?: string;
      };

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "OPENAI_API_KEY environment variable is not set" }],
        };
      }

      // Scene rewrite mode
      if (asset_ref !== undefined && scene_index !== undefined) {
        return handleSceneRewrite(fs, apiKey, asset_ref, scene_index, prompt, book_id);
      }

      // Standard rewrite mode — require prompt OR reference images
      const hasImages = !!image_refs && image_refs.length > 0;
      if (!prompt && !hasImages) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: "Provide a prompt, or reference image_refs (for vision-based description), or both.",
          }],
        };
      }

      // Auto-lookup previous error BEFORE @s01 slot expansion (stored failed
      // prompts are pre-expansion). Skipped when previous_error was passed
      // explicitly.
      let previousError: PreviousError | undefined;
      if (previous_error) {
        previousError = { message: previous_error };
      } else if (prompt) {
        const found = await findPreviousErrorForPrompt(fs, book_id, prompt);
        if (found) {
          previousError = {
            message: found.message,
            ...(found.failCode ? { failCode: found.failCode } : {}),
          };
        }
      }

      // Expand @s01 slot refs → @<artifact-id> tokens
      let expandedPrompt = prompt ?? "";
      if (expandedPrompt) {
        expandedPrompt = expandTimelineSlotRefs(expandedPrompt, timelineSlotArtifactIds(fs));
      }

      return handleStandardRewrite(fs, apiKey, expandedPrompt, model, image_refs, book_id, platform, custom_prompt, provider_docs, previousError);
    },
  };
}

async function handleStandardRewrite(
  fs: Engine,
  apiKey: string,
  prompt: string,
  model: string,
  imageRefs: string[] | undefined,
  bookId: string,
  platform: Platform | undefined,
  customPrompt: string | undefined,
  providerDocs: boolean | undefined,
  previousError: PreviousError | undefined,
): Promise<{ isError?: true; content: Array<{ type: "text"; text: string }> }> {
  const effectiveProviderDocs = providerDocs || model === "gemini_omni";

  let guide: string;
  let guideFile: string;
  try {
    if (effectiveProviderDocs) {
      guide = await loadUseapiGuide();
      guideFile = USEAPI_GUIDE_FILE;
    } else {
      guide = await loadGuide(model);
      guideFile = guideFilename(model);
    }
  } catch (e) {
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: (e as Error).message }],
    };
  }

  const maxChars = model === "kling30" ? 400 : undefined;
  const responses = buildIntelligenceResponses(apiKey, { timeout: 60_000 });
  const extras: BuildRewriteExtras = effectiveProviderDocs
    ? { maxChars, customPrompt, providerDocs: true, modelContext: MODEL_CONTEXT[model] ?? model, previousError }
    : { maxChars, platform, customPrompt, previousError };

  let messages: OpenAiMessage[];
  if (imageRefs && imageRefs.length > 0) {
    const dataUris = await resolveImageDataUris(imageRefs, fs, bookId);
    if (dataUris.length === 0) {
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: "Could not resolve any image files from provided refs" }],
      };
    }
    messages = buildVisionMessages(guide, prompt, dataUris, extras);
  } else {
    messages = buildRewriteMessages(guide, prompt, extras);
  }

  const result = await responses(intelligenceRequest({
    input: responseInputFromMessages(messages),
    text: { format: { type: "text" } },
    max_output_tokens: 1024,
  }));

  const rewritten = firstResponseText(result);
  const output = buildResult(model, prompt, rewritten, guideFile, previousError);

  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
  };
}

async function handleSceneRewrite(
  fs: Engine,
  apiKey: string,
  assetRef: string,
  sceneIndex: number,
  instruction: string | undefined,
  _bookId: string,
): Promise<{ isError?: true; content: Array<{ type: "text"; text: string }> }> {
  const assetId = assetRef.replace(/^@/, "");

  const metaResult = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, "tool.params");
  if (!metaResult.ok) {
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: `No .tool.params.json found for ${assetRef}` }],
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

  const responses = buildIntelligenceResponses(apiKey, { timeout: 60_000 });
  const result = await responses(intelligenceRequest({
    input: [{ role: "user", content: text }],
    text: { format: { type: "text" } },
    max_output_tokens: 1024,
  }));

  const rewritten = firstResponseText(result);
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

function responseInputFromMessages(messages: OpenAiMessage[]): Array<{
  role: "user" | "assistant" | "system";
  content: string | Array<
    | { type: "input_text"; text: string }
    | { type: "input_image"; image_url: string; detail: "auto" | "low" | "high" }
  >;
}> {
  return messages.map((message) => ({
    role: message.role,
    content: typeof message.content === "string"
      ? message.content
      : message.content.map((part) => part.type === "text"
        ? { type: "input_text" as const, text: part.text }
        : {
            type: "input_image" as const,
            image_url: part.image_url.url,
            detail: part.image_url.detail ?? "auto",
          }),
  }));
}
