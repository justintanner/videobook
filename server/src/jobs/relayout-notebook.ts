import type { Engine } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import {
  notebookDocumentsEqual,
  relayoutNotebookDocument,
} from "../notebook-relayout.js";
import { mutateNotebook } from "../notebook-mutations.js";
import { registerJobHandler, resolveBookEngine } from "../queue.js";

interface RelayoutNotebookPayload {
  type: "relayout_notebook";
  bookId: string;
  notebookId: string;
}

export async function executeRelayoutNotebook(
  engine: Engine,
  payload: RelayoutNotebookPayload,
) {
  const before = engine.notebooks.read(payload.notebookId);
  if (!before.ok) throw new Error(before.error.message);
  const next = relayoutNotebookDocument(engine, before.value);
  if (notebookDocumentsEqual(before.value, next)) {
    return {
      changed: false,
      notebook_id: payload.notebookId,
      cell_count: next.cells.length,
      edge_count: next.edges.length,
      revision: engine.head,
      cells: next.cells.map((cell) => ({
        id: cell.id,
        type: cell.type,
        address: notebookGridTag(cell.slot),
        slot: cell.slot,
        output_artifact_id: cell.outputArtifactId ?? null,
      })),
    };
  }
  const write = await mutateNotebook(
    engine,
    payload.notebookId,
    "relayout_notebook",
    () => next,
    { notebookId: payload.notebookId },
  );
  if (!write.ok) throw new Error(write.error.message);
  const after = engine.notebooks.read(payload.notebookId);
  if (!after.ok) throw new Error(after.error.message);
  return {
    changed: true,
    notebook_id: payload.notebookId,
    cell_count: after.value.cells.length,
    edge_count: after.value.edges.length,
    revision: write.value.hash,
    cells: after.value.cells.map((cell) => ({
      id: cell.id,
      type: cell.type,
      address: notebookGridTag(cell.slot),
      slot: cell.slot,
      output_artifact_id: cell.outputArtifactId ?? null,
    })),
  };
}

export function registerRelayoutNotebookJob(_fs: Engine): void {
  registerJobHandler("relayout_notebook", async (payload) => {
    const notebookId = typeof payload.notebookId === "string"
      ? payload.notebookId
      : "";
    const bookId = typeof payload.bookId === "string" ? payload.bookId : "";
    if (!notebookId) throw new Error("relayout_notebook requires notebookId");
    if (!bookId) throw new Error("relayout_notebook requires bookId");
    const engine = await resolveBookEngine(bookId);
    return executeRelayoutNotebook(engine, {
      type: "relayout_notebook",
      bookId,
      notebookId,
    });
  });
}
