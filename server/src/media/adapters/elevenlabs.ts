import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import type {
  ElevenLabsComposeMusicRequest,
  ElevenLabsSoundGenerationRequest,
  ElevenLabsTextToSpeechRequest,
} from "@apicity/elevenlabs";
import { requireApiKey } from "../../api-key.js";
import { elevenLabsClient } from "../elevenlabs-client.js";
import type { ProviderAdapter, SubmitContext, SubmitResult } from "./types.js";

const ASSET_SCHEME = "asset://";

function elevenLabsProvider(): ReturnType<typeof elevenLabsClient> {
  return elevenLabsClient({
    apiKey: requireApiKey("ELEVENLABS_API_KEY"),
    timeout: 10 * 60_000,
  });
}

async function readAssetBlob(engine: Engine, ref: string): Promise<Blob> {
  const [assetId, ...rest] = ref.slice(ASSET_SCHEME.length).split("/");
  const dir = await engine.workspaces.resolveArtifact(assetId!);
  if (!dir.ok) throw new Error(dir.error.message);
  const bytes = await readFile(join(dir.value, rest.join("/")));
  return new Blob([bytes], { type: "video/mp4" });
}

async function videoToMusic(request: Record<string, unknown>, context: SubmitContext): Promise<ArrayBuffer> {
  const refs = Array.isArray(request.videos) ? request.videos.map(String) : [];
  const videos = await Promise.all(refs.map((ref) => readAssetBlob(context.engine, ref)));
  return elevenLabsProvider().v1.music.videoToMusic({ ...request, videos } as never, context.ctx.signal);
}

function generate(request: Record<string, unknown>, context: SubmitContext): Promise<ArrayBuffer> {
  const provider = elevenLabsProvider();
  const signal = context.ctx.signal;
  switch (context.model.apiId) {
    case "sound-generation":
      return provider.v1.soundGeneration(request as unknown as ElevenLabsSoundGenerationRequest, signal);
    case "music":
      return provider.v1.music(request as unknown as ElevenLabsComposeMusicRequest, signal);
    case "video-to-music":
      return videoToMusic(request, context);
    case "text-to-speech": {
      const { voice_id: voiceId, ...body } = request;
      return provider.v1.textToSpeech(String(voiceId), body as unknown as ElevenLabsTextToSpeechRequest, signal);
    }
    default:
      throw new Error(`Unsupported ElevenLabs model ${context.model.apiId}`);
  }
}

async function submit(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult> {
  const audio = await generate(request, context);
  return { kind: "done", taskId: `${context.model.apiId}-${Date.now()}`, outputs: [{ bytes: Buffer.from(audio), extension: "mp3" }] };
}

export const elevenLabsAdapter: ProviderAdapter = {
  provider: "elevenlabs",
  envKey: "ELEVENLABS_API_KEY",
  upload: async (_engine, assetId, filename) => `${ASSET_SCHEME}${assetId}/${filename}`,
  uploadUrl: async (url) => {
    throw new Error(`ElevenLabs needs a project asset, not a URL: ${url}`);
  },
  submit,
};
