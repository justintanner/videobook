import type { Engine, NotebookDocument } from "videobook-engine";

type NotebookMutationResult = Awaited<ReturnType<Engine["notebooks"]["write"]>>;

const writeChains = new Map<string, Promise<unknown>>();

export async function mutateNotebook(
  engine: Engine,
  notebookId: string,
  _operation: string,
  mutate: (notebook: NotebookDocument) => NotebookDocument,
  _details: Record<string, unknown> = {},
): Promise<NotebookMutationResult> {
  const current = writeChains.get(notebookId) ?? Promise.resolve();
  const next = current.then(async () => {
    const read = engine.notebooks.read(notebookId);
    if (!read.ok) return read;
    return await engine.notebooks.write(mutate(read.value));
  });
  writeChains.set(notebookId, next.catch(() => {}));
  return await next;
}
