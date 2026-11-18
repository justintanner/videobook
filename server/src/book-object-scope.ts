import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  err,
  ok,
  type BackupState,
  type ContentStore,
  type Engine,
  type EngineError,
  type Result,
  type StorageStatus,
} from "videobook-engine";
import { hashFile } from "./archive-b2.js";
import type { BookManager } from "./book-manager.js";

const SCOPE_SETTING = "storage.object_scope.v1";
const COPY_CONCURRENCY = 8;

export interface BookObjectScope {
  remote: ContentStore;
  rootDir: string;
  legacyPrefix: string;
  bookPrefix: string;
}

interface ScopeVerification {
  prefix: string;
  verifiedAt: number;
  missing: string[];
}

export interface BookStorageStatus extends Omit<StorageStatus, "state"> {
  state: BackupState | "incomplete";
  missingObjects?: number;
}

type CopyOutcome = "present" | "uploaded" | "copied" | "missing";

export function bookObjectScope(
  remote: ContentStore,
  prefix: string,
  rootDir: string,
  bookId: string,
): BookObjectScope {
  const legacyPrefix = prefix.replace(/^\/+|\/+$/g, "");
  return { remote, rootDir, legacyPrefix, bookPrefix: `${legacyPrefix}/books/${bookId}` };
}

function objectKey(prefix: string, hash: string): string {
  return `${prefix}/${hash.slice(0, 2)}/${hash}`;
}

export function scopedContentStore(scope: BookObjectScope): ContentStore {
  const { remote, bookPrefix, legacyPrefix } = scope;
  return {
    head: (key) => remote.head(key),
    uploadFile: (key, sourcePath) => remote.uploadFile(key, sourcePath),
    delete: (key) => remote.delete(key),
    downloadFile: async (key, destinationPath) => {
      try {
        await remote.downloadFile(key, destinationPath);
      } catch (error) {
        if (!key.startsWith(`${bookPrefix}/`)) throw error;
        const legacy = `${legacyPrefix}${key.slice(bookPrefix.length)}`;
        if (!(await remote.head(legacy)).exists) throw error;
        await remote.downloadFile(legacy, destinationPath);
      }
    },
  };
}

function* rootRevisions(engine: Engine, logCount: number): Generator<string> {
  yield `HEAD~${logCount - 1}`;
  const oldest = engine.history.revisions(Number.MAX_SAFE_INTEGER).at(-1);
  if (oldest) yield `${oldest.hash}~1`;
}

function storedObjects(engine: Engine): Map<string, number> {
  const integrity = engine.catalogIntegrity();
  const expected = integrity.tableRowCounts.objects ?? 0;
  for (const root of rootRevisions(engine, integrity.logCount)) {
    const rows = engine.history.diff(root, "WORKING", "objects")
      .filter((row) => row.diff_type !== "removed");
    if (rows.length !== expected) continue;
    return new Map(rows
      .filter((row) => !row.to_forgotten_at && typeof row.to_object_hash === "string")
      .map((row) => [row.to_object_hash as string, Number(row.to_size_bytes)]));
  }
  throw new Error("Could not list the media stored in this book");
}

async function remoteMatches(remote: ContentStore, key: string, size: number): Promise<boolean> {
  const head = await remote.head(key);
  return head.exists && (head.size === undefined || head.size === size);
}

async function localObject(scope: BookObjectScope, hash: string, size: number): Promise<string | undefined> {
  const path = join(scope.rootDir, "data", "objects", "sha256", hash.slice(0, 2), hash);
  try {
    return (await stat(path)).size === size ? path : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function copyLegacyObject(scope: BookObjectScope, hash: string, key: string): Promise<boolean> {
  const legacy = objectKey(scope.legacyPrefix, hash);
  if (!(await scope.remote.head(legacy)).exists) return false;
  const directory = await mkdtemp(join(tmpdir(), "videobook-object-copy-"));
  try {
    const file = join(directory, hash);
    await scope.remote.downloadFile(legacy, file);
    if (await hashFile(file) !== hash) return false;
    await scope.remote.uploadFile(key, file);
    return true;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function ensureBookCopy(scope: BookObjectScope, hash: string, size: number): Promise<CopyOutcome> {
  const key = objectKey(scope.bookPrefix, hash);
  if (await remoteMatches(scope.remote, key, size)) return "present";
  const local = await localObject(scope, hash, size);
  let outcome: CopyOutcome = "missing";
  if (local) {
    await scope.remote.uploadFile(key, local);
    outcome = "uploaded";
  } else if (await copyLegacyObject(scope, hash, key)) {
    outcome = "copied";
  }
  if (await remoteMatches(scope.remote, key, size)) return outcome === "missing" ? "present" : outcome;
  if (outcome !== "missing") throw new Error(`Could not verify the remote copy of ${hash}`);
  return "missing";
}

async function verifyBookObjects(engine: Engine, scope: BookObjectScope): Promise<void> {
  const queue = [...storedObjects(engine)];
  const missing: string[] = [];
  const worker = async () => {
    for (let next = queue.pop(); next; next = queue.pop()) {
      if (await ensureBookCopy(scope, next[0], next[1]) === "missing") missing.push(next[0]);
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: COPY_CONCURRENCY }, worker));
  const failure = settled.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  const record: ScopeVerification = { prefix: scope.bookPrefix, verifiedAt: Date.now(), missing: missing.sort() };
  const saved = engine.settings.set(SCOPE_SETTING, record);
  if (!saved.ok) throw new Error(saved.error.message);
}

function verification(engine: Engine, scope: BookObjectScope): ScopeVerification | undefined {
  const record = engine.settings.get<ScopeVerification>(SCOPE_SETTING);
  return record?.prefix === scope.bookPrefix ? record : undefined;
}

export function bookStorageStatus(engine: Engine, scope?: BookObjectScope): BookStorageStatus {
  const status = engine.storage.status();
  if (!scope || status.state === "unconfigured") return status;
  const record = verification(engine, scope);
  if (!record) return status.state === "backed_up" ? { ...status, state: "pending" } : status;
  if (record.missing.length === 0 || status.state === "offline" || status.state === "diverged") return status;
  return {
    ...status,
    state: "incomplete",
    missingObjects: record.missing.length,
    lastError: `${record.missing.length} backed-up file(s) are missing from remote storage and from this device`,
  };
}

export async function backupBook(
  engine: Engine,
  scope?: BookObjectScope,
): Promise<Result<BookStorageStatus, EngineError>> {
  const backup = await engine.storage.backup();
  if (!backup.ok || !scope || backup.value.state === "unconfigured") return backup;
  const record = verification(engine, scope);
  if (!record || record.missing.length > 0) {
    try {
      await verifyBookObjects(engine, scope);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err({ code: "OFFLINE", message: `Could not verify this book's remote copies: ${message}` });
    }
  }
  return ok(bookStorageStatus(engine, scope));
}

export async function releaseSharedObject(books: BookManager, bookId: string, hash: string): Promise<void> {
  const scope = books.objectScope(bookId);
  if (!scope) return;
  const legacy = objectKey(scope.legacyPrefix, hash);
  if (!(await scope.remote.head(legacy)).exists) return;
  await books.ready();
  for (const summary of books.list()) {
    const managed = books.get(summary.bookId);
    const other = books.objectScope(summary.bookId);
    if (summary.bookId === bookId || !managed.ok || !other) continue;
    const size = storedObjects(managed.value.engine).get(hash);
    if (size === undefined) continue;
    if (await ensureBookCopy(other, hash, size) === "missing") {
      throw new Error(`Kept the shared remote copy of ${hash}: book ${summary.name} has no other copy`);
    }
  }
  await scope.remote.delete(legacy);
}
