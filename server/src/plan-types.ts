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

// One on-screen graphic in a joke's visual run. A joke fires an ordered RUN of
// these across its voiceover — rapid-fire cuts with setup and payoff spanning
// several cards (the "sinkhole of misery" pattern: map → cityscape → still →
// portrait → headline → fake poster → title card).
//
// The backing image is EITHER a reused input-pool image ("upload") or a newly
// generated graphic ("generated"). For generated OSGs the plan job creates an
// img-* asset and enqueues a text-to-image job at write time; `image_asset_id`
// points at that (still-generating) asset. Live status (generating/ready/
// failed) is derived from the asset store, never stored here.
export type ClipShowOsg = {
  source: "upload" | "generated";
  // img-* asset backing this card. Set at enqueue time for both sources; null
  // only if the asset could not be created.
  image_asset_id: string | null;
  // Text-to-image prompt for generated cards; null for reused uploads.
  image_prompt: string | null;
  // Visual treatment (see CLIP_SHOW_TREATMENTS): photo | cityscape | map |
  // headline | fake_poster | title_card | caption | portrait.
  treatment: string;
  // The word/phrase in the joke this card lands on.
  beat_text: string;
  // On-screen overlay text, or null.
  caption: string | null;
  // How long the card holds. Rapid-fire cards are short; a payoff holds longer.
  duration_ms: number;
};

// One generated joke the host reads aloud as an ElevenLabs voiceover (the
// "read-through"), illustrated by an ordered run of OSGs. A joke may group
// several input-pool images and/or invent new generated graphics.
export type ClipShowSegment = {
  // Input-pool images grouped into this joke (may be empty for an all-generated
  // run). Used as the source context when regenerating the joke.
  source_image_asset_ids: string[];
  source_summary: string;
  joke: string;
  joke_notes?: string;
  // Comedic style used to write the joke (see CLIP_SHOW_JOKE_TYPES). "auto"
  // when the model chose freely. Steers single-joke regeneration.
  joke_type?: string;
  // Ordered on-screen graphics that fire across the joke (1..N).
  osgs: ClipShowOsg[];
  audio_asset_id?: string | null;
};

export type ClipShowPlanSidecar = {
  formula: "clip_show";
  character: ClipShowCharacter;
  show_brief: string;
  tone: string;
  model: "gpt-5.5";
  image_model: "generate_nano_banana_pro_fal";
  audio_model: "elevenlabs";
  segments: ClipShowSegment[];
};
