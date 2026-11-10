import type { Engine } from "videobook-engine";
import { deleteGraphicsDraft } from "./drafts.js";
import { forgetGraphicsRenders } from "./render.js";

export function forgetGraphicsState(engine: Engine, artifactId: string): void {
  deleteGraphicsDraft(engine, artifactId);
  forgetGraphicsRenders(engine, artifactId);
}
