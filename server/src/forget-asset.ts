import type {
  Engine,
  NotebookCell,
  NotebookDocument,
} from "videobook-engine";
import { markDescendantsStale } from "./notebook-action-catalog.js";
import { mutateNotebook } from "./notebook-mutations.js";
import { removeArtifactFromTimeline } from "./tools/delete-asset.js";

/** One place at HEAD that still holds the artifact, as the engine reports it. */
interface ForgetAssetReference {
  kind: string;
  id: string;
}

export interface ForgetAssetOutcome {
  /** `in_use` means nothing was destroyed: references still hold the asset. */
  status: "forgotten" | "in_use";
  artifactId: string;
  label: string | null;
  references: ForgetAssetReference[];
  /** Notebook cells whose hold on the asset was cleared first. */
  clearedCells: number;
  /** Content objects whose bytes are gone. */
  forgottenObjects: number;
  /** Objects left alone because another artifact stores the same bytes. */
  sharedObjects: number;
  reclaimedBytes: number;
}

const CELL_INPUT_ARTIFACT_KEYS = [
  "firstFrameArtifactId",
  "lastFrameArtifactId",
  "providerArtifactId",
] as const;

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function inputVersionIds(inputs: Record<string, unknown>): string[] {
  return Array.isArray(inputs.outputVersionArtifactIds)
    ? inputs.outputVersionArtifactIds.filter(isString)
    : [];
}

function cellHoldsArtifact(cell: NotebookCell, artifactId: string): boolean {
  const inputs = cell.inputs ?? {};
  return cell.outputArtifactId === artifactId
    || (cell.references ?? []).some((reference) => reference.targetId === artifactId)
    || (cell.pinnedResults ?? []).some((pinned) => pinned.artifactId === artifactId)
    || CELL_INPUT_ARTIFACT_KEYS.some((key) => inputs[key] === artifactId)
    || inputVersionIds(inputs).includes(artifactId);
}

function detachedInputs(
  cell: NotebookCell,
  artifactId: string,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = { ...(cell.inputs ?? {}) };
  for (const key of CELL_INPUT_ARTIFACT_KEYS) {
    if (inputs[key] === artifactId) delete inputs[key];
  }
  if (Array.isArray(inputs.outputVersionArtifactIds)) {
    inputs.outputVersionArtifactIds = inputVersionIds(inputs)
      .filter((id) => id !== artifactId);
  }
  if (cell.outputArtifactId === artifactId) inputs.state = "ready";
  return inputs;
}

function detachedCell(cell: NotebookCell, artifactId: string): NotebookCell {
  const references = (cell.references ?? [])
    .filter((reference) => reference.targetId !== artifactId);
  const pinnedResults = (cell.pinnedResults ?? [])
    .filter((pinned) => pinned.artifactId !== artifactId);
  return {
    ...cell,
    ...(cell.outputArtifactId === artifactId ? { outputArtifactId: undefined } : {}),
    inputs: detachedInputs(cell, artifactId),
    ...(cell.references ? { references } : {}),
    ...(cell.pinnedResults ? { pinnedResults } : {}),
  };
}

/** A cleared cell reads as never run, so a re-run refills it. */
function detachedExecution(
  document: NotebookDocument,
  cellIds: readonly string[],
): NotebookDocument["execution"] {
  const execution = { ...(document.execution ?? {}) };
  for (const cellId of cellIds) {
    const current = execution[cellId];
    if (!current || typeof current !== "object") continue;
    execution[cellId] = {
      ...current,
      status: "ready",
      stale: false,
      outputArtifactId: undefined,
      providerArtifactId: undefined,
      error: undefined,
    };
  }
  return execution;
}

function detachedDocument(
  document: NotebookDocument,
  artifactId: string,
): { document: NotebookDocument; cellIds: string[] } {
  const cellIds = document.cells
    .filter((cell) => cellHoldsArtifact(cell, artifactId))
    .map((cell) => cell.id);
  if (cellIds.length === 0) return { document, cellIds };
  const detached: NotebookDocument = {
    ...document,
    cells: document.cells.map((cell) =>
      cellIds.includes(cell.id) ? detachedCell(cell, artifactId) : cell),
    execution: detachedExecution(document, cellIds),
  };
  return {
    document: cellIds.reduce(
      (next, cellId) => markDescendantsStale(next, cellId),
      detached,
    ),
    cellIds,
  };
}

async function detachFromNotebooks(
  engine: Engine,
  artifactId: string,
): Promise<number> {
  let cleared = 0;
  for (const notebook of engine.notebooks.list()) {
    if (!notebook.cells.some((cell) => cellHoldsArtifact(cell, artifactId))) {
      continue;
    }
    let cellIds: string[] = [];
    const result = await mutateNotebook(
      engine,
      notebook.id,
      "forget_asset",
      (document) => {
        const detached = detachedDocument(document, artifactId);
        cellIds = detached.cellIds;
        return detached.document;
      },
      { artifactId },
      { artifactId },
    );
    if (!result.ok) throw new Error(result.error.message);
    cleared += cellIds.length;
  }
  return cleared;
}

function referencesOf(details: Record<string, unknown> | undefined): ForgetAssetReference[] {
  const references = details?.references;
  if (!Array.isArray(references)) return [];
  return references.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    return isString(row.kind) && isString(row.id)
      ? [{ kind: row.kind, id: row.id }]
      : [];
  });
}

/**
 * Deletes an artifact and destroys the bytes behind it.
 *
 * `engine.artifacts.delete` clears the catalog rows and the workspace copy,
 * but the content objects survive — that is what makes a duplicate import
 * free and an old revision restorable. Forgetting finishes the job through
 * `storage.deleteObject`, which is left unforced on purpose: an object another
 * artifact still references is kept, so forgetting one copy of shared bytes
 * never blanks the other.
 */
export async function forgetAsset(
  engine: Engine,
  input: { assetId: string; clearReferences: boolean },
): Promise<ForgetAssetOutcome> {
  const artifact = engine.artifacts.get(input.assetId);
  if (!artifact.ok) throw new Error(artifact.error.message);
  const artifactId = artifact.value.artifactId;
  const label = artifact.value.label ?? null;
  const manifest = await engine.files.manifest(artifactId, { includeDotfiles: true });
  const hashes = [...new Set(
    manifest.ok ? manifest.value.files.map((file) => file.objectHash) : [],
  )];
  const clearedCells = input.clearReferences
    ? await detachFromNotebooks(engine, artifactId)
    : 0;
  if (input.clearReferences) {
    const timeline = await removeArtifactFromTimeline(engine, artifactId);
    if (timeline.error) throw new Error(timeline.error);
  }
  const deleted = await engine.artifacts.delete(artifactId, {
    deleteOwnedMedia: true,
  });
  if (!deleted.ok) {
    if (deleted.error.code !== "IN_USE") throw new Error(deleted.error.message);
    return {
      status: "in_use",
      artifactId,
      label,
      references: referencesOf(deleted.error.details),
      clearedCells,
      forgottenObjects: 0,
      sharedObjects: 0,
      reclaimedBytes: 0,
    };
  }
  let forgottenObjects = 0;
  let sharedObjects = 0;
  let reclaimedBytes = 0;
  for (const hash of hashes) {
    const result = await engine.storage.deleteObject(hash);
    if (result.ok) {
      forgottenObjects += 1;
      if (result.value.deletedLocal) reclaimedBytes += result.value.sizeBytes;
      continue;
    }
    // Bytes another artifact stores, or an object row that never existed.
    if (result.error.code === "IN_USE") {
      sharedObjects += 1;
      continue;
    }
    if (result.error.code === "NOT_FOUND") continue;
    throw new Error(result.error.message);
  }
  return {
    status: "forgotten",
    artifactId,
    label,
    references: [],
    clearedCells,
    forgottenObjects,
    sharedObjects,
    reclaimedBytes,
  };
}
