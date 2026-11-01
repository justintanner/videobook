import { v7 as uuidv7 } from "uuid";
import type { Engine } from "videobook-engine";
import { failQueuedNotebookCells, markNotebookCellQueued } from "./jobs/run-notebook.js";
import { queue } from "./queue.js";

export type NotebookRunRequest = {
  bookId: string;
  notebookId: string;
  cellIds?: string[];
  actor?: string;
};

export type NotebookRunAccepted = { jobId: string; runId: string };

export async function enqueueNotebookRun(
  engine: Engine,
  request: NotebookRunRequest,
): Promise<NotebookRunAccepted> {
  const { bookId, notebookId, cellIds, actor } = request;
  const runId = uuidv7();
  const jobId = `run-notebook-${notebookId}-${runId}`;
  try {
    for (const cellId of cellIds ?? []) {
      await markNotebookCellQueued(engine, notebookId, cellId, runId);
    }
    await queue.enqueue(jobId, {
      type: "run_notebook",
      bookId,
      notebookId,
      runId,
      force: cellIds !== undefined,
      ...(cellIds ? { cellIds } : {}),
      ...(actor ? { actor } : {}),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await failQueuedNotebookCells(engine, notebookId, {
      cellIds: cellIds ?? [],
      runId,
      error: message,
    }).catch(() => undefined);
    throw new Error(message);
  }
  return { jobId, runId };
}
