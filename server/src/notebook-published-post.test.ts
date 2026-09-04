import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "./engine.js";
import {
  allocateGenerateVideoResult,
  listGenerateVideoOutputs,
} from "./notebook-cell-outputs.js";
import {
  isPublishedPostCell,
  resolvePublishedPostSourceCell,
  sourceCellForPostedArtifact,
} from "./notebook-published-post.js";
import { createPublishedPostCell } from "./x/published-post-cell.js";
import type { PostToXResult } from "./x/post-contract.js";

function posted(overrides: Partial<PostToXResult> = {}): PostToXResult {
  return {
    status: "posted",
    tweet_id: "TWEET",
    tweet_url: "https://x.com/i/web/status/TWEET",
    media_id: "MEDIA",
    posted_at: "2026-09-04T00:00:00.000Z",
    replies: [],
    followup_error: null,
    ...overrides,
  };
}

describe("published post notebook cells", () => {
  let engine: Engine;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-published-post-"));
    engine = createEngineForTest(tempDir);
  });

  afterEach(async () => {
    closeEngineForTest(tempDir, engine);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("skips published-post cells when resolving the media holder and extract source", async () => {
    const artifact = await engine.artifacts.create("video", "clip");
    if (!artifact.ok) throw new Error(artifact.error.message);
    const notebook = await engine.notebooks.create("Main");
    if (!notebook.ok) throw new Error(notebook.error.message);
    const source = engine.notebooks.createCell({
      type: "video",
      slot: { row: 0, column: 0 },
      outputArtifactId: artifact.value.artifactId,
    });
    const written = await engine.notebooks.write({
      ...notebook.value,
      cells: [source],
    });
    if (!written.ok) throw new Error(written.error.message);

    const created = await createPublishedPostCell({
      engine,
      assetId: artifact.value.artifactId,
      posted: posted(),
    });
    expect(created).toMatchObject({ cellAddress: "@a2" });
    const after = engine.notebooks.read(notebook.value.id);
    if (!after.ok) throw new Error(after.error.message);
    const published = after.value.cells.find((cell) => cell.id === created?.cellId);
    expect(published && isPublishedPostCell(published)).toBe(true);
    expect(sourceCellForPostedArtifact(after.value, artifact.value.artifactId)?.id)
      .toBe(source.id);
    expect(resolvePublishedPostSourceCell(after.value, published!).id).toBe(source.id);
  });

  it("does not treat a published-post tile as a generation media output", async () => {
    const artifact = await engine.artifacts.create("video", "generated");
    if (!artifact.ok) throw new Error(artifact.error.message);
    const notebook = await engine.notebooks.create("Main");
    if (!notebook.ok) throw new Error(notebook.error.message);
    const producer = engine.notebooks.createCell({
      type: "generate_video",
      slot: { row: 0, column: 0 },
      prompt: "a scene",
    });
    const allocated = allocateGenerateVideoResult(engine, {
      ...notebook.value,
      cells: [producer],
    }, producer.id, {
      runId: "run-1",
      acceptedAt: "2026-09-04T00:00:00.000Z",
      artifactId: artifact.value.artifactId,
      state: "completed",
    });
    const published = engine.notebooks.createCell({
      type: "video",
      slot: { row: 0, column: 2 },
      outputArtifactId: artifact.value.artifactId,
      inputs: {
        sourceOperation: "post_to_x",
        tweetId: "TWEET",
        tweetUrl: "https://x.com/i/web/status/TWEET",
        postedAt: "2026-09-04T00:00:00.000Z",
        status: "posted",
        sourceCellId: allocated.outputCell.id,
      },
    });
    const hijack = engine.notebooks.createEdge({
      source: producer.id,
      target: published.id,
      targetInput: "media",
    });
    const document = {
      ...allocated.document,
      cells: [...allocated.document.cells, published],
      edges: [...allocated.document.edges, hijack],
    };
    const outputs = listGenerateVideoOutputs(document, producer.id);
    expect(outputs.map((match) => match.outputCell.id)).toEqual([allocated.outputCell.id]);
    expect(outputs.some((match) => isPublishedPostCell(match.outputCell))).toBe(false);
  });
});
