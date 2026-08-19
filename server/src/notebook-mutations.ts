import type { Engine, NotebookDocument } from "videobook-engine";
import { normalizeLegacyExtractCells } from "./notebook-cell-outputs.js";

type NotebookMutationResult = Awaited<ReturnType<Engine["notebooks"]["write"]>>;

const writeChains = new Map<string, Promise<unknown>>();

export async function mutateNotebook(
  engine: Engine,
  notebookId: string,
  operation: string,
  mutate: (notebook: NotebookDocument) => NotebookDocument,
  details: Record<string, unknown> = {},
  options: { artifactId?: string } = {},
): Promise<NotebookMutationResult> {
  const current = writeChains.get(notebookId) ?? Promise.resolve();
  const next = current.then(async () => {
    const read = engine.notebooks.read(notebookId);
    if (!read.ok) return read;
    return await engine.notebooks.write(
      mutate(
        normalizeLegacyExtractCells(read.value),
      ),
      {
      operation,
      details,
      ...(options.artifactId ? { artifactId: options.artifactId } : {}),
    });
  });
  writeChains.set(notebookId, next.catch(() => {}));
  return await next;
}
