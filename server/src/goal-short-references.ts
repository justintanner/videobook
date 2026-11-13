import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { isNotebookGridAddress } from "videobook-engine/notebook-mentions";
import { formatShortSeconds, type ShortStoryboardVideo } from "./goal-short-plan.js";
import { readableImage, type UsableImage } from "./notebook-frame-cells.js";
import { resolveNotebookArtifactReference } from "./notebook-reference-resolver.js";

export type BriefMention =
  | { kind: "image"; image: UsableImage }
  | { kind: "video"; video: ShortStoryboardVideo }
  | { kind: "skipped"; note: string }
  | { kind: "ignored" };

export type ReferenceNote =
  | { kind: "text"; text: string }
  | { kind: "storyboard"; mention: string; frames: { cellId: string; atSeconds: number }[] };

function skipped(note: string): BriefMention {
  return { kind: "skipped", note };
}

function readNotebook(engine: Engine, notebookId: string): NotebookDocument {
  const notebook = engine.notebooks.read(notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  return notebook.value;
}

function unresolvedNote(mention: string, reference: string, code: string): string {
  if (code === "no_output") return `${mention} has no output yet and was skipped.`;
  if (code === "ambiguous") return `${mention} is ambiguous and was skipped.`;
  if (code === "not_media") return `${mention} is not an image and was skipped.`;
  if (code === "not_found" && isNotebookGridAddress(reference)) return `${mention} is empty and was skipped.`;
  return `${mention} was not found and was skipped.`;
}

function isAudio(kind: string | null, cell: NotebookCell | undefined): boolean {
  return kind === "audio" || cell?.type === "audio" || cell?.type === "extract_audio" || cell?.type === "generate_audio";
}

function isVideo(kind: string | null, cell: NotebookCell | undefined): boolean {
  return kind === "video" || cell?.type === "video" || cell?.type === "split_video" || cell?.type === "generate_video" || cell?.type === "concat" || cell?.type === "splice";
}

export async function briefMention(
  engine: Engine,
  notebookId: string,
  reference: string,
  options: { ignoreArtifactIds?: ReadonlySet<string>; mention?: string },
): Promise<BriefMention> {
  const label = options.mention ?? (reference.startsWith("@") ? reference : `@${reference}`);
  const document = readNotebook(engine, notebookId);
  const resolved = resolveNotebookArtifactReference({ engine, documents: [document], reference, requireMedia: true });
  if ("code" in resolved) return skipped(unresolvedNote(label, resolved.reference, resolved.code));
  if (options.ignoreArtifactIds?.has(resolved.artifactId)) return { kind: "ignored" };
  const artifact = engine.artifacts.get(resolved.artifactId);
  const kind = artifact.ok ? artifact.value.kind : null;
  const cell = resolved.cellId ? document.cells.find((candidate) => candidate.id === resolved.cellId) : undefined;
  if (isAudio(kind, cell)) return skipped(`${label} is audio and was skipped.`);
  if (isVideo(kind, cell)) {
    const address = cell ? notebookGridTag(cell.slot) : null;
    return {
      kind: "video",
      video: { artifactId: resolved.artifactId, cellId: cell?.id ?? null, address, label: (artifact.ok && artifact.value.label) || cell?.label || address || label },
    };
  }
  if (kind !== "image") return skipped(`${label} is not an image and was skipped.`);
  if (!cell) return skipped(`${label} is not an image cell and was skipped.`);
  const image = await readableImage(engine, resolved.artifactId, cell);
  if (!image) return skipped(`${label} has no readable image and was skipped.`);
  return { kind: "image", image };
}

function frameList(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items.join("");
}

export function renderReferenceNotes(document: NotebookDocument, notes: readonly ReferenceNote[]): string[] {
  return notes.map((note) => {
    if (note.kind === "text") return note.text;
    const frames = note.frames.map((frame) => {
      const cell = document.cells.find((candidate) => candidate.id === frame.cellId);
      return `${cell ? notebookGridTag(cell.slot) : "a new cell"} at ${formatShortSeconds(frame.atSeconds)} s`;
    });
    const count = frames.length === 1 ? "1 frame" : `${frames.length} frames`;
    return `${note.mention} is a video, so the short follows its storyboard of ${count}: ${frameList(frames)}. Their on-screen graphics are removed before the frame is made.`;
  });
}
