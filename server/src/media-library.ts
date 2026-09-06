import { join } from "node:path";
import type {
  Artifact,
  ArtifactKind,
  Engine,
  NotebookCell,
  NotebookDocument,
  PreparedSearchOptions,
  SearchHit,
} from "videobook-engine";
import type { BookManager, ManagedBook } from "./book-manager.js";
import { registerLocalClipSearchProvider } from "./local-search-models.js";
import { enqueueTemporalSearchPreparation } from "./jobs/prepare-temporal-search.js";
import { markDescendantsStale } from "./notebook-action-catalog.js";
import { mutateNotebook } from "./notebook-mutations.js";
import { searchReferenceStore } from "./search-reference-store.js";
import { comparableHitScore } from "./search-scoring.js";
import { buildAssetList, type ProjectAsset } from "./tools/reconcile-project-work.js";

type MediaCellType = "audio" | "image" | "video";

interface LibraryAsset extends ProjectAsset {
  owning_book_id: string;
  owning_book_name: string;
  search_match?: {
    score: number;
    location: SearchHit["location"];
  };
}

interface LibraryAssetSearchResult {
  preparationJobs: Array<{ bookId: string; jobId: number }>;
  assets: LibraryAsset[];
  page: {
    offset: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
  books_with_errors: Array<{
    book_id: string;
    message: string;
  }>;
}

interface CopiedLibraryAsset {
  sourceBookId: string;
  sourceArtifactId: string;
  targetBookId: string;
  targetArtifactId: string;
}

interface AttachedLibraryAsset extends CopiedLibraryAsset {
  notebookId: string;
  cellId: string;
  revision: string;
}

interface CopyLibraryAssetInput {
  sourceBookId: string;
  sourceArtifactId: string;
  targetBookId: string;
  newName?: string;
}

interface AttachLibraryAssetInput extends CopyLibraryAssetInput {
  notebookId: string;
  cellId: string;
  expectedOutputArtifactId: string | null;
}

function isMediaCellType(value: string): value is MediaCellType {
  return value === "audio" || value === "image" || value === "video";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compatibleArtifact(cell: NotebookCell, artifact: Artifact): boolean {
  if (cell.type === "video") {
    return artifact.kind === "video" || artifact.kind === "final";
  }
  return cell.type === artifact.kind;
}

function assertMediaCell(
  document: NotebookDocument,
  cellId: string,
): NotebookCell {
  const cell = document.cells.find((candidate) => candidate.id === cellId);
  if (!cell) throw new Error(`Cell not found: ${cellId}`);
  if (!isMediaCellType(cell.type)) {
    throw new Error("Only audio, image, and video cells can hold media slots");
  }
  return cell;
}

function withCellExecution(
  document: NotebookDocument,
  cellId: string,
  status: "ready" | "completed",
): NotebookDocument {
  const currentExecution = document.execution ?? {};
  const currentCell = isRecord(currentExecution[cellId])
    ? currentExecution[cellId]
    : {};
  return {
    ...document,
    execution: {
      ...currentExecution,
      [cellId]: {
        ...currentCell,
        status,
        stale: false,
        error: undefined,
      },
    },
  };
}

function bindMediaSlot(
  document: NotebookDocument,
  cellId: string,
  artifact: Artifact | null,
): NotebookDocument {
  const cell = assertMediaCell(document, cellId);
  if (artifact && !compatibleArtifact(cell, artifact)) {
    throw new Error(
      `A ${cell.type} cell cannot use a ${artifact.kind} artifact`,
    );
  }
  if (
    artifact
    && document.edges.some((edge) => edge.target === cellId)
  ) {
    throw new Error("Clear connected inputs before attaching Library media");
  }
  const cells = document.cells.map((candidate) => {
    if (candidate.id !== cellId) return candidate;
    return {
      ...candidate,
      outputArtifactId: artifact?.artifactId,
      inputs: {
        ...(candidate.inputs ?? {}),
        state: artifact ? "completed" : "ready",
      },
    };
  });
  const edges = artifact
    ? document.edges
    : document.edges.filter((edge) => edge.target !== cellId);
  return withCellExecution(
    markDescendantsStale({ ...document, cells, edges }, cellId),
    cellId,
    artifact ? "completed" : "ready",
  );
}

export async function setNotebookMediaSlot(
  engine: Engine,
  input: {
    notebookId: string;
    cellId: string;
    artifactRef: string | null;
    expectedRevision?: string;
  },
): Promise<{
  cellId: string;
  outputArtifactId: string | null;
  revision: string;
}> {
  if (
    input.expectedRevision
    && input.expectedRevision !== engine.head
  ) {
    throw new Error(
      `Stale notebook revision: expected ${input.expectedRevision}`,
    );
  }
  const artifact = input.artifactRef
    ? engine.artifacts.get(input.artifactRef)
    : null;
  if (artifact && !artifact.ok) throw new Error(artifact.error.message);
  const resolved = artifact?.ok ? artifact.value : null;
  const result = await mutateNotebook(
    engine,
    input.notebookId,
    resolved ? "set_notebook_media_slot" : "clear_notebook_media_slot",
    (notebook) => bindMediaSlot(notebook, input.cellId, resolved),
    {
      cellId: input.cellId,
      outputArtifactId: resolved?.artifactId ?? null,
    },
  );
  if (!result.ok) throw new Error(result.error.message);
  return {
    cellId: input.cellId,
    outputArtifactId: resolved?.artifactId ?? null,
    revision: result.value.hash,
  };
}

function kindMatches(
  requested: ReadonlySet<MediaCellType>,
  kind: string,
): boolean {
  return requested.has(kind as MediaCellType)
    || (kind === "final" && requested.has("video"));
}

function searchRank(
  asset: LibraryAsset,
  query: string,
): number {
  if (!query) return 3;
  const label = asset.label?.toLowerCase() ?? "";
  const book = asset.owning_book_name.toLowerCase();
  const prompt = asset.prompt?.toLowerCase() ?? "";
  if ((label && label === query) || book === query) return 0;
  if ((label && label.startsWith(query)) || book.startsWith(query)) return 1;
  return prompt.startsWith(query) ? 2 : 3;
}

function matchesQuery(asset: LibraryAsset, query: string): boolean {
  if (!query) return true;
  return [
    asset.id,
    asset.label ?? "",
    asset.owning_book_name,
    asset.prompt ?? "",
  ].some((value) => value.toLowerCase().includes(query));
}

export async function searchLibraryAssets(
  books: BookManager,
  input: {
    query?: string;
    referenceId?: string;
    referenceRange?: PreparedSearchOptions["range"];
    kinds: MediaCellType[];
    limit?: number;
    offset?: number;
  },
): Promise<LibraryAssetSearchResult> {
  await books.ready();
  const query = input.query?.trim().toLowerCase() ?? "";
  const requested = new Set(input.kinds);
  const prepared = input.referenceId
    ? searchReferenceStore.get(input.referenceId).reference
    : undefined;
  const artifactKinds = [
    ...(requested.has("audio") ? ["audio" as const] : []),
    ...(requested.has("image") ? ["image" as const] : []),
    ...(requested.has("video") ? ["video" as const, "final" as const] : []),
  ];
  const summaries = books.list({ sort: "newest" });
  const results = await Promise.allSettled(
    summaries.map(async (summary) => {
      const book = books.get(summary.bookId);
      if (!book.ok) throw new Error(book.error.message);
      const engine = book.value.engine;
      const builtAssets = await engine.withLocalMedia(() => buildAssetList(
        engine,
        summary.bookId,
        "newest",
      ));
      const assets = builtAssets
        .filter((asset) =>
          asset.status === "ready"
          && kindMatches(requested, asset.type))
        .map((asset): LibraryAsset => ({
          ...asset,
          owning_book_id: summary.bookId,
          owning_book_name: summary.name,
        }));
      let hits: SearchHit[] = [];
      let searchError: string | undefined;
      let preparationJob: { bookId: string; jobId: number } | undefined;
      if (query || prepared) {
        registerLocalClipSearchProvider(engine);
        const searchQuery = {
          ...(query ? { text: query } : {}),
          modalities: query
            ? ["visual" as const, "metadata" as const]
            : ["visual" as const],
          artifactKinds,
          limit: 100,
        };
        const result = prepared
          ? await engine.temporalSearch.queryPrepared(
              searchQuery,
              prepared,
              input.referenceRange ? { range: input.referenceRange } : {},
            )
          : await engine.temporalSearch.query(searchQuery);
        if (result.ok) {
          hits = result.value.hits;
        } else if (result.error.code === "NOT_READY" && result.error.details?.requiresIndexPreparation) {
          preparationJob = await enqueueTemporalSearchPreparation(summary.bookId);
        } else {
          searchError = result.error.message;
        }
      }
      return { assets, hits, searchError, preparationJob };
    }),
  );
  const errors: LibraryAssetSearchResult["books_with_errors"] = [];
  const assets: LibraryAsset[] = [];
  const semanticHits: Array<{
    key: string;
    hit: SearchHit;
  }> = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      assets.push(...result.value.assets);
      semanticHits.push(
        ...result.value.hits.map((hit) => ({
          key: `${summaries[index]?.bookId ?? "unknown"}:${hit.artifactId}`,
          hit,
        })),
      );
      if (result.value.searchError) {
        errors.push({
          book_id: summaries[index]?.bookId ?? "unknown",
          message: result.value.searchError,
        });
      }
      return;
    }
    const book = summaries[index];
    errors.push({
      book_id: book?.bookId ?? "unknown",
      message: result.reason instanceof Error
        ? result.reason.message
        : String(result.reason),
    });
  });
  const metadataRank = new Map(
    assets
      .filter((asset) => !prepared && matchesQuery(asset, query))
      .sort((left, right) => {
        const rank = searchRank(left, query) - searchRank(right, query);
        if (rank !== 0) return rank;
        const created = Date.parse(right.created_at) - Date.parse(left.created_at);
        return created !== 0
          ? created
          : left.artifact_id.localeCompare(right.artifact_id);
      })
      .map((asset, index) => [
        `${asset.owning_book_id}:${asset.artifact_id}`,
        index + 1,
      ]),
  );
  semanticHits.sort((left, right) =>
    comparableHitScore(right.hit) - comparableHitScore(left.hit)
    || left.key.localeCompare(right.key));
  const semanticRank = new Map<string, number>();
  const semanticMatch = new Map<string, SearchHit>();
  for (const item of semanticHits) {
    if (semanticRank.has(item.key)) continue;
    semanticRank.set(item.key, semanticRank.size + 1);
    semanticMatch.set(item.key, item.hit);
  }
  const ranked = assets
    .flatMap((asset) => {
      const key = `${asset.owning_book_id}:${asset.artifact_id}`;
      const metadata = metadataRank.get(key);
      const semantic = semanticRank.get(key);
      if ((query || prepared) && metadata === undefined && semantic === undefined) {
        return [];
      }
      const hit = semanticMatch.get(key);
      return [{
        asset: hit
          ? {
              ...asset,
              search_match: {
                score: comparableHitScore(hit),
                location: hit.location,
              },
            }
          : asset,
        score:
          (metadata === undefined ? 0 : 1 / (60 + metadata))
          + (semantic === undefined ? 0 : 1 / (60 + semantic)),
      }];
    })
    .sort((left, right) => {
      const rank = right.score - left.score;
      if (rank !== 0) return rank;
      const created =
        Date.parse(right.asset.created_at) - Date.parse(left.asset.created_at);
      return created !== 0
        ? created
        : left.asset.artifact_id.localeCompare(right.asset.artifact_id);
    })
    .map((item) => item.asset);
  if (!query && !prepared) {
    ranked.sort((left, right) => {
      const created = Date.parse(right.created_at) - Date.parse(left.created_at);
      return created !== 0
        ? created
        : left.artifact_id.localeCompare(right.artifact_id);
    });
  }
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 50;
  const page = ranked.slice(offset, offset + limit);
  return {
    assets: page,
    preparationJobs: results.flatMap((result) =>
      result.status === "fulfilled" && result.value.preparationJob
        ? [result.value.preparationJob]
        : []),
    page: {
      offset,
      limit,
      total: ranked.length,
      hasMore: offset + page.length < ranked.length,
    },
    books_with_errors: errors,
  };
}

export async function resolveBookReference(
  books: BookManager,
  reference: string,
): Promise<ManagedBook> {
  await books.ready();
  const byId = books.get(reference);
  if (byId.ok) return byId.value;
  const byName = books.getByName(reference);
  if (byName.ok) return byName.value;
  throw new Error(`Book not found: ${reference}`);
}

function copyableFile(name: string): boolean {
  return !name.endsWith(".part")
    && !name.endsWith(".tmp")
    && name !== "error.json"
    && !name.endsWith("/error.json");
}

async function copyArtifactFiles(
  source: Engine,
  target: Engine,
  sourceArtifact: Artifact,
  targetArtifact: Artifact,
): Promise<void> {
  const sourceManifest = await source.files.manifest(
    sourceArtifact.artifactId,
    { includeDotfiles: true },
  );
  if (!sourceManifest.ok) throw new Error(sourceManifest.error.message);
  const files = sourceManifest.value.files.filter((file) =>
    copyableFile(file.name));
  for (const file of files) {
    const sourcePath = join(
      sourceManifest.value.path,
      ...file.name.split("/"),
    );
    const written = await target.files.writeFromPath(
      targetArtifact.artifactId,
      file.name,
      sourcePath,
    );
    if (!written.ok) throw new Error(written.error.message);
  }
  const targetManifest = await target.files.manifest(
    targetArtifact.artifactId,
    { includeDotfiles: true },
  );
  if (!targetManifest.ok) throw new Error(targetManifest.error.message);
  const targetHashes = new Map(
    targetManifest.value.files.map((file) => [file.name, file.objectHash]),
  );
  for (const file of files) {
    if (targetHashes.get(file.name) !== file.objectHash) {
      throw new Error(`Copied file hash mismatch: ${file.name}`);
    }
  }
}

async function copyArtifactMetadata(
  source: Engine,
  target: Engine,
  sourceArtifact: Artifact,
  targetArtifact: Artifact,
  sourceBookId: string,
): Promise<void> {
  const original = await source.metadata.artifacts.read<Record<string, unknown>>(
    sourceArtifact.artifactId,
    "original",
  );
  const metadata = {
    ...(original.ok ? original.value : {}),
    origin: "library-copy",
    source_book_id: sourceBookId,
    source_artifact_id: sourceArtifact.artifactId,
  };
  const written = await target.metadata.artifacts.write(
    targetArtifact.artifactId,
    "original",
    metadata,
  );
  if (!written.ok) throw new Error(written.error.message);
  const waveform = await source.metadata.waveforms.read(
    sourceArtifact.artifactId,
  );
  if (waveform.ok) {
    const waveformWrite = await target.metadata.waveforms.write(
      targetArtifact.artifactId,
      waveform.value.peaks,
    );
    if (!waveformWrite.ok) throw new Error(waveformWrite.error.message);
  }
  const streams = source.streams.list(sourceArtifact.artifactId);
  if (!streams.ok) throw new Error(streams.error.message);
  for (const stream of streams.value) {
    const registered = await target.streams.register({
      artifactId: targetArtifact.artifactId,
      sourcePath: stream.sourcePath,
      objectHash: stream.objectHash,
      streamIndex: stream.streamIndex,
      kind: stream.kind,
      timeBase: stream.timeBase,
      durationTicks: stream.durationTicks,
      codec: stream.codec,
      ...(stream.video ? { video: stream.video } : {}),
      ...(stream.audio ? { audio: stream.audio } : {}),
    });
    if (!registered.ok) throw new Error(registered.error.message);
  }
}

async function deleteCopiedArtifact(
  engine: Engine,
  artifactId: string,
): Promise<string | null> {
  const deleted = await engine.artifacts.delete(artifactId);
  return deleted.ok ? null : deleted.error.message;
}

export async function copyLibraryAsset(
  books: BookManager,
  input: CopyLibraryAssetInput,
): Promise<CopiedLibraryAsset> {
  if (input.sourceBookId === input.targetBookId) {
    throw new Error("Source and target books must be different");
  }
  const sourceBook = await resolveBookReference(books, input.sourceBookId);
  const targetBook = await resolveBookReference(books, input.targetBookId);
  if (sourceBook.bookId === targetBook.bookId) {
    throw new Error("Source and target books must be different");
  }
  const sourceArtifactResult = sourceBook.engine.artifacts.get(
    input.sourceArtifactId,
  );
  if (!sourceArtifactResult.ok) {
    throw new Error(sourceArtifactResult.error.message);
  }
  const sourceArtifact = sourceArtifactResult.value;
  if (
    sourceArtifact.kind !== "audio"
    && sourceArtifact.kind !== "image"
    && sourceArtifact.kind !== "video"
    && sourceArtifact.kind !== "final"
  ) {
    throw new Error(`Artifact kind is not reusable media: ${sourceArtifact.kind}`);
  }
  const targetKind: ArtifactKind = sourceArtifact.kind === "final"
    ? "video"
    : sourceArtifact.kind;
  const label = input.newName ?? sourceArtifact.label;
  const created = await targetBook.engine.artifacts.create({
    kind: targetKind,
    ...(label ? { label } : {}),
  });
  if (!created.ok) throw new Error(created.error.message);
  const targetArtifact = created.value;
  let lease: { ownerId: string } | null = null;
  try {
    await copyArtifactFiles(
      sourceBook.engine,
      targetBook.engine,
      sourceArtifact,
      targetArtifact,
    );
    await copyArtifactMetadata(
      sourceBook.engine,
      targetBook.engine,
      sourceArtifact,
      targetArtifact,
      sourceBook.bookId,
    );
    lease = targetBook.engine.jobs.artifactWork.begin(
      targetArtifact.artifactId,
      {
        kind: "upload",
        ownerKind: "job",
        durationMs: 15 * 60_000,
      },
    );
    if (!lease) {
      throw new Error("Could not claim the copied Library artifact");
    }
    if (
      !targetBook.engine.jobs.artifactWork.complete(
        targetArtifact.artifactId,
        lease.ownerId,
      )
    ) {
      throw new Error("Could not complete the copied Library artifact");
    }
    return {
      sourceBookId: sourceBook.bookId,
      sourceArtifactId: sourceArtifact.artifactId,
      targetBookId: targetBook.bookId,
      targetArtifactId: targetArtifact.artifactId,
    };
  } catch (cause) {
    if (lease) {
      await targetBook.engine.jobs.artifactWork.fail(
        targetArtifact.artifactId,
        lease.ownerId,
        {
          message: cause instanceof Error ? cause.message : String(cause),
        },
      );
    }
    const cleanupError = await deleteCopiedArtifact(
      targetBook.engine,
      targetArtifact.artifactId,
    );
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      cleanupError
        ? `${message}; orphan ${targetArtifact.artifactId}: ${cleanupError}`
        : message,
    );
  }
}

function assertAttachableCell(
  document: NotebookDocument,
  input: AttachLibraryAssetInput,
  artifact: Artifact,
): void {
  const cell = assertMediaCell(document, input.cellId);
  const currentOutput = cell.outputArtifactId ?? null;
  if (currentOutput !== input.expectedOutputArtifactId) {
    throw new Error("The media slot changed while the Library asset was copying");
  }
  if (document.edges.some((edge) => edge.target === input.cellId)) {
    throw new Error("The media slot was connected while the Library asset was copying");
  }
  if (!compatibleArtifact(cell, artifact)) {
    throw new Error(
      `A ${cell.type} cell cannot use a ${artifact.kind} artifact`,
    );
  }
}

export async function copyAndAttachLibraryAsset(
  books: BookManager,
  input: AttachLibraryAssetInput,
): Promise<AttachedLibraryAsset> {
  const sourceBook = await resolveBookReference(books, input.sourceBookId);
  const targetBook = await resolveBookReference(books, input.targetBookId);
  const sourceArtifact = sourceBook.engine.artifacts.get(input.sourceArtifactId);
  if (!sourceArtifact.ok) throw new Error(sourceArtifact.error.message);
  const before = targetBook.engine.notebooks.read(input.notebookId);
  if (!before.ok) throw new Error(before.error.message);
  assertAttachableCell(before.value, input, sourceArtifact.value);
  const copied = await copyLibraryAsset(books, input);
  const targetArtifact = targetBook.engine.artifacts.get(
    copied.targetArtifactId,
  );
  if (!targetArtifact.ok) {
    await deleteCopiedArtifact(
      targetBook.engine,
      copied.targetArtifactId,
    );
    throw new Error(targetArtifact.error.message);
  }
  try {
    const result = await mutateNotebook(
      targetBook.engine,
      input.notebookId,
      "attach_library_asset",
      (notebook) => {
        assertAttachableCell(notebook, input, targetArtifact.value);
        return bindMediaSlot(notebook, input.cellId, targetArtifact.value);
      },
      {
        sourceBookId: copied.sourceBookId,
        sourceArtifactId: copied.sourceArtifactId,
        targetArtifactId: copied.targetArtifactId,
        cellId: input.cellId,
      },
    );
    if (!result.ok) throw new Error(result.error.message);
    return {
      ...copied,
      notebookId: input.notebookId,
      cellId: input.cellId,
      revision: result.value.hash,
    };
  } catch (cause) {
    const cleanupError = await deleteCopiedArtifact(
      targetBook.engine,
      copied.targetArtifactId,
    );
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      cleanupError
        ? `${message}; orphan ${copied.targetArtifactId}: ${cleanupError}`
        : message,
    );
  }
}
