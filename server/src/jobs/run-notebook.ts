import { randomUUID } from "node:crypto";

import type {
  NotebookCell,
  NotebookDocument,
  NotebookRun,
  VideobookFs,
} from "videobook-engine";

import { registerJobHandler } from "../queue.js";

interface RunNotebookPayload {
  type: "run_notebook";
  projectSlug: string;
  notebookId: string;
}

export function registerRunNotebookJob(fs: VideobookFs): void {
  registerJobHandler("run_notebook", async (payload) => {
    const input = payload as unknown as RunNotebookPayload;
    const notebookResult = await fs.readNotebook(
      input.notebookId,
      input.projectSlug,
    );
    if (!notebookResult.ok) throw new Error(notebookResult.error.message);
    const cellOrder = topologicalOrder(notebookResult.value);
    const outputs: Record<string, string> = {};
    for (const cell of cellOrder) {
      const output = cell.outputAssetId ?? cell.entityId;
      if (output) outputs[cell.id] = output;
    }
    const now = new Date().toISOString();
    const run: NotebookRun = {
      id: randomUUID(),
      notebookId: input.notebookId,
      status: "completed",
      startedAt: now,
      completedAt: now,
      cellOrder: cellOrder.map((cell) => cell.id),
      outputs,
    };
    const recorded = await fs.recordNotebookRun(run, input.projectSlug);
    if (!recorded.ok) throw new Error(recorded.error.message);
    return run;
  });
}

export function topologicalOrder(notebook: NotebookDocument): NotebookCell[] {
  const cells = new Map(notebook.cells.map((cell) => [cell.id, cell]));
  const incoming = new Map(notebook.cells.map((cell) => [cell.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of notebook.edges) {
    if (!cells.has(edge.source) || !cells.has(edge.target)) {
      throw new Error(`Notebook edge references a missing cell: ${edge.id}`);
    }
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }
  const ready = notebook.cells
    .filter((cell) => incoming.get(cell.id) === 0)
    .map((cell) => cell.id);
  const ordered: NotebookCell[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(cells.get(id)!);
    for (const target of outgoing.get(id) ?? []) {
      const count = (incoming.get(target) ?? 0) - 1;
      incoming.set(target, count);
      if (count === 0) ready.push(target);
    }
  }
  if (ordered.length !== notebook.cells.length) {
    throw new Error("Notebook graph contains a cycle");
  }
  return ordered;
}
