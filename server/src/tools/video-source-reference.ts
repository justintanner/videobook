import type { Engine, NotebookDocument } from "videobook-engine";
import { notebookGridTag, parseNotebookGridAddress } from "videobook-engine/notebook-grid";

function outputAtAddress(
  notebook: NotebookDocument,
  row: number,
  column: number,
): string | null | undefined {
  const cell = notebook.cells.find((candidate) =>
    candidate.slot.row === row && candidate.slot.column === column);
  if (!cell) return undefined;
  return cell.outputArtifactId ?? null;
}

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
  const normalized = reference.trim().replace(/^@/u, "");
  if (!normalized) throw new Error("asset_id is required");

  const direct = engine.artifacts.get(normalized);
  if (direct.ok) return direct.value.slug;

  const slot = parseNotebookGridAddress(normalized);
  const notebooks = notebookCandidates(engine, notebookId);
  const matches = notebooks.flatMap((notebook) => {
    if (slot) {
      const outputArtifactId = outputAtAddress(notebook, slot.row, slot.column);
      return outputArtifactId === undefined ? [] : [{ notebook, outputArtifactId }];
    }
    const cell = notebook.cells.find((candidate) =>
      candidate.slug.toLowerCase() === normalized.toLowerCase()
      || candidate.id.toLowerCase() === normalized.toLowerCase());
    if (!cell?.outputArtifactId) return [];
    return [{ notebook, outputArtifactId: cell.outputArtifactId }];
  });
  const resolvedMatches = matches.filter(
    (match): match is { notebook: NotebookDocument; outputArtifactId: string } =>
      match.outputArtifactId !== null,
  );
  if (resolvedMatches.length === 0) {
    const label = slot ? notebookGridTag(slot) : `@${normalized}`;
    if (matches.length > 0) {
      throw new Error(`Video source ${label} has no media output yet`);
    }
    throw new Error(`Video source ${label} was not found`);
  }
  const artifactIds = [...new Set(resolvedMatches.map((match) => match.outputArtifactId))];
  if (artifactIds.length > 1) {
    throw new Error(`Video source @${normalized} is ambiguous; include notebook_id`);
  }
  const artifact = engine.artifacts.get(artifactIds[0]!);
  if (!artifact.ok) throw new Error(artifact.error.message);
  return artifact.value.slug;
}
