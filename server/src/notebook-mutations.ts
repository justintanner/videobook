import type { Engine, NotebookDocument } from "videobook-engine";

type NotebookMutationResult = Awaited<ReturnType<Engine["notebooks"]["write"]>>;

const writeChains = new Map<string, Promise<unknown>>();

export async function mutateNotebook(
  engine: Engine,
  notebookId: string,
  operation: string,
  mutate: (notebook: NotebookDocument) => NotebookDocument,
  details: Record<string, unknown> = {},
): Promise<NotebookMutationResult> {
  const current = writeChains.get(notebookId) ?? Promise.resolve();
  const next = current.then(async () => {
    const read = engine.notebooks.read(notebookId);
    if (!read.ok) return read;
    const result = await engine.notebooks.write(mutate(read.value));
    if (result.ok) {
      await engine.history.recordAction({
        operation,
        scope: "book",
        phase: "completed",
        actor: "human",
        lane: "notebook",
        writeSet: [`notebook:${notebookId}`],
        details: { notebookId, ...details },
      });
    }
    return result;
  });
  writeChains.set(notebookId, next.catch(() => {}));
  return await next;
}
