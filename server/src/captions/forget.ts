import type { Engine } from "videobook-engine";
import { forgetAnalysisComponents } from "../analysis-components.js";
import { clearCaptionPreparation } from "./analysis.js";
import { deleteCaptionDrafts } from "./drafts.js";
import { forgetCaptionRenders } from "./render.js";

export function forgetCaptionState(engine: Engine, artifactId: string): void {
  deleteCaptionDrafts(engine, artifactId);
  forgetAnalysisComponents(engine, artifactId);
  clearCaptionPreparation(engine, artifactId);
  forgetCaptionRenders(engine, artifactId);
}
