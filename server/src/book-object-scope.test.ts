import { afterEach, describe, expect, it } from "vitest";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { createEngine, type ContentStore, type Engine } from "videobook-engine";
import { BookManager } from "./book-manager.js";
import { scopedBookEngine, withBookContext } from "./book-context.js";
import { forgetAsset } from "./forget-asset.js";
import { registerForgetAssetJob } from "./jobs/forget-asset.js";
import { queue, setEngineRoot } from "./queue.js";
import { deleteAssetDef } from "./tools/delete-asset.js";
import type { ToolDef } from "./tools/tool-def.js";
import { videobookDomainDefs } from "./tools/videobook-domain.js";

const ORIGINAL = Buffer.from("identical original media bytes");
const SECOND_TAKE = Buffer.from("a second take both books imported");

interface Asset {
  artifactId: string;
  hash: string;
}

function directoryStore(root: string): ContentStore {
  const file = (key: string) => join(root, ...key.split("/"));
  return {
    head: async (key) => {
      try {
        return { exists: true, size: (await stat(file(key))).size };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
        throw error;
      }
    },
    uploadFile: async (key, sourcePath) => {
      await mkdir(dirname(file(key)), { recursive: true });
      await copyFile(sourcePath, file(key));
    },
    downloadFile: async (key, destinationPath) => {
      await copyFile(file(key), destinationPath);
    },
    delete: async (key) => {
      await rm(file(key), { force: true });
    },
  };
}

function toolJson(result: Awaited<ReturnType<ToolDef["handler"]>>): Record<string, unknown> {
  if (result.isError) throw new Error(result.content[0]?.text ?? "Tool failed");
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function objectKey(prefix: string, hash: string): string {
  return `${prefix}/${hash.slice(0, 2)}/${hash}`;
}

async function writeOriginal(engine: Engine, bytes: Buffer): Promise<Asset> {
  const artifact = await engine.artifacts.create("video", "Original");
  if (!artifact.ok) throw new Error(artifact.error.message);
  const written = await engine.files.write(artifact.value.artifactId, "original.mp4", bytes);
  if (!written.ok) throw new Error(written.error.message);
  const manifest = await engine.files.manifest(artifact.value.artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  return { artifactId: artifact.value.artifactId, hash: manifest.value.files[0]!.objectHash };
}

describe("remote media shared by books", () => {
  let rootDir: string | undefined;
  let books: BookManager | undefined;

  afterEach(async () => {
    await queue.stop();
    await books?.close();
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    rootDir = undefined;
    books = undefined;
  });

  async function harness() {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-object-scope-"));
    const remoteDir = join(rootDir, "remote");
    const remote = directoryStore(remoteDir);
    const libraryDir = join(rootDir, "books");
    const start = async () => {
      books = new BookManager({ libraryDir, remoteObjects: remote, objectPrefix: "media" });
      await books.ready();
      registerForgetAssetJob(scopedBookEngine, books);
    };
    await start();
    const manager = (): BookManager => books!;
    const engine = (bookId: string): Engine => {
      const managed = manager().get(bookId);
      if (!managed.ok) throw new Error(managed.error.message);
      return managed.value.engine;
    };
    const tool = (name: string): ToolDef => {
      const def = [...videobookDomainDefs(scopedBookEngine, manager()), deleteAssetDef(scopedBookEngine)]
        .find((entry) => entry.name === name);
      if (!def) throw new Error(`Missing ${name}`);
      return def;
    };
    const call = async (bookId: string, name: string, args: Record<string, unknown> = {}) => {
      const def = tool(name);
      return toolJson(await withBookContext(
        { bookId, engine: engine(bookId) },
        () => def.handler({ book_id: bookId, ...args }),
      ));
    };

    return {
      async remoteKeys(): Promise<string[]> {
        const entries = await readdir(remoteDir, { recursive: true, withFileTypes: true }).catch(() => []);
        return entries
          .filter((entry) => entry.isFile())
          .map((entry) => relative(remoteDir, join(entry.parentPath, entry.name)).split(sep).join("/"))
          .sort();
      },
      async book(name: string): Promise<string> {
        const created = await manager().create(name);
        if (!created.ok) throw new Error(created.error.message);
        return created.value.bookId;
      },
      original: (bookId: string, bytes = ORIGINAL) => writeOriginal(engine(bookId), bytes),
      async beforeScoping<T>(bookId: string, work: (legacy: Engine) => Promise<T>): Promise<T> {
        await manager().close();
        const legacy = createEngine({ rootDir: join(libraryDir, bookId), remoteObjects: remote, objectPrefix: "media", durableWrites: false });
        try {
          await legacy.ready;
          return await work(legacy);
        } finally {
          legacy.close();
          await start();
        }
      },
      sync: (bookId: string) => call(bookId, "storage_sync"),
      status: (bookId: string) => call(bookId, "storage_status"),
      async forget(bookId: string, artifactId: string) {
        const managed = manager().get(bookId);
        if (!managed.ok) throw new Error(managed.error.message);
        await setEngineRoot(managed.value.rootDir, managed.value.engine);
        return await call(bookId, "delete_asset", { asset_id: artifactId, forget: true });
      },
      async dropLocal(bookId: string, asset: Asset): Promise<void> {
        const evicted = await engine(bookId).workspaces.evict(asset.artifactId);
        if (!evicted.ok) throw new Error(evicted.error.message);
        await unlink(join(libraryDir, bookId, "data", "objects", "sha256", asset.hash.slice(0, 2), asset.hash));
      },
      async retrieve(bookId: string, artifactId: string): Promise<Buffer> {
        const read = await engine(bookId).files.read(artifactId, "original.mp4");
        if (!read.ok) throw new Error(read.error.message);
        return read.value;
      },
    };
  }

  async function legacyBackup(legacy: Engine, bytes: Buffer[]): Promise<Asset[]> {
    const assets: Asset[] = [];
    for (const entry of bytes) assets.push(await writeOriginal(legacy, entry));
    const backup = await legacy.storage.backup();
    if (!backup.ok) throw new Error(backup.error.message);
    expect(backup.value).toMatchObject({ state: "backed_up", pendingObjects: 0 });
    return assets;
  }

  it("keeps the second book's backup when the first forgets identical bytes", async () => {
    const h = await harness();
    const first = await h.book("first");
    const second = await h.book("second");
    const firstAsset = await h.original(first);
    const secondAsset = await h.original(second);
    expect(secondAsset.hash).toBe(firstAsset.hash);
    expect(await h.sync(first)).toMatchObject({ ok: true, value: { state: "backed_up", pendingObjects: 0 } });
    expect(await h.sync(second)).toMatchObject({ ok: true, value: { state: "backed_up", pendingObjects: 0 } });

    expect(await h.forget(first, firstAsset.artifactId)).toMatchObject({ status: "forgotten", forgotten_objects: 1 });
    expect(await h.sync(second)).toMatchObject({ ok: true, value: { state: "backed_up", pendingObjects: 0 } });
    await h.dropLocal(second, secondAsset);

    expect(await h.retrieve(second, secondAsset.artifactId)).toEqual(ORIGINAL);
    expect(await h.remoteKeys()).toEqual([objectKey(`media/books/${second}`, secondAsset.hash)]);
  });

  it("copies a shared-prefix backup into the surviving book before Forget retires the shared key", async () => {
    const h = await harness();
    const first = await h.book("first");
    const second = await h.book("second");
    const [firstAsset] = await h.beforeScoping(first, (legacy) => legacyBackup(legacy, [ORIGINAL]));
    const [secondAsset] = await h.beforeScoping(second, (legacy) => legacyBackup(legacy, [ORIGINAL]));
    expect(secondAsset!.hash).toBe(firstAsset!.hash);
    expect(await h.remoteKeys()).toEqual([objectKey("media", firstAsset!.hash)]);
    await h.dropLocal(second, secondAsset!);
    expect(await h.status(second)).toMatchObject({ state: "pending", pendingObjects: 0 });
    expect(await h.retrieve(second, secondAsset!.artifactId)).toEqual(ORIGINAL);
    await h.dropLocal(second, secondAsset!);

    expect(await h.forget(first, firstAsset!.artifactId)).toMatchObject({ status: "forgotten", forgotten_objects: 1 });
    expect(await h.remoteKeys()).toEqual([objectKey(`media/books/${second}`, secondAsset!.hash)]);
    expect(await h.sync(second)).toMatchObject({ ok: true, value: { state: "backed_up", pendingObjects: 0 } });
    expect(await h.status(second)).toMatchObject({ state: "backed_up", pendingObjects: 0 });

    expect(await h.retrieve(second, secondAsset!.artifactId)).toEqual(ORIGINAL);
  });

  it("repairs a surviving backup from local bytes and reports media it cannot repair", async () => {
    const h = await harness();
    const first = await h.book("first");
    const second = await h.book("second");
    const firstAssets = await h.beforeScoping(first, (legacy) => legacyBackup(legacy, [ORIGINAL, SECOND_TAKE]));
    const [kept, lost] = await h.beforeScoping(second, (legacy) => legacyBackup(legacy, [ORIGINAL, SECOND_TAKE]));
    await h.beforeScoping(first, async (legacy) => {
      for (const asset of firstAssets) {
        expect(await forgetAsset(legacy, { assetId: asset.artifactId, clearReferences: false }))
          .toMatchObject({ status: "forgotten", forgottenObjects: 1 });
      }
    });
    expect(await h.remoteKeys()).toEqual([]);
    await h.dropLocal(second, lost!);

    expect(await h.sync(second)).toMatchObject({
      ok: true,
      value: { state: "incomplete", pendingObjects: 0, missingObjects: 1, lastError: expect.stringContaining("missing") },
    });
    expect(await h.status(second)).toMatchObject({ state: "incomplete", missingObjects: 1 });
    expect(await h.remoteKeys()).toEqual([objectKey(`media/books/${second}`, kept!.hash)]);
    await h.dropLocal(second, kept!);
    expect(await h.retrieve(second, kept!.artifactId)).toEqual(ORIGINAL);
    await expect(h.retrieve(second, lost!.artifactId)).rejects.toThrow();

    await h.original(second, SECOND_TAKE);
    expect(await h.sync(second)).toMatchObject({ ok: true, value: { state: "backed_up", pendingObjects: 0 } });
    expect(await h.remoteKeys()).toEqual([kept!.hash, lost!.hash].map((hash) => objectKey(`media/books/${second}`, hash)).sort());
    await h.dropLocal(second, lost!);
    expect(await h.retrieve(second, lost!.artifactId)).toEqual(SECOND_TAKE);
  });
});
