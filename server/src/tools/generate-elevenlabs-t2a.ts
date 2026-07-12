import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { queue } from "../queue.js";

import type { ToolDef } from "./tool-def.js";

const DEFAULT_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}



export function generateElevenlabsT2aDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_elevenlabs_t2a",
    description: "Generate an aud-* text-to-audio asset using an ElevenLabs voice.",
    schema: {
      project_slug: z.string().describe("Project slug"),
      voice_id: z.string().describe("ElevenLabs voice ID"),
      text: z.string().min(1).max(5000).describe("Text to synthesize"),
      asset_name: z.string().optional().describe("Optional output audio asset name"),
      model_id: z.string().optional().describe(`ElevenLabs TTS model ID (default ${DEFAULT_MODEL_ID})`),
      output_format: z.string().optional().describe(`ElevenLabs output format (default ${DEFAULT_OUTPUT_FORMAT})`),
    },
    handler: async (args) => {
      const {
        project_slug,
        voice_id,
        text,
        asset_name,
        model_id,
        output_format,
      } = args as {
        project_slug: string;
        voice_id: string;
        text: string;
        asset_name?: string;
        model_id?: string;
        output_format?: string;
      };

      if (!process.env.ELEVENLABS_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "ELEVENLABS_API_KEY environment variable is not set" }],
        };
      }

      const voiceId = voice_id.trim();

      const name = asset_name?.trim() || `elevenlabs-${slugify(text) || Date.now()}`;
      const assetResult = await fs.createAsset("aud", name, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create audio asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: audAssetId, path: audAssetDir } = assetResult.value;
      const jobId = `elevenlabs-t2a-${audAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_elevenlabs_t2a",
        audAssetId,
        audAssetDir,
        projectSlug: project_slug,
        voiceId,
        text,
        modelId: model_id?.trim() || DEFAULT_MODEL_ID,
        outputFormat: output_format?.trim() || DEFAULT_OUTPUT_FORMAT,
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            aud_asset_id: audAssetId,
            elevenlabs_voice_id: voiceId,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
