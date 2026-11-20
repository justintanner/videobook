import type { Engine } from "videobook-engine";
import { deleteAutoEditDraft, forgetAutoEditRenders } from "./drafts.js";

export function forgetAutoEditState(engine: Engine, artifactId: string): void {
  deleteAutoEditDraft(engine, artifactId);
  forgetAutoEditRenders(engine, artifactId);
}
