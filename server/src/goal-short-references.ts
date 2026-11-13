import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { findPrimaryMediaFile } from "videobook-engine";
import { firstEmptyNotebookGridSlot, notebookGridTag, notebookOccupiedSlots, NOTEBOOK_GRID_CAPACITY } from "videobook-engine/notebook-grid";
import { isNotebookGridAddress } from "videobook-engine/notebook-mentions";
import { probeVideo } from "./ffmpeg.js";
import { arrangeGoalNotebook } from "./notebook-goal-layout.js";
import { captureFrame, materializeArtifactFile } from "./notebook-media-ops.js";
import { mutateNotebook } from "./notebook-mutations.js";
import { resolveNotebookArtifactReference } from "./notebook-reference-resolver.js";

export type UsableImage = {
  kind: "image";
  artifactId: string;
  cellId: string;
  address: string;
  label: string;
  objectHash: string;
};

export type UsableImageReference = {
  image: UsableImage | null;
  note: string | null;
  countable: boolean;
  frame: { cellId: string; atSeconds: number } | null;
  sourceArtifactId: string | null;
  ignored: boolean;
};

export type ReferenceNote =
  | { kind: "text"; text: string }
  | { kind: "frame"; mention: string; cellId: string; atSeconds: number };

type FrameMetadata = {
  origin?: string;
  sourceArtifactId?: string;
  atSeconds?: number;
};

function skipped(note: string, sourceArtifactId: string | null = null): UsableImageReference {
  return { image: null, note, countable: false, frame: null, sourceArtifactId, ignored: false };
}

function available(sourceArtifactId: string): UsableImageReference {
  return { image: null, note: null, countable: true, frame: null, sourceArtifactId, ignored: false };
}

function ignoredReference(sourceArtifactId: string): UsableImageReference {
  return { image: null, note: null, countable: false, frame: null, sourceArtifactId, ignored: true };
}

function adopted(image: UsableImage, frame: { cellId: string; atSeconds: number } | null, sourceArtifactId: string): UsableImageReference {
  return { image, note: null, countable: true, frame, sourceArtifactId, ignored: false };
}

function formatSeconds(seconds: number): string {
  return (Math.round(seconds * 10) / 10).toFixed(1);
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

async function readableImage(engine: Engine, artifactId: string, cell: NotebookCell): Promise<UsableImage | null> {
  const manifest = await engine.files.manifest(artifactId);
  const file = manifest.ok ? findPrimaryMediaFile(manifest.value.files, "image") : null;
  if (!file) return null;
  const address = notebookGridTag(cell.slot);
  const artifact = engine.artifacts.get(artifactId);
  return {
    kind: "image",
    artifactId,
    cellId: cell.id,
    address,
    label: (artifact.ok && artifact.value.label) || cell.label || address,
    objectHash: file.objectHash,
  };
}

async function videoDuration(engine: Engine, artifactId: string): Promise<number | null> {
  let source: Awaited<ReturnType<typeof materializeArtifactFile>> | null = null;
  try {
    source = await materializeArtifactFile(engine, artifactId, ["original.mp4", "original.mov"]);
    const probe = await probeVideo(source.path);
    const duration = probe.videoDuration || probe.duration;
    return duration > 0 ? duration : null;
  } catch {
    return null;
  } finally {
    await source?.cleanup();
  }
}

function sameFrame(inputs: Record<string, unknown> | undefined, sourceArtifactId: string, sourceCellId: string | undefined, requestedSeconds: number): boolean {
  if (!inputs || inputs.mediaRole !== "extract-frame-output") return false;
  const sameSource = inputs.sourceArtifactId === sourceArtifactId || (sourceCellId !== undefined && inputs.sourceCellId === sourceCellId);
  if (!sameSource) return false;
  if (typeof inputs.requestedSeconds === "number") return Math.abs(inputs.requestedSeconds - requestedSeconds) < 0.001;
  return typeof inputs.atSeconds === "number" && Math.abs(inputs.atSeconds - requestedSeconds) <= 0.05;
}

async function existingFrameCell(engine: Engine, document: NotebookDocument, sourceArtifactId: string, sourceCellId: string | undefined, requestedSeconds: number): Promise<NotebookCell | null> {
  for (const cell of document.cells) {
    if (cell.type !== "image" || !cell.outputArtifactId) continue;
    if (cell.inputs?.mediaRole === "extract-frame-output") {
      if (sameFrame(cell.inputs, sourceArtifactId, sourceCellId, requestedSeconds) && await readableImage(engine, cell.outputArtifactId, cell)) return cell;
      continue;
    }
    try {
      const metadata = await engine.metadata.artifacts.read<FrameMetadata>(cell.outputArtifactId, "original");
      if (!metadata.ok || metadata.value.origin !== "extract_frame" || metadata.value.sourceArtifactId !== sourceArtifactId) continue;
      if (typeof metadata.value.atSeconds !== "number" || Math.abs(metadata.value.atSeconds - requestedSeconds) > 0.05) continue;
      if (await readableImage(engine, cell.outputArtifactId, cell)) return cell;
    } catch {
      continue;
    }
  }
  return null;
}

async function placeFrameCell(engine: Engine, notebookId: string, artifactId: string, label: string, inputs: Record<string, unknown>): Promise<NotebookCell | null> {
  let cellId: string | null = null;
  try {
    const placed = await mutateNotebook(engine, notebookId, "goal_video_frame", (document) => {
      const existing = document.cells.find((candidate) => candidate.outputArtifactId === artifactId);
      if (existing) {
        cellId = existing.id;
        return document;
      }
      const cell = engine.notebooks.createCell({
        type: "image",
        label,
        slot: firstEmptyNotebookGridSlot(notebookOccupiedSlots(document.cells)),
        outputArtifactId: artifactId,
        inputs,
      });
      cellId = cell.id;
      return arrangeGoalNotebook({ ...document, cells: [...document.cells, cell] });
    }, { artifactId }, { artifactId });
    if (!placed.ok || !cellId) return null;
  } catch {
    return null;
  }
  return readNotebook(engine, notebookId).cells.find((candidate) => candidate.id === cellId) ?? null;
}

function notebookHasRoom(document: NotebookDocument): boolean {
  return notebookOccupiedSlots(document.cells).length < NOTEBOOK_GRID_CAPACITY;
}

async function videoReference(
  engine: Engine,
  notebookId: string,
  document: NotebookDocument,
  sourceArtifactId: string,
  sourceCellId: string | undefined,
  label: string,
  atSeconds: number | null,
  accept: boolean,
): Promise<UsableImageReference> {
  const duration = await videoDuration(engine, sourceArtifactId);
  if (duration === null) return skipped(`${label} is a video, but its frame could not be read, so it was skipped.`, sourceArtifactId);
  if (atSeconds !== null && (!(atSeconds >= 0) || atSeconds >= duration)) {
    return skipped(`${label} is a video, but its frame at ${formatSeconds(atSeconds)} s could not be read, so it was skipped.`, sourceArtifactId);
  }
  const requested = atSeconds ?? duration / 2;
  const existing = await existingFrameCell(engine, document, sourceArtifactId, sourceCellId, requested);
  if (existing?.outputArtifactId) {
    const image = await readableImage(engine, existing.outputArtifactId, existing);
    if (image) {
      if (!accept) return available(sourceArtifactId);
      const stamped = existing.inputs?.atSeconds;
      const at = typeof stamped === "number" ? stamped : requested;
      return adopted(image, { cellId: existing.id, atSeconds: at }, sourceArtifactId);
    }
  }
  if (!notebookHasRoom(document)) return skipped(`${label} is a video, but the notebook is full, so it was skipped.`, sourceArtifactId);
  if (!accept) return available(sourceArtifactId);
  let captured: { artifactId: string; atSeconds: number };
  try {
    captured = await captureFrame(engine, sourceArtifactId, { role: "time", timestampSeconds: requested, title: `Frame of ${label}` });
  } catch {
    return skipped(`${label} is a video, but its frame could not be read, so it was skipped.`, sourceArtifactId);
  }
  const cell = await placeFrameCell(engine, notebookId, captured.artifactId, `Frame of ${label}`, {
    mediaRole: "extract-frame-output",
    sourceArtifactId,
    ...(sourceCellId ? { sourceCellId } : {}),
    frameMode: "time",
    atSeconds: captured.atSeconds,
    requestedSeconds: requested,
    state: "completed",
  });
  if (!cell) return skipped(`${label} is a video, but the notebook is full, so it was skipped.`, sourceArtifactId);
  const image = await readableImage(engine, captured.artifactId, cell);
  if (!image) return skipped(`${label} is a video, but its frame could not be read, so it was skipped.`, sourceArtifactId);
  return adopted(image, { cellId: cell.id, atSeconds: captured.atSeconds }, sourceArtifactId);
}

function isAudio(kind: string | null, cell: NotebookCell | undefined): boolean {
  return kind === "audio" || cell?.type === "audio" || cell?.type === "extract_audio" || cell?.type === "generate_audio";
}

function isVideo(kind: string | null, cell: NotebookCell | undefined): boolean {
  return kind === "video" || cell?.type === "video" || cell?.type === "split_video" || cell?.type === "generate_video" || cell?.type === "concat" || cell?.type === "splice";
}

export async function usableImageReference(
  engine: Engine,
  notebookId: string,
  reference: string,
  options: { accept: boolean; atSeconds?: number | null; ignoreArtifactIds?: ReadonlySet<string>; mention?: string },
): Promise<UsableImageReference> {
  const label = options.mention ?? (reference.startsWith("@") ? reference : `@${reference}`);
  const document = readNotebook(engine, notebookId);
  const resolved = resolveNotebookArtifactReference({ engine, documents: [document], reference, requireMedia: true });
  if ("code" in resolved) return skipped(unresolvedNote(label, resolved.reference, resolved.code));
  if (options.ignoreArtifactIds?.has(resolved.artifactId)) return ignoredReference(resolved.artifactId);
  const artifact = engine.artifacts.get(resolved.artifactId);
  const kind = artifact.ok ? artifact.value.kind : null;
  const cell = resolved.cellId ? document.cells.find((candidate) => candidate.id === resolved.cellId) : undefined;
  if (isAudio(kind, cell)) return skipped(`${label} is audio and was skipped.`, resolved.artifactId);
  if (isVideo(kind, cell)) {
    return videoReference(engine, notebookId, document, resolved.artifactId, cell?.id, label, options.atSeconds ?? null, options.accept);
  }
  if (kind !== "image") return skipped(`${label} is not an image and was skipped.`, resolved.artifactId);
  if (!cell) return skipped(`${label} is not an image cell and was skipped.`, resolved.artifactId);
  const image = await readableImage(engine, resolved.artifactId, cell);
  if (!image) return skipped(`${label} has no readable image and was skipped.`, resolved.artifactId);
  return options.accept ? adopted(image, null, resolved.artifactId) : available(resolved.artifactId);
}

export function renderReferenceNotes(document: NotebookDocument, notes: readonly ReferenceNote[]): string[] {
  return notes.map((note) => {
    if (note.kind === "text") return note.text;
    const cell = document.cells.find((candidate) => candidate.id === note.cellId);
    const address = cell ? notebookGridTag(cell.slot) : "a new cell";
    return `${note.mention} is a video, so its frame at ${formatSeconds(note.atSeconds)} s (${address}) is the reference.`;
  });
}
