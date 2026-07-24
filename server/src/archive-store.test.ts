import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { getEngineRoot } from "./queue.js";
import {
  createLocalArchiveStore,
  getArchiveStore,
  localArchiveDir,
  localArchiveMediaUrl,
} from "./archive-store.js";

type EnvName =
  | "B2_ACCESS_KEY_ID"
  | "B2_SECRET_ACCESS_KEY"
  | "B2_REGION"
  | "B2_BUCKET"
  | "VIDEOBOOK_ARCHIVE_DIR";

const envNames: EnvName[] = [
  "B2_ACCESS_KEY_ID",
  "B2_SECRET_ACCESS_KEY",
  "B2_REGION",
  "B2_BUCKET",
  "VIDEOBOOK_ARCHIVE_DIR",
];

describe("archive store", () => {
  let tempDir: string;
  let envSnapshot: Array<[EnvName, string | undefined]>;

  beforeEach(async () => {
    envSnapshot = envNames.map((name) => [name, process.env[name]]);
    for (const name of envNames) delete process.env[name];
    tempDir = await mkdtemp(join(tmpdir(), "videocity-archive-store-test-"));
  });

  afterEach(async () => {
    for (const [name, value] of envSnapshot) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("selects the local store when B2 is not configured", () => {
    process.env.VIDEOBOOK_ARCHIVE_DIR = join(tempDir, "archive");
    expect(getArchiveStore().kind).toBe("local");
  });

  it("selects the B2 store when B2 env vars are configured", () => {
    process.env.B2_ACCESS_KEY_ID = "real-access-key";
    process.env.B2_SECRET_ACCESS_KEY = "real-secret-key";
    process.env.B2_REGION = "us-west-004";
    process.env.B2_BUCKET = "archive-bucket";
    expect(getArchiveStore().kind).toBe("b2");
  });

  it("falls back to local when B2 keys are test placeholders", () => {
    process.env.B2_ACCESS_KEY_ID = "test-access-key";
    process.env.B2_SECRET_ACCESS_KEY = "test-secret-key";
    process.env.B2_REGION = "us-west-004";
    process.env.B2_BUCKET = "archive-bucket";
    process.env.VIDEOBOOK_ARCHIVE_DIR = join(tempDir, "archive");
    expect(getArchiveStore().kind).toBe("local");
  });

  it("honors VIDEOBOOK_ARCHIVE_DIR and defaults inside the engine root", () => {
    process.env.VIDEOBOOK_ARCHIVE_DIR = join(tempDir, "custom-archive");
    expect(localArchiveDir()).toBe(join(tempDir, "custom-archive"));
    delete process.env.VIDEOBOOK_ARCHIVE_DIR;
    expect(localArchiveDir()).toBe(join(resolve(getEngineRoot()), "archive"));
  });

  it("round-trips json, text, and bytes through the local store", async () => {
    const store = createLocalArchiveStore(join(tempDir, "archive"));
    const key = "clips/" + "a".repeat(64) + "/archive.json";

    expect(await store.getJson(key)).toBeNull();
    expect(await store.exists(key)).toBe(false);

    await store.putJson(key, { hello: "world" });
    expect(await store.exists(key)).toBe(true);
    expect(await store.getJson<{ hello: string }>(key)).toEqual({ hello: "world" });

    await store.putText("clips/x/transcript.txt", "spoken words");
    expect(await store.getText("clips/x/transcript.txt")).toBe("spoken words");
    expect(await store.getText("clips/x/missing.txt")).toBeNull();

    const bytes = await store.getBytes("clips/x/transcript.txt");
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe("spoken words");
    expect(await store.getBytes("clips/x/missing.bin")).toBeNull();
  });

  it("copies uploaded files and lists keys by prefix", async () => {
    const store = createLocalArchiveStore(join(tempDir, "archive"));
    const sourcePath = join(tempDir, "source.mp4");
    await writeFile(sourcePath, "fake-media");

    await store.uploadFile("clips/abc/original.mp4", sourcePath, "video/mp4");
    await store.putJson("clips/abc/archive.json", { ok: true });
    await store.putJson("topics/ai/abc-ingest.json", { ok: true });

    expect(new TextDecoder().decode((await store.getBytes("clips/abc/original.mp4"))!)).toBe("fake-media");

    const clipKeys = (await store.list("clips/")).map((item) => item.key);
    expect(clipKeys).toEqual(["clips/abc/archive.json", "clips/abc/original.mp4"]);

    const topicKeys = (await store.list("topics/ai/")).map((item) => item.key);
    expect(topicKeys).toEqual(["topics/ai/abc-ingest.json"]);

    const sizes = await store.list("clips/abc/original.mp4");
    expect(sizes[0]?.size).toBe("fake-media".length);
    expect(typeof sizes[0]?.lastModified).toBe("string");

    expect(await store.list("nonexistent/")).toEqual([]);
  });

  it("rejects path-traversal keys", async () => {
    const store = createLocalArchiveStore(join(tempDir, "archive"));
    await expect(store.getJson("../escape.json")).rejects.toThrow("Invalid archive key");
    await expect(store.putText("clips/../../escape.txt", "no")).rejects.toThrow("Invalid archive key");
  });

  it("returns relative /archive-files URLs from presignGet", () => {
    const store = createLocalArchiveStore(join(tempDir, "archive"));
    const signed = store.presignGet("clips/abc/original file.mp4", 3600);
    expect(signed).toEqual({
      url: "/archive-files/clips/abc/original%20file.mp4",
      expiresAt: null,
    });
    expect(localArchiveMediaUrl("a/b")).toBe("/archive-files/a/b");
  });
});
