import type { Engine } from "videobook-engine";
import { deleteGraphicsDraft } from "./drafts.js";

export function forgetGraphicsState(engine: Engine, artifactId: string): void {
  deleteGraphicsDraft(engine, artifactId);
}
