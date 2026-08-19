import { z, type ZodRawShape } from "zod";
import {
  GoogleFlowVoicePresetSchema,
  GoogleFlowVoicesCreateRequestSchema,
  GoogleFlowVoicesListRequestSchema,
  type GoogleFlowVoicesCreateRequest,
} from "@apicity/googleflow/zod";
import type { GoogleFlowProvider } from "@apicity/googleflow";
import { createGoogleFlowProvider } from "../jobs/_google-flow.js";
import { apicityField } from "./schema-from-apicity.js";
import { toolError } from "./_shared.js";
import type { SchemaArgs, ToolDef, ToolResult } from "./tool-def.js";
import {
  readCreatedRef,
  readEntityList,
  resolveGoogleFlowEmail,
  type GoogleFlowEntity,
} from "./_google-flow-entities.js";

// ---------------------------------------------------------------------------
// Google Flow custom voices (POST/GET/DELETE /google-flow/voices). A voice is a
// saved TTS clip built on one of the 30 system presets; its ref feeds
// referenceAudio_1..5 on generate_google_flow_omni_flash_video (voice_refs). Refs carry
// ':'/'@' that must reach useapi.net raw — the googleFlowFetch hook wired into
// createGoogleFlowProvider handles the GET/DELETE-by-ref paths
// (docs/apicity-gaps.md §16).
// ---------------------------------------------------------------------------

type CreateGoogleFlowVoiceInput = {
  voice: string;
  displayName: string;
  dialog: string;
  voicePerformance: string;
  email?: string;
};

type CreatedGoogleFlowVoice = {
  voice_ref: string;
  display_name: string;
  voice: string;
  email: string;
  status: "created";
};

export async function createGoogleFlowVoice(
  provider: GoogleFlowProvider,
  input: CreateGoogleFlowVoiceInput,
): Promise<CreatedGoogleFlowVoice> {
  const email = await resolveGoogleFlowEmail(provider, input.email);
  const res = await provider.v1.voices({
    email,
    // Runtime-validated against the 30-preset enum by the tool schema and again
    // by the provider's own safeParse; narrow the app-side string here.
    voice: input.voice as GoogleFlowVoicesCreateRequest["voice"],
    displayName: input.displayName,
    dialog: input.dialog,
    voicePerformance: input.voicePerformance,
  });
  const ref = readCreatedRef(res as Record<string, unknown>, "voice");
  if (!ref) {
    throw new Error(`Google Flow voice create returned no voice ref: ${JSON.stringify(res)}`);
  }
  return { voice_ref: ref, display_name: input.displayName, voice: input.voice, email, status: "created" };
}

export async function listGoogleFlowVoices(
  provider: GoogleFlowProvider,
  input: { email?: string; source?: "user" | "system" },
): Promise<{ email: string; count: number; voices: GoogleFlowEntity[] }> {
  const email = await resolveGoogleFlowEmail(provider, input.email);
  const res = await provider.get.v1.voices({
    email,
    ...(input.source ? { source: input.source } : {}),
  });
  const voices = readEntityList(res as Record<string, unknown>, "voices", "voice");
  return { email, count: voices.length, voices };
}

export async function deleteGoogleFlowVoice(
  provider: GoogleFlowProvider,
  ref: string,
): Promise<{ ref: string; status: "deleted" }> {
  await provider.delete.v1.voices({ ref });
  return { ref, status: "deleted" };
}

function jsonResult(payload: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

const createGoogleFlowVoiceSchema = {
  voice: apicityField(
    GoogleFlowVoicePresetSchema,
    "Base voice preset — one of Google Flow's 30 named system voices (case-sensitive, e.g. 'Kore')",
    { required: true },
  ),
  display_name: apicityField(
    GoogleFlowVoicesCreateRequestSchema.shape.displayName,
    "Display name for the saved voice (1-200 chars)",
    { required: true },
  ),
  dialog: apicityField(
    GoogleFlowVoicesCreateRequestSchema.shape.dialog,
    "Sample line spoken to mint the voice reference clip (1-120 chars)",
    { required: true },
  ),
  voice_performance: apicityField(
    GoogleFlowVoicesCreateRequestSchema.shape.voicePerformance,
    "Delivery direction, e.g. 'warm, slow, conspiratorial' (1-120 chars)",
    { required: true },
  ),
  email: z.string().optional().describe("Google Flow account email; omit to use the single configured account"),
} satisfies ZodRawShape;

export function createGoogleFlowVoiceDef(): ToolDef {
  return {
    name: "create_google_flow_voice",
    description:
      "Create a reusable Google Flow custom voice from a system preset. Synthesizes a short TTS clip (takes a few seconds and consumes plan credits) and returns a voice ref for the voice_refs parameter of generate_google_flow_omni_flash_video.",
    schema: createGoogleFlowVoiceSchema,
    handler: async (args): Promise<ToolResult> => {
      const a = args as SchemaArgs<typeof createGoogleFlowVoiceSchema>;
      if (!process.env.GOOGLE_FLOW_API_KEY) {
        return toolError("GOOGLE_FLOW_API_KEY environment variable is not set");
      }
      try {
        const provider = createGoogleFlowProvider();
        const result = await createGoogleFlowVoice(provider, {
          voice: a.voice as string,
          displayName: a.display_name as string,
          dialog: a.dialog as string,
          voicePerformance: a.voice_performance as string,
          ...(a.email ? { email: a.email } : {}),
        });
        return jsonResult({
          ...result,
          usage: "Pass voice_ref in voice_refs of generate_google_flow_omni_flash_video (referenceAudio_1..5)",
        });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

const listGoogleFlowVoicesSchema = {
  source: apicityField(
    GoogleFlowVoicesListRequestSchema.shape.source,
    "Filter: 'user' (custom saved voices) or 'system' (the 30 built-in presets); omit for all",
  ),
  email: z.string().optional().describe("Google Flow account email; omit to use the single configured account"),
} satisfies ZodRawShape;

export function listGoogleFlowVoicesDef(): ToolDef {
  return {
    name: "list_google_flow_voices",
    description: "List Google Flow voices (custom 'user' voices and/or the 'system' presets) for an account.",
    schema: listGoogleFlowVoicesSchema,
    handler: async (args): Promise<ToolResult> => {
      const a = args as SchemaArgs<typeof listGoogleFlowVoicesSchema>;
      if (!process.env.GOOGLE_FLOW_API_KEY) {
        return toolError("GOOGLE_FLOW_API_KEY environment variable is not set");
      }
      try {
        const provider = createGoogleFlowProvider();
        const result = await listGoogleFlowVoices(provider, {
          ...(a.email ? { email: a.email } : {}),
          ...(a.source ? { source: a.source as "user" | "system" } : {}),
        });
        return jsonResult(result);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

const deleteGoogleFlowVoiceSchema = {
  ref: z.string().min(1).describe("Voice ref returned by create_google_flow_voice / list_google_flow_voices"),
} satisfies ZodRawShape;

export function deleteGoogleFlowVoiceDef(): ToolDef {
  return {
    name: "delete_google_flow_voice",
    description: "Delete a Google Flow custom voice by its ref.",
    schema: deleteGoogleFlowVoiceSchema,
    handler: async (args): Promise<ToolResult> => {
      const a = args as SchemaArgs<typeof deleteGoogleFlowVoiceSchema>;
      if (!process.env.GOOGLE_FLOW_API_KEY) {
        return toolError("GOOGLE_FLOW_API_KEY environment variable is not set");
      }
      try {
        const provider = createGoogleFlowProvider();
        return jsonResult(await deleteGoogleFlowVoice(provider, a.ref));
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
