import type { Engine } from "videobook-engine";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";
import { generationLabel } from "../artifact-label.js";
import {
  audioGenerationModels,
  buildAudioGenerationRequest,
  type AudioGenerationModel,
} from "../audio-generation-models.js";
import { resolveVideoRef } from "./_seedance2-shared.js";

type ToolError = { isError: true; content: Array<{ type: "text"; text: string }> };

const ENV_KEYS: Record<AudioGenerationModel["provider"], string> = {
  elevenlabs: "ELEVENLABS_API_KEY",
  kie: "KIE_API_KEY",
  fal: "FAL_API_KEY",
};

function toolError(text: string): ToolError {
  return { isError: true, content: [{ type: "text", text }] };
}

async function validateInputs(
  engine: Engine,
  model: AudioGenerationModel,
  args: Record<string, unknown>,
): Promise<string | null> {
  const built = buildAudioGenerationRequest(model, args);
  if (!built.ok) return built.error;
  if (model.route !== "elevenlabs_video_to_music") return null;
  const videoRef = typeof args.video_ref === "string" ? args.video_ref : "";
  const resolved = await resolveVideoRef(engine, videoRef);
  return resolved.ok ? null : resolved.error;
}

function audioToolDef(engine: Engine, model: AudioGenerationModel): ToolDef {
  const envKey = ENV_KEYS[model.provider];
  return {
    name: model.canonicalName,
    description: model.description,
    schema: model.toolShape,
    handler: async (args) => {
      if (!process.env[envKey]) return toolError(`${envKey} environment variable is not set`);
      const bookId = args.book_id;
      if (typeof bookId !== "string" || bookId.length === 0) return toolError("book_id is required");
      const invalid = await validateInputs(engine, model, args);
      if (invalid) return toolError(invalid);
      const prompt = typeof args.prompt === "string" ? args.prompt : undefined;
      const created = await engine.artifacts.create("aud", generationLabel(model.modelId, prompt));
      if (!created.ok) return toolError(`Failed to create audio asset: ${created.error.message}`);
      const audAssetId = created.value.artifactId;
      const jobId = `${model.provider}-audio-${audAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: model.canonicalName,
        toolName: model.canonicalName,
        bookId,
        audAssetId,
        args,
      });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ aud_asset_id: audAssetId, job_id: jobId, status: "enqueued" }),
        }],
      };
    },
  };
}

export function generateAudioModelDefs(engine: Engine): ToolDef[] {
  return audioGenerationModels().map((model) => audioToolDef(engine, model));
}
