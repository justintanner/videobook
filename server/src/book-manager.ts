import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { logger } from "./logger.js";
import { LegacyMigrationQueue, migrationFailure, type MigratedBook, type MigrationOptions, type MigrationCheckpoint } from "./legacy-migration.js";
import {
  createEngine,
  dryRunV4Migration,
  err,
  isUuidV7,
  ok,
  readV4BookIdentity,
  type ContentStore,
  type Engine,
  type EngineError,
  type Result,
  type V4MigrationDryRun,
} from "videobook-engine";

interface BookSummary {
  bookId: string;
  name: string;
  createdAt: number;
  artifactCount: number;
  notebookCount: number;
}

export interface ManagedBook extends BookSummary {
  rootDir: string;
  engine: Engine;
}

interface LegacyBookSummary extends V4MigrationDryRun {
  slug: string;
}

interface BookManagerOptions {
  migrationLeaseMs?: number;
  onMigrationCheckpoint?: (phase: MigrationCheckpoint) => void | Promise<void>;
  onMigrationPublished?: (bookId: string) => Promise<void>;
  libraryDir: string;
  remoteObjects?: ContentStore;
  objectPrefix?: string;
  catalogBackupUrlTemplate?: string;
  catalogBackupName?: string;
}

interface DeleteBookOptions {
  confirmName: string;
  beforeDelete?: (book: ManagedBook) => Promise<void>;
}

function engineError(
  code: EngineError["code"],
  message: string,
): EngineError {
  return { code, message };
}

function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path !== "" && !path.startsWith(`..${sep}`) && path !== "..";
}

function isSchemaIncompatible(cause: unknown): boolean {
  if (!cause || typeof cause !== "object" || !("error" in cause)) return false;
  const error = (cause as { error?: { code?: unknown } }).error;
  return error?.code === "SCHEMA_INCOMPATIBLE";
}

function sortBooks(
  books: BookSummary[],
  sort: "newest" | "oldest",
): BookSummary[] {
  return [...books].sort((left, right) => (
    sort === "newest"
      ? right.createdAt - left.createdAt
      : left.createdAt - right.createdAt
  ));
}

export class BookManager {
  private readonly migrations: LegacyMigrationQueue;
  private readonly libraryDir: string;
  private readonly options: BookManagerOptions;
  private readonly books = new Map<string, ManagedBook>();
  private readonly legacyBooks = new Map<string, LegacyBookSummary>();
  private readonly knownRoots = new Set<string>();
  private readonly opening = new Map<string, Promise<void>>();
  private scanPromise: Promise<void> | null = null;
  private readyPromise: Promise<void> | null = null;

  constructor(options: BookManagerOptions) {
    this.libraryDir = resolve(options.libraryDir);
    this.options = { ...options, libraryDir: this.libraryDir };
    this.migrations = new LegacyMigrationQueue({
      libraryDir: this.libraryDir,
      legacy: (bookId) => this.legacyBooks.get(bookId),
      existing: (bookId) => this.books.get(bookId)?.engine,
      open: (root) => this.createEngine(root),
      adopt: (engine, root, bookId) => {
        const managed = this.toManagedBook(engine, root, engine.book.get());
        if (managed.bookId !== bookId) throw new Error("Migrated book identity does not match its root");
        if (!this.books.has(bookId)) this.assertUnique(managed);
        this.books.set(bookId, managed);
        this.legacyBooks.delete(bookId);
        this.knownRoots.add(bookId);
        return managed;
      },
      checkpoint: options.onMigrationCheckpoint,
      published: options.onMigrationPublished,
      leaseMs: options.migrationLeaseMs,
    });
  }

  get rootDir(): string {
    return this.libraryDir;
  }

  async ready(): Promise<void> {
    if (!this.readyPromise) this.readyPromise = this.load();
    return this.readyPromise;
  }

  async discover(): Promise<string[]> {
    await this.scan();
    return [...this.knownRoots];
  }

  async ensure(bookId: string): Promise<Result<ManagedBook, EngineError>> {
    await this.scan();
    const existing = this.books.get(bookId);
    if (existing) return ok(existing);
    if (!this.knownRoots.has(bookId)) {
      return err(engineError("NOT_FOUND", `Book not found: ${bookId}`));
    }
    await this.openRoot(bookId);
    const opened = this.books.get(bookId);
    return opened
      ? ok(opened)
      : err(engineError("NOT_FOUND", `Book not found: ${bookId}`));
  }

  list(options: { sort?: "newest" | "oldest" } = {}): BookSummary[] {
    const books = [...this.books.values()].map((book) => this.summary(book));
    return sortBooks(books, options.sort ?? "newest");
  }

  listLegacy(): LegacyBookSummary[] {
    return [...this.legacyBooks.values()].sort((left, right) =>
      left.slug.localeCompare(right.slug)
    );
  }

  get(bookId: string): Result<ManagedBook, EngineError> {
    const book = this.books.get(bookId);
    return book
      ? ok(book)
      : err(engineError("NOT_FOUND", `Book not found: ${bookId}`));
  }

  getByName(name: string): Result<ManagedBook, EngineError> {
    const wanted = name.trim().toLowerCase();
    const book = [...this.books.values()].find(
      (item) => item.name.toLowerCase() === wanted,
    );
    return book
      ? ok(book)
      : err(engineError("NOT_FOUND", `Book not found: ${name}`));
  }

  async create(name: string): Promise<Result<BookSummary, EngineError>> {
    await this.ready();
    const trimmed = name.trim();
    if (!trimmed) {
      return err(engineError("INVALID_INPUT", "Book name must be non-empty"));
    }
    if (
      this.getByName(trimmed).ok
      || [...this.legacyBooks.values()].some(
        (book) => book.slug.toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      return err(engineError("ALREADY_EXISTS", `Book name already exists: ${trimmed}`));
    }

    const temporaryRoot = join(this.libraryDir, `.creating-${randomUUID()}`);
    await mkdir(temporaryRoot, { recursive: false });
    let temporaryEngine: Engine | null = null;
    try {
      temporaryEngine = this.createEngine(temporaryRoot, trimmed);
      await temporaryEngine.ready;
      const created = temporaryEngine.book.get();
      temporaryEngine.close();
      temporaryEngine = null;
      const finalRoot = this.bookRoot(created.bookId);
      await rename(temporaryRoot, finalRoot);
      const engine = this.createEngine(finalRoot);
      await engine.ready;
      const book = engine.book.get();
      const notebook = await engine.notebooks.create("Main");
      if (!notebook.ok) {
        engine.close();
        await rm(finalRoot, { recursive: true, force: true });
        return err(notebook.error);
      }
      const managed = this.toManagedBook(engine, finalRoot, book);
      this.assertUnique(managed);
      this.knownRoots.add(managed.bookId);
      this.books.set(managed.bookId, managed);
      return ok(this.summary(managed));
    } catch (cause) {
      temporaryEngine?.close();
      await this.removeTemporaryRoot(temporaryRoot);
      const message = cause instanceof Error ? cause.message : String(cause);
      return err(engineError("IO_ERROR", `Could not create book: ${message}`));
    }
  }

  async rename(
    bookId: string,
    name: string,
  ): Promise<Result<BookSummary, EngineError>> {
    await this.ready();
    const existing = this.get(bookId);
    if (!existing.ok) return existing;
    const trimmed = name.trim();
    if (!trimmed) {
      return err(engineError("INVALID_INPUT", "Book name must be non-empty"));
    }
    const conflict = this.getByName(trimmed);
    if (conflict.ok && conflict.value.bookId !== bookId) {
      return err(engineError("ALREADY_EXISTS", `Book name already exists: ${trimmed}`));
    }
    const renamed = await existing.value.engine.book.rename(trimmed);
    if (!renamed.ok) return renamed;
    const managed = this.toManagedBook(
      existing.value.engine,
      existing.value.rootDir,
      renamed.value,
    );
    this.books.set(bookId, managed);
    return ok(this.summary(managed));
  }

  async delete(
    bookId: string,
    options: DeleteBookOptions,
  ): Promise<Result<{ bookId: string; name: string }, EngineError>> {
    await this.ready();
    const resolved = this.get(bookId);
    if (!resolved.ok) return resolved;
    const book = resolved.value;
    if (options.confirmName.trim().toLowerCase() !== book.name.toLowerCase()) {
      return err(engineError("INVALID_INPUT", "Confirmation must match the current book name"));
    }
    try {
      await options.beforeDelete?.(book);
      book.engine.close();
      const root = this.bookRoot(book.bookId);
      if (root !== book.rootDir || !isInside(this.libraryDir, root)) {
        return err(engineError("INVALID_INPUT", "Invalid book root"));
      }
      await rm(root, { recursive: true, force: false });
      this.books.delete(book.bookId);
      this.knownRoots.delete(book.bookId);
      return ok({ bookId: book.bookId, name: book.name });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return err(engineError("IO_ERROR", `Could not delete book: ${message}`));
    }
  }

  async close(): Promise<void> {
    await this.stopMigrations();
    for (const book of this.books.values()) book.engine.close();
    this.books.clear();
    this.legacyBooks.clear();
    this.knownRoots.clear();
    this.opening.clear();
    this.scanPromise = null;
    this.readyPromise = null;
  }

  async stopMigrations(): Promise<void> {
    await this.migrations.close();
  }

  async migrateLegacy(
    bookId: string,
    expectedSourceHead: string,
    options: MigrationOptions = {},
  ): Promise<Result<MigratedBook, EngineError>> {
    try {
      await this.ready();
      return ok(await this.migrations.perform(bookId, expectedSourceHead, options));
    } catch (cause) { return err(migrationFailure(cause)); }
  }

  async enqueueLegacyMigration(bookId: string, sourceHead: string, migrationKey: string) {
    await this.ready();
    return this.migrations.enqueue(bookId, sourceHead, migrationKey);
  }

  async legacyMigrationStatus(bookId: string, migrationKey: string) {
    await this.ready();
    return this.migrations.status(bookId, migrationKey);
  }

  async cancelLegacyMigration(bookId: string, migrationKey: string) {
    await this.ready();
    return this.migrations.cancel(bookId, migrationKey);
  }

  private async load(): Promise<void> {
    await this.scan();
    await Promise.all([...this.knownRoots].map((bookId) => this.openRoot(bookId)));
    await this.migrations.startIfPresent();
  }

  private async scan(): Promise<void> {
    if (!this.scanPromise) this.scanPromise = this.scanOnce();
    return this.scanPromise;
  }

  private async scanOnce(): Promise<void> {
    await this.migrations.restoreInterruptedArchives();
    await mkdir(this.libraryDir, { recursive: true });
    const entries = await readdir(this.libraryDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const root = this.bookRoot(entry.name);
      if (!isUuidV7(entry.name) || !isInside(this.libraryDir, root)) continue;
      this.knownRoots.add(entry.name);
    }
  }

  private async openRoot(bookId: string): Promise<void> {
    if (this.books.has(bookId) || this.legacyBooks.has(bookId)) return;
    const inflight = this.opening.get(bookId);
    if (inflight) {
      await inflight;
      return;
    }
    const pending = this.openRootOnce(bookId);
    this.opening.set(bookId, pending);
    try {
      await pending;
    } finally {
      this.opening.delete(bookId);
    }
  }

  private async openRootOnce(bookId: string): Promise<void> {
    if (this.books.has(bookId) || this.legacyBooks.has(bookId)) return;
    const root = this.bookRoot(bookId);
    const identity = readV4BookIdentity(root);
    if (identity.ok) {
      if (identity.value.bookId !== bookId) {
        throw new Error(`Book root ${bookId} has mismatched legacy book identity`);
      }
      const dryRun = dryRunV4Migration(root);
      if (!dryRun.ok) throw new Error(dryRun.error.message);
      if (dryRun.value.sourceBookId !== bookId) {
        throw new Error(`Book root ${bookId} changed identity during inspection`);
      }
      this.legacyBooks.set(bookId, { ...dryRun.value, slug: identity.value.slug });
      return;
    }
    if (identity.error.code !== "SCHEMA_INCOMPATIBLE") {
      throw new Error(identity.error.message);
    }
    let engine: Engine | undefined;
    try {
      const openedAt = performance.now();
      engine = this.createEngine(root);
      await engine.ready;
      const openMs = performance.now() - openedAt;
      const book = engine.book.get();
      const gc = engine.lastCatalogGc;
      const tag = `${book.name} [${bookId.slice(0, 8)}]`;
      if (openMs > 1_000) {
        logger.warn(
          `[books] open ${tag} took ${openMs.toFixed(0)} ms — catalog is likely bloated`,
        );
      } else {
        logger.info(`[books] open ${tag} ${openMs.toFixed(1)} ms`);
      }
      if (gc) {
        logger.info(
          `[books] catalog gc ${tag} ${gc.trigger} ${gc.bytesBefore} → ${gc.bytesAfter} ${gc.summary}`,
        );
      }
      const managed = this.toManagedBook(engine, root, book);
      if (managed.bookId !== bookId) {
        engine.close();
        throw new Error(`Book root ${bookId} has mismatched book identity`);
      }
      this.assertUnique(managed);
      this.books.set(managed.bookId, managed);
    } catch (cause) {
      engine?.close();
      if (isSchemaIncompatible(cause)) {
        return;
      }
      throw cause;
    }
  }

  private createEngine(rootDir: string, initialBookName?: string): Engine {
    const engine = createEngine({
      rootDir,
      ...(initialBookName ? { initialBookName } : {}),
      ...(this.options.remoteObjects
        ? { remoteObjects: this.options.remoteObjects }
        : {}),
      objectPrefix: this.options.objectPrefix ?? "videobook/sha256",
      ...(this.catalogBackup(rootDir) ? { catalogBackup: this.catalogBackup(rootDir)! } : {}),
    });
    return engine;
  }

  private catalogBackup(rootDir: string): { name: string; url: string } | undefined {
    const template = this.options.catalogBackupUrlTemplate;
    if (!template) return undefined;
    const bookId = rootDir.split(sep).at(-1);
    if (!bookId) return undefined;
    return {
      name: this.options.catalogBackupName ?? "backup",
      url: template.replaceAll("{bookId}", encodeURIComponent(bookId)),
    };
  }

  private bookRoot(bookId: string): string {
    return resolve(this.libraryDir, bookId);
  }

  private assertUnique(book: ManagedBook): void {
    const sameName = [...this.books.values()].find(
      (item) =>
        item.name.toLowerCase() === book.name.toLowerCase()
        && item.bookId !== book.bookId,
    );
    if (sameName) {
      throw new Error(`Duplicate book name: ${book.name}`);
    }
  }

  private toManagedBook(
    engine: Engine,
    rootDir: string,
    book: { bookId: string; name: string; createdAt: number },
  ): ManagedBook {
    return {
      ...book,
      rootDir,
      engine,
      artifactCount: engine.artifacts.list().length,
      notebookCount: engine.notebooks.list().length,
    };
  }

  private summary(book: ManagedBook): BookSummary {
    return {
      bookId: book.bookId,
      name: book.name,
      createdAt: book.createdAt,
      artifactCount: book.engine.artifacts.list().length,
      notebookCount: book.engine.notebooks.list().length,
    };
  }

  private async removeTemporaryRoot(root: string): Promise<void> {
    try {
      const stats = await lstat(root);
      if (stats.isDirectory() && isInside(this.libraryDir, root)) {
        await rm(root, { recursive: true, force: true });
      }
    } catch {
      return;
    }
  }
}
