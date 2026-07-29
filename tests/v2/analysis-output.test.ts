import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "videobook-engine";
import { buildAssetList } from "../../server/src/tools/sync.js";

describe("Analysis output assets", () => {
  let rootDir: string;
  let engine: Engine;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-analysis-output-"));
    engine = createEngine({
      rootDir,
      initialBookSlug: "analysis-output",
    });
    await engine.ready;
  });

  afterEach(async () => {
    engine.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("projects normalized shot metadata through asset sync", async () => {
    const created = await engine.artifacts.create({
      kind: "script",
      name: "analysis projection",
    });
    if (!created.ok) throw new Error(created.error.message);
    const written = await engine.metadata.artifacts.write(
      created.value.artifactId,
      "original",
      {
        analysisInfo: {
          sourceDurationSeconds: 16,
          shots: [{
            ordinal: 1,
            label: "Opening",
            startSeconds: 0,
            endSeconds: 8,
            durationSeconds: 8,
          }],
        },
      },
    );
    expect(written.ok).toBe(true);
    const outputJson = {
      version: 2,
      request: {
        provider: "openai",
        model: "gpt-5.6-sol",
        mode: "live",
      },
      raw: {
        shots: [{
          startSeconds: 0,
          endSeconds: 16,
          label: "Opening",
          prompt: "A presenter opens the segment.",
        }],
      },
      shots: [{
        ordinal: 1,
        label: "Opening",
        startSeconds: 0,
        endSeconds: 16,
        durationSeconds: 16,
        prompt: "A presenter opens the segment.",
      }],
      sourceDurationSeconds: 16,
      normalizedAt: "2026-07-29T00:00:00.000Z",
    };
    const outputWritten = await engine.files.write(
      created.value.artifactId,
      "analysis.json",
      JSON.stringify(outputJson),
    );
    expect(outputWritten.ok).toBe(true);

    const assets = await buildAssetList(
      engine,
      engine.book.get().bookId,
    );
    expect(assets[0]?.analysis_info).toEqual({
      source_duration_seconds: 16,
      output_json: outputJson,
      shots: [{
        ordinal: 1,
        label: "Opening",
        start_seconds: 0,
        end_seconds: 8,
        duration_seconds: 8,
      }],
    });
  });
});
