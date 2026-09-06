import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEngine,
  type Engine,
  type IndexManifest,
  type Result,
  type SearchHit,
  type TemporalSearchProvider,
} from "videobook-engine";
import { searchReferenceStore } from "../../server/src/search-reference-store.js";
import { semanticSearchDefs } from "../../server/src/tools/semantic-search.js";
import type { ToolDef } from "../../server/src/tools/tool-def.js";

/**
 * PRD section 13: search providers receive only scoped file/range/text inputs.
 * The application forwards a prepared reference plus an optional
 * `reference_range` window; the engine must search only the samples inside
 * that window and reject invalid or unknown inputs before any search runs.
 */
const manifest: IndexManifest = {
  manifestId: "range-scope-fixture",
  provider: "fixture",
  modelId: "fixture",
  modelRevision: "1",
  license: "test",
  embeddingSpace: "range-scope-space",
  dimensions: 3,
  modalities: ["visual", "metadata"],
  supportedLanguages: ["en"],
  preprocessingVersion: "1",
  extractorVersion: "1",
  createdAt: 1,
};

class Provider implements TemporalSearchProvider {
  readonly networkAccess = { modelDownloads: false, inference: false };
  readonly manifestId = manifest.manifestId;
  async prepare(): Promise<void> {}
  async embedText(): Promise<Float32Array> {
    return Float32Array.from([1, 0, 0]);
  }
}

const VECTORS: number[][] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function payload(result: Awaited<ReturnType<ToolDef["handler"]>>): {
  hits: SearchHit[];
} {
  expect(result.isError, result.content[0]?.text).toBeUndefined();
  return JSON.parse(result.content[0]!.text) as { hits: SearchHit[] };
}

function errorText(result: Awaited<ReturnType<ToolDef["handler"]>>): string {
  expect(result.isError).toBe(true);
  return result.content[0]?.text ?? "";
}

async function seedThreeMoments(engine: Engine): Promise<string> {
  const artifactId = value(
    await engine.artifacts.create("video", "three-moments"),
  ).artifactId;
  value(
    await engine.files.write(
      artifactId,
      "original.mp4",
      Buffer.from("three-moments"),
    ),
  );
  const objectHash = value(await engine.files.manifest(artifactId)).files[0]!
    .objectHash;
  const stream = value(
    await engine.streams.register({
      artifactId,
      sourcePath: "original.mp4",
      objectHash,
      streamIndex: 0,
      kind: "video",
      timeBase: { numerator: 1, denominator: 1_000 },
      durationTicks: 15_000,
      codec: "h264",
      video: {
        width: 64,
        height: 64,
        rotationDegrees: 0,
        pixelAspect: { numerator: 1, denominator: 1 },
      },
    }),
  );
  value(engine.temporalSearch.manifests.register(manifest));
  engine.temporalSearch.providers.register(new Provider());
  value(
    engine.temporalSearch.commitBatch({
      artifactId,
      objectHash,
      manifestId: manifest.manifestId,
      generation: "range-generation",
      phase: "visual",
      maxUnits: 3,
      observations: VECTORS.map((vector, index) => ({
        artifactId,
        objectHash,
        streamId: stream.streamId,
        range: {
          streamId: stream.streamId,
          objectHash,
          startTick: index * 5_000,
          durationTicks: 5_000,
          timeBase: stream.timeBase,
        },
        kind: "frame" as const,
        representativeTick: index * 5_000,
        segmentationVersion: "1",
        texts: [],
        embeddings: [
          {
            modality: "visual" as const,
            embeddingSpace: manifest.embeddingSpace,
            vector,
            sourceHash: `${objectHash}:${index}`,
          },
        ],
        fingerprints: [],
      })),
      coveredRanges: [
        {
          streamId: stream.streamId,
          objectHash,
          startTick: 0,
          durationTicks: 15_000,
          timeBase: stream.timeBase,
        },
      ],
      totalUnits: 3,
      complete: true,
    }),
  );
  value(
    engine.temporalSearch.activate(manifest.manifestId, "range-generation"),
  );
  value(await engine.temporalSearch.prepare());
  return artifactId;
}

describe("application reference range scoping", () => {
  let rootDir: string | undefined;
  const referenceIds: string[] = [];

  afterEach(async () => {
    referenceIds.splice(0).forEach((id) => searchReferenceStore.release(id));
    if (rootDir)
      await rm(rootDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
  });

  it("searches only the requested window of a prepared reference and rejects invalid or unknown inputs before searching", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-range-scope-"));
    const engine = createEngine({ rootDir, initialBookName: "range-scope" });
    await engine.ready;
    try {
      const artifactId = await seedThreeMoments(engine);
      const bookId = engine.book.get().bookId;
      const tool = semanticSearchDefs(engine).find(
        (entry) => entry.name === "search_moments",
      )!;
      const video = searchReferenceStore.put({
        kind: "video",
        name: "reference.mp4",
        durationMs: 15_000,
        reference: {
          kind: "video",
          embeddingSpace: manifest.embeddingSpace,
          durationMs: 15_000,
          samples: VECTORS.map((vector, index) => ({
            offsetMs: index * 5_000,
            vector,
          })),
        },
      });
      referenceIds.push(video.reference_id);
      const image = searchReferenceStore.put({
        kind: "image",
        name: "reference.png",
        reference: {
          kind: "image",
          embeddingSpace: manifest.embeddingSpace,
          vector: [0, 1, 0],
        },
      });
      referenceIds.push(image.reference_id);
      const search = (args: Record<string, unknown>) =>
        tool.handler({
          book_id: bookId,
          query: { modalities: ["visual"], limit: 5 },
          reference_id: video.reference_id,
          ...args,
        });
      const topStart = async (args: Record<string, unknown>) => {
        const hit = payload(await search(args)).hits[0];
        expect(hit?.artifactId).toBe(artifactId);
        return hit?.location.kind === "timed"
          ? hit.location.range.startTick
          : null;
      };
      expect(
        await topStart({
          reference_range: { start_seconds: 5, duration_seconds: 4 },
        }),
      ).toBe(5_000);
      expect(
        await topStart({
          reference_range: { start_seconds: 10, duration_seconds: 4 },
        }),
      ).toBe(10_000);
      expect(
        await topStart({
          reference_range: { start_seconds: 0, duration_seconds: 4 },
        }),
      ).toBe(0);
      expect(await topStart({})).toBe(0);
      expect(
        errorText(await search({ reference_range: { start_seconds: -1 } })),
      ).toContain("non-negative");
      expect(
        errorText(
          await search({
            reference_range: { start_seconds: 0, duration_seconds: 0 },
          }),
        ),
      ).toContain("positive");
      expect(
        errorText(
          await search({
            reference_range: { start_seconds: 14, duration_seconds: 0.5 },
          }),
        ),
      ).toContain("does not contain a sampled frame");
      expect(
        errorText(
          await search({
            reference_id: image.reference_id,
            reference_range: { start_seconds: 0, duration_seconds: 1 },
          }),
        ),
      ).toContain("do not accept a time range");
      await expect(
        search({ reference_id: "00000000-0000-7000-8000-000000000000" }),
      ).rejects.toThrow("expired or was released");
      expect(
        payload(await search({ reference_id: image.reference_id })).hits[0],
      ).toMatchObject({
        artifactId,
        location: { kind: "timed", range: { startTick: 5_000 } },
      });
    } finally {
      engine.close();
    }
  });
});
