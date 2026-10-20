import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TAG_FACETS, normalizeTag } from "videobook-engine/tag-values";
import type { Result } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "./engine.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function value<T>(result: Result<T, { message: string }>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/**
 * The engine owns tag storage outright: there is no consumer-side
 * fallback, so an engine bump that drops or reshapes this surface has to fail
 * here rather than inside a tagging job. The migration itself is the engine's
 * to test; what this guards is the shape the application codes against.
 */
describe("engine tag contract", () => {
  let tempDir: string;
  let engine: ReturnType<typeof createEngineForTest> | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-tags-"));
  });

  afterEach(async () => {
    if (engine) {
      closeEngineForTest(tempDir, engine);
      engine = undefined;
    }
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function book() {
    engine ??= createEngineForTest(tempDir);
    await engine.ready;
    return engine;
  }

  async function repoJson<T>(path: string): Promise<T> {
    return JSON.parse(await readFile(join(repoRoot, path), "utf8")) as T;
  }

  it("pins one npm engine release across both manifests, the lockfile and the install", async () => {
    const root = await repoJson<{ dependencies: Record<string, string>; allowScripts: Record<string, boolean> }>("package.json");
    const server = await repoJson<{ dependencies: Record<string, string> }>("server/package.json");
    const lock = await repoJson<{ packages: Record<string, { version?: string; resolved?: string; integrity?: string; dependencies?: Record<string, string>; bundleDependencies?: string[] }> }>("package-lock.json");
    const installed = await repoJson<{ version: string; dependencies: Record<string, string>; bundleDependencies?: string[] }>("node_modules/videobook-engine/package.json");
    const version = server.dependencies["videobook-engine"];

    expect(version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(root.dependencies["videobook-engine"]).toBe(version);
    expect(installed.version).toBe(version);
    expect(lock.packages["node_modules/videobook-engine"]).toMatchObject({
      version,
      resolved: `https://registry.npmjs.org/videobook-engine/-/videobook-engine-${version}.tgz`,
      integrity: expect.stringMatching(/^sha512-/u),
      dependencies: installed.dependencies,
    });
    expect(lock.packages["node_modules/videobook-engine"]?.bundleDependencies ?? []).toEqual(installed.bundleDependencies ?? []);
    expect(Object.keys(root.allowScripts).filter((key) => key.startsWith("file:"))).toEqual([]);
  });

  it("exposes the tag surface the application builds on", async () => {
    const { tags } = await book();
    for (const method of [
      "read",
      "readMany",
      "add",
      "addMany",
      "remove",
      "restore",
      "query",
      "candidates",
      "facets",
      "suggest",
      "readAtRevision",
      "export",
      "import",
    ] as const) {
      expect(typeof tags[method], method).toBe("function");
    }
    expect(typeof tags.automatic.snapshot).toBe("function");
    expect(typeof tags.automatic.replace).toBe("function");
    // Browser code reads facets and normalization from the subpath, never the
    // Node barrel, so the two must agree on the vocabulary.
    expect([...TAG_FACETS]).toEqual(["people", "places", "editing", "custom"]);
    expect(normalizeTag({ facet: "editing", label: " Close   Up " })).toEqual({
      facet: "editing",
      key: "close up",
      label: "Close Up",
    });
  });

  it("round-trips manual tags, dismissals and lookups on a real book", async () => {
    const scoped = await book();
    const artifact = value(await scoped.artifacts.create("video", "clip"));

    expect(value(scoped.tags.read(artifact.artifactId)).effective).toEqual([]);

    const added = value(
      await scoped.tags.add(artifact.artifactId, {
        facet: "editing",
        label: "Interview",
      }),
    );
    expect(added.effective.map((tag) => tag.key)).toEqual(["interview"]);
    expect(added.manual.map((tag) => tag.origin)).toEqual(["manual"]);

    const matches = value(scoped.tags.query({
      all: [{ facet: "editing", label: "Interview" }],
    }));
    expect(matches.artifacts.map((row) => row.artifact.artifactId)).toEqual([
      artifact.artifactId,
    ]);
    // A filter the asset does not satisfy returns nothing, which is what makes
    // the assertion above mean something.
    expect(value(scoped.tags.query({
      all: [{ facet: "places", label: "Kitchen" }],
    })).artifacts).toEqual([]);
    expect(
      value(scoped.tags.suggest({ prefix: "int" })).map((row) => row.key),
    ).toEqual(["interview"]);

    const removed = value(
      await scoped.tags.remove(artifact.artifactId, {
        facet: "editing",
        label: "Interview",
      }),
    );
    expect(removed.effective).toEqual([]);

    // Tag state outlives the process: a reopened catalog reads it back.
    closeEngineForTest(tempDir, scoped);
    engine = undefined;
    const reopened = await book();
    expect(value(reopened.tags.read(artifact.artifactId)).effective).toEqual(
      [],
    );
  });

  it("keeps automatic tags fenced to the content they described", async () => {
    const scoped = await book();
    const artifact = value(await scoped.artifacts.create("video", "fenced"));
    value(
      await scoped.files.write(
        artifact.artifactId,
        "original.mp4",
        Buffer.from("content-a"),
      ),
    );
    const analyzedHash = value(await scoped.files.manifest(artifact.artifactId))
      .files[0]!.objectHash;
    value(
      await scoped.tags.add(artifact.artifactId, {
        facet: "people",
        label: "Two people",
      }),
    );

    const analyzed = value(
      await scoped.tags.automatic.replace({
        artifactId: artifact.artifactId,
        sourceHash: analyzedHash,
        generator: "test",
        extractorVersion: "1",
        tags: [{ facet: "editing", label: "Wide shot" }],
      }),
    );
    expect(analyzed.effective.map((tag) => tag.key).sort()).toEqual([
      "two people",
      "wide shot",
    ]);
    expect(analyzed.snapshot?.sourceHash).toBe(analyzedHash);

    // Replacing the media the snapshot described retires its automatic tags —
    // the reason a tagging job fences on the content hash, not the asset
    // fingerprint — while the manual tag stays put.
    value(
      await scoped.files.write(
        artifact.artifactId,
        "original.mp4",
        Buffer.from("content-b"),
      ),
    );
    const afterEdit = value(scoped.tags.read(artifact.artifactId));
    expect(afterEdit.effective.map((tag) => tag.key)).toEqual(["two people"]);
    expect(afterEdit.manual.map((tag) => tag.key)).toEqual(["two people"]);
  });
});
