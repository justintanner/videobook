import type { Engine, NotebookDocument } from "videobook-engine";
import { normalizeLegacyExtractCells } from "./notebook-cell-outputs.js";
import { pruneInputParams } from "./generation-input-params.js";

type NotebookMutationResult = Awaited<ReturnType<Engine["notebooks"]["write"]>>;

const writeChains = new Map<string, Promise<unknown>>();

export async function withNotebookMutation<T>(
  notebookId: string,
  mutate: () => Promise<T>,
): Promise<T> {
  const current = writeChains.get(notebookId) ?? Promise.resolve();
  const next = current.then(mutate);
  writeChains.set(notebookId, next.catch(() => {}));
  return await next;
}

export async function mutateNotebook(
  engine: Engine,
  notebookId: string,
  operation: string,
  mutate: (notebook: NotebookDocument) => NotebookDocument,
  details: Record<string, unknown> = {},
  options: { artifactId?: string } = {},
): Promise<NotebookMutationResult> {
  return await withNotebookMutation(notebookId, async () => {
    const read = engine.notebooks.read(notebookId);
    if (!read.ok) return read;
    return await engine.notebooks.write(
      pruneInputParams(mutate(
        normalizeLegacyExtractCells(read.value),
      )),
      {
      operation,
      details,
      ...(options.artifactId ? { artifactId: options.artifactId } : {}),
    });
  });
}

export async function mutateNotebookIfChanged(
  engine: Engine,
  notebookId: string,
  operation: string,
  mutate: (notebook: NotebookDocument) => NotebookDocument | null,
  details: Record<string, unknown> = {},
): Promise<NotebookMutationResult | { ok: true; value: null }> {
  return await withNotebookMutation(notebookId, async () => {
    const read = engine.notebooks.read(notebookId);
    if (!read.ok) return read;
    const next = mutate(normalizeLegacyExtractCells(read.value));
    if (next === null) return { ok: true as const, value: null };
    return await engine.notebooks.write(pruneInputParams(next), { operation, details });
  });
}
