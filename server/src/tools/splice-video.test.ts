import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { v7 as uuidv7 } from "uuid";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { spliceVideoDef } from "./splice-video.js";
import type { Engine } from "videobook-engine";

describe("splice_video tool", () => {
  let root: string;
  let engine: Engine;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-splice-tool-"));
    engine = createEngineForTest(root);
  });

  afterAll(async () => {
    closeEngineForTest(root, engine);
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("accepts additional clips and defaults overlap to 0", () => {
    const parsed = z.object(spliceVideoDef(engine).schema).safeParse({
      first_asset_id: uuidv7(),
      second_asset_id: uuidv7(),
      additional_asset_ids: [uuidv7(), uuidv7()],
      book_id: engine.book.get().bookId,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.overlap).toBe(0);
    expect(parsed.data.additional_asset_ids).toHaveLength(2);
  });

  it("rejects duplicate clip ids", async () => {
    const assetId = uuidv7();
    const result = await spliceVideoDef(engine).handler({
      first_asset_id: assetId,
      second_asset_id: assetId,
      book_id: engine.book.get().bookId,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("unique");
  });
});
