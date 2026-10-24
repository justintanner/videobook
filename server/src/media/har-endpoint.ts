import { isKieVeoModel } from "./wire.js";
import type { ParsedModelId } from "./types.js";

export function generationHarEndpoint(model: ParsedModelId): string {
  switch (model.provider) {
    case "kie":
      if (isKieVeoModel(model.apiId)) return "api.v1.veo.generate";
      if (model.apiId === "suno/generate") return "api.v1.generate";
      if (model.apiId === "suno/sounds-generate") return "api.v1.generate.sounds";
      return "api.v1.jobs.createTask";
    case "fal": return "v1.queue.submit";
    case "xai": return "v1.videos.generations";
    case "alibaba": return "api.v1.services.aigc.multimodalGeneration.generation";
    case "machgen": return "api.v0.generate";
    case "elevenlabs":
      switch (model.apiId) {
        case "sound-generation": return "v1.soundGeneration";
        case "music": return "v1.music";
        case "video-to-music": return "v1.music.videoToMusic";
        case "text-to-speech": return "v1.textToSpeech";
        default: throw new Error(`Unsupported ElevenLabs model ${model.apiId}`);
      }
  }
}
