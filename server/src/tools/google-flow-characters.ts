import type { VideocityFs } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import {
  GoogleFlowCharactersCreateRequestSchema,
} from "@apicity/googleflow/zod";
import type { GoogleFlowProvider } from "@apicity/googleflow";
import { createGoogleFlowProvider, uploadAssetToGoogleFlow } from "../jobs/_google-flow.js";
import { apicityField } from "./schema-from-apicity.js";
import { toolError } from "./_shared.js";
import { resolveImageSlug } from "./_seedance2-shared.js";
import type { SchemaArgs, ToolDef, ToolResult } from "./tool-def.js";
import {
  readCreatedRef,
  readEntityList,
  resolveGoogleFlowEmail,
  type GoogleFlowEntity,
} from "./_google-flow-entities.js";

// ---------------------------------------------------------------------------
// Google Flow characters (POST/GET/DELETE /google-flow/characters). A character
// bundles 1-2 reference images (plus optional personality notes and a voice)
// into a ref that feeds character_1..7 on generate_google_omni_video
// (character_refs). Each character's images share omni's 7-image reference
// budget with image_slugs. GET/DELETE-by-ref paths ride the googleFlowFetch raw
// -path hook in createGoogleFlowProvider (docs/apicity-gaps.md §16).
// ---------------------------------------------------------------------------

export type CreateGoogleFlowCharacterInput = {
  displayName: string;
  imageReferences: string[];
  personalityNotes?: string;
  voice?: string;
};

export type CreatedGoogleFlowCharacter = {
  character_ref: string;
  display_name: string;
  status: "created";
};

export async function createGoogleFlowCharacter(
  provider: GoogleFlowProvider,
  input: CreateGoogleFlowCharacterInput,
): Promise<CreatedGoogleFlowCharacter> {
  const [imageReference_1, imageReference_2] = input.imageReferences;
  if (!imageReference_1) throw new Error("createGoogleFlowCharacter requires at least one image reference");
  const res = await provider.v1.characters({
    displayName: input.displayName,
    imageReference_1,
    ...(imageReference_2 ? { imageReference_2 } : {}),
    ...(input.personalityNotes ? { personalityNotes: input.personalityNotes } : {}),
    ...(input.voice ? { voice: input.voice } : {}),
  });
  const ref = readCreatedRef(res as Record<string, unknown>, "character");
  if (!ref) {
    throw new Error(`Google Flow character create returned no character ref: ${JSON.stringify(res)}`);
  }
  return { character_ref: ref, display_name: input.displayName, status: "created" };
}

export async function listGoogleFlowCharacters(
  provider: GoogleFlowProvider,
  input: { email?: string },
): Promise<{ email: string; count: number; characters: GoogleFlowEntity[] }> {
  const email = await resolveGoogleFlowEmail(provider, input.email);
  const res = await provider.get.v1.characters({ email });
  const characters = readEntityList(res as Record<string, unknown>, "characters", "character");
  return { email, count: characters.length, characters };
}

export async function deleteGoogleFlowCharacter(
  provider: GoogleFlowProvider,
  ref: string,
): Promise<{ ref: string; status: "deleted" }> {
  await provider.delete.v1.characters({ ref });
  return { ref, status: "deleted" };
}

function jsonResult(payload: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

const createGoogleFlowCharacterSchema = {
  project_slug: z.string().describe("Project slug (source of the character images)"),
  display_name: apicityField(
    GoogleFlowCharactersCreateRequestSchema.shape.displayName,
    "Character name (1-200 chars)",
    { required: true },
  ),
  image_slugs: z
    .array(z.string())
    .min(1)
    .max(2)
    .describe(
      "1-2 character image @slugs; uploaded to Google Flow as imageReference_1/2. Each image counts against Omni's 7-image reference budget",
    ),
  personality_notes: apicityField(
    GoogleFlowCharactersCreateRequestSchema.shape.personalityNotes,
    "Personality / behavior notes (max 2000 chars)",
  ),
  voice: z
    .string()
    .optional()
    .describe("Optional voice: a preset name (e.g. 'Kore') or a custom voice ref from create_google_flow_voice"),
} satisfies ZodRawShape;

export function createGoogleFlowCharacterDef(fs: VideocityFs): ToolDef {
  return {
    name: "create_google_flow_character",
    description:
      "Create a reusable Google Flow character from 1-2 project image assets (plus optional personality notes and a voice). Returns a character ref for the character_refs parameter of generate_google_omni_video (character_1..7). Consumes plan credits.",
    schema: createGoogleFlowCharacterSchema,
    handler: async (args): Promise<ToolResult> => {
      const a = args as SchemaArgs<typeof createGoogleFlowCharacterSchema>;
      if (!process.env.GOOGLE_FLOW_API_KEY) {
        return toolError("GOOGLE_FLOW_API_KEY environment variable is not set");
      }
      const blank = (v: unknown): v is "" => typeof v === "string" && v.trim() === "";
      const slugs = (a.image_slugs ?? []).filter((s) => !blank(s));
      if (slugs.length < 1) return toolError("image_slugs requires at least one non-empty image @slug");
      if (slugs.length > 2) return toolError("A Google Flow character accepts at most 2 image references");

      const resolved: Array<{ assetId: string; filename: string }> = [];
      for (const slug of slugs) {
        const r = await resolveImageSlug(fs, slug, a.project_slug);
        if (!r.ok) return toolError(`image_slugs: ${r.error}`);
        resolved.push(r.value);
      }

      try {
        const provider = createGoogleFlowProvider();
        const imageReferences: string[] = [];
        for (const input of resolved) {
          imageReferences.push(
            await uploadAssetToGoogleFlow(provider, fs, input.assetId, input.filename, a.project_slug),
          );
        }
        const result = await createGoogleFlowCharacter(provider, {
          displayName: a.display_name as string,
          imageReferences,
          ...(a.personality_notes ? { personalityNotes: a.personality_notes as string } : {}),
          ...(a.voice ? { voice: a.voice } : {}),
        });
        return jsonResult({
          ...result,
          source_images: resolved.map((r) => r.assetId),
          usage: "Pass character_ref in character_refs of generate_google_omni_video (character_1..7)",
        });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

const listGoogleFlowCharactersSchema = {
  email: z.string().optional().describe("Google Flow account email; omit to use the single configured account"),
} satisfies ZodRawShape;

export function listGoogleFlowCharactersDef(): ToolDef {
  return {
    name: "list_google_flow_characters",
    description: "List Google Flow characters for an account.",
    schema: listGoogleFlowCharactersSchema,
    handler: async (args): Promise<ToolResult> => {
      const a = args as SchemaArgs<typeof listGoogleFlowCharactersSchema>;
      if (!process.env.GOOGLE_FLOW_API_KEY) {
        return toolError("GOOGLE_FLOW_API_KEY environment variable is not set");
      }
      try {
        const provider = createGoogleFlowProvider();
        return jsonResult(await listGoogleFlowCharacters(provider, { ...(a.email ? { email: a.email } : {}) }));
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

const deleteGoogleFlowCharacterSchema = {
  ref: z.string().min(1).describe("Character ref returned by create_google_flow_character / list_google_flow_characters"),
} satisfies ZodRawShape;

export function deleteGoogleFlowCharacterDef(): ToolDef {
  return {
    name: "delete_google_flow_character",
    description: "Delete a Google Flow character by its ref.",
    schema: deleteGoogleFlowCharacterSchema,
    handler: async (args): Promise<ToolResult> => {
      const a = args as SchemaArgs<typeof deleteGoogleFlowCharacterSchema>;
      if (!process.env.GOOGLE_FLOW_API_KEY) {
        return toolError("GOOGLE_FLOW_API_KEY environment variable is not set");
      }
      try {
        const provider = createGoogleFlowProvider();
        return jsonResult(await deleteGoogleFlowCharacter(provider, a.ref));
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
