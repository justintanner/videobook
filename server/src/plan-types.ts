export type PlanFormula = "char_swap" | "storyboard_video" | "clip_show";

export type StoryboardVideoSourceAnalysis = {
  prompt: string;
  shot?: string;
  pose?: string;
};

export type StoryboardVideoPlanSidecar = {
  formula: "storyboard_video";
  source_image_asset_id: string;
  source_image_asset_ids: string[];
  source_image_analysis?: StoryboardVideoSourceAnalysis | null;
  storyboard_brief: string;
  loop_video: boolean;
  storyboard_prompt: string;
  video_prompt: string;
  storyboard_asset_id?: string | null;
  video_asset_id?: string | null;
  storyboard_model: "generate_gpt_image";
  video_model: "generate_seedance2_video" | "generate_seedance2_fast_video";
  duration_s: number;
  aspect_ratio: "16:9";
  resolution: "720p";
  total_duration_s: number;
};

export type ClipShowCharacter = {
  asset_id: string;
  name: string;
  description: string;
  elevenlabs_voice_id: string;
};

// One input the host makes a joke about: either a text topic or an img-* image.
export type ClipShowItem =
  | { kind: "topic"; topic: string }
  | { kind: "image"; image_asset_id: string };

// One generated joke (1:1 with an input item, in order). The host reads it aloud
// as an ElevenLabs voiceover — the "read-through". No first frame, no video.
export type ClipShowSegment = {
  kind: "topic" | "image";
  topic?: string;
  image_asset_id?: string;
  source_summary: string;
  joke: string;
  joke_notes?: string;
  // Comedic style used to write the joke (see CLIP_SHOW_JOKE_TYPES). "auto"
  // when the model chose freely. Steers single-segment regeneration.
  joke_type?: string;
  audio_asset_id?: string | null;
};

export type ClipShowPlanSidecar = {
  formula: "clip_show";
  character: ClipShowCharacter;
  show_brief: string;
  tone: string;
  model: "gpt-5.5";
  audio_model: "elevenlabs";
  segments: ClipShowSegment[];
};
