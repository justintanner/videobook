import { z, type ZodRawShape, type ZodType } from "zod";
import {
  ElevenLabsComposeMusicRequestSchema,
  ElevenLabsSoundGenerationRequestSchema,
  ElevenLabsVideoToMusicRequestSchema,
} from "@apicity/elevenlabs/zod";
import {
  ElevenLabsSoundEffectV2RequestSchema,
  ElevenLabsTextToDialogueV3RequestSchema,
  ElevenLabsTextToSpeechMultilingualV2RequestSchema,
  ElevenLabsTextToSpeechTurbo25RequestSchema,
  GoogleGemini25ProTtsRequestSchema,
  GoogleGemini31FlashTtsRequestSchema,
  GoogleGemini38FlashLiteTtsRequestSchema,
  GoogleGemini38FlashTtsRequestSchema,
  SunoGenerateRequestSchema,
  SunoSoundsRequestSchema,
} from "@apicity/kie/zod";
import {
  FalAlibabaQwenAudio3TtsRequestSchema,
  FalElevenlabsMusicV2p5RequestSchema,
  FalElevenlabsTtsElevenV4RequestSchema,
  FalElevenlabsTtsElevenV4TurboRequestSchema,
  FalGoogleGemini3p8FlashLiteTtsRequestSchema,
  FalGoogleGemini3p8FlashTtsRequestSchema,
  FalMinimaxMusic3RequestSchema,
  FalSeedSpeechTtsV2RequestSchema,
} from "@apicity/fal/zod";
import type { GenerationActionSpec } from "./generation-registry.js";
import { apicityField, apicityUnionEnumField } from "./tools/schema-from-apicity.js";

type ZodLike = { _def?: unknown; unwrap?: () => unknown };

export type AudioGenerationRoute =
  | "elevenlabs_sound"
  | "elevenlabs_music"
  | "elevenlabs_video_to_music"
  | "kie_task"
  | "suno_music"
  | "suno_sounds"
  | "fal_queue";

type AudioGenerationOperation =
  | "text_to_sound_effect"
  | "text_to_music"
  | "video_to_music"
  | "text_to_speech"
  | "text_to_dialogue";

export type AudioGenerationModel = {
  canonicalName: string;
  provider: "elevenlabs" | "kie" | "fal";
  route: AudioGenerationRoute;
  modelId: string;
  apicityIdentifier: string;
  schemaOwner: "@apicity/elevenlabs/zod" | "@apicity/kie/zod" | "@apicity/fal/zod";
  operation: AudioGenerationOperation;
  description: string;
  toolShape: ZodRawShape;
  requestSchema: ZodType;
  build: (args: Record<string, unknown>) => Record<string, unknown>;
};

export const SUNO_CALLBACK_URL = "https://localhost/videobook/suno-callback";
const DEFAULT_ELEVENLABS_VOICE = "Rachel";
const SPEAKER_ID = "Speaker 1";

const PROVIDER_PATHS: Record<AudioGenerationRoute, string> = {
  elevenlabs_sound: "elevenlabs.v1.soundGeneration(request)",
  elevenlabs_music: "elevenlabs.v1.music(request)",
  elevenlabs_video_to_music: "elevenlabs.v1.music.videoToMusic(request)",
  kie_task: "kie.post.api.v1.jobs.createTask(request, { otp })",
  suno_music: "kie.suno.post.api.v1.generate(request, { otp })",
  suno_sounds: "kie.suno.post.api.v1.generate.sounds(request)",
  fal_queue: "fal.post.v1.queue.submit()",
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function copyText(target: Record<string, unknown>, key: string, value: unknown): void {
  const parsed = text(value);
  if (parsed !== undefined) target[key] = parsed;
}

function copyNumber(target: Record<string, unknown>, key: string, value: unknown): void {
  const parsed = finiteNumber(value);
  if (parsed !== undefined) target[key] = parsed;
}

function copyFlag(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "boolean") target[key] = value;
}

function promptText(args: Record<string, unknown>): string {
  return text(args.prompt) ?? "";
}

function bookIdField(): z.ZodString {
  return z.string().describe("Book id");
}

function promptField(description: string): z.ZodString {
  return z.string().min(1).describe(description);
}

function optionalField(schema: ZodLike, description: string) {
  return apicityField(schema, description);
}

function defaultedField<T extends string | number | boolean>(
  schema: ZodLike,
  description: string,
  value: T,
) {
  return apicityField(schema, description).default(value as never);
}

function nestedInput(schema: ZodType): Record<string, ZodLike> {
  return (schema as unknown as { shape: { input: { shape: Record<string, ZodLike> } } }).shape.input.shape;
}

function topShape(schema: ZodType): Record<string, ZodLike> {
  return (schema as unknown as { shape: Record<string, ZodLike> }).shape;
}

function arrayItemShape(schema: ZodLike): Record<string, ZodLike> {
  return (schema as unknown as { element: { shape: Record<string, ZodLike> } }).element.shape;
}

const WRAPPER_TYPES = new Set(["optional", "nullable", "default"]);

function wrapperType(schema: ZodLike): string | undefined {
  const def = schema._def as { type?: unknown } | undefined;
  return typeof def?.type === "string" ? def.type : undefined;
}

function unwrapped(schema: ZodLike): ZodLike {
  let current = schema;
  for (let depth = 0; depth < 4 && WRAPPER_TYPES.has(wrapperType(current) ?? "") && current.unwrap; depth += 1) {
    current = current.unwrap() as ZodLike;
  }
  return current;
}

const elevenSound = topShape(ElevenLabsSoundGenerationRequestSchema);
const elevenMusic = topShape(ElevenLabsComposeMusicRequestSchema);
const elevenVideoMusic = topShape(ElevenLabsVideoToMusicRequestSchema);
const kieSoundEffect = nestedInput(ElevenLabsSoundEffectV2RequestSchema);
const kieDialogue = nestedInput(ElevenLabsTextToDialogueV3RequestSchema);
const kieTtsMultilingual = nestedInput(ElevenLabsTextToSpeechMultilingualV2RequestSchema);
const kieTtsTurbo = nestedInput(ElevenLabsTextToSpeechTurbo25RequestSchema);
const kieGemini31 = nestedInput(GoogleGemini31FlashTtsRequestSchema);
const kieGemini25 = nestedInput(GoogleGemini25ProTtsRequestSchema);
const kieGemini38 = nestedInput(GoogleGemini38FlashTtsRequestSchema);
const kieGemini38Lite = nestedInput(GoogleGemini38FlashLiteTtsRequestSchema);
const sunoMusic = topShape(SunoGenerateRequestSchema);
const sunoSounds = topShape(SunoSoundsRequestSchema);
const falMusic25 = topShape(FalElevenlabsMusicV2p5RequestSchema);
const falMinimaxMusic = topShape(FalMinimaxMusic3RequestSchema);
const falElevenV4 = topShape(FalElevenlabsTtsElevenV4RequestSchema);
const falElevenV4Turbo = topShape(FalElevenlabsTtsElevenV4TurboRequestSchema);
const falGemini38 = topShape(FalGoogleGemini3p8FlashTtsRequestSchema);
const falGemini38Lite = topShape(FalGoogleGemini3p8FlashLiteTtsRequestSchema);
const falQwen = topShape(FalAlibabaQwenAudio3TtsRequestSchema);
const falSeedSpeech = topShape(FalSeedSpeechTtsV2RequestSchema);

const MUSIC_MODES = ["track", "loop", "ambience"] as const;

function elevenLabsSoundPayload(args: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = { text: promptText(args) };
  copyNumber(payload, "duration_seconds", args.duration_seconds);
  copyNumber(payload, "prompt_influence", args.prompt_influence);
  copyFlag(payload, "loop", args.loop);
  return payload;
}

function elevenLabsMusicPayload(args: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    prompt: promptText(args),
    generation_mode: text(args.generation_mode) ?? "track",
  };
  copyNumber(payload, "music_length_ms", args.music_length_ms);
  copyFlag(payload, "force_instrumental", args.force_instrumental);
  copyText(payload, "model_id", args.model_id);
  return payload;
}

function elevenLabsVideoToMusicPayload(args: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  copyText(payload, "description", args.prompt);
  copyText(payload, "model_id", args.model_id);
  return payload;
}

function kieSoundEffectPayload(args: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { text: promptText(args) };
  copyFlag(input, "loop", args.loop);
  copyNumber(input, "prompt_influence", args.prompt_influence);
  return { model: "elevenlabs/sound-effect-v2", input };
}

function kieTtsPayload(
  model: "elevenlabs/text-to-speech-multilingual-v2" | "elevenlabs/text-to-speech-turbo-2-5",
  args: Record<string, unknown>,
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    text: promptText(args),
    voice: text(args.voice) ?? DEFAULT_ELEVENLABS_VOICE,
    stability: finiteNumber(args.stability) ?? 0.5,
    similarity_boost: finiteNumber(args.similarity_boost) ?? 0.75,
    style: finiteNumber(args.style) ?? 0,
    speed: finiteNumber(args.speed) ?? 1,
  };
  copyText(input, "language_code", args.language_code);
  return { model, input };
}

function kieDialoguePayload(args: Record<string, unknown>): Record<string, unknown> {
  return {
    model: "elevenlabs/text-to-dialogue-v3",
    input: {
      dialogue: [{ text: promptText(args), voice: text(args.voice) ?? DEFAULT_ELEVENLABS_VOICE }],
      stability: finiteNumber(args.stability) ?? 0.5,
    },
  };
}

function kieGeminiClassicPayload(
  model: "google/gemini-3-1-flash-tts" | "google/gemini-2-5-pro-tts",
  args: Record<string, unknown>,
): Record<string, unknown> {
  const speaker: Record<string, unknown> = {
    speaker_id: SPEAKER_ID,
    voice_name: text(args.voice) ?? "Kore",
    accent: text(args.accent) ?? "Neutral",
  };
  copyText(speaker, "style", args.style);
  copyText(speaker, "pace", args.pace);
  const input: Record<string, unknown> = {
    speakers: [speaker],
    dialogue_turns: [{ speaker_id: SPEAKER_ID, text: promptText(args) }],
  };
  copyText(input, "scene", args.scene);
  copyNumber(input, "temperature", args.temperature);
  return { model, input };
}

function kieGemini38Payload(
  model: "google/gemini-3-8-flash-tts" | "google/gemini-3-8-flash-lite-tts",
  args: Record<string, unknown>,
): Record<string, unknown> {
  const turn: Record<string, unknown> = { speaker_id: SPEAKER_ID, text: promptText(args) };
  copyText(turn, "style", args.style);
  return {
    model,
    input: {
      speakers: [{ speaker_id: SPEAKER_ID, voice_name: text(args.voice) ?? "Fola" }],
      dialogue_turns: [turn],
      temperature: finiteNumber(args.temperature) ?? 1,
      filler_words: typeof args.filler_words === "boolean" ? args.filler_words : false,
    },
  };
}

function sunoMusicPayload(args: Record<string, unknown>): Record<string, unknown> {
  const style = text(args.style);
  const payload: Record<string, unknown> = {
    prompt: promptText(args),
    model: text(args.model) ?? "V5_5",
    instrumental: typeof args.instrumental === "boolean" ? args.instrumental : true,
    customMode: style !== undefined,
    callBackUrl: SUNO_CALLBACK_URL,
  };
  if (style !== undefined) {
    payload.style = style;
    payload.title = text(args.title) ?? promptText(args).slice(0, 80);
  }
  copyText(payload, "negativeTags", args.negative_tags);
  copyText(payload, "vocalGender", args.vocal_gender);
  return payload;
}

function sunoSoundsPayload(args: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    prompt: promptText(args),
    model: text(args.model) ?? "V5_5",
  };
  copyFlag(payload, "soundLoop", args.sound_loop);
  copyNumber(payload, "soundTempo", args.sound_tempo);
  copyText(payload, "soundKey", args.sound_key);
  return payload;
}

function falMusic25Payload(args: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    prompt: promptText(args),
    force_instrumental: typeof args.force_instrumental === "boolean" ? args.force_instrumental : false,
    output_format: "mp3_48000_192",
  };
  copyNumber(payload, "music_length_ms", args.music_length_ms);
  return payload;
}

function falMinimaxMusicPayload(args: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    prompt: promptText(args),
    lyrics: text(args.lyrics) ?? "[Instrumental]",
  };
  copyNumber(payload, "duration", args.duration);
  copyNumber(payload, "seed", args.seed);
  return payload;
}

function falElevenV4Payload(args: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    text: promptText(args),
    voice: text(args.voice) ?? DEFAULT_ELEVENLABS_VOICE,
    stability: finiteNumber(args.stability) ?? 0.5,
    similarity_boost: finiteNumber(args.similarity_boost) ?? 0.75,
    output_format: "mp3_44100_128",
    apply_text_normalization: text(args.apply_text_normalization) ?? "auto",
    timestamps: false,
  };
  copyText(payload, "language_code", args.language_code);
  return payload;
}

function falGemini38Payload(args: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    prompt: promptText(args),
    voice: text(args.voice) ?? "Kore",
  };
  copyText(payload, "style_instructions", args.style_instructions);
  return payload;
}

function falQwenPayload(args: Record<string, unknown>): Record<string, unknown> {
  return {
    text: promptText(args),
    voice: text(args.voice) ?? "Cherry",
    language: text(args.language) ?? "Auto",
  };
}

function falSeedSpeechPayload(args: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = { text: promptText(args), output_format: "mp3" };
  copyText(payload, "voice", args.voice);
  copyNumber(payload, "speed", args.speed);
  copyNumber(payload, "pitch", args.pitch);
  copyText(payload, "language", args.language);
  copyText(payload, "voice_instruction", args.voice_instruction);
  return payload;
}

function kieTtsShape(shape: Record<string, ZodLike>): ZodRawShape {
  return {
    book_id: bookIdField(),
    prompt: promptField("Words to speak"),
    voice: defaultedField(shape.voice, "ElevenLabs voice name", DEFAULT_ELEVENLABS_VOICE),
    stability: defaultedField(shape.stability, "Voice stability (0-1)", 0.5),
    similarity_boost: defaultedField(shape.similarity_boost, "Similarity to the voice (0-1)", 0.75),
    style: defaultedField(shape.style, "Style exaggeration (0-1)", 0),
    speed: defaultedField(shape.speed, "Speaking speed (0.7-1.2)", 1),
    language_code: optionalField(shape.language_code, "ISO 639-1 language code"),
  };
}

function kieGeminiClassicShape(shape: Record<string, ZodLike>): ZodRawShape {
  const speaker = arrayItemShape(unwrapped(shape.speakers));
  return {
    book_id: bookIdField(),
    prompt: promptField("Words to speak"),
    voice: defaultedField(speaker.voice_name, "Gemini voice", "Kore"),
    accent: defaultedField(speaker.accent, "Speaker accent", "Neutral"),
    style: optionalField(speaker.style, "Delivery style"),
    pace: optionalField(speaker.pace, "Delivery pace"),
    scene: optionalField(shape.scene, "Scene description that frames the delivery"),
    temperature: optionalField(shape.temperature, "Sampling temperature (0-2)"),
  };
}

function kieGemini38Shape(shape: Record<string, ZodLike>): ZodRawShape {
  const speaker = arrayItemShape(unwrapped(shape.speakers));
  const turn = arrayItemShape(unwrapped(shape.dialogue_turns));
  return {
    book_id: bookIdField(),
    prompt: promptField("Words to speak"),
    voice: defaultedField(speaker.voice_name, "Gemini voice", "Fola"),
    style: optionalField(turn.style, "Delivery style instructions"),
    temperature: defaultedField(shape.temperature, "Sampling temperature (0-2)", 1),
    filler_words: defaultedField(shape.filler_words, "Add natural filler words", false),
  };
}

function falElevenV4Shape(shape: Record<string, ZodLike>): ZodRawShape {
  return {
    book_id: bookIdField(),
    prompt: promptField("Words to speak; supports audio tags such as [whispering]"),
    voice: defaultedField(shape.voice, "ElevenLabs voice name", DEFAULT_ELEVENLABS_VOICE),
    stability: defaultedField(shape.stability, "Voice stability (0-1)", 0.5),
    similarity_boost: defaultedField(shape.similarity_boost, "Similarity to the voice (0-1)", 0.75),
    language_code: optionalField(shape.language_code, "ISO 639-1 language code"),
    apply_text_normalization: defaultedField(shape.apply_text_normalization, "Normalize numbers and dates", "auto"),
  };
}

function falGemini38Shape(shape: Record<string, ZodLike>): ZodRawShape {
  return {
    book_id: bookIdField(),
    prompt: promptField("Verbatim words to speak; inline <laugh> or <sigh> are allowed"),
    voice: defaultedField(shape.voice, "Gemini voice", "Kore"),
    style_instructions: optionalField(shape.style_instructions, "Delivery style, separate from the words"),
  };
}

const MODELS: AudioGenerationModel[] = [
  {
    canonicalName: "generate_elevenlabs_sound_effect",
    provider: "elevenlabs",
    route: "elevenlabs_sound",
    modelId: "elevenlabs/sound-generation",
    apicityIdentifier: "ElevenLabsSoundGenerationRequestSchema",
    schemaOwner: "@apicity/elevenlabs/zod",
    operation: "text_to_sound_effect",
    description: "Generate a sound effect or background ambience clip (0.5-30 seconds, optionally looping) from a text description with ElevenLabs",
    toolShape: {
      book_id: bookIdField(),
      prompt: apicityField(elevenSound.text, "Sound to generate", { required: true }),
      duration_seconds: optionalField(elevenSound.duration_seconds, "Length in seconds (0.5-30); automatic when omitted"),
      prompt_influence: optionalField(elevenSound.prompt_influence, "How literally to follow the prompt (0-1)"),
      loop: defaultedField(elevenSound.loop, "Make the clip loop seamlessly", false),
    },
    requestSchema: ElevenLabsSoundGenerationRequestSchema,
    build: elevenLabsSoundPayload,
  },
  {
    canonicalName: "generate_elevenlabs_music",
    provider: "elevenlabs",
    route: "elevenlabs_music",
    modelId: "elevenlabs/music",
    apicityIdentifier: "ElevenLabsComposeMusicRequestSchema",
    schemaOwner: "@apicity/elevenlabs/zod",
    operation: "text_to_music",
    description: "Compose a music track, seamless loop, or background ambience bed from a text description with ElevenLabs Music",
    toolShape: {
      book_id: bookIdField(),
      prompt: apicityField(elevenMusic.prompt, "Music to compose", { required: true }),
      generation_mode: z.enum(MUSIC_MODES).default("track").describe("Track, seamless loop, or ambience bed"),
      music_length_ms: optionalField(elevenMusic.music_length_ms, "Length in milliseconds (3000-600000); automatic when omitted"),
      force_instrumental: defaultedField(elevenMusic.force_instrumental, "Guarantee no vocals", true),
      model_id: apicityUnionEnumField(elevenMusic.model_id, "ElevenLabs music model"),
    },
    requestSchema: ElevenLabsComposeMusicRequestSchema,
    build: elevenLabsMusicPayload,
  },
  {
    canonicalName: "generate_elevenlabs_video_to_music",
    provider: "elevenlabs",
    route: "elevenlabs_video_to_music",
    modelId: "elevenlabs/video-to-music",
    apicityIdentifier: "ElevenLabsVideoToMusicRequestSchema",
    schemaOwner: "@apicity/elevenlabs/zod",
    operation: "video_to_music",
    description: "Score a connected video with a music track timed to its picture using ElevenLabs Music",
    toolShape: {
      book_id: bookIdField(),
      video_ref: z.string().min(1).describe("Video to score"),
      prompt: z.string().max(1000).optional().describe("Optional musical direction"),
      model_id: apicityUnionEnumField(elevenVideoMusic.model_id, "ElevenLabs music model"),
    },
    requestSchema: ElevenLabsVideoToMusicRequestSchema.omit({ videos: true }),
    build: elevenLabsVideoToMusicPayload,
  },
  {
    canonicalName: "generate_kie_elevenlabs_sound_effect_v2",
    provider: "kie",
    route: "kie_task",
    modelId: "elevenlabs/sound-effect-v2",
    apicityIdentifier: "ElevenLabsSoundEffectV2RequestSchema",
    schemaOwner: "@apicity/kie/zod",
    operation: "text_to_sound_effect",
    description: "Generate a sound effect or ambience clip from a text description with ElevenLabs Sound Effects v2 on Kie",
    toolShape: {
      book_id: bookIdField(),
      prompt: promptField("Sound to generate"),
      loop: defaultedField(kieSoundEffect.loop, "Make the clip loop seamlessly", false),
      prompt_influence: optionalField(kieSoundEffect.prompt_influence, "How literally to follow the prompt (0-1)"),
    },
    requestSchema: ElevenLabsSoundEffectV2RequestSchema,
    build: kieSoundEffectPayload,
  },
  {
    canonicalName: "generate_kie_elevenlabs_text_to_speech_multilingual_v2",
    provider: "kie",
    route: "kie_task",
    modelId: "elevenlabs/text-to-speech-multilingual-v2",
    apicityIdentifier: "ElevenLabsTextToSpeechMultilingualV2RequestSchema",
    schemaOwner: "@apicity/kie/zod",
    operation: "text_to_speech",
    description: "Speak text with ElevenLabs Multilingual v2 on Kie",
    toolShape: kieTtsShape(kieTtsMultilingual),
    requestSchema: ElevenLabsTextToSpeechMultilingualV2RequestSchema,
    build: (args) => kieTtsPayload("elevenlabs/text-to-speech-multilingual-v2", args),
  },
  {
    canonicalName: "generate_kie_elevenlabs_text_to_speech_turbo_2_5",
    provider: "kie",
    route: "kie_task",
    modelId: "elevenlabs/text-to-speech-turbo-2-5",
    apicityIdentifier: "ElevenLabsTextToSpeechTurbo25RequestSchema",
    schemaOwner: "@apicity/kie/zod",
    operation: "text_to_speech",
    description: "Speak text quickly and cheaply with ElevenLabs Turbo 2.5 on Kie",
    toolShape: kieTtsShape(kieTtsTurbo),
    requestSchema: ElevenLabsTextToSpeechTurbo25RequestSchema,
    build: (args) => kieTtsPayload("elevenlabs/text-to-speech-turbo-2-5", args),
  },
  {
    canonicalName: "generate_kie_elevenlabs_text_to_dialogue_v3",
    provider: "kie",
    route: "kie_task",
    modelId: "elevenlabs/text-to-dialogue-v3",
    apicityIdentifier: "ElevenLabsTextToDialogueV3RequestSchema",
    schemaOwner: "@apicity/kie/zod",
    operation: "text_to_dialogue",
    description: "Perform expressive lines with ElevenLabs v3 on Kie; supports audio tags such as [laughs] and [whispers]",
    toolShape: {
      book_id: bookIdField(),
      prompt: promptField("Lines to perform, with optional audio tags"),
      voice: z.string().min(1).default(DEFAULT_ELEVENLABS_VOICE).describe("ElevenLabs voice name"),
      stability: apicityField(kieDialogue.stability, "Stability: 0 creative, 0.5 natural, 1 robust").default(0.5 as never),
    },
    requestSchema: ElevenLabsTextToDialogueV3RequestSchema,
    build: kieDialoguePayload,
  },
  {
    canonicalName: "generate_kie_gemini_2_5_pro_tts",
    provider: "kie",
    route: "kie_task",
    modelId: "google/gemini-2-5-pro-tts",
    apicityIdentifier: "GoogleGemini25ProTtsRequestSchema",
    schemaOwner: "@apicity/kie/zod",
    operation: "text_to_speech",
    description: "Speak text with Gemini 2.5 Pro TTS on Kie, with accent, style and pace controls",
    toolShape: kieGeminiClassicShape(kieGemini25),
    requestSchema: GoogleGemini25ProTtsRequestSchema,
    build: (args) => kieGeminiClassicPayload("google/gemini-2-5-pro-tts", args),
  },
  {
    canonicalName: "generate_kie_gemini_3_1_flash_tts",
    provider: "kie",
    route: "kie_task",
    modelId: "google/gemini-3-1-flash-tts",
    apicityIdentifier: "GoogleGemini31FlashTtsRequestSchema",
    schemaOwner: "@apicity/kie/zod",
    operation: "text_to_speech",
    description: "Speak text with Gemini 3.1 Flash TTS on Kie, with accent, style and pace controls",
    toolShape: kieGeminiClassicShape(kieGemini31),
    requestSchema: GoogleGemini31FlashTtsRequestSchema,
    build: (args) => kieGeminiClassicPayload("google/gemini-3-1-flash-tts", args),
  },
  {
    canonicalName: "generate_kie_gemini_3_8_flash_tts",
    provider: "kie",
    route: "kie_task",
    modelId: "google/gemini-3-8-flash-tts",
    apicityIdentifier: "GoogleGemini38FlashTtsRequestSchema",
    schemaOwner: "@apicity/kie/zod",
    operation: "text_to_speech",
    description: "Speak text with Gemini 3.8 Flash TTS on Kie",
    toolShape: kieGemini38Shape(kieGemini38),
    requestSchema: GoogleGemini38FlashTtsRequestSchema,
    build: (args) => kieGemini38Payload("google/gemini-3-8-flash-tts", args),
  },
  {
    canonicalName: "generate_kie_gemini_3_8_flash_lite_tts",
    provider: "kie",
    route: "kie_task",
    modelId: "google/gemini-3-8-flash-lite-tts",
    apicityIdentifier: "GoogleGemini38FlashLiteTtsRequestSchema",
    schemaOwner: "@apicity/kie/zod",
    operation: "text_to_speech",
    description: "Speak text with the low-cost Gemini 3.8 Flash Lite TTS on Kie",
    toolShape: kieGemini38Shape(kieGemini38Lite),
    requestSchema: GoogleGemini38FlashLiteTtsRequestSchema,
    build: (args) => kieGemini38Payload("google/gemini-3-8-flash-lite-tts", args),
  },
  {
    canonicalName: "generate_kie_suno_music",
    provider: "kie",
    route: "suno_music",
    modelId: "suno/generate",
    apicityIdentifier: "SunoGenerateRequestSchema",
    schemaOwner: "@apicity/kie/zod",
    operation: "text_to_music",
    description: "Generate a song or instrumental background track with Suno on Kie; set a style to use custom mode",
    toolShape: {
      book_id: bookIdField(),
      prompt: apicityField(sunoMusic.prompt, "Song description, or lyrics in custom mode", { required: true }),
      model: apicityUnionEnumField(sunoMusic.model, "Suno model").default("V5_5" as never),
      instrumental: defaultedField(sunoMusic.instrumental, "Instrumental only", true),
      style: optionalField(sunoMusic.style, "Music style; enables custom mode"),
      title: optionalField(sunoMusic.title, "Track title in custom mode"),
      negative_tags: optionalField(sunoMusic.negativeTags, "Styles to avoid"),
      vocal_gender: optionalField(sunoMusic.vocalGender, "Vocal gender"),
    },
    requestSchema: SunoGenerateRequestSchema,
    build: sunoMusicPayload,
  },
  {
    canonicalName: "generate_kie_suno_sounds",
    provider: "kie",
    route: "suno_sounds",
    modelId: "suno/sounds-generate",
    apicityIdentifier: "SunoSoundsRequestSchema",
    schemaOwner: "@apicity/kie/zod",
    operation: "text_to_sound_effect",
    description: "Generate a sound effect, ambience or loop with Suno Sounds on Kie, with optional tempo and key",
    toolShape: {
      book_id: bookIdField(),
      prompt: apicityField(sunoSounds.prompt, "Sound to generate", { required: true }),
      model: apicityUnionEnumField(sunoSounds.model, "Suno model").default("V5_5" as never),
      sound_loop: defaultedField(sunoSounds.soundLoop, "Make the sound loop", false),
      sound_tempo: optionalField(sunoSounds.soundTempo, "Tempo in BPM (1-300)"),
      sound_key: optionalField(sunoSounds.soundKey, "Musical key"),
    },
    requestSchema: SunoSoundsRequestSchema,
    build: sunoSoundsPayload,
  },
  {
    canonicalName: "generate_fal_elevenlabs_music_2_5",
    provider: "fal",
    route: "fal_queue",
    modelId: "elevenlabs/music/v2.5",
    apicityIdentifier: "elevenlabs/music/v2.5",
    schemaOwner: "@apicity/fal/zod",
    operation: "text_to_music",
    description: "Compose music or an instrumental background bed with ElevenLabs Music 2.5 on fal",
    toolShape: {
      book_id: bookIdField(),
      prompt: promptField("Music to compose"),
      music_length_ms: optionalField(falMusic25.music_length_ms, "Length in milliseconds (3000-600000); automatic when omitted"),
      force_instrumental: defaultedField(falMusic25.force_instrumental, "Guarantee no vocals", true),
    },
    requestSchema: FalElevenlabsMusicV2p5RequestSchema,
    build: falMusic25Payload,
  },
  {
    canonicalName: "generate_fal_minimax_music_3",
    provider: "fal",
    route: "fal_queue",
    modelId: "minimax/music-3",
    apicityIdentifier: "minimax/music-3",
    schemaOwner: "@apicity/fal/zod",
    operation: "text_to_music",
    description: "Generate music up to 5 minutes with MiniMax Music 3 on fal; omit lyrics for an instrumental",
    toolShape: {
      book_id: bookIdField(),
      prompt: promptField("Music style and mood"),
      lyrics: optionalField(falMinimaxMusic.lyrics, "Lyrics; defaults to [Instrumental]"),
      duration: optionalField(falMinimaxMusic.duration, "Length in seconds (1-300)"),
      seed: optionalField(falMinimaxMusic.seed, "Random seed"),
    },
    requestSchema: FalMinimaxMusic3RequestSchema,
    build: falMinimaxMusicPayload,
  },
  {
    canonicalName: "generate_fal_elevenlabs_tts_eleven_v4",
    provider: "fal",
    route: "fal_queue",
    modelId: "elevenlabs/tts/eleven-v4",
    apicityIdentifier: "elevenlabs/tts/eleven-v4",
    schemaOwner: "@apicity/fal/zod",
    operation: "text_to_speech",
    description: "Speak text with ElevenLabs Eleven v4 on fal; supports audio tags such as [whispering]",
    toolShape: falElevenV4Shape(falElevenV4),
    requestSchema: FalElevenlabsTtsElevenV4RequestSchema,
    build: falElevenV4Payload,
  },
  {
    canonicalName: "generate_fal_elevenlabs_tts_eleven_v4_turbo",
    provider: "fal",
    route: "fal_queue",
    modelId: "elevenlabs/tts/eleven-v4-turbo",
    apicityIdentifier: "elevenlabs/tts/eleven-v4-turbo",
    schemaOwner: "@apicity/fal/zod",
    operation: "text_to_speech",
    description: "Speak text quickly with ElevenLabs Eleven v4 Turbo on fal",
    toolShape: falElevenV4Shape(falElevenV4Turbo),
    requestSchema: FalElevenlabsTtsElevenV4TurboRequestSchema,
    build: falElevenV4Payload,
  },
  {
    canonicalName: "generate_fal_gemini_3_8_flash_tts",
    provider: "fal",
    route: "fal_queue",
    modelId: "google/gemini-3.8-flash-tts",
    apicityIdentifier: "google/gemini-3.8-flash-tts",
    schemaOwner: "@apicity/fal/zod",
    operation: "text_to_speech",
    description: "Speak text with Gemini 3.8 Flash TTS on fal, with separate style instructions",
    toolShape: falGemini38Shape(falGemini38),
    requestSchema: FalGoogleGemini3p8FlashTtsRequestSchema,
    build: falGemini38Payload,
  },
  {
    canonicalName: "generate_fal_gemini_3_8_flash_lite_tts",
    provider: "fal",
    route: "fal_queue",
    modelId: "google/gemini-3.8-flash-lite-tts",
    apicityIdentifier: "google/gemini-3.8-flash-lite-tts",
    schemaOwner: "@apicity/fal/zod",
    operation: "text_to_speech",
    description: "Speak text with the low-cost Gemini 3.8 Flash Lite TTS on fal",
    toolShape: falGemini38Shape(falGemini38Lite),
    requestSchema: FalGoogleGemini3p8FlashLiteTtsRequestSchema,
    build: falGemini38Payload,
  },
  {
    canonicalName: "generate_fal_qwen_audio_3_tts",
    provider: "fal",
    route: "fal_queue",
    modelId: "alibaba/qwen-audio-3-tts",
    apicityIdentifier: "alibaba/qwen-audio-3-tts",
    schemaOwner: "@apicity/fal/zod",
    operation: "text_to_speech",
    description: "Speak text with Qwen Audio 3 TTS on fal in ten languages",
    toolShape: {
      book_id: bookIdField(),
      prompt: apicityField(falQwen.text, "Words to speak", { required: true }),
      voice: defaultedField(falQwen.voice, "Qwen voice", "Cherry"),
      language: defaultedField(falQwen.language, "Language of the text", "Auto"),
    },
    requestSchema: FalAlibabaQwenAudio3TtsRequestSchema,
    build: falQwenPayload,
  },
  {
    canonicalName: "generate_fal_seed_speech_tts_v2",
    provider: "fal",
    route: "fal_queue",
    modelId: "fal-ai/bytedance/seed-speech/tts/v2",
    apicityIdentifier: "fal-ai/bytedance/seed-speech/tts/v2",
    schemaOwner: "@apicity/fal/zod",
    operation: "text_to_speech",
    description: "Speak text with ByteDance Seed Speech TTS v2 on fal, with speed, pitch and voice instructions",
    toolShape: {
      book_id: bookIdField(),
      prompt: apicityField(falSeedSpeech.text, "Words to speak", { required: true }),
      voice: optionalField(falSeedSpeech.voice, "Seed Speech voice"),
      speed: optionalField(falSeedSpeech.speed, "Speaking speed (0.5-2)"),
      pitch: optionalField(falSeedSpeech.pitch, "Pitch shift in semitones (-12 to 12)"),
      language: optionalField(falSeedSpeech.language, "Language of the text"),
      voice_instruction: optionalField(falSeedSpeech.voice_instruction, "Delivery instructions"),
    },
    requestSchema: FalSeedSpeechTtsV2RequestSchema,
    build: falSeedSpeechPayload,
  },
];

const MODELS_BY_NAME = new Map(MODELS.map((model) => [model.canonicalName, model]));

export function audioGenerationModels(): readonly AudioGenerationModel[] {
  return MODELS;
}

export function audioGenerationModel(toolName: string): AudioGenerationModel | undefined {
  return MODELS_BY_NAME.get(toolName);
}

export function buildAudioGenerationRequest(
  model: AudioGenerationModel,
  args: Record<string, unknown>,
): { ok: true; request: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = model.requestSchema.safeParse(model.build(args));
  if (parsed.success) return { ok: true, request: parsed.data as Record<string, unknown> };
  const message = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
    .join("; ");
  return { ok: false, error: `Invalid ${model.canonicalName} request: ${message}` };
}

export function buildAudioGenerationTranslateResult(
  toolName: string,
  args: Record<string, unknown>,
): { provider_path: string; payload: Record<string, unknown> } | null {
  const model = MODELS_BY_NAME.get(toolName);
  if (!model) return null;
  return { provider_path: PROVIDER_PATHS[model.route], payload: model.build(args) };
}

export const AUDIO_GENERATION_ACTIONS: GenerationActionSpec[] = MODELS.map((model) => ({
  canonical_name: model.canonicalName,
  provider: model.provider,
  apicity_identifier: model.apicityIdentifier,
  media_type: "audio",
  operation: model.operation,
  picker_visibility: "visible",
  legacy_names: [],
  schema_owner: model.schemaOwner,
  job_task_discriminator: model.canonicalName,
  persisted_history_consumers: ["notebook", "prompt_history", "project_activity"],
}));
