import type { Engine, NotebookCell, NotebookDocument, NotebookGridSlot } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { probeVideo } from "../ffmpeg.js";
import type { ProbeResult } from "../ffmpeg.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { mutateNotebook } from "../notebook-mutations.js";
import { extractVideoPoster } from "../video-poster.js";

export type RenderedCellPlacement = { cellId: string | null; address: string | null };

type RenderedCellInput = {
  notebookId: string | null;
  operation: string;
  sourceArtifactId: string;
  outputArtifactId: string;
  fallbackLabel: string;
  destination: (notebook: NotebookDocument) => { existing: NotebookCell | null; slot: NotebookGridSlot };
  inputs: Record<string, unknown>;
};

const UNPLACED: RenderedCellPlacement = { cellId: null, address: null };

function versionedCell(cell: NotebookCell, artifactId: string): NotebookCell {
  const previous = Array.isArray(cell.inputs?.outputVersionArtifactIds)
    ? cell.inputs.outputVersionArtifactIds.filter((value): value is string => typeof value === "string")
    : [];
  const versions = [...new Set([...previous, ...(cell.outputArtifactId ? [cell.outputArtifactId] : []), artifactId])];
  return { ...cell, outputArtifactId: artifactId, inputs: { ...cell.inputs, outputVersionArtifactIds: versions, state: "completed" } };
}

function placeOutput(engine: Engine, notebook: NotebookDocument, input: RenderedCellInput, label: string): { notebook: NotebookDocument; cell: NotebookCell } {
  const placed = notebook.cells.find((cell) => cell.outputArtifactId === input.outputArtifactId);
  if (placed) return { notebook, cell: placed };
  const destination = input.destination(notebook);
  if (destination.existing) {
    const cell = versionedCell(destination.existing, input.outputArtifactId);
    return { notebook: { ...notebook, cells: notebook.cells.map((candidate) => (candidate.id === cell.id ? cell : candidate)) }, cell };
  }
  const cell = engine.notebooks.createCell({
    type: "video",
    label,
    slot: destination.slot,
    outputArtifactId: input.outputArtifactId,
    inputs: { ...input.inputs, state: "completed" },
  });
  return { notebook: { ...notebook, cells: [...notebook.cells, cell] }, cell };
}

export async function placeRenderedCell(engine: Engine, input: RenderedCellInput): Promise<RenderedCellPlacement> {
  if (!input.notebookId) return UNPLACED;
  const artifact = engine.artifacts.get(input.outputArtifactId);
  const label = artifact.ok ? artifact.value.label ?? input.fallbackLabel : input.fallbackLabel;
  const placement: { cellId: string | null; address: string | null } = { ...UNPLACED };
  const written = await mutateNotebook(engine, input.notebookId, input.operation, (notebook) => {
    const result = placeOutput(engine, notebook, input, label);
    placement.cellId = result.cell.id;
    placement.address = notebookGridTag(result.cell.slot);
    return result.notebook;
  }, { sourceArtifactId: input.sourceArtifactId, outputArtifactId: input.outputArtifactId }, { artifactId: input.outputArtifactId });
  if (!written.ok) throw new Error(written.error.message);
  return placement;
}

export function sourceCellPlacement(engine: Engine, notebookId: string | null, sourceArtifactId: string): RenderedCellPlacement {
  const notebook = notebookId ? engine.notebooks.read(notebookId) : null;
  const cell = notebook?.ok ? notebook.value.cells.find((entry) => entry.outputArtifactId === sourceArtifactId) : undefined;
  return cell ? { cellId: cell.id, address: notebookGridTag(cell.slot) } : UNPLACED;
}

export async function writeRenderedVideo(engine: Engine, artifactId: string, path: string, signal: AbortSignal): Promise<ProbeResult> {
  const probe = await probeVideo(path, { signal });
  const written = await engine.files.writeFromPath(artifactId, "original.mp4", path);
  if (!written.ok) throw new Error(written.error.message);
  await registerMediaProbe(engine, artifactId, "original.mp4", probe);
  const poster = await engine.files.write(artifactId, "original.jpg", await extractVideoPoster(path, probe.videoDuration, signal));
  if (!poster.ok) throw new Error(poster.error.message);
  return probe;
}
