import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import { BookManager } from "./book-manager.js";
import { scopedBookEngine, withBookContext } from "./book-context.js";
import { registerForgetAssetJob } from "./jobs/forget-asset.js";
import { queue, setEngineRoot } from "./queue.js";
import { directoryContentStore } from "./test-content-store.js";
import { deleteAssetDef } from "./tools/delete-asset.js";
import type { ToolDef } from "./tools/tool-def.js";
import { videobookDomainDefs } from "./tools/videobook-domain.js";

const FIRST_CUT = Buffer.from("first cut of the original video");
const FINAL_CUT = Buffer.from("final cut shared with another asset");
const THUMBNAIL = Buffer.from("poster frame of the original video");

interface ToolReply {
  isError: boolean;
  body: Record<string, unknown> | string;
}

function reply(result: Awaited<ReturnType<ToolDef["handler"]>>): ToolReply {
  const text = result.content[0]?.text ?? "";
  try {
    return { isError: result.isError === true, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { isError: result.isError === true, body: text };
  }
}

describe("Forget erasure", () => {
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
    rootDir = await mkdtemp(join(tmpdir(), "videobook-forget-recovery-"));
    const remote = directoryContentStore(join(rootDir, "remote"));
    const manager = new BookManager({ libraryDir: join(rootDir, "books"), remoteObjects: remote, objectPrefix: "media" });
    books = manager;
    await manager.ready();
    registerForgetAssetJob(scopedBookEngine, manager);
    const created = await manager.create("forget-recovery");
    if (!created.ok) throw new Error(created.error.message);
    const bookId = created.value.bookId;
    const managed = manager.get(bookId);
    if (!managed.ok) throw new Error(managed.error.message);
    const engine = managed.value.engine;
    const root = managed.value.rootDir;
    await setEngineRoot(root, engine);
    const defs = [...videobookDomainDefs(scopedBookEngine, manager), deleteAssetDef(scopedBookEngine)];
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolReply> => {
      const def = defs.find((entry) => entry.name === name);
      if (!def) throw new Error(`Missing ${name}`);
      return reply(await withBookContext({ bookId, engine }, () => def.handler({ book_id: bookId, ...args })));
    };
    return {
      engine,
      remote,
      call,
      forget: (assetId: string) => call("delete_asset", { asset_id: assetId, forget: true }),
      dropLocal: (hash: string) => unlink(join(root, "data", "objects", "sha256", hash.slice(0, 2), hash)),
    };
  }

  async function write(engine: Engine, artifactId: string, filename: string, bytes: Buffer): Promise<{ hash: string; revision: string }> {
    const written = await engine.files.write(artifactId, filename, bytes);
    if (!written.ok) throw new Error(written.error.message);
    const manifest = await engine.files.manifest(artifactId, { includeDotfiles: true });
    if (!manifest.ok) throw new Error(manifest.error.message);
    const file = manifest.value.files.find((entry) => entry.name === filename);
    if (!written.revision) throw new Error("write_file made no revision");
    return { hash: file!.objectHash, revision: written.revision };
  }

  async function video(engine: Engine, label: string): Promise<string> {
    const artifact = await engine.artifacts.create("video", label);
    if (!artifact.ok) throw new Error(artifact.error.message);
    return artifact.value.artifactId;
  }

  it("erases every stored file of an asset whose thumbnail is already missing", async () => {
    const h = await harness();
    const assetId = await video(h.engine, "Original");
    const first = await write(h.engine, assetId, "original.mp4", FIRST_CUT);
    const final = await write(h.engine, assetId, "original.mp4", FINAL_CUT);
    const thumbnail = await write(h.engine, assetId, "original.jpg", THUMBNAIL);
    const otherId = await video(h.engine, "Same final cut");
    await write(h.engine, otherId, "original.mp4", FINAL_CUT);
    expect((await h.engine.files.readAtRevision(assetId, "original.mp4", first.revision)).ok).toBe(true);
    expect((await h.engine.workspaces.evict(assetId)).ok).toBe(true);
    await h.dropLocal(thumbnail.hash);

    const outcome = await h.forget(assetId);
    expect(outcome).toMatchObject({
      isError: false,
      body: { status: "forgotten", forgotten_objects: 2, shared_objects: 1, pending_objects: 0 },
    });
    expect(h.engine.artifacts.get(assetId).ok).toBe(false);
    for (const [filename, revision] of [["original.mp4", first.revision], ["original.mp4", final.revision], ["original.jpg", thumbnail.revision]] as const) {
      const read = await h.engine.files.readAtRevision(assetId, filename, revision);
      if (filename === "original.mp4" && revision === final.revision) expect(read).toMatchObject({ ok: true, value: FINAL_CUT });
      else expect(read).toMatchObject({ ok: false, error: { code: "OBJECT_UNAVAILABLE" } });
    }
    expect(await h.engine.files.read(otherId, "original.mp4")).toMatchObject({ ok: true, value: FINAL_CUT });
  });

  it("reports an interrupted Forget and finishes it by the original asset ID", async () => {
    const h = await harness();
    const assetId = await video(h.engine, "Original");
    const original = await write(h.engine, assetId, "original.mp4", FIRST_CUT);
    expect(await h.call("storage_sync")).toMatchObject({ isError: false, body: { ok: true, value: { state: "backed_up" } } });
    const key = (await h.remote.keys()).find((entry) => entry.endsWith(original.hash));
    expect(key).toBeDefined();
    h.remote.failNextDeletes(1);

    expect(await h.forget(assetId)).toMatchObject({
      isError: false,
      body: {
        status: "incomplete",
        artifact_id: assetId,
        forgotten_objects: 0,
        pending_objects: 1,
        error: expect.stringContaining("Remote storage unavailable"),
      },
    });
    expect(h.engine.artifacts.get(assetId).ok).toBe(false);
    expect(await h.remote.keys()).toContain(key);

    expect(await h.forget(assetId)).toMatchObject({
      isError: false,
      body: { status: "forgotten", artifact_id: assetId, forgotten_objects: 1, pending_objects: 0 },
    });
    expect(await h.remote.keys()).not.toContain(key);
    expect(await h.engine.files.readAtRevision(assetId, "original.mp4", original.revision))
      .toMatchObject({ ok: false, error: { code: "OBJECT_UNAVAILABLE" } });
    expect(await h.forget(assetId)).toMatchObject({ isError: true });
  });
});
