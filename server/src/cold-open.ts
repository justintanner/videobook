import { createHash } from "node:crypto";
import { join } from "node:path";
import { findPrimaryMediaFile } from "videobook-engine";
import type { Engine, NotebookDocument, NotebookGridSlot } from "videobook-engine";
import { notebookGridTag, notebookOccupiedSlots, NOTEBOOK_GRID_ROW_COUNT, NOTEBOOK_GRID_COLUMN_COUNT } from "videobook-engine/notebook-grid";
import { z } from "zod";
import { INTELLIGENCE_MODEL } from "./openai-intelligence.js";
import { coldOpenRangeError } from "./cold-open-model.js";

const coldOpenSuggestionSchema = z.object({
  sourceArtifactId: z.string().uuid(),
  sourceObjectHash: z.string().min(1),
  durationSeconds: z.number().finite().min(0.5),
  fps: z.number().finite().positive(),
  startSeconds: z.number().finite().nonnegative(),
  endSeconds: z.number().finite().positive(),
  reason: z.string().min(1),
  model: z.string().min(1),
});

export async function coldOpenSource(engine: Engine, artifactId: string, expectedHash?: string) {
  const artifact = engine.artifacts.get(artifactId);
  if (!artifact.ok) throw new Error(artifact.error.message);
  if (!["video", "final"].includes(artifact.value.kind)) throw new Error("Choose a video for the cold open.");
  const manifest = await engine.files.manifest(artifactId, { includeDotfiles: true });
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = findPrimaryMediaFile(manifest.value.files, artifact.value.kind);
  if (!file) throw new Error("The source video is missing.");
  if (expectedHash && file.objectHash !== expectedHash) throw new Error("The source video changed. Open a new cold-open review.");
  const streams = engine.streams.list(artifactId);
  if (!streams.ok) throw new Error(streams.error.message);
  const video = streams.value.find(stream => stream.kind === "video" && stream.sourcePath === file.name && stream.objectHash === file.objectHash);
  if (!video) throw new Error("Wait for the video to finish processing before making a cold open.");
  const durationSeconds = video.durationTicks * video.timeBase.numerator / video.timeBase.denominator;
  const metadata = await engine.metadata.artifacts.read<{ fps?: number }>(artifactId, "original");
  const fps = metadata.ok && metadata.value.fps && metadata.value.fps > 0 ? metadata.value.fps : 30;
  const error = coldOpenRangeError(0, durationSeconds, durationSeconds);
  if (error) throw new Error(error);
  return { artifact: artifact.value, file, manifest: manifest.value, path: join(manifest.value.path, file.name), durationSeconds, fps };
}

export function coldOpenCacheKey(source: Awaited<ReturnType<typeof coldOpenSource>>): string {
  const inputs = source.manifest.files.filter(file => ["elevenlabs.json", ".analysis.gpt4otrans.json"].includes(file.name))
    .map(file => [file.name, file.objectHash]).sort();
  return `cold-open.suggestion.${createHash("sha256").update(JSON.stringify([1, INTELLIGENCE_MODEL, source.artifact.artifactId, source.file.objectHash, inputs])).digest("hex")}`;
}

export function readColdOpenSuggestion(engine: Engine, key: string) {
  const parsed = coldOpenSuggestionSchema.safeParse(engine.settings.get(key));
  if (!parsed.success || coldOpenRangeError(parsed.data.startSeconds, parsed.data.endSeconds, parsed.data.durationSeconds)) return null;
  return parsed.data;
}

export function coldOpenDestination(notebook: NotebookDocument, sourceArtifactId: string): NotebookGridSlot {
  const occupied = new Set(notebookOccupiedSlots(notebook.cells).map(notebookGridTag));
  const source = notebook.cells.find(cell => cell.outputArtifactId === sourceArtifactId);
  const below = source ? { row: source.slot.row + 1, column: source.slot.column } : null;
  if (below && below.row < NOTEBOOK_GRID_ROW_COUNT && !occupied.has(notebookGridTag(below))) return below;
  for (let row = 0; row < NOTEBOOK_GRID_ROW_COUNT; row += 1) {
    for (let column = 0; column < NOTEBOOK_GRID_COLUMN_COUNT; column += 1) {
      const slot = { row, column };
      if (!occupied.has(notebookGridTag(slot))) return slot;
    }
  }
  throw new Error("The notebook needs one empty cell for the cold-open copy.");
}

export function checkColdOpenNotebook(engine: Engine, notebookId: string | undefined, sourceArtifactId: string): void {
  if (!notebookId) return;
  const notebook = engine.notebooks.read(notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  coldOpenDestination(notebook.value, sourceArtifactId);
}
