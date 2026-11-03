import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { normalizeNotebookReference } from "videobook-engine/notebook-mentions";
import { resolveNotebookArtifactReference } from "../notebook-reference-resolver.js";

function notebookCandidates(
  engine: Engine,
  notebookId: string | undefined,
): NotebookDocument[] {
  if (!notebookId) return engine.notebooks.list();
  const notebook = engine.notebooks.read(notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  return [notebook.value];
}

export function resolveVideoAssetReference(
  engine: Engine,
  reference: string,
  notebookId?: string,
): string {
  const normalized = normalizeNotebookReference(reference);
  if (!normalized) throw new Error("asset_id is required");
  const notebooks = notebookCandidates(engine, notebookId);
  const result = resolveNotebookArtifactReference({
    engine,
    documents: notebooks,
    reference: normalized,
  });
  if (!("code" in result)) return result.artifactId;
  if (result.code === "ambiguous") {
    throw new Error(`Video source @${normalized} is ambiguous; include notebook_id`);
  }
  if (result.code === "no_output" || result.code === "not_media") {
    throw new Error(`Video source @${normalized} has no media output yet`);
  }
  throw new Error(`Video source @${normalized} was not found`);
}

export type VideoCutSource = {
  artifactId: string;
  notebook: { document: NotebookDocument; cell: NotebookCell } | null;
};

function sourceCell(
  documents: readonly NotebookDocument[],
  artifactId: string,
  cellId: string | undefined,
): { document: NotebookDocument; cell: NotebookCell } | null {
  for (const document of documents) {
    const cell = document.cells.find((candidate) =>
      cellId ? candidate.id === cellId : candidate.outputArtifactId === artifactId);
    if (cell) return { document, cell };
  }
  return null;
}

export function resolveVideoCutSource(
  engine: Engine,
  reference: string,
  notebookId?: string,
): VideoCutSource {
  const artifactId = resolveVideoAssetReference(engine, reference, notebookId);
  const documents = notebookCandidates(engine, notebookId);
  const resolved = resolveNotebookArtifactReference({
    engine,
    documents,
    reference: normalizeNotebookReference(reference),
  });
  const cellId = "code" in resolved ? undefined : resolved.cellId;
  return { artifactId, notebook: sourceCell(documents, artifactId, cellId) };
}
