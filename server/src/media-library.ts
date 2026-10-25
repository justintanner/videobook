import { join } from "node:path";
import type {
  Artifact,
  ArtifactKind,
  Engine,
  NotebookCell,
  NotebookDocument,
  PreparedSearchOptions,
  PreparedSearchReference,
  EngineError,
  Result,
  SearchHit,
} from "videobook-engine";
import type { BookManager, ManagedBook } from "./book-manager.js";
import { registerLocalClipSearchProvider } from "./local-search-models.js";
import { enqueueTemporalSearchPreparation } from "./jobs/prepare-temporal-search.js";
import { enqueueSearchIndex } from "./jobs/enqueue-search-index.js";
import { missingVisualIndexes } from "./search-index-coverage.js";
import { markDescendantsStale } from "./notebook-action-catalog.js";
import { mutateNotebook } from "./notebook-mutations.js";
import { searchReferenceStore } from "./search-reference-store.js";
import { comparableHitScore } from "./search-scoring.js";
import {
  projectLibraryAsset,
  readLibraryCandidates,
  type LibraryAssetRow,
  type LibraryCandidate,
} from "./library-asset-projection.js";
import { assetRecency, readAssetUsage, recordAssetUse } from "./asset-usage.js";
import {
  tagFacetCounts,
  transferAssetTags,
  type AssetTagFilter,
  type TagFacetCountRecord,
} from "./asset-tags.js";
import {
  addStatusCounts,
  countBrowseStatuses,
  emptyStatusCounts,
  matchesBrowseStatus,
  pageLibraryAssets,
  type LibraryBrowseStatus,
  type LibraryStatusCounts,
} from "./library-browse.js";

type MediaCellType = "audio" | "image" | "video";

interface LibraryAsset extends LibraryAssetRow {
  owning_book_id: string;
  owning_book_name: string;
  last_used_at: string | null;
  search_match?: {
    score: number;
    location: SearchHit["location"];
  };
}

interface LibraryAssetSearchResult {
  unindexed_visual_assets: number;
  /** Tag groups present in the filtered result, with distinct asset counts. */
  tag_facets: TagFacetCountRecord[];
  preparationJobs: Array<{ bookId: string; jobId: number }>;
  assets: LibraryAsset[];
  page: {
    offset: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
  status_counts: LibraryStatusCounts;
  books_with_errors: Array<{
    book_id: string;
    message: string;
  }>;
}

type LibraryBook = Pick<ManagedBook, "bookId" | "name">;

interface LibrarySearchInput {
  query?: string;
  referenceId?: string;
  referenceRange?: PreparedSearchOptions["range"];
  kinds: MediaCellType[];
  tags?: AssetTagFilter;
  limit?: number;
  offset?: number;
  browseStatus?: LibraryBrowseStatus;
  indexCoverage?: boolean;
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
  if (resolved) recordAssetUse(engine, resolved.artifactId);
  return {
    cellId: input.cellId,
    outputArtifactId: resolved?.artifactId ?? null,
    revision: result.value.hash,
  };
}

type LibraryEntry = LibraryCandidate & {
  owning_book_id: string;
  owning_book_name: string;
  last_used_at: string | null;
};

type BookSearchResult = {
  entries: LibraryEntry[];
  statusCounts: LibraryStatusCounts;
  hits: SearchHit[];
  searchError?: string;
  preparationJob?: { bookId: string; jobId: number };
  unindexed: number;
};

type LibrarySearchPlan = {
  query: string;
  prepared: PreparedSearchReference | undefined;
  referenceRange: PreparedSearchOptions["range"] | undefined;
  searching: boolean;
  browseStatus: LibraryBrowseStatus;
  candidateKinds: ReadonlySet<ArtifactKind>;
  searchKinds: ArtifactKind[];
  tags: AssetTagFilter | undefined;
  indexCoverage: boolean;
};

function libraryArtifactKinds(requested: ReadonlySet<MediaCellType>): ArtifactKind[] {
  return [
    ...(requested.has("audio") ? ["audio" as const] : []),
    ...(requested.has("image") ? ["image" as const] : []),
    ...(requested.has("video") ? ["video" as const, "final" as const] : []),
  ];
}

function searchRank(
  asset: LibraryEntry,
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

function matchesQuery(asset: LibraryEntry, query: string): boolean {
  if (!query) return true;
  return [
    asset.id,
    asset.label ?? "",
    asset.owning_book_name,
    asset.prompt ?? "",
  ].some((value) => value.toLowerCase().includes(query));
}

function lastUsedAt(usedAt: number | undefined): string | null {
  return usedAt === undefined ? null : new Date(usedAt).toISOString();
}

function libraryAssetRecency(asset: LibraryEntry): number {
  const used = asset.last_used_at ? Date.parse(asset.last_used_at) : undefined;
  return assetRecency(asset.created_at, used);
}

function compareRecentlyUsed(left: LibraryEntry, right: LibraryEntry): number {
  const recency = libraryAssetRecency(right) - libraryAssetRecency(left);
  if (recency !== 0) return recency;
  const created = Date.parse(right.created_at) - Date.parse(left.created_at);
  return created !== 0
    ? created
    : left.artifact_id.localeCompare(right.artifact_id);
}

function compareNewest(left: LibraryEntry, right: LibraryEntry): number {
  const created = Date.parse(right.created_at) - Date.parse(left.created_at);
  return created !== 0
    ? created
    : left.artifact_id.localeCompare(right.artifact_id);
}

function entryKey(entry: { owning_book_id: string; artifact_id: string }): string {
  return `${entry.owning_book_id}:${entry.artifact_id}`;
}

async function querySemanticHits(
  engine: Engine,
  plan: LibrarySearchPlan,
  readyEntries: readonly LibraryEntry[],
): Promise<Result<SearchHit[], EngineError>> {
  registerLocalClipSearchProvider(engine);
  const searchQuery = {
    ...(plan.query ? { text: plan.query } : {}),
    modalities: plan.query
      ? ["visual" as const, "metadata" as const]
      : ["visual" as const],
    artifactKinds: plan.searchKinds,
    sourceArtifactIds: readyEntries.map((entry) => entry.artifact_id),
    limit: 100,
  };
  const result = plan.prepared
    ? await engine.temporalSearch.queryPrepared(
        searchQuery,
        plan.prepared,
        plan.referenceRange ? { range: plan.referenceRange } : {},
      )
    : await engine.temporalSearch.query(searchQuery);
  return result.ok ? { ok: true, value: result.value.hits } : result;
}

async function searchBook(
  books: BookManager,
  summary: LibraryBook,
  plan: LibrarySearchPlan,
): Promise<BookSearchResult> {
  const book = books.get(summary.bookId);
  if (!book.ok) throw new Error(book.error.message);
  const engine = book.value.engine;
  const candidates = await engine.withLocalMedia(() => readLibraryCandidates(engine, {
    kinds: plan.candidateKinds,
    ...(plan.tags ? { tags: plan.tags } : {}),
  }));
  const usage = readAssetUsage(engine);
  const eligible = candidates.map((candidate): LibraryEntry => ({
    ...candidate,
    owning_book_id: summary.bookId,
    owning_book_name: summary.name,
    last_used_at: lastUsedAt(usage.get(candidate.artifact_id)),
  }));
  const readyEntries = eligible.filter((entry) => entry.status === "ready");
  const result: BookSearchResult = {
    entries: plan.searching
      ? readyEntries
      : eligible.filter((entry) => matchesBrowseStatus(entry.status, plan.browseStatus)),
    statusCounts: countBrowseStatuses(eligible),
    hits: [],
    unindexed: plan.indexCoverage ? missingVisualIndexes(engine, readyEntries).length : 0,
  };
  if (!plan.searching) return result;
  const hits = await querySemanticHits(engine, plan, readyEntries);
  if (hits.ok) return { ...result, hits: hits.value };
  if (hits.error.code === "NOT_READY" && hits.error.details?.requiresIndexPreparation) {
    return { ...result, preparationJob: await enqueueTemporalSearchPreparation(summary.bookId) };
  }
  return { ...result, searchError: hits.error.message };
}

function rankEntries(
  entries: readonly LibraryEntry[],
  semanticHits: ReadonlyArray<{ key: string; hit: SearchHit }>,
  plan: LibrarySearchPlan,
): Array<{ entry: LibraryEntry; hit: SearchHit | undefined }> {
  if (!plan.searching) {
    return [...entries].sort(compareRecentlyUsed).map((entry) => ({ entry, hit: undefined }));
  }
  const metadataRank = new Map(
    entries
      .filter((entry) => !plan.prepared && matchesQuery(entry, plan.query))
      .sort((left, right) =>
        searchRank(left, plan.query) - searchRank(right, plan.query)
        || compareNewest(left, right))
      .map((entry, index) => [entryKey(entry), index + 1]),
  );
  const sortedHits = [...semanticHits].sort((left, right) =>
    comparableHitScore(right.hit) - comparableHitScore(left.hit)
    || left.key.localeCompare(right.key));
  const semanticRank = new Map<string, number>();
  const semanticMatch = new Map<string, SearchHit>();
  for (const item of sortedHits) {
    if (semanticRank.has(item.key)) continue;
    semanticRank.set(item.key, semanticRank.size + 1);
    semanticMatch.set(item.key, item.hit);
  }
  return entries
    .flatMap((entry) => {
      const key = entryKey(entry);
      const metadata = metadataRank.get(key);
      const semantic = semanticRank.get(key);
      if (metadata === undefined && semantic === undefined) return [];
      return [{
        entry,
        hit: semanticMatch.get(key),
        score:
          (metadata === undefined ? 0 : 1 / (60 + metadata))
          + (semantic === undefined ? 0 : 1 / (60 + semantic)),
      }];
    })
    .sort((left, right) =>
      right.score - left.score || compareNewest(left.entry, right.entry))
    .map(({ entry, hit }) => ({ entry, hit }));
}

async function projectLibraryEntry(
  books: BookManager,
  entry: LibraryEntry,
  hit: SearchHit | undefined,
): Promise<LibraryAsset> {
  const book = books.get(entry.owning_book_id);
  if (!book.ok) throw new Error(book.error.message);
  const engine = book.value.engine;
  const row = await engine.withLocalMedia(() =>
    projectLibraryAsset(engine, entry.owning_book_id, entry));
  return {
    ...row,
    owning_book_id: entry.owning_book_id,
    owning_book_name: entry.owning_book_name,
    last_used_at: entry.last_used_at,
    ...(hit
      ? { search_match: { score: comparableHitScore(hit), location: hit.location } }
      : {}),
  };
}

function librarySearchPlan(input: LibrarySearchInput): LibrarySearchPlan {
  const query = input.query?.trim().toLowerCase() ?? "";
  const prepared = input.referenceId
    ? searchReferenceStore.get(input.referenceId).reference
    : undefined;
  const searching = Boolean(query || prepared);
  const searchKinds = libraryArtifactKinds(new Set(input.kinds));
  return {
    query,
    prepared,
    referenceRange: input.referenceRange,
    searching,
    browseStatus: searching ? "ready" : (input.browseStatus ?? "ready"),
    candidateKinds: new Set<ArtifactKind>(searchKinds),
    searchKinds,
    tags: input.tags,
    indexCoverage: input.indexCoverage ?? searching,
  };
}

export async function searchLibraryAssets(
  books: BookManager,
  input: LibrarySearchInput,
): Promise<LibraryAssetSearchResult> {
  await books.ready();
  const plan = librarySearchPlan(input);
  const summaries = books.list({ sort: "newest" });
  const results = await Promise.allSettled(
    summaries.map((summary) => searchBook(books, summary, plan)),
  );
  const errors: LibraryAssetSearchResult["books_with_errors"] = [];
  const entries: LibraryEntry[] = [];
  let statusCounts = emptyStatusCounts();
  const semanticHits: Array<{ key: string; hit: SearchHit }> = [];
  results.forEach((result, index) => {
    const bookId = summaries[index]?.bookId ?? "unknown";
    if (result.status === "rejected") {
      errors.push({
        book_id: bookId,
        message: result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
      });
      return;
    }
    entries.push(...result.value.entries);
    statusCounts = addStatusCounts(statusCounts, result.value.statusCounts);
    semanticHits.push(...result.value.hits.map((hit) => ({
      key: `${bookId}:${hit.artifactId}`,
      hit,
    })));
    if (result.value.searchError) {
      errors.push({ book_id: bookId, message: result.value.searchError });
    }
  });
  const ranked = rankEntries(entries, semanticHits, plan);
  const paged = pageLibraryAssets(ranked.map(({ entry }) => entry), {
    offset: input.offset ?? 0,
    limit: input.limit ?? 50,
  });
  const offset = input.offset ?? 0;
  const pageHits = ranked.slice(offset, offset + paged.pageAssets.length);
  return {
    assets: await Promise.all(pageHits.map(({ entry, hit }) =>
      projectLibraryEntry(books, entry, hit))),
    tag_facets: tagFacetCounts(paged.matching),
    unindexed_visual_assets: results.reduce((count, result) =>
      count + (result.status === "fulfilled" ? result.value.unindexed : 0), 0),
    preparationJobs: results.flatMap((result) =>
      result.status === "fulfilled" && result.value.preparationJob
        ? [result.value.preparationJob]
        : []),
    page: paged.page,
    status_counts: statusCounts,
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
  const manifest = await target.files.manifest(targetArtifact.artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const copiedHashes = new Map(manifest.value.files.map((file) => [file.name, file.objectHash]));
  for (const stream of streams.value) {
    if (copiedHashes.get(stream.sourcePath) !== stream.objectHash) continue;
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
  const deleted = await engine.artifacts.delete(artifactId, { deleteOwnedMedia: true });
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
    // After the bytes, so the destination engine can validate the source's
    // automatic evidence against the content the copy actually carries.
    await transferAssetTags(
      { engine: sourceBook.engine, artifactId: sourceArtifact.artifactId },
      { engine: targetBook.engine, artifactId: targetArtifact.artifactId },
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
    await enqueueSearchIndex(targetBook.engine, targetArtifact.artifactId);
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
    recordAssetUse(sourceBook.engine, copied.sourceArtifactId);
    recordAssetUse(targetBook.engine, copied.targetArtifactId);
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
