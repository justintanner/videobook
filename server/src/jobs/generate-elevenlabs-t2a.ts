import type { Engine } from "videobook-engine";
import { join } from "node:path";
import { createElevenLabs } from "@apicity/elevenlabs";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { probeVideo } from "../ffmpeg.js";

type GenerateElevenlabsT2aPayload = {
  type: "generate_elevenlabs_t2a";
  audAssetId: string;
  projectSlug: string;
  voiceId: string;
  text: string;
  modelId: string;
  outputFormat: string;
};

export function registerGenerateElevenlabsT2aJob(fs: Engine): void {
  registerJobHandler("generate_elevenlabs_t2a", async (payload, ctx) => {
    const {
      audAssetId,
      projectSlug,
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

    const write = await fs.files.write(audAssetId, "original.mp3", Buffer.from(audio), projectSlug);
    if (!write.ok) throw new Error(`Failed to write original.mp3: ${write.error.message}`);

    let duration: number | undefined;
    try {
      const dir = await fs.workspaces.resolveArtifact(audAssetId, projectSlug);
      if (dir.ok) {
        const probe = await probeVideo(join(dir.value, "original.mp3"));
        if (Number.isFinite(probe.duration) && probe.duration > 0) {
          duration = probe.duration;
        }
      }
    } catch { /* non-fatal — list_assets backfill can recover */ }

    const metadata = {
      origin: "elevenlabs_t2a",
      model: "elevenlabs/text-to-speech",
      model_id: modelId,
      output_format: outputFormat,
      voice_id: voiceId,
      text,
      generated_at: new Date().toISOString(),
      ...(duration !== undefined ? { duration } : {}),
    };
    const metaWrite = await fs.metadata.artifacts.write(audAssetId, "original", metadata, projectSlug);
    if (!metaWrite.ok) throw new Error(`Failed to write artifact metadata: ${metaWrite.error.message}`);

    return { success: true, provider: "elevenlabs" as const };
  });
}
