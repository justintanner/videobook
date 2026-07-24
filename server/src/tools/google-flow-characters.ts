import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import {
  GoogleFlowCharactersCreateRequestSchema,
} from "@apicity/googleflow/zod";
import type { GoogleFlowProvider } from "@apicity/googleflow";
import { createGoogleFlowProvider, uploadAssetToGoogleFlow } from "../jobs/_google-flow.js";
import { apicityField } from "./schema-from-apicity.js";
import { toolError } from "./_shared.js";

import { extname } from "node:path";
import type { ArtifactManifestFile } from "videobook-engine";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function getImagesFromManifest(files: ArtifactManifestFile[]): ArtifactManifestFile[] {
  return files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
}
import type { SchemaArgs, ToolDef, ToolResult } from "./tool-def.js";
import {
  readCharacterImageCount,
  readCharacterThumbnailUrl,
  readCreatedRef,
  readEntityList,
  resolveGoogleFlowEmail,
  type GoogleFlowEntity,
} from "./_google-flow-entities.js";

// ---------------------------------------------------------------------------
// Google Flow characters (POST/GET/DELETE /google-flow/characters). A character
// bundles 1-2 reference images (plus optional personality notes and a voice)
// into a ref that feeds character_1..N on generate_google_flow_omni_flash_video
// (character_refs). Each character costs a flat 2 of omni's 7 reference slots
// shared with image_slugs, regardless of its image count (google-flow-refs.ts).
// GET/DELETE-by-ref paths ride the googleFlowFetch raw
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
  status: "created" | "partial-success";
  warning?: string;
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
  }) as Record<string, unknown>;
  const ref = readCreatedRef(res, "character");
  if (!ref) {
    throw new Error(`Google Flow character create returned no character ref: ${JSON.stringify(res)}`);
  }
  
  const returnedName = (typeof res.displayName === "string" && res.displayName.trim()) ||
                       (typeof res.display_name === "string" && res.display_name.trim()) ||
                       (typeof res.name === "string" && res.name.trim()) ||
                       "Untitled Character";

  if (returnedName !== input.displayName) {
    return {
      character_ref: ref,
      display_name: returnedName,
      status: "partial-success",
      warning: `Provider returned name "${returnedName}" instead of requested "${input.displayName}"`
    };
  }

  return { character_ref: ref, display_name: input.displayName, status: "created" };
}

export function reconcileGoogleFlowCharacter(
  listData: GoogleFlowEntity | null,
  singletonData: GoogleFlowEntity | null,
): GoogleFlowEntity {
  if (!listData) return singletonData!;
  if (!singletonData) return listData;

  const rawList = (listData.raw as Record<string, unknown>) || {};
  const rawSingle = (singletonData.raw as Record<string, unknown>) || {};

  const nameConflict =
    typeof rawSingle.displayName === "string" &&
    rawSingle.displayName !== "Untitled Character" &&
    rawSingle.displayName !== listData.display_name;

  return {
    ref: listData.ref ?? singletonData.ref,
    display_name: listData.display_name ?? singletonData.display_name,
    thumbnail_url: singletonData.thumbnail_url ?? listData.thumbnail_url,
    image_count: singletonData.image_count ?? listData.image_count,
    raw: {
      ...rawSingle,
      ...rawList,
      displayName: listData.display_name ?? singletonData.display_name,
      display_name: listData.display_name ?? singletonData.display_name,
      personalityNotes: rawList.personalityNotes ?? rawList.personality_notes,
      voice: rawList.voice ?? rawSingle.voice,
      _conflict: nameConflict ? "singleton-read-disagrees" : undefined,
    },
  };
}

/** Resolve one character with signed thumbnail (GET characters/ref) and reconcile with list data. */
export async function getGoogleFlowCharacter(
  provider: GoogleFlowProvider,
  ref: string,
): Promise<GoogleFlowEntity> {
  const email = await resolveGoogleFlowEmail(provider).catch(() => undefined);
  const [listRes, singletonRes] = await Promise.allSettled([
    email ? provider.get.v1.characters({ email }) : Promise.resolve({ characters: [] }),
    provider.get.v1.characters.retrieve({ ref })
  ]);

  if (singletonRes.status === "rejected") {
    throw singletonRes.reason;
  }

  const rawSingleton = singletonRes.value as Record<string, unknown>;
  const detailEntity = {
    ref: readCreatedRef(rawSingleton, "character") ?? ref,
    display_name:
      (typeof rawSingleton.displayName === "string" && rawSingleton.displayName.trim()) ||
      (typeof rawSingleton.display_name === "string" && rawSingleton.display_name.trim()) ||
      (typeof rawSingleton.name === "string" && rawSingleton.name.trim()) ||
      null,
    thumbnail_url: readCharacterThumbnailUrl(rawSingleton),
    image_count: readCharacterImageCount(rawSingleton),
    raw: rawSingleton,
  };

  let listEntity: GoogleFlowEntity | null = null;
  if (listRes.status === "fulfilled") {
    const characters = readEntityList(listRes.value as Record<string, unknown>, "characters", "character");
    listEntity = characters.find(c => c.ref === ref) ?? null;
  }

  return reconcileGoogleFlowCharacter(listEntity, detailEntity);
}

const PREVIEW_BATCH = 8;

/** Attach signed thumbnail_url via parallel retrieve when list omits media URLs. */
export async function enrichCharactersWithPreviews(
  provider: GoogleFlowProvider,
  characters: GoogleFlowEntity[],
): Promise<GoogleFlowEntity[]> {
  if (characters.length === 0) return characters;
  const out = characters.map((c) => ({ ...c }));
  for (let i = 0; i < out.length; i += PREVIEW_BATCH) {
    const batch = out.slice(i, i + PREVIEW_BATCH);
    const results = await Promise.allSettled(
      batch.map(async (c) => {
        if (!c.ref) return c;
        if (c.thumbnail_url) return c;
        try {
          const res = await provider.get.v1.characters.retrieve({ ref: c.ref }) as Record<string, unknown>;
          const detailEntity = {
            ref: readCreatedRef(res, "character") ?? c.ref,
            display_name:
              (typeof res.displayName === "string" && res.displayName.trim()) ||
              (typeof res.display_name === "string" && res.display_name.trim()) ||
              (typeof res.name === "string" && res.name.trim()) ||
              null,
            thumbnail_url: readCharacterThumbnailUrl(res),
            image_count: readCharacterImageCount(res),
            raw: res,
          };
          return reconcileGoogleFlowCharacter(c, detailEntity);
        } catch {
          return c;
        }
      }),
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") out[i + j] = r.value;
    }
  }
  return out;
}

const getGoogleFlowCharacterSchema = {
  ref: z.string().min(1).describe("Character ref to retrieve"),
} satisfies ZodRawShape;

export function getGoogleFlowCharacterDef(): ToolDef {
  return {
    name: "get_google_flow_character",
    description: "Retrieve normalized details for a single Google Flow character by ref.",
    schema: getGoogleFlowCharacterSchema,
    handler: async (args): Promise<ToolResult> => {
      const a = args as SchemaArgs<typeof getGoogleFlowCharacterSchema>;
      if (!process.env.GOOGLE_FLOW_API_KEY) {
        return toolError("GOOGLE_FLOW_API_KEY environment variable is not set");
      }
      try {
        const provider = createGoogleFlowProvider();
        return jsonResult(await getGoogleFlowCharacter(provider, a.ref));
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export async function listGoogleFlowCharacters(
  provider: GoogleFlowProvider,
  input: { email?: string; includePreviews?: boolean },
): Promise<{ email: string; count: number; characters: GoogleFlowEntity[] }> {
  const email = await resolveGoogleFlowEmail(provider, input.email);
  const res = await provider.get.v1.characters({ email });
  let characters = readEntityList(res as Record<string, unknown>, "characters", "character");
  if (input.includePreviews !== false) {
    characters = await enrichCharactersWithPreviews(provider, characters);
  }
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
      "1-2 character image @slugs; uploaded to Google Flow as imageReference_1/2. The character costs a flat 2 of Omni's 7 reference slots regardless of image count",
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

export function createGoogleFlowCharacterDef(fs: Engine): ToolDef {
  return {
    name: "create_google_flow_character",
    description:
      "Create a reusable Google Flow character from 1-2 project image assets (plus optional personality notes and a voice). Returns a character ref for the character_refs parameter of generate_google_flow_omni_flash_video (character_1..7). Consumes plan credits.",
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
        const assetId = slug.replace(/^@/, "");
        if (!assetId.startsWith("img-") && !assetId.startsWith("char-")) {
          return toolError(`image_slugs entries must be img-* or char-* assets, got: ${assetId}`);
        }
        const manifest = await fs.files.manifest(assetId, a.project_slug);
        if (!manifest.ok) return toolError(`image_slugs: ${manifest.error.message}`);
        const images = getImagesFromManifest(manifest.value.files);
        if (images.length === 0) return toolError(`image_slugs: No image files found in asset ${assetId}`);
        
        resolved.push({ assetId, filename: images[0].name });
        if (assetId.startsWith("char-") && images.length > 1 && resolved.length < 2) {
          resolved.push({ assetId, filename: images[1].name });
        }
      }
      
      if (resolved.length > 2) {
        resolved.length = 2; // enforce max 2 images for GF characters
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
          usage: "Pass character_ref in character_refs of generate_google_flow_omni_flash_video (character_1..7)",
        });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

const listGoogleFlowCharactersSchema = {
  email: z.string().optional().describe("Google Flow account email; omit to use the single configured account"),
  include_previews: z
    .boolean()
    .optional()
    .describe("When true (default), resolve signed thumbnail_url for each character via GET characters/ref"),
} satisfies ZodRawShape;

export function listGoogleFlowCharactersDef(): ToolDef {
  return {
    name: "list_google_flow_characters",
    description:
      "List Google Flow characters for an account (display names + optional signed thumbnail previews).",
    schema: listGoogleFlowCharactersSchema,
    handler: async (args): Promise<ToolResult> => {
      const a = args as SchemaArgs<typeof listGoogleFlowCharactersSchema>;
      if (!process.env.GOOGLE_FLOW_API_KEY) {
        return toolError("GOOGLE_FLOW_API_KEY environment variable is not set");
      }
      try {
        const provider = createGoogleFlowProvider();
        return jsonResult(await listGoogleFlowCharacters(provider, {
          ...(a.email ? { email: a.email } : {}),
          includePreviews: a.include_previews !== false,
        }));
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

// ---------------------------------------------------------------------------
// Rename. useapi.net has no PATCH/PUT for characters (probed 2026-07-11:
// PATCH /characters/{ref} → 500 "Unknown method PATCH for post-characters"),
// so rename = recreate with the same uploaded images + the new name, then
// delete the old ref. The ref CHANGES: callers must swap old_ref →
// character_ref anywhere the old ref is stored (e.g. character_refs).
// Recreate reuses the original uploads without re-uploading: an image
// mediaGenerationId is `<user:N-email:HEX>-image:<mediaId>` (the POST /assets
// response shape), and GET characters/ref returns each image's bare mediaId,
// so the id is rebuilt from the character ref's own prefix.
// ---------------------------------------------------------------------------

/** Rebuild create-time image mediaGenerationIds from a character ref and its
 *  retrieve body (`imageReferences[].mediaId`). */
export function characterImageGenerationIds(ref: string, raw: Record<string, unknown>): string[] {
  const marker = "-character:";
  const markerIdx = ref.indexOf(marker);
  if (markerIdx <= 0) {
    throw new Error(`Character ref has no "${marker}" segment to derive image ids from: ${ref}`);
  }
  const prefix = ref.slice(0, markerIdx);
  const images = raw.imageReferences ?? raw.image_references;
  const ids: string[] = [];
  if (Array.isArray(images)) {
    for (const img of images) {
      if (!img || typeof img !== "object") continue;
      const rec = img as Record<string, unknown>;
      const mediaId = rec.mediaId ?? rec.media_id;
      if (typeof mediaId === "string" && mediaId.trim() !== "") {
        ids.push(`${prefix}-image:${mediaId}`);
      }
    }
  }
  if (ids.length === 0) {
    throw new Error(`Character ${ref} retrieve returned no imageReferences[].mediaId to rebuild from`);
  }
  return ids.slice(0, 2);
}

/** Voice ref from a character retrieve body: bare string or an object
 *  carrying voice/ref/name. Null when absent (voice is optional). */
function readCharacterVoiceRef(raw: Record<string, unknown>): string | null {
  const voice = raw.voice;
  if (typeof voice === "string" && voice.trim() !== "") return voice;
  if (voice && typeof voice === "object" && !Array.isArray(voice)) {
    const rec = voice as Record<string, unknown>;
    for (const key of ["voice", "ref", "name"]) {
      const value = rec[key];
      if (typeof value === "string" && value.trim() !== "") return value;
    }
  }
  return null;
}

export type ReplacedGoogleFlowCharacter = {
  character_ref: string;
  old_ref: string;
  display_name: string;
  status: "replaced" | "partial-success";
  warning?: string;
};

export async function replaceGoogleFlowCharacter(
  provider: GoogleFlowProvider,
  fs: Engine | undefined,
  projectSlug: string | undefined,
  ref: string,
  opts: {
    displayName?: string;
    imageSlugs?: string[];
    personalityNotes?: string;
    voice?: string;
    clearPersonalityNotes?: boolean;
    clearVoice?: boolean;
  }
): Promise<ReplacedGoogleFlowCharacter> {
  const detail = await getGoogleFlowCharacter(provider, ref);
  const raw = (detail.raw ?? {}) as Record<string, unknown>;

  let imageReferences: string[] = [];
  if (opts.imageSlugs && opts.imageSlugs.length > 0) {
    if (!fs) throw new Error("fs is required when providing new image_slugs");
    if (!projectSlug) throw new Error("project_slug is required when providing new image_slugs");
    const blank = (v: unknown): v is "" => typeof v === "string" && v.trim() === "";
    const slugs = opts.imageSlugs.filter((s) => !blank(s));
    if (slugs.length > 2) throw new Error("A Google Flow character accepts at most 2 image references");

    const resolved: Array<{ assetId: string; filename: string }> = [];
    for (const slug of slugs) {
      const assetId = slug.replace(/^@/, "");
      if (!assetId.startsWith("img-") && !assetId.startsWith("char-")) {
        throw new Error(`image_slugs entries must be img-* or char-* assets, got: ${assetId}`);
      }
      const manifest = await fs.files.manifest(assetId, projectSlug);
      if (!manifest.ok) throw new Error(`image_slugs: ${manifest.error.message}`);
      const images = getImagesFromManifest(manifest.value.files);
      if (images.length === 0) throw new Error(`image_slugs: No image files found in asset ${assetId}`);
      
      resolved.push({ assetId, filename: images[0].name });
      if (assetId.startsWith("char-") && images.length > 1 && resolved.length < 2) {
        resolved.push({ assetId, filename: images[1].name });
      }
    }
    if (resolved.length > 2) resolved.length = 2;

    for (const input of resolved) {
      imageReferences.push(
        await uploadAssetToGoogleFlow(provider, fs, input.assetId, input.filename, projectSlug),
      );
    }
  } else {
    imageReferences = characterImageGenerationIds(ref, raw);
  }

  const finalDisplayName = opts.displayName ?? detail.display_name ?? "Unnamed";
  
  let finalPersonalityNotes: string | undefined;
  if (opts.clearPersonalityNotes) {
    finalPersonalityNotes = undefined;
  } else if (opts.personalityNotes) {
    finalPersonalityNotes = opts.personalityNotes;
  } else {
    finalPersonalityNotes = typeof raw.personalityNotes === "string" && raw.personalityNotes.trim() !== ""
      ? raw.personalityNotes
      : undefined;
  }

  let finalVoice: string | undefined;
  if (opts.clearVoice) {
    finalVoice = undefined;
  } else if (opts.voice) {
    finalVoice = opts.voice;
  } else {
    const v = readCharacterVoiceRef(raw);
    if (v) finalVoice = v;
  }

  const created = await createGoogleFlowCharacter(provider, {
    displayName: finalDisplayName,
    imageReferences,
    ...(finalPersonalityNotes !== undefined ? { personalityNotes: finalPersonalityNotes } : {}),
    ...(finalVoice !== undefined ? { voice: finalVoice } : {}),
  });

  let warning: string | undefined = created.warning;
  try {
    await deleteGoogleFlowCharacter(provider, ref);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const delWarning = `Replaced copy created, but deleting the old character failed: ${msg}`;
    warning = warning ? `${warning} | ${delWarning}` : delWarning;
  }

  return {
    character_ref: created.character_ref,
    old_ref: ref,
    display_name: created.display_name,
    status: created.status === "partial-success" ? "partial-success" : "replaced",
    ...(warning !== undefined ? { warning } : {}),
  };
}

const replaceGoogleFlowCharacterSchema = {
  ref: z.string().min(1).describe("Character ref to replace"),
  project_slug: z.string().optional().describe("Project slug (required if providing new image_slugs)"),
  display_name: apicityField(
    GoogleFlowCharactersCreateRequestSchema.shape.displayName,
    "New display name (1-200 chars)",
  ).optional(),
  image_slugs: z.array(z.string()).max(2).optional().describe("New image slugs to replace the existing ones"),
  personality_notes: apicityField(
    GoogleFlowCharactersCreateRequestSchema.shape.personalityNotes,
    "New personality notes",
  ).optional(),
  clear_personality_notes: z.boolean().optional().describe("Clear existing personality notes"),
  voice: z.string().optional().describe("New voice preset or custom ref"),
  clear_voice: z.boolean().optional().describe("Clear existing voice"),
} satisfies ZodRawShape;

export function replaceGoogleFlowCharacterDef(fs: Engine): ToolDef {
  return {
    name: "replace_google_flow_character",
    description: "Replace a Google Flow character with updated fields. Returns { character_ref, old_ref, status, warning }. Recreate happens first, then best-effort delete.",
    schema: replaceGoogleFlowCharacterSchema,
    handler: async (args): Promise<ToolResult> => {
      const a = args as SchemaArgs<typeof replaceGoogleFlowCharacterSchema>;
      if (!process.env.GOOGLE_FLOW_API_KEY) {
        return toolError("GOOGLE_FLOW_API_KEY environment variable is not set");
      }
      try {
        const provider = createGoogleFlowProvider();
        return jsonResult(await replaceGoogleFlowCharacter(provider, fs, a.project_slug, a.ref, {
          displayName: a.display_name as string | undefined,
          imageSlugs: a.image_slugs as string[] | undefined,
          personalityNotes: a.personality_notes as string | undefined,
          clearPersonalityNotes: a.clear_personality_notes,
          voice: a.voice,
          clearVoice: a.clear_voice,
        }));
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
