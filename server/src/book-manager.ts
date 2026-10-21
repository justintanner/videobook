import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { BOOK_SLUG_ERROR, normalizeBookSlug } from "videobook-engine/book-slug";
import { logger } from "./logger.js";
import {
  createEngine,
  err,
  isUuidV7,
  ok,
  type ContentStore,
  type Engine,
  type EngineError,
  type Result,
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

interface BookManagerOptions {
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

const MOVE_ATTEMPTS = 8;
const RETRYABLE_MOVE_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

function systemCode(cause: unknown): string | undefined {
  if (!cause || typeof cause !== "object" || !("code" in cause)) return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Windows denies renaming a directory while Defender, or a Dolt file that just
// closed, still holds a handle. Retry, then copy and drop the staging tree.
async function moveDirectory(source: string, destination: string): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < MOVE_ATTEMPTS; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (cause) {
      last = cause;
      if (!RETRYABLE_MOVE_CODES.has(systemCode(cause) ?? "")) throw cause;
      if (attempt < MOVE_ATTEMPTS - 1) await delay(50 * 2 ** attempt);
    }
  }
  try {
    await cp(source, destination, { recursive: true });
  } catch {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw last;
  }
  await rm(source, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
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
  private readonly libraryDir: string;
  private readonly options: BookManagerOptions;
  private readonly books = new Map<string, ManagedBook>();
  private readonly knownRoots = new Set<string>();
  private readonly opening = new Map<string, Promise<void>>();
  private readonly reservedNames = new Set<string>();
  private scanPromise: Promise<void> | null = null;
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

  async discover(): Promise<string[]> {
    await this.scan();
    return [...this.knownRoots];
  }

  async ensure(bookId: string): Promise<Result<ManagedBook, EngineError>> {
    await this.scan();
    const existing = this.books.get(bookId);
    if (existing) {
      if (normalizeBookSlug(existing.name) === existing.name) return ok(existing);
      await this.ready();
      return this.get(bookId);
    }
    if (!this.knownRoots.has(bookId)) {
      return err(engineError("NOT_FOUND", `Book not found: ${bookId}`));
    }
    await this.openRoot(bookId);
    const opened = this.books.get(bookId);
    if (opened && normalizeBookSlug(opened.name) !== opened.name) {
      await this.ready();
      return this.get(bookId);
    }
    return opened
      ? ok(opened)
      : err(engineError("NOT_FOUND", `Book not found: ${bookId}`));
  }

  list(options: { sort?: "newest" | "oldest" } = {}): BookSummary[] {
    const books = [...this.books.values()].map((book) => this.summary(book));
    return sortBooks(books, options.sort ?? "newest");
  }

  get(bookId: string): Result<ManagedBook, EngineError> {
    const book = this.books.get(bookId);
    return book
      ? ok(book)
      : err(engineError("NOT_FOUND", `Book not found: ${bookId}`));
  }

  getByName(name: string): Result<ManagedBook, EngineError> {
    const wanted = normalizeBookSlug(name);
    const book = [...this.books.values()].find(
      (item) => item.name === wanted,
    );
    return book
      ? ok(book)
      : err(engineError("NOT_FOUND", `Book not found: ${name}`));
  }

  async create(name: string): Promise<Result<BookSummary, EngineError>> {
    await this.ready();
    const slug = normalizeBookSlug(name);
    if (!slug) {
      return err(engineError("INVALID_INPUT", BOOK_SLUG_ERROR));
    }
    if (this.getByName(slug).ok || this.reservedNames.has(slug)) {
      return err(engineError("ALREADY_EXISTS", `Book name already exists: ${slug}`));
    }

    this.reservedNames.add(slug);
    const temporaryRoot = join(this.libraryDir, `.creating-${randomUUID()}`);
    let temporaryEngine: Engine | null = null;
    let finalEngine: Engine | null = null;
    let finalRoot: string | null = null;
    try {
      await mkdir(temporaryRoot, { recursive: false });
      temporaryEngine = this.createEngine(temporaryRoot, slug);
      await temporaryEngine.ready;
      const audioTracks = temporaryEngine.sequences.getPrimary().tracks.filter((track) => track.kind === "audio");
      for (const track of audioTracks.slice(1)) {
        const removed = await temporaryEngine.sequences.removeTrack(track.trackId);
        if (!removed.ok) throw new Error(removed.error.message);
      }
      const created = temporaryEngine.book.get();
      temporaryEngine.close();
      temporaryEngine = null;
      await delay(0);
      const destination = this.bookRoot(created.bookId);
      await moveDirectory(temporaryRoot, destination);
      finalRoot = destination;
      const engine = this.createEngine(finalRoot);
      finalEngine = engine;
      await engine.ready;
      const book = engine.book.get();
      const notebook = await engine.notebooks.create("Main");
      if (!notebook.ok) {
        engine.close();
        finalEngine = null;
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
      finalEngine?.close();
      await this.removeTemporaryRoot(temporaryRoot);
      if (finalRoot) await this.removeTemporaryRoot(finalRoot);
      const message = cause instanceof Error ? cause.message : String(cause);
      return err(engineError("IO_ERROR", `Could not create book: ${message}`));
    } finally {
      this.reservedNames.delete(slug);
    }
  }

  async rename(
    bookId: string,
    name: string,
  ): Promise<Result<BookSummary, EngineError>> {
    await this.ready();
    const existing = this.get(bookId);
    if (!existing.ok) return existing;
    const slug = normalizeBookSlug(name);
    if (!slug) {
      return err(engineError("INVALID_INPUT", BOOK_SLUG_ERROR));
    }
    const conflict = this.getByName(slug);
    if (
      (conflict.ok && conflict.value.bookId !== bookId)
      || this.reservedNames.has(slug)
    ) {
      return err(engineError("ALREADY_EXISTS", `Book name already exists: ${slug}`));
    }
    this.reservedNames.add(slug);
    try {
      const renamed = await existing.value.engine.book.rename(slug);
      if (!renamed.ok) return renamed;
      const managed = this.toManagedBook(
        existing.value.engine,
        existing.value.rootDir,
        renamed.value,
      );
      this.books.set(bookId, managed);
      return ok(this.summary(managed));
    } finally {
      this.reservedNames.delete(slug);
    }
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
    const root = this.bookRoot(book.bookId);
    if (root !== book.rootDir || !isInside(this.libraryDir, root)) {
      return err(engineError("INVALID_INPUT", "Invalid book root"));
    }
    try {
      await options.beforeDelete?.(book);
      this.books.delete(book.bookId);
      this.knownRoots.delete(book.bookId);
      book.engine.close();
      await rm(root, { recursive: true, force: false });
      return ok({ bookId: book.bookId, name: book.name });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return err(engineError("IO_ERROR", `Could not delete book: ${message}`));
    }
  }

  async close(): Promise<void> {
    for (const book of this.books.values()) book.engine.close();
    this.books.clear();
    this.knownRoots.clear();
    this.opening.clear();
    this.scanPromise = null;
    this.readyPromise = null;
  }

  private async load(): Promise<void> {
    await this.scan();
    await Promise.all([...this.knownRoots].map((bookId) => this.openRoot(bookId)));
    for (const book of [...this.books.values()].sort((left, right) => left.bookId.localeCompare(right.bookId))) {
      this.assertUnique(await this.normalizeStoredBookName(book));
    }
  }

  private async normalizeStoredBookName(book: ManagedBook): Promise<ManagedBook> {
    const base = normalizeBookSlug(book.name) || "project";
    if (base === book.name) return book;
    let name = base;
    let suffix = 2;
    while (this.getByName(name).ok || this.reservedNames.has(name)) {
      name = `${base}-${suffix++}`;
    }
    this.reservedNames.add(name);
    try {
      const renamed = await book.engine.book.rename(name);
      if (!renamed.ok) throw new Error(renamed.error.message);
      const managed = this.toManagedBook(book.engine, book.rootDir, renamed.value);
      this.books.set(book.bookId, managed);
      return managed;
    } finally {
      this.reservedNames.delete(name);
    }
  }

  private async scan(): Promise<void> {
    if (!this.scanPromise) this.scanPromise = this.scanOnce();
    return this.scanPromise;
  }

  private async scanOnce(): Promise<void> {
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
    if (this.books.has(bookId)) return;
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
    if (this.books.has(bookId)) return;
    const root = this.bookRoot(bookId);
    let engine: Engine | undefined;
    try {
      const openedAt = performance.now();
      engine = this.createEngine(root);
      await engine.ready;
      const openMs = performance.now() - openedAt;
      const book = engine.book.get();
      const gc = engine.lastCatalogGc;
      if (openMs > 1_000) {
        logger.warn("book-open-slow", { bookId, durationMs: openMs });
      } else {
        logger.info("book-open", { bookId, durationMs: openMs });
      }
      if (gc) {
        logger.info("book-catalog-gc", { bookId, bytesBefore: gc.bytesBefore, bytesAfter: gc.bytesAfter });
      }
      const managed = this.toManagedBook(engine, root, book);
      if (managed.bookId !== bookId) {
        engine.close();
        throw new Error(`Book root ${bookId} has mismatched book identity`);
      }
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
