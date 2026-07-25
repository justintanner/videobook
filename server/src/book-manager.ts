import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  createEngine,
  dryRunV4Migration,
  err,
  isUuidV7,
  isValidBookSlug,
  migrateV4,
  ok,
  readV4BookIdentity,
  type ContentStore,
  type Engine,
  type EngineError,
  type Result,
  type V4MigrationDryRun,
  type V4MigrationResult,
} from "videobook-engine";

export interface BookSummary {
  bookId: string;
  slug: string;
  createdAt: number;
  artifactCount: number;
  notebookCount: number;
}

export interface ManagedBook extends BookSummary {
  rootDir: string;
  engine: Engine;
}

export interface LegacyBookSummary extends V4MigrationDryRun {
  slug: string;
}

export interface MigratedBook {
  book: BookSummary;
  migration: V4MigrationResult;
  legacyArchiveRoot: string;
}

export interface BookManagerOptions {
  libraryDir: string;
  remoteObjects?: ContentStore;
  objectPrefix: string;
  catalogBackupUrlTemplate?: string;
  catalogBackupName: string;
}

export interface DeleteBookOptions {
  confirmSlug: string;
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
  private readonly libraryDir: string;
  private readonly options: BookManagerOptions;
  private readonly books = new Map<string, ManagedBook>();
  private readonly legacyBooks = new Map<string, LegacyBookSummary>();
  private readyPromise: Promise<void> | null = null;

  constructor(options: BookManagerOptions) {
    this.libraryDir = resolve(options.libraryDir);
    this.options = { ...options, libraryDir: this.libraryDir };
  }

  get rootDir(): string {
    return this.libraryDir;
  }

  async ready(): Promise<void> {
    if (!this.readyPromise) this.readyPromise = this.load();
    return this.readyPromise;
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

  getBySlug(slug: string): Result<ManagedBook, EngineError> {
    const book = [...this.books.values()].find((item) => item.slug === slug);
    return book
      ? ok(book)
      : err(engineError("NOT_FOUND", `Book not found: ${slug}`));
  }

  async create(slug: string): Promise<Result<BookSummary, EngineError>> {
    await this.ready();
    if (!isValidBookSlug(slug)) {
      return err(engineError("INVALID_INPUT", `Invalid book slug: ${slug}`));
    }
    if (
      this.getBySlug(slug).ok
      || [...this.legacyBooks.values()].some((book) => book.slug === slug)
    ) {
      return err(engineError("SLUG_CONFLICT", `Book slug already exists: ${slug}`));
    }

    const temporaryRoot = join(this.libraryDir, `.creating-${randomUUID()}`);
    await mkdir(temporaryRoot, { recursive: false });
    let temporaryEngine: Engine | null = null;
    try {
      temporaryEngine = this.createEngine(temporaryRoot, slug);
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
    slug: string,
  ): Promise<Result<BookSummary, EngineError>> {
    await this.ready();
    const existing = this.get(bookId);
    if (!existing.ok) return existing;
    if (!isValidBookSlug(slug)) {
      return err(engineError("INVALID_INPUT", `Invalid book slug: ${slug}`));
    }
    const conflict = this.getBySlug(slug);
    if (conflict.ok && conflict.value.bookId !== bookId) {
      return err(engineError("SLUG_CONFLICT", `Book slug already exists: ${slug}`));
    }
    const renamed = await existing.value.engine.book.rename(slug);
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
  ): Promise<Result<{ bookId: string; slug: string }, EngineError>> {
    await this.ready();
    const resolved = this.get(bookId);
    if (!resolved.ok) return resolved;
    const book = resolved.value;
    if (options.confirmSlug !== book.slug) {
      return err(engineError("INVALID_INPUT", "Confirmation must match the current book slug"));
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
      return ok({ bookId: book.bookId, slug: book.slug });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return err(engineError("IO_ERROR", `Could not delete book: ${message}`));
    }
  }

  async close(): Promise<void> {
    for (const book of this.books.values()) book.engine.close();
    this.books.clear();
    this.legacyBooks.clear();
  }

  async migrateLegacy(
    bookId: string,
    expectedSourceHead: string,
  ): Promise<Result<MigratedBook, EngineError>> {
    await this.ready();
    const legacy = this.legacyBooks.get(bookId);
    if (!legacy) {
      return err(engineError("NOT_FOUND", `Legacy book not found: ${bookId}`));
    }
    if (legacy.sourceHeadRevision !== expectedSourceHead) {
      return err(engineError(
        "STALE_REVISION",
        "Legacy book changed after migration confirmation",
      ));
    }
    const sourceRoot = this.bookRoot(bookId);
    const temporaryRoot = join(this.libraryDir, `.migrating-${randomUUID()}`);
    const migrated = await migrateV4({
      sourceRoot,
      destinationRoot: temporaryRoot,
      dryRun: false,
      expectedSourceBookId: bookId,
      expectedSourceHead,
    });
    if (!migrated.ok) return migrated;
    if (!("destinationBookId" in migrated.value)) {
      return err(engineError("INTERNAL_ERROR", "Migration result is incomplete"));
    }
    const archiveDir = join(this.libraryDir, ".legacy-v4");
    const archiveRoot = join(
      archiveDir,
      `${bookId}-${expectedSourceHead.slice(0, 12)}`,
    );
    try {
      await mkdir(archiveDir, { recursive: true });
      await rename(sourceRoot, archiveRoot);
      try {
        await rename(temporaryRoot, sourceRoot);
      } catch (cause) {
        await rename(archiveRoot, sourceRoot);
        throw cause;
      }
      const engine = this.createEngine(sourceRoot);
      await engine.ready;
      const managed = this.toManagedBook(engine, sourceRoot, engine.book.get());
      this.assertUnique(managed);
      this.legacyBooks.delete(bookId);
      this.books.set(bookId, managed);
      return ok({
        book: this.summary(managed),
        migration: migrated.value,
        legacyArchiveRoot: archiveRoot,
      });
    } catch (cause) {
      await this.removeTemporaryRoot(temporaryRoot);
      return err(engineError(
        "IO_ERROR",
        `Could not switch to migrated book: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      ));
    }
  }

  private async load(): Promise<void> {
    await mkdir(this.libraryDir, { recursive: true });
    const entries = await readdir(this.libraryDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const root = this.bookRoot(entry.name);
      if (!isUuidV7(entry.name) || !isInside(this.libraryDir, root)) continue;
      let engine: Engine | undefined;
      try {
        engine = this.createEngine(root);
        await engine.ready;
        const managed = this.toManagedBook(engine, root, engine.book.get());
        if (managed.bookId !== entry.name) {
          engine.close();
          throw new Error(`Book root ${entry.name} has mismatched book identity`);
        }
        this.assertUnique(managed);
        this.books.set(managed.bookId, managed);
      } catch (cause) {
        engine?.close();
        const dryRun = dryRunV4Migration(root);
        if (dryRun.ok) {
          const identity = readV4BookIdentity(root);
          if (!identity.ok) throw cause;
          this.legacyBooks.set(dryRun.value.sourceBookId, {
            ...dryRun.value,
            slug: identity.value.slug,
          });
          continue;
        }
        throw cause;
      }
    }
  }

  private createEngine(rootDir: string, initialBookSlug?: string): Engine {
    const engine = createEngine({
      rootDir,
      ...(initialBookSlug ? { initialBookSlug } : {}),
      ...(this.options.remoteObjects
        ? { remoteObjects: this.options.remoteObjects }
        : {}),
      objectPrefix: this.options.objectPrefix,
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
      name: this.options.catalogBackupName,
      url: template.replaceAll("{bookId}", encodeURIComponent(bookId)),
    };
  }

  private bookRoot(bookId: string): string {
    return resolve(this.libraryDir, bookId);
  }

  private assertUnique(book: ManagedBook): void {
    const sameSlug = [...this.books.values()].find((item) => item.slug === book.slug);
    if (sameSlug && sameSlug.bookId !== book.bookId) {
      throw new Error(`Duplicate book slug: ${book.slug}`);
    }
  }

  private toManagedBook(
    engine: Engine,
    rootDir: string,
    book: { bookId: string; slug: string; createdAt: number },
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
      slug: book.slug,
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
