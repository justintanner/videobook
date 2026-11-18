import type {
  Engine,
  NotebookCell,
  NotebookDocument,
  Revision,
} from "videobook-engine";
import { currentCatalogRows, type CatalogRow } from "./catalog-rows.js";
import { markDescendantsStale } from "./notebook-action-catalog.js";
import { mutateNotebook } from "./notebook-mutations.js";
import { removeArtifactFromTimeline } from "./tools/delete-asset.js";
import { forgetCaptionState } from "./captions/forget.js";
import { forgetGraphicsState } from "./graphics/forget.js";
import { forgetCleanupState } from "./video-cleanup/service.js";

/** One place at HEAD that still holds the artifact, as the engine reports it. */
interface ForgetAssetReference {
  kind: string;
  id: string;
}

export interface ForgetAssetOutcome {
  /** `in_use` means nothing was destroyed: references still hold the asset. */
  status: "forgotten" | "in_use" | "incomplete";
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
  pendingObjects: number;
  error?: string;
}

interface PendingForget {
  label: string | null;
  hashes: string[];
  clearedCells: number;
  forgottenObjects: number;
  sharedObjects: number;
  reclaimedBytes: number;
}

const PENDING_FORGET_PREFIX = "forget_asset.pending.v1.";

const OWNED_OBJECT_COLUMNS = [
  ["artifact_files", "object_hash"],
  ["artifact_streams", "object_hash"],
  ["transcripts", "payload_hash"],
] as const;

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

function remainingForgetReferences(engine: Engine, artifactId: string): ForgetAssetReference[] {
  const references = engine.artifacts.deletionReferences(artifactId, { deleteOwnedMedia: true });
  if (!references.ok) throw new Error(references.error.message);
  const clearable = new Set(engine.sequences.getPrimary().clips
    .filter((clip) => clip.source.artifactId === artifactId).map((clip) => `sequenceClip:${clip.clipId}`));
  for (const notebook of engine.notebooks.list()) {
    for (const cell of notebook.cells) {
      const cellId = `${notebook.id}/${cell.id}`;
      if (cell.outputArtifactId === artifactId) clearable.add(`cell.outputArtifact:${cellId}`);
      for (const reference of cell.references ?? []) {
        if (reference.targetId === artifactId) clearable.add(`cell.reference:${cellId}/${reference.id}`);
      }
      for (const result of cell.pinnedResults ?? []) {
        if (result.artifactId === artifactId) clearable.add(`pinnedSearchResult:${cellId}/${result.id}`);
      }
    }
  }
  return references.value.filter((reference) => !clearable.has(`${reference.kind}:${reference.id}`));
}

function inUseOutcome(artifactId: string, label: string | null, references: ForgetAssetReference[], clearedCells = 0): ForgetAssetOutcome {
  return { status: "in_use", artifactId, label, references, clearedCells,
    forgottenObjects: 0, sharedObjects: 0, reclaimedBytes: 0, pendingObjects: 0 };
}

function pendingKey(artifactId: string): string {
  return `${PENDING_FORGET_PREFIX}${artifactId}`;
}

function readPendingForget(engine: Engine, artifactId: string): PendingForget | null {
  return engine.settings.get<PendingForget>(pendingKey(artifactId));
}

export function hasPendingForget(engine: Engine, artifactId: string): boolean {
  return readPendingForget(engine, artifactId) !== null;
}

function savePendingForget(engine: Engine, artifactId: string, pending: PendingForget | null): void {
  const saved = pending
    ? engine.settings.set(pendingKey(artifactId), pending)
    : engine.settings.delete(pendingKey(artifactId));
  if (!saved.ok) throw new Error(saved.error.message);
}

function touchesArtifact(revision: Revision, artifactId: string): boolean {
  if (revision.artifactId === artifactId) return true;
  const writeSet = revision.details?.writeSet;
  return Array.isArray(writeSet) && writeSet.some((entry) =>
    entry === `artifact:${artifactId}`
    || (typeof entry === "string" && entry.startsWith(`file:${artifactId}:`)));
}

function collectObjectHashes(rows: CatalogRow[], artifactId: string, column: string, hashes: Set<string>): void {
  for (const row of rows) {
    for (const side of ["from", "to"]) {
      const hash = row[`${side}_${column}`];
      if (row[`${side}_artifact_id`] === artifactId && isString(hash)) hashes.add(hash);
    }
  }
}

function artifactObjectHashes(engine: Engine, artifactId: string): string[] {
  const hashes = new Set<string>();
  const revisions = engine.history.revisions(Number.MAX_SAFE_INTEGER)
    .filter((revision) => touchesArtifact(revision, artifactId));
  for (const [table, column] of OWNED_OBJECT_COLUMNS) {
    collectObjectHashes(currentCatalogRows(engine, table), artifactId, column, hashes);
    for (const revision of revisions) {
      collectObjectHashes(engine.history.diff(`${revision.hash}~1`, revision.hash, table), artifactId, column, hashes);
    }
  }
  return [...hashes].sort();
}

async function eraseObjects(
  engine: Engine,
  artifactId: string,
  pending: PendingForget,
  releaseObject?: (hash: string) => Promise<void>,
): Promise<ForgetAssetOutcome> {
  let { forgottenObjects, sharedObjects, reclaimedBytes } = pending;
  const remaining: string[] = [];
  let error: string | undefined;
  for (const hash of pending.hashes) {
    const result = await engine.storage.deleteObject(hash);
    if (!result.ok) {
      if (result.error.code === "IN_USE") sharedObjects += 1;
      else if (result.error.code !== "NOT_FOUND") {
        remaining.push(hash);
        error ??= result.error.message;
      }
      continue;
    }
    try {
      await releaseObject?.(hash);
    } catch (cause) {
      remaining.push(hash);
      error ??= cause instanceof Error ? cause.message : String(cause);
      continue;
    }
    forgottenObjects += 1;
    if (result.value.deletedLocal) reclaimedBytes += result.value.sizeBytes;
  }
  const next = { ...pending, hashes: remaining, forgottenObjects, sharedObjects, reclaimedBytes };
  savePendingForget(engine, artifactId, remaining.length > 0 ? next : null);
  return {
    status: remaining.length > 0 ? "incomplete" : "forgotten",
    artifactId,
    label: pending.label,
    references: [],
    clearedCells: pending.clearedCells,
    forgottenObjects,
    sharedObjects,
    reclaimedBytes,
    pendingObjects: remaining.length,
    ...(error ? { error } : {}),
  };
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
  releaseObject?: (hash: string) => Promise<void>,
): Promise<ForgetAssetOutcome> {
  const artifact = engine.artifacts.get(input.assetId);
  if (!artifact.ok) {
    const pending = readPendingForget(engine, input.assetId);
    if (!pending) throw new Error(artifact.error.message);
    return await eraseObjects(engine, input.assetId, pending, releaseObject);
  }
  const artifactId = artifact.value.artifactId;
  const label = artifact.value.label ?? null;
  if (input.clearReferences) {
    const blockers = remainingForgetReferences(engine, artifactId);
    if (blockers.length > 0) return inUseOutcome(artifactId, label, blockers);
    const timeline = await removeArtifactFromTimeline(engine, artifactId, { dryRun: true });
    if (timeline.error) throw new Error(timeline.error);
  }
  const hashes = artifactObjectHashes(engine, artifactId);
  const clearedCells = input.clearReferences
    ? await detachFromNotebooks(engine, artifactId)
    : 0;
  if (input.clearReferences) {
    const timeline = await removeArtifactFromTimeline(engine, artifactId);
    if (timeline.error) throw new Error(timeline.error);
  }
  const previous = readPendingForget(engine, artifactId);
  const pending: PendingForget = {
    label, hashes, clearedCells, forgottenObjects: 0, sharedObjects: 0, reclaimedBytes: 0,
  };
  savePendingForget(engine, artifactId, pending);
  const deleted = await engine.artifacts.delete(artifactId, {
    deleteOwnedMedia: true,
  });
  if (!deleted.ok) {
    savePendingForget(engine, artifactId, previous);
    if (deleted.error.code !== "IN_USE") throw new Error(deleted.error.message);
    return inUseOutcome(artifactId, label, referencesOf(deleted.error.details), clearedCells);
  }
  forgetCaptionState(engine, artifactId);
  forgetGraphicsState(engine, artifactId);
  forgetCleanupState(engine, artifactId);
  return await eraseObjects(engine, artifactId, pending, releaseObject);
}
