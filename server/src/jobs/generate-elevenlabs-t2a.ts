import type { VideocityFs } from "vc-engine";
import { createElevenLabs } from "@apicity/elevenlabs";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";

type GenerateElevenlabsT2aPayload = {
  type: "generate_elevenlabs_t2a";
  audAssetId: string;
  projectSlug: string;
  characterAssetId: string;
  voiceId: string;
  text: string;
  modelId: string;
  outputFormat: string;
};

export function registerGenerateElevenlabsT2aJob(fs: VideocityFs): void {
  registerJobHandler("generate_elevenlabs_t2a", async (payload, ctx) => {
    const {
      audAssetId,
      projectSlug,
      characterAssetId,
      voiceId,
      text,
      modelId,
      outputFormat,
    } = payload as GenerateElevenlabsT2aPayload;

    ctx.getOwnerId();

    const apiKey = requireApiKey("ELEVENLABS_API_KEY");
    const provider = createElevenLabs({ apiKey, timeout: 5 * 60_000 });
    const audio = await provider.v1.textToSpeech(voiceId, {
      text,
      model_id: modelId,
      output_format: outputFormat,
    });

    const write = await fs.writeFile(audAssetId, "original.mp3", Buffer.from(audio), projectSlug);
    if (!write.ok) throw new Error(`Failed to write original.mp3: ${write.error.message}`);

    const metadata = {
      origin: "elevenlabs_t2a",
      model: "elevenlabs/text-to-speech",
      model_id: modelId,
      output_format: outputFormat,
      voice_id: voiceId,
      source_character_asset_id: characterAssetId,
      text,
      generated_at: new Date().toISOString(),
    };
    const metaWrite = await fs.writeMetadata(audAssetId, "original", metadata, projectSlug);
    if (!metaWrite.ok) throw new Error(`Failed to write .original.json: ${metaWrite.error.message}`);

    return { success: true, provider: "elevenlabs" as const };
  });
}
