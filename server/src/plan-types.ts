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

export type ClipShowPlacement = "before" | "after" | "both";

export type ClipShowCharacter = {
  asset_id: string;
  name: string;
  description: string;
  elevenlabs_voice_id: string;
};

export type ClipShowSegment = {
  clip_asset_id: string;
  clip_summary: string;
  placement: ClipShowPlacement;
  intro_dialog: string;
  outro_dialog: string;
  dialog: string;
  joke_notes: string;
  quality_notes: string;
  first_frame_prompt: string;
  video_prompt: string;
  audio_asset_id?: string | null;
  first_frame_asset_id?: string | null;
  video_asset_id?: string | null;
};

export type ClipShowPlanSidecar = {
  formula: "clip_show";
  character: ClipShowCharacter;
  clip_asset_ids: string[];
  show_brief: string;
  tone: string;
  model: "gpt-5.5";
  audio_model: "elevenlabs";
  first_frame_model: "generate_gpt_image";
  video_model: "generate_seedance2_video";
  video_resolution: "720p";
  video_aspect_ratio: "16:9";
  video_duration_s: number;
  total_duration_s: number;
  segments: ClipShowSegment[];
};
