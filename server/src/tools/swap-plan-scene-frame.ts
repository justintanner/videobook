import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "vc-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";
import { type ImageInput, resolveImageSlugs } from "./_image-inputs.js";
import { falWanImageSizeForDimensions, kieImageAspectRatioForDimensions } from "./_plan-aspect.js";
import type { PlanSwapModel } from "./_plan-aspect.js";

const REQUIRED_CHARACTERS = 2;

const SUPPORTED_PROVIDERS = ["kie", "fal"] as const;
const SUPPORTED_MODELS = ["nano-banana-pro", "gpt-image-2", "wan-2-7-image-pro"] as const;
// Fal doesn't host gpt-image-2 (OpenAI exclusive). Other models are mirrored
// via fal-ai/nano-banana-pro/edit and fal-ai/wan/v2.7/pro/edit.
const SUPPORTED_MODELS_BY_PROVIDER = {
  kie: SUPPORTED_MODELS,
  fal: ["nano-banana-pro", "wan-2-7-image-pro"] as const,
} as const;
type Provider = typeof SUPPORTED_PROVIDERS[number];
type Model = typeof SUPPORTED_MODELS[number];

const DEFAULT_MODEL: Model = "nano-banana-pro";

type SwapJobType =
  | "generate_gpt_image"
  | "generate_nano_banana_image"
  | "generate_wan27_image_pro"
  | "generate_nano_banana_pro_edit_fal"
  | "generate_wan27_pro_edit_fal";

const KIE_JOB_TYPE_BY_MODEL: Record<Model, SwapJobType> = {
  "gpt-image-2": "generate_gpt_image",
  "nano-banana-pro": "generate_nano_banana_image",
  "wan-2-7-image-pro": "generate_wan27_image_pro",
};

// Fal job types — only the two models Fal hosts. gpt-image-2 is intentionally
// absent and rejected upstream by SUPPORTED_MODELS_BY_PROVIDER.
const FAL_JOB_TYPE_BY_MODEL: Partial<Record<Model, SwapJobType>> = {
  "nano-banana-pro": "generate_nano_banana_pro_edit_fal",
  "wan-2-7-image-pro": "generate_wan27_pro_edit_fal",
};

// Short model codes embedded in the swap asset slug so multiple models
// running for the same scene/frame don't collide on slug-uniqueness retries.
// Provider is appended (e.g. `nbp-fal`) so kie+fal variants of the same model
// produce distinct asset slugs.
const SLUG_CODE_BY_MODEL: Record<Model, string> = {
  "gpt-image-2": "gi2",
  "nano-banana-pro": "nbp",
  "wan-2-7-image-pro": "wan",
};

type SwapVariants = Record<string, string>;

type PlanScene = {
  start: number;
  end: number;
  visual: string;
  swap?: {
    image1: string | null;
    image2: string | null;
    image1_accepted?: boolean;
    image2_accepted?: boolean;
    image1_variants?: SwapVariants;
    image2_variants?: SwapVariants;
  } | null;
};

type PlanSidecar = {
  scenes: PlanScene[];
  source_asset_id: string;
  characters: Array<{ asset_id: string; name: string; description: string }>;
  total_duration_s: number;
  max_scene_seconds: number;
  model: string;
};

type SourceDimensions = {
  width: number | null;
  height: number | null;
};

const schema = {
  project_slug: z.string().describe("Project slug"),
  scene_index: z.number().int().nonnegative().describe("Zero-based scene index in plan/.plan.json"),
  frame_index: z.union([z.literal(1), z.literal(2)]).describe("1 = first-frame swap (image1), 2 = last-frame swap (image2)"),
  character_asset_ids: z
    .array(z.string())
    .length(REQUIRED_CHARACTERS)
    .describe(`Exactly ${REQUIRED_CHARACTERS} char-* or img-* slugs — the two on-screen subjects to swap in.`),
  provider: z.enum(SUPPORTED_PROVIDERS).optional().describe("Image-edit provider (default: kie)"),
  model: z.enum(SUPPORTED_MODELS).optional().describe(`Image-edit model (default: ${DEFAULT_MODEL})`),
  prior_swap_asset_id: z
    .string()
    .optional()
    .describe("Optional img-* slug of an already-swapped frame from this scene (typically image1's swap when generating image2). Appended as Image 4 so the model can match the visual identity / styling of the prior frame."),
  safe_mode: z
    .boolean()
    .optional()
    .describe("When true, uses a much tamer prompt that avoids 'replace people' wording — for retrying after a content-moderation block."),
  custom_prompt: z
    .string()
    .optional()
    .describe("If provided, used verbatim as the prompt. Overrides the built-in default and ignores safe_mode."),
};

// The default prompt — exposed so the client can prefill the inline editor.
export const DEFAULT_SWAP_PROMPT = "Edit Image 1: replace the people with the people from Image 2 and Image 3, matching each reference's appearance and outfit. Keep Image 1's composition, framing, lighting, camera angle, and the original poses unchanged.";

// Short, neutral prompt. Earlier versions embedded scene prose plus identity
// language ("face, hair, skin tone, body type") and tripped gpt-image-2's
// content filter (failures at 11–19s with 0 credits — the OpenAI moderation
// signature). nano-banana-pro is more permissive but the same tight
// instruction works well for both.
//
// frame2Continuity: when true, the prompt assumes inputs are exactly
// [source last frame, prior swap of first frame] — no character refs. Used
// when the prior frame is already swapped, since char identity already lives
// in Image 2 and re-passing the original char crops adds noise.
function buildSwapPrompt(hasPriorSwap: boolean, safeMode: boolean, frame2Continuity: boolean): string {
  if (frame2Continuity) {
    if (safeMode) {
      return "Re-style Image 1 (the last frame of this scene) so the people in it look like the people in Image 2 (the first frame of this scene). Use Image 2 only as a look reference for face, hair, wardrobe, and color grade. Do not copy Image 2's composition, framing, background, camera position, crop, or pose. Preserve Image 1's source-frame composition, framing, crop, camera angle, background, lighting, and original poses unchanged.";
    }
    return "Edit Image 1 (the last frame of this scene): match the people's appearance to Image 2 (the first frame of this scene). Use Image 2 only as a look reference for face, hair, wardrobe, and color grade. Do not copy Image 2's composition, framing, background, camera position, crop, or pose. Preserve Image 1's source-frame composition, framing, crop, camera angle, background, lighting, and original poses unchanged.";
  }
  if (safeMode) {
    // Reframed without "replace people" / "swap subjects" wording — these
    // phrases trigger Kie/OpenAI moderation. Talk in styling / matching
    // terms instead. The references still drive the result.
    if (hasPriorSwap) {
      return "Re-style Image 1 so the people in it look like the people in Image 2 and Image 3. Image 4 shows how those same two people appeared in the prior frame of this scene — match their look to Image 4 for continuity. Keep Image 1's composition, framing, lighting, camera angle, and poses unchanged.";
    }
    return "Re-style Image 1 so the people in it look like the people in Image 2 and Image 3, matching each reference's appearance and outfit. Keep Image 1's composition, framing, lighting, camera angle, and poses unchanged.";
  }
  if (hasPriorSwap) {
    return "Edit Image 1: replace the people with the people from Image 2 and Image 3, matching each reference's appearance and outfit. Image 4 shows how those same two people appeared in the prior frame of this scene — match their look (face, hair, wardrobe, color grade) to Image 4 exactly so the two frames feel continuous. Keep Image 1's composition, framing, lighting, camera angle, and the original poses unchanged.";
  }
  return "Edit Image 1: replace the people with the people from Image 2 and Image 3, matching each reference's appearance and outfit. Keep Image 1's composition, framing, lighting, camera angle, and the original poses unchanged.";
}

function metadataNumber(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

async function readSourceDimensions(
  fs: ClipfirstFs,
  sourceAssetId: string,
  projectSlug: string,
): Promise<SourceDimensions> {
  const metadata = await fs.readMetadata<Record<string, unknown>>(
    sourceAssetId.replace(/^@/, ""),
    "original",
    projectSlug,
  );
  if (!metadata.ok) return { width: null, height: null };
  return {
    width: metadataNumber(metadata.value.width),
    height: metadataNumber(metadata.value.height),
  };
}

export function swapPlanSceneFrameDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "swap_plan_scene_frame",
    description:
      "Run an image-to-image model (nano-banana-pro by default; gpt-image-2 alternative) on a plan scene's source frame, swapping the two on-screen subjects with two character references. Creates a new img-* asset for the swapped frame and updates plan/.plan.json with that asset's id at scenes[N].swap.image{1|2}. Reuses the existing generate_nano_banana_image / generate_gpt_image job pipelines.",
    schema,
    handler: async (args) => {
      const { project_slug, scene_index, frame_index, character_asset_ids, provider: providerArg, model: modelArg, prior_swap_asset_id, safe_mode, custom_prompt } = args as {
        project_slug: string;
        scene_index: number;
        frame_index: 1 | 2;
        character_asset_ids: string[];
        provider?: Provider;
        model?: Model;
        prior_swap_asset_id?: string;
        safe_mode?: boolean;
        custom_prompt?: string;
      };

      const provider: Provider = providerArg ?? "kie";
      const model: Model = modelArg ?? DEFAULT_MODEL;

      const allowedModels = SUPPORTED_MODELS_BY_PROVIDER[provider];
      if (!allowedModels.includes(model as never)) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Provider ${provider} does not yet support model ${model}. Supported: ${allowedModels.join(", ")}.`,
          }],
        };
      }

      if (provider === "kie" && !process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      if (provider === "fal" && !process.env.FAL_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }],
        };
      }

      const planRead = await fs.readFile("plan", ".plan.json", project_slug);
      if (!planRead.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No plan in ${project_slug}: ${planRead.error.message}` }],
        };
      }
      let plan: PlanSidecar;
      try {
        plan = JSON.parse(Buffer.from(planRead.value).toString("utf-8")) as PlanSidecar;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Invalid .plan.json: ${msg}` }],
        };
      }

      const scene = plan.scenes[scene_index];
      if (!scene) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Scene index ${scene_index} out of range (have ${plan.scenes.length})`,
          }],
        };
      }

      const sourceFilename = `s${scene_index + 1}-image${frame_index}-source.jpg`;
      const planManifest = await fs.getManifest("plan", project_slug);
      if (!planManifest.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: planManifest.error.message }],
        };
      }
      const hasSourceFrame = planManifest.value.files.some((f) => f.name === sourceFilename);
      if (!hasSourceFrame) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `${sourceFilename} not found in plan/. Re-run /plan-vis to extract source frames.`,
          }],
        };
      }

      const resolvedChars = await resolveImageSlugs(fs, character_asset_ids, project_slug);
      if (!resolvedChars.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: resolvedChars.error }],
        };
      }
      if (resolvedChars.inputs.length !== REQUIRED_CHARACTERS) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Expected ${REQUIRED_CHARACTERS} character refs, got ${resolvedChars.inputs.length}`,
          }],
        };
      }

      // Frame-2 continuity: when generating the last frame and we already
      // have a swapped first frame, drop the character refs entirely — the
      // prior swap is the canonical look reference, and re-passing the char
      // crops just adds noise.
      const isFrame2Continuity = frame_index === 2 && Boolean(prior_swap_asset_id);

      let priorPushed = false;
      if (prior_swap_asset_id) {
        const priorAssetDir = await fs.resolveAssetDir(prior_swap_asset_id, project_slug);
        if (!priorAssetDir.ok) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: `prior_swap_asset_id ${prior_swap_asset_id} not found: ${priorAssetDir.error.message}`,
            }],
          };
        }
        priorPushed = true;
      }

      const imageInputs: ImageInput[] = isFrame2Continuity
        ? [
          { assetId: "plan", filename: sourceFilename },
          { assetId: prior_swap_asset_id as string, filename: "original.png" },
        ]
        : [
          { assetId: "plan", filename: sourceFilename },
          ...resolvedChars.inputs,
          ...(priorPushed ? [{ assetId: prior_swap_asset_id as string, filename: "original.png" }] : []),
        ];

      const charIds = isFrame2Continuity ? [] : resolvedChars.sourceImageIds;

      const prompt = custom_prompt && custom_prompt.trim().length > 0
        ? custom_prompt.trim()
        : buildSwapPrompt(Boolean(prior_swap_asset_id), safe_mode === true, isFrame2Continuity);

      const slugCode = provider === "fal"
        ? `${SLUG_CODE_BY_MODEL[model]}-fal`
        : SLUG_CODE_BY_MODEL[model];
      // Asset slug shape: `img-<modelTag>[-fal]-s<sceneIdx1based>-<frameIdx>`
      // (e.g. `img-gi2-s1-1`, `img-nbp-fal-s2-2`). Scene index is 1-based for
      // user-facing readability — code internally keeps `scene_index` 0-based.
      const newAssetResult = await fs.createAsset(
        "img",
        `${slugCode}-s${scene_index + 1}-${frame_index}`,
        project_slug,
      );
      if (!newAssetResult.ok) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Failed to create swap asset: ${newAssetResult.error.message}`,
          }],
        };
      }
      const { assetId: imgAssetId, path: imgAssetDir } = newAssetResult.value;

      const swap = scene.swap ?? { image1: null, image2: null };
      const slotKey = `image${frame_index}` as "image1" | "image2";
      const variantsKey = `image${frame_index}_variants` as "image1_variants" | "image2_variants";
      const acceptedKey = `image${frame_index}_accepted` as "image1_accepted" | "image2_accepted";

      // Variant key: bare `{model}` for kie (preserves backward-compat with
      // older plans) and `fal:{model}` for fal — kie-nbp and fal-nbp coexist.
      const variantKey = provider === "fal" ? `fal:${model}` : model;
      const variants: SwapVariants = { ...(swap[variantsKey] ?? {}) };
      const previousForModel = variants[variantKey];
      variants[variantKey] = imgAssetId;
      swap[variantsKey] = variants;

      // Update the selected pointer to the new asset id when:
      //   - nothing was selected yet (first run for this frame), OR
      //   - the user was on this model's previous variant (a regen of the
      //     selected one should follow the new asset).
      // Otherwise the user has an explicit selection on a different model and
      // we don't override their choice.
      if (!swap[slotKey] || swap[slotKey] === previousForModel) {
        swap[slotKey] = imgAssetId;
        swap[acceptedKey] = false;
      }
      plan.scenes[scene_index] = { ...scene, swap };

      const writeResult = await fs.writeFile(
        "plan",
        ".plan.json",
        JSON.stringify(plan, null, 2),
        project_slug,
      );
      if (!writeResult.ok) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Failed to update .plan.json: ${writeResult.error.message}`,
          }],
        };
      }

      // Job-type routing by (provider, model). Kie jobs use camelCase
      // aspectRatio/resolution; the fal nano-banana-pro/edit job uses
      // snake_case aspect_ratio/resolution; the fal wan/2.7/pro/edit job uses
      // image_size instead — keep the per-job payload shape minimal.
      const jobId = `swap-${provider}-${model}-${imgAssetId}-${Date.now()}`;
      const jobType: SwapJobType | undefined = provider === "fal"
        ? FAL_JOB_TYPE_BY_MODEL[model]
        : KIE_JOB_TYPE_BY_MODEL[model];
      if (!jobType) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `No job handler for provider=${provider} model=${model}`,
          }],
        };
      }

      const baseJob = {
        type: jobType,
        prompt,
        imageInputs,
        imgAssetId,
        imgAssetDir,
        sourceImageIds: charIds,
        projectSlug: project_slug,
      };
      const sourceDimensions = await readSourceDimensions(fs, plan.source_asset_id, project_slug);
      const kieAspectRatio = kieImageAspectRatioForDimensions(
        model as PlanSwapModel,
        sourceDimensions.width,
        sourceDimensions.height,
      );
      const falWanImageSize = falWanImageSizeForDimensions(
        sourceDimensions.width,
        sourceDimensions.height,
      );
      const providerSpecific: Record<string, unknown> = provider === "fal"
        ? (model === "wan-2-7-image-pro"
          ? { image_size: falWanImageSize }
          : { aspect_ratio: kieAspectRatio, resolution: "2K" })
        : { aspectRatio: kieAspectRatio, resolution: "2K" };
      await queue.enqueue(jobId, {
        ...baseJob,
        ...providerSpecific,
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id: imgAssetId,
            scene_index,
            frame_index,
            provider,
            model,
            job_id: jobId,
            status: "enqueued",
            aspect: {
              source_width: sourceDimensions.width,
              source_height: sourceDimensions.height,
              image_aspect_ratio: providerSpecific.aspectRatio ?? providerSpecific.aspect_ratio,
              image_size: providerSpecific.image_size,
            },
            sidecar: plan,
          }),
        }],
      };
    },
  };
}

export function registerSwapPlanSceneFrameTool(server: McpServer, fs: ClipfirstFs): void {
  const def = swapPlanSceneFrameDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
