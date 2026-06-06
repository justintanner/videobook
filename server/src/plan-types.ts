export type PlanFormula = "char_swap" | "screenshot_dialog";

export type ScreenshotDialogPlanScene = {
  image_asset_id: string;
  dialog: string;
  visual: string;
  duration_s: number;
  video?: string | null;
};

export type ScreenshotDialogPlanSidecar = {
  formula: "screenshot_dialog";
  scenes: ScreenshotDialogPlanScene[];
  screenshot_asset_ids: string[];
  total_duration_s: number;
  model: string;
  analysis_prompt?: string;
  user_context?: string;
};
