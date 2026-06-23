import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

// Persisted per-frame character wiring. Each frame's swap uses only the
// character(s) listed here (1–2), in order (first = Image 2, second = Image 3).
// Absent → consumers fall back to all sidecar.characters (legacy "both" default).
type FrameCharacters = {
  image1?: string[];
  image2?: string[];
};

type PlanScene = {
  start: number;
  end: number;
  visual: string;
  frame_characters?: FrameCharacters | null;
  swap?: {
    image1: string | null;
    image2: string | null;
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

const MIN_CHARACTERS = 1;
const MAX_CHARACTERS = 2;

const schema = {
  project_slug: z.string().describe("Project slug"),
  scene_index: z.number().int().nonnegative().describe("Zero-based scene index in plan/.plan.json"),
  frame_index: z.union([z.literal(1), z.literal(2)]).describe("1 = first-frame swap (image1), 2 = last-frame swap (image2)"),
  character_asset_ids: z
    .array(z.string())
    .min(MIN_CHARACTERS)
    .max(MAX_CHARACTERS)
    .describe(`${MIN_CHARACTERS}–${MAX_CHARACTERS} character asset ids (char-*/img-*, @ optional) wired to this frame's swap, in order. First = Image 2, second = Image 3.`),
};

export function setPlanSceneFrameCharactersDef(fs: VideocityFs): ToolDef {
  return {
    name: "set_plan_scene_frame_characters",
    description:
      "Set which character(s) a plan scene's swap frame uses (the canvas wiring). Writes scenes[N].frame_characters.image{1|2} as an ordered list of 1–2 character asset ids; the swap gen then feeds only those references instead of all characters. Returns the updated sidecar.",
    schema,
    handler: async (args) => {
      const { project_slug, scene_index, frame_index, character_asset_ids } = args as {
        project_slug: string;
        scene_index: number;
        frame_index: 1 | 2;
        character_asset_ids: string[];
      };

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

      // Normalize (@ stripped, de-duplicated keeping order) and validate against
      // the known character roster so wiring can't drift to unknown ids.
      const known = new Set(plan.characters.map((c) => c.asset_id));
      const seen = new Set<string>();
      const ids: string[] = [];
      for (const raw of character_asset_ids) {
        const id = raw.replace(/^@/, "");
        if (seen.has(id)) continue;
        if (!known.has(id)) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: `Character ${id} is not in this plan's character roster (${[...known].join(", ") || "none"})`,
            }],
          };
        }
        seen.add(id);
        ids.push(id);
      }
      if (ids.length < MIN_CHARACTERS) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `At least ${MIN_CHARACTERS} character required` }],
        };
      }

      const frameCharacters: FrameCharacters = { ...(scene.frame_characters ?? {}) };
      frameCharacters[`image${frame_index}` as "image1" | "image2"] = ids;
      plan.scenes[scene_index] = { ...scene, frame_characters: frameCharacters };

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

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            scene_index,
            frame_index,
            character_asset_ids: ids,
            sidecar: plan,
          }),
        }],
      };
    },
  };
}
