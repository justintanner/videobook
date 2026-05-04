import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";
import { type ImageInput, resolveImageSlugs } from "./_image-inputs.js";

const REQUIRED_CHARACTERS = 2;

const SUPPORTED_PROVIDERS = ["kie"] as const;
const SUPPORTED_MODELS_BY_PROVIDER = {
  kie: ["gpt-image-2"],
} as const;
type Provider = typeof SUPPORTED_PROVIDERS[number];
type Model = "gpt-image-2";

type PlanScene = {
  start: number;
  end: number;
  visual: string;
  swap?: { image1: string | null; image2: string | null } | null;
};

type PlanSidecar = {
  scenes: PlanScene[];
  source_asset_id: string;
  characters: Array<{ asset_id: string; name: string; description: string }>;
  total_duration_s: number;
  max_scene_seconds: number;
  model: string;
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
  model: z.enum(["gpt-image-2"]).optional().describe("Image-edit model (default: gpt-image-2)"),
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Translate the plan's `@<asset-id>` tokens to "the person from Image N"
// before handing the prose to gpt-image-2. The model has no concept of asset
// ids — it only sees three image byte streams labelled Image 1/2/3 by array
// order. The Seedance-specific "lock the appearance of ... to reference image
// 1 and reference image 2 respectively" trailer is also stripped because it
// contradicts our 3-input layout (Image 1 is the source frame, not a
// reference) and would mislead the model.
function rewriteVisualForSwap(visual: string, charA: string, charB: string): string {
  let out = visual
    .replace(new RegExp(`@${escapeRegExp(charA)}\\b`, "g"), "the person from Image 2")
    .replace(new RegExp(`@${escapeRegExp(charB)}\\b`, "g"), "the person from Image 3");
  out = out.replace(/\s*lock the appearance of[^.]*respectively\.?\s*/gi, " ");
  return out.replace(/\s+/g, " ").trim();
}

// Per OpenAI's gpt-image-2 prompting guide: label each input image by role
// and reference inputs as "Image 1", "Image 2", "Image 3". The character refs
// are FULL-appearance references — face + hair + body + wardrobe. We take
// pose/composition/lighting from the source frame; we take the people
// themselves (including wardrobe) from the references.
function buildSwapPrompt(charA: string, charB: string, visual: string): string {
  const context = rewriteVisualForSwap(visual, charA, charB);
  return [
    "Image 1: source frame to edit. Image 2: full-appearance reference for one of the on-screen subjects (face, hair, body, AND wardrobe). Image 3: full-appearance reference for the other on-screen subject (face, hair, body, AND wardrobe).",
    "",
    "Scene context (describes which on-screen subject in Image 1 corresponds to which reference):",
    `"${context}"`,
    "",
    "Replace each on-screen subject in Image 1 with the corresponding person from Image 2 or Image 3 as described in the scene context. For each replacement, copy across the reference's full appearance — face, hair, skin tone, body type, and the wardrobe as shown in the reference (same garments, same colors, same styling).",
    "",
    "Preserve from Image 1: composition, framing, camera angle, lens, depth of field, lighting direction and color palette, environment / set, and the body language, pose, and gesture of each subject (the action they're performing in the frame).",
    "",
    "Do NOT preserve the original subjects' clothing — replace it with the reference wardrobe. The pose stays; the wardrobe changes.",
    "",
    "Output: photorealistic, 8k, high detail.",
  ].join("\n");
}

export function swapPlanSceneFrameDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "swap_plan_scene_frame",
    description:
      "Run gpt-image-2 image-to-image on a plan scene's source frame, swapping the two on-screen subjects with two character references. Creates a new img-* asset for the swapped frame and updates plan/.plan.json with that asset's id at scenes[N].swap.image{1|2}. Reuses the existing generate_gpt_image job pipeline.",
    schema,
    handler: async (args) => {
      const { project_slug, scene_index, frame_index, character_asset_ids, provider: providerArg, model: modelArg } = args as {
        project_slug: string;
        scene_index: number;
        frame_index: 1 | 2;
        character_asset_ids: string[];
        provider?: Provider;
        model?: Model;
      };

      const provider: Provider = providerArg ?? "kie";
      const model: Model = modelArg ?? "gpt-image-2";

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

      const sourceFilename = `scene-${scene_index}-image${frame_index}-source.jpg`;
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

      const charIds = resolvedChars.sourceImageIds;
      const prompt = buildSwapPrompt(charIds[0], charIds[1], scene.visual);

      const imageInputs: ImageInput[] = [
        { assetId: "plan", filename: sourceFilename },
        ...resolvedChars.inputs,
      ];

      const newAssetResult = await fs.createAsset(
        "img",
        `scene-${scene_index}-image${frame_index}-swap`,
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
      swap[`image${frame_index}` as "image1" | "image2"] = imgAssetId;
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

      // Job-type routing by (provider, model). Today only kie+gpt-image-2 is
      // wired; future fal models will branch here.
      const jobId = `swap-${provider}-${model}-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_gpt_image",
        prompt,
        imageInputs,
        imgAssetId,
        imgAssetDir,
        sourceImageIds: charIds,
        projectSlug: project_slug,
        aspectRatio: "16:9",
        resolution: "2K",
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
