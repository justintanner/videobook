export type PlanFormula = "char_swap" | "storyboard_video";

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
  video_model: "generate_seedance2_video" | "generate_seedance2_fast_video" | "generate_grok_imagine_video";
  duration_s: number;
  aspect_ratio: "16:9";
  resolution: "720p";
  total_duration_s: number;
};
