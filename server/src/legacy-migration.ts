import { lstat, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  createEngine,
  dryRunV4Migration,
  isUuidV7,
  migrateV4,
  type Engine,
  type EngineError,
  type Job,
  type QueueRunner,
  type Result,
  type V4MigrationDryRun,
  type V4MigrationRequest,
  type V4MigrationResult,
} from "videobook-engine";
import type { ManagedBook } from "./book-manager.js";

type MigrationPhase = "copying" | "switching" | "indexing" | "complete";
export type MigrationCheckpoint = "copying" | "prepared" | "archived" | "published" | "indexed";
export type MigrationOptions = Pick<V4MigrationRequest, "expectedMigrationKey" | "signal" | "onProgress" | "ffprobePath">;

export interface MigratedBook {
  book: Omit<ManagedBook, "engine" | "rootDir">;
  migration: V4MigrationResult;
  legacyArchiveRoot: string;
  reindexJobIds: number[];
}

interface MigrationRecord {
  format: 1;
  bookId: string;
  sourceHead: string;
  migrationKey: string;
  phase: MigrationPhase;
  jobId?: number;
  queueRequested?: boolean;
  progress?: Parameters<NonNullable<V4MigrationRequest["onProgress"]>>[0];
  receipt?: V4MigrationResult;
  result?: MigratedBook;
}

interface MigrationHost {
  libraryDir: string;
  legacy(bookId: string): V4MigrationDryRun | undefined;
  existing(bookId: string): Engine | undefined;
  open(root: string): Engine;
  adopt(engine: Engine, root: string, bookId: string): ManagedBook;
  checkpoint?: (phase: MigrationCheckpoint) => void | Promise<void>;
  published?: (bookId: string) => Promise<void>;
  leaseMs?: number;
}

class MigrationFault extends Error {
  readonly code: EngineError["code"];
  constructor(code: EngineError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = code;
  }
}

export function migrationFailure(cause: unknown): EngineError {
  return { code: cause instanceof MigrationFault ? cause.code : "IO_ERROR",
    message: cause instanceof Error ? cause.message : String(cause) };
}

function value<T>(result: Result<T, EngineError>): T {
  if (!result.ok) throw new MigrationFault(result.error.code, result.error.message);
  return result.value;
}

async function directoryExists(root: string): Promise<boolean> {
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MigrationFault("INVALID_INPUT", `Expected a plain migration directory: ${root}`);
    return true;
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

export class LegacyMigrationQueue {
  private readonly host: MigrationHost;
  private enginePromise: Promise<Engine> | null = null;
  private runner: QueueRunner | null = null;
  private stopping = new AbortController();
  private submissionTail: Promise<unknown> = Promise.resolve();
  private recordTail: Promise<unknown> = Promise.resolve();
  private controlTail: Promise<unknown> = Promise.resolve();
  private workTail: Promise<unknown> = Promise.resolve();

  constructor(host: MigrationHost) { this.host = host; }

  private get root(): string { return join(this.host.libraryDir, ".migration-runtime"); }

  private async engine(): Promise<Engine> {
    if (!this.enginePromise) this.enginePromise = (async () => {
      await directoryExists(this.root);
      const engine = createEngine({ rootDir: this.root, initialBookName: "Library migrations" });
      try { await engine.ready; return engine; }
      catch (cause) { engine.close(); throw cause; }
    })();
    return this.enginePromise;
  }

  private paths(record: MigrationRecord) {
    this.validateIdentity(record.bookId, record.migrationKey);
    const suffix = `${record.bookId}-${record.migrationKey.slice(7)}`;
    return { source: join(this.host.libraryDir, record.bookId),
      candidate: join(this.host.libraryDir, `.migrating-${suffix}`),
      archive: join(this.host.libraryDir, ".legacy-v4", suffix) };
  }

  private validateIdentity(bookId: string, migrationKey: string): void {
    if (!isUuidV7(bookId) || !/^sha256:[a-f0-9]{64}$/.test(migrationKey)) {
      throw new MigrationFault("INVALID_INPUT", "Migration requires a book ID and the confirmed migration key");
    }
  }

  private async read(bookId: string): Promise<MigrationRecord | undefined> {
    const result = await (await this.engine()).metadata.book.read<MigrationRecord>(`legacyMigration.${bookId}`);
    if (!result.ok && result.error.code === "NOT_FOUND") return undefined;
    const record = value(result);
    if (record.format !== 1 || record.bookId !== bookId) throw new MigrationFault("STORAGE_ERROR", "Invalid migration recovery record");
    this.validateIdentity(record.bookId, record.migrationKey);
    return record;
  }

  private async write(record: MigrationRecord): Promise<void> {
    value(await (await this.engine()).metadata.book.write(`legacyMigration.${record.bookId}`, record));
  }

  private async records(): Promise<MigrationRecord[]> {
    const index = await (await this.engine()).metadata.book.read<string[]>("legacyMigrationBooks");
    if (!index.ok && index.error.code === "NOT_FOUND") return [];
    const ids = value(index);
    if (!Array.isArray(ids) || !ids.every(isUuidV7)) throw new MigrationFault("STORAGE_ERROR", "Invalid migration recovery index");
    const records: MigrationRecord[] = [];
    for (const id of ids) {
      const record = await this.read(id);
      if (record) records.push(record);
    }
    return records;
  }

  private initialize(bookId: string, sourceHead: string, migrationKey: string): Promise<MigrationRecord> {
    const operation = this.recordTail.then(() => this.initializeOnce(bookId, sourceHead, migrationKey));
    this.recordTail = operation.catch(() => {});
    return operation;
  }

  private async initializeOnce(bookId: string, sourceHead: string, migrationKey: string): Promise<MigrationRecord> {
    this.validateIdentity(bookId, migrationKey);
    const existing = await this.read(bookId);
    if (existing?.migrationKey === migrationKey && existing.sourceHead === sourceHead) return existing;
    if (existing?.phase === "complete" || existing?.phase === "switching" || existing?.phase === "indexing") {
      throw new MigrationFault("ALREADY_EXISTS", "Book already has a confirmed migration to recover");
    }
    const engine = await this.engine();
    const previousJob = existing?.jobId === undefined ? null : engine.jobs.queue.get(existing.jobId);
    if (previousJob && ["queued", "running", "completing"].includes(previousJob.state)) {
      throw new MigrationFault("ALREADY_EXISTS", "A migration is already active for this book");
    }
    const legacy = this.host.legacy(bookId);
    if (!legacy) throw new MigrationFault("NOT_FOUND", `Legacy book not found: ${bookId}`);
    if (legacy.sourceHeadRevision !== sourceHead || legacy.migrationKey !== migrationKey) {
      throw new MigrationFault("STALE_REVISION", "Legacy book changed after migration confirmation");
    }
    const index = await engine.metadata.book.read<string[]>("legacyMigrationBooks");
    if (!index.ok && index.error.code !== "NOT_FOUND") value<string[]>(index);
    const ids = index.ok ? index.value : [];
    if (!ids.includes(bookId)) value(await engine.metadata.book.write("legacyMigrationBooks", [...ids, bookId]));
    const record: MigrationRecord = { format: 1, bookId, sourceHead, migrationKey, phase: "copying" };
    await this.write(record);
    return record;
  }

  async status(bookId: string, migrationKey: string) {
    this.validateIdentity(bookId, migrationKey);
    if (!await directoryExists(this.root)) throw new MigrationFault("NOT_FOUND", "Migration was not found");
    const record = await this.read(bookId);
    if (!record || record.migrationKey !== migrationKey) throw new MigrationFault("NOT_FOUND", "Migration was not found");
    const job = record.jobId === undefined ? null : (await this.engine()).jobs.queue.get(record.jobId);
    return { bookId, migrationKey, phase: record.phase, progress: record.progress ?? null,
      job, result: record.result ?? null };
  }

  enqueue(bookId: string, sourceHead: string, migrationKey: string) {
    const operation = this.submissionTail.then(async () => {
      const record = await this.initialize(bookId, sourceHead, migrationKey);
      if (record.phase === "complete") await this.verifyCompleted(record);
      const engine = await this.engine();
      const job = record.jobId === undefined ? null : engine.jobs.queue.get(record.jobId);
      if (record.phase !== "complete" && (!job || job.state === "failed" || job.state === "aborted")) {
        await this.write({ ...record, queueRequested: true });
        const queued = engine.jobs.queue.enqueue({ type: "migrate_legacy_book", maxAttempts: 3,
          dedupeKey: `migrate:${bookId}:${migrationKey}`, payload: { bookId, sourceHead, migrationKey } });
        await this.write({ ...record, queueRequested: true, jobId: queued.job.id });
      }
      await this.start();
      return this.status(bookId, migrationKey);
    });
    this.submissionTail = operation.catch(() => {});
    return operation;
  }

  private control<T>(run: () => Promise<T>): Promise<T> {
    const operation = this.controlTail.then(run);
    this.controlTail = operation.catch(() => {});
    return operation;
  }

  cancel(bookId: string, migrationKey: string) {
    return this.control(async () => {
      const status = await this.status(bookId, migrationKey);
      if (status.phase !== "copying") throw new MigrationFault("INVALID_INPUT", "Migration has begun its final switch and cannot be cancelled");
      if (!status.job || !await (await this.engine()).jobs.queue.abort(status.job.id, "Migration cancelled by user")) {
        throw new MigrationFault("INVALID_INPUT", "Migration is not active");
      }
      return this.status(bookId, migrationKey);
    });
  }

  async restoreInterruptedArchives(): Promise<void> {
    if (!await directoryExists(this.root)) return;
    await directoryExists(join(this.host.libraryDir, ".legacy-v4"));
    for (const record of await this.records()) {
      if (record.phase !== "switching" || !record.receipt) continue;
      const roots = this.paths(record);
      if (await directoryExists(roots.source) || !await directoryExists(roots.archive)) continue;
      this.verifySource(roots.archive, record);
      await rename(roots.archive, roots.source);
    }
  }

  async startIfPresent(): Promise<void> {
    if (await directoryExists(this.root)) await this.start();
  }

  private async start(): Promise<void> {
    if (this.runner) return;
    const engine = await this.engine();
    for (const record of await this.records()) {
      if (!record.queueRequested || record.phase === "complete" || record.jobId !== undefined) continue;
      const queued = engine.jobs.queue.enqueue({ type: "migrate_legacy_book", maxAttempts: 3,
        dedupeKey: `migrate:${record.bookId}:${record.migrationKey}`,
        payload: { bookId: record.bookId, sourceHead: record.sourceHead, migrationKey: record.migrationKey } });
      await this.write({ ...record, jobId: queued.job.id });
    }
    await engine.jobs.queue.reap();
    this.runner = engine.jobs.queue.createRunner({ concurrency: 1,
      leaseMs: this.host.leaseMs ?? 30_000, pollIntervalMs: 50, reapIntervalMs: 500,
      resolveHandler: (type) => type === "migrate_legacy_book" ? async (job: Job, signal?: AbortSignal) => {
        const { FFPROBE } = await import("./ffmpeg.js");
        return this.perform(String(job.payload.bookId), String(job.payload.sourceHead), {
          expectedMigrationKey: String(job.payload.migrationKey), ffprobePath: FFPROBE,
          signal: signal ? AbortSignal.any([signal, this.stopping.signal]) : this.stopping.signal,
        });
      } : null });
    this.runner.start();
  }

  async close(): Promise<void> {
    this.stopping.abort();
    await this.submissionTail;
    await this.runner?.stop();
    await this.workTail;
    await this.controlTail;
    if (this.enginePromise) (await this.enginePromise).close();
    this.enginePromise = null;
    this.runner = null;
    this.stopping = new AbortController();
  }

  perform(bookId: string, sourceHead: string, options: MigrationOptions): Promise<MigratedBook> {
    const operation = this.workTail.then(() => this.performOnce(bookId, sourceHead, options));
    this.workTail = operation.catch(() => {});
    return operation;
  }

  private verifySource(root: string, record: MigrationRecord): void {
    const source = value(dryRunV4Migration(root));
    if (source.sourceBookId !== record.bookId || source.sourceHeadRevision !== record.sourceHead || source.migrationKey !== record.migrationKey) {
      throw new MigrationFault("STALE_REVISION", "Legacy source changed after migration confirmation");
    }
    const blocking = source.issues.find((issue) => issue.severity === "error");
    if (blocking) throw new MigrationFault(
      blocking.code === "MISSING_OBJECT" || blocking.code === "CORRUPT_OBJECT" ? "OBJECT_UNAVAILABLE" : "INVALID_INPUT",
      blocking.message,
    );
  }

  private async verifyCompleted(record: MigrationRecord): Promise<void> {
    const engine = this.host.existing(record.bookId);
    if (!engine) throw new MigrationFault("STORAGE_ERROR", "The completed migration is no longer present in the library");
    this.verifySource(this.paths(record).archive, record);
    await this.verifyDestination(engine, record);
  }

  private async verifyDestination(engine: Engine, record: MigrationRecord): Promise<void> {
    const receipt = record.receipt;
    if (!receipt || receipt.destinationBookId !== record.bookId || receipt.migrationKey !== record.migrationKey) {
      throw new MigrationFault("STORAGE_ERROR", "Migration receipt does not match the confirmed source");
    }
    const audit = value(await engine.metadata.book.read<{ migrationKey: string; reportArtifactId: string }>(
      `migration.${record.migrationKey.replaceAll(":", ".")}`));
    const report = JSON.parse(value(await engine.files.read(receipt.reportArtifactId, "migration-report.json")).toString());
    if (engine.book.get().bookId !== record.bookId || audit.migrationKey !== record.migrationKey
      || audit.reportArtifactId !== receipt.reportArtifactId || report.migrationKey !== record.migrationKey
      || !engine.history.resolveRevision(receipt.importActionId) || !engine.history.resolveRevision(receipt.destinationRevision)) {
      throw new MigrationFault("STORAGE_ERROR", "Migrated catalog does not match its recovery record");
    }
  }

  private async performOnce(bookId: string, sourceHead: string, options: MigrationOptions): Promise<MigratedBook> {
    await this.submissionTail;
    const existing = await this.read(bookId);
    const key = options.expectedMigrationKey ?? this.host.legacy(bookId)?.migrationKey ?? existing?.migrationKey ?? "";
    let record = await this.initialize(bookId, sourceHead, key);
    if (record.result && record.phase === "complete") { await this.verifyCompleted(record); return record.result; }
    const roots = this.paths(record);
    let engine: Engine | undefined;
    let adopted = false;
    let ownsEngine = false;
    try {
      await directoryExists(join(this.host.libraryDir, ".legacy-v4"));
      await directoryExists(roots.source);
      if (!await directoryExists(roots.archive)) {
        if (options.signal?.aborted) throw new MigrationFault("CANCELLED", "Migration cancelled");
        this.verifySource(roots.source, record);
        await this.host.checkpoint?.("copying");
        let progressTail: Promise<void> = Promise.resolve();
        let progressError: unknown;
        let lastProgressAt = 0;
        let lastPhase = "";
        const migrated = await migrateV4({ ...options, sourceRoot: roots.source, destinationRoot: roots.candidate,
          dryRun: false, expectedSourceBookId: bookId, expectedSourceHead: sourceHead, expectedMigrationKey: key,
          onProgress: (progress) => {
            options.onProgress?.(progress);
            if (progress.phase === lastPhase && progress.completed !== progress.total && Date.now() - lastProgressAt < 1_000) return;
            lastProgressAt = Date.now(); lastPhase = progress.phase;
            record = { ...record, progress };
            const snapshot = record;
            progressTail = progressTail.then(() => this.write(snapshot)).catch((cause: unknown) => { progressError ??= cause; });
          } });
        await progressTail;
        if (progressError) throw progressError;
        const result = value(migrated);
        if (!("destinationBookId" in result)) throw new MigrationFault("STORAGE_ERROR", "Migration result is incomplete");
        record = { ...record, receipt: result };
        engine = this.host.open(roots.candidate);
        ownsEngine = true;
        await engine.ready;
        await this.verifyDestination(engine, record);
        const { prepareMigrationStreams } = await import("./migration-media.js");
        await prepareMigrationStreams(engine, options.signal);
        const { ensureGenerationMediaOutputs } = await import("./notebook-cell-outputs.js");
        for (const notebook of engine.notebooks.list()) {
          const original = value(engine.notebooks.read(notebook.id));
          const normalized = ensureGenerationMediaOutputs(engine, original);
          if (normalized !== original) value(await engine.notebooks.write(normalized));
        }
        value(await engine.metadata.book.write("legacySource", { bookId, sourceHeadRevision: sourceHead,
          migrationKey: key, archiveRoot: roots.archive, importActionId: result.importActionId,
          reportArtifactId: result.reportArtifactId }));
        engine.close(); engine = undefined; ownsEngine = false;
        this.verifySource(roots.source, record);
        await this.control(async () => {
          if (options.signal?.aborted) throw new MigrationFault("CANCELLED", "Migration cancelled before switch");
          record = { ...record, phase: "switching" };
          await this.write(record);
        });
        await this.host.checkpoint?.("prepared");
        await directoryExists(join(this.host.libraryDir, ".legacy-v4"));
        await mkdir(join(this.host.libraryDir, ".legacy-v4"), { recursive: true });
        if (await directoryExists(roots.archive)) throw new MigrationFault("ALREADY_EXISTS", "Legacy archive already exists");
        this.verifySource(roots.source, record);
        await rename(roots.source, roots.archive);
        await this.host.checkpoint?.("archived");
        await rename(roots.candidate, roots.source);
        await this.host.checkpoint?.("published");
      }
      if (!await directoryExists(roots.source) || await directoryExists(roots.candidate)) {
        throw new MigrationFault("STORAGE_ERROR", "Migration switch is incomplete; restart the library to recover the source");
      }
      this.verifySource(roots.archive, record);
      engine = this.host.existing(bookId);
      if (!engine) { engine = this.host.open(roots.source); ownsEngine = true; }
      await engine.ready;
      await this.verifyDestination(engine, record);
      record = { ...record, phase: "indexing" };
      await this.write(record);
      const managed = this.host.adopt(engine, roots.source, bookId);
      adopted = true;
      const reindexJobIds: number[] = [];
      for (const artifact of engine.artifacts.list()) {
        if (!["image", "video", "audio", "final"].includes(artifact.kind)) continue;
        const queued = engine.jobs.queue.enqueue({ type: "semantic_index", artifactId: null,
          externalTaskId: `migration:${key}:${artifact.artifactId}`, maxAttempts: 3,
          payload: { type: "semantic_index", bookId, assetId: artifact.artifactId, migration: true } });
        reindexJobIds.push(queued.job.id);
      }
      await this.host.checkpoint?.("indexed");
      const result: MigratedBook = {
        book: { bookId: managed.bookId, name: managed.name, createdAt: managed.createdAt,
          artifactCount: managed.artifactCount, notebookCount: managed.notebookCount },
        migration: record.receipt!, legacyArchiveRoot: roots.archive, reindexJobIds,
      };
      await this.host.published?.(bookId);
      await this.write({ ...record, phase: "complete", result });
      return result;
    } catch (cause) {
      if (!await directoryExists(roots.source) && await directoryExists(roots.archive)) {
        this.verifySource(roots.archive, record);
        await rename(roots.archive, roots.source);
      }
      if (record.phase === "switching" && !await directoryExists(roots.archive)) {
        await this.write({ ...record, phase: "copying" });
      }
      throw cause;
    } finally { if (ownsEngine && !adopted) engine?.close(); }
  }
}
