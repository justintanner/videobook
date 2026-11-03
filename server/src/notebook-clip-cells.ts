import type { Engine, NotebookCell, NotebookDocument, NotebookGridSlot } from "videobook-engine";
import { nextVerticalSlotFrom, notebookGridTag, notebookOccupiedSlots } from "videobook-engine/notebook-grid";
import { CUT_CLIP_OUTPUT_ROLE } from "./notebook-cell-outputs.js";
import { mutateNotebook } from "./notebook-mutations.js";
import { enqueueNotebookRun } from "./notebook-run-enqueue.js";
import type { VideoRange } from "./video-cut-ranges.js";

export type ClipCellRequest = {
  label: string;
  keepRanges: VideoRange[];
};

export type ClipCellsResult = {
  sourceAddress: string;
  cells: Array<{ cellId: string; address: string; label: string; keepRanges: VideoRange[] }>;
  jobId: string;
  runId: string;
};

function clipSlots(cells: readonly NotebookCell[], sourceSlot: NotebookGridSlot, count: number): NotebookGridSlot[] {
  const occupied = notebookOccupiedSlots(cells);
  const slots: NotebookGridSlot[] = [];
  let cursor = sourceSlot;
  for (let index = 0; index < count; index += 1) {
    const slot = nextVerticalSlotFrom(cursor, [...occupied, ...slots]);
    slots.push(slot);
    cursor = slot;
  }
  return slots;
}

function clipCell(engine: Engine, source: NotebookCell, request: ClipCellRequest, slot: NotebookGridSlot): NotebookCell {
  const first = request.keepRanges[0]!;
  const last = request.keepRanges.at(-1)!;
  return engine.notebooks.createCell({
    type: "video",
    label: request.label,
    slot,
    inputs: {
      mediaRole: CUT_CLIP_OUTPUT_ROLE,
      sourceCellId: source.id,
      keepRanges: request.keepRanges,
      startSeconds: first.startSeconds,
      endSeconds: last.endSeconds,
      state: "queued",
    },
  });
}

function withClipCells(
  engine: Engine,
  document: NotebookDocument,
  sourceCellId: string,
  requests: readonly ClipCellRequest[],
): { document: NotebookDocument; cells: NotebookCell[] } {
  const source = document.cells.find((cell) => cell.id === sourceCellId);
  if (!source) throw new Error("The source cell was removed");
  const slots = clipSlots(document.cells, source.slot, requests.length);
  const cells = requests.map((request, index) => clipCell(engine, source, request, slots[index]!));
  const edges = cells.map((cell) => engine.notebooks.createEdge({
    source: source.id,
    target: cell.id,
    targetInput: "segment",
  }));
  return {
    document: { ...document, cells: [...document.cells, ...cells], edges: [...document.edges, ...edges] },
    cells,
  };
}

export async function addClipCells(
  engine: Engine,
  input: {
    bookId: string;
    document: NotebookDocument;
    source: NotebookCell;
    requests: readonly ClipCellRequest[];
    actor?: string;
  },
): Promise<ClipCellsResult> {
  if (input.requests.length === 0) throw new Error("Nothing to cut");
  const placed: { cells: NotebookCell[] } = { cells: [] };
  const written = await mutateNotebook(engine, input.document.id, "cut_video_clips", (document) => {
    const next = withClipCells(engine, document, input.source.id, input.requests);
    placed.cells = next.cells;
    return next.document;
  }, { sourceCellId: input.source.id });
  if (!written.ok) throw new Error(written.error.message);
  const run = await enqueueNotebookRun(engine, {
    bookId: input.bookId,
    notebookId: input.document.id,
    cellIds: placed.cells.map((cell) => cell.id),
    actor: input.actor ?? "videobook-user",
  });
  return {
    sourceAddress: notebookGridTag(input.source.slot),
    cells: placed.cells.map((cell, index) => ({
      cellId: cell.id,
      address: notebookGridTag(cell.slot),
      label: input.requests[index]!.label,
      keepRanges: input.requests[index]!.keepRanges,
    })),
    jobId: run.jobId,
    runId: run.runId,
  };
}
