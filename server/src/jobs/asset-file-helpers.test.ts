import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Engine } from "videobook-engine";

import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { downloadUrlIntoAsset } from "./_download-into-asset.js";
import { replaceArtifactFileFromPath } from "./_persist-output.js";

describe("asset file helpers", () => {
  let engineRoot: string;
  let engine: Engine;
  let assetId: string;

  beforeEach(async () => {
    engineRoot = await mkdtemp(join(tmpdir(), "videobook-asset-files-"));
    engine = createEngineForTest(engineRoot);
    const created = await engine.artifacts.create("img", "asset file helper");
    if (!created.ok) throw new Error(created.error.message);
    assetId = created.value.artifactId;
  });

  afterEach(async () => {
    closeEngineForTest(engineRoot, engine);
    await rm(engineRoot, { recursive: true, force: true, maxRetries: 3 });
  });

  it("downloads bytes directly into the scoped engine", async () => {
    const downloaded = await downloadUrlIntoAsset(
      engine,
      "data:text/plain;base64,aGVsbG8=",
      assetId,
      "original.txt",
    );

    expect(downloaded).toEqual(Buffer.from("hello"));
    const stored = await engine.files.read(assetId, "original.txt");
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.value).toEqual(downloaded);
  });

  it("reports the requested media kind when persistence fails", async () => {
    await expect(downloadUrlIntoAsset(
      engine,
      "data:text/plain;base64,aGVsbG8=",
      "missing-artifact",
      "original.txt",
      { kind: "transcript" },
    )).rejects.toThrow("Failed to persist transcript");
  });

  it("moves a workspace result into the artifact and removes the source", async () => {
    const sourcePath = join(engineRoot, "rendered.txt");
    await writeFile(sourcePath, "rendered result");

    await replaceArtifactFileFromPath(
      engine,
      assetId,
      "rendered.txt",
      sourcePath,
    );

    const stored = await engine.files.read(assetId, "rendered.txt");
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.value.toString("utf8")).toBe("rendered result");
    await expect(access(sourcePath)).rejects.toThrow();
  });
});
