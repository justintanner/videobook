import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEngine,
  LOCAL_CLIP_MANIFEST,
  type Engine,
  type IndexManifest,
  type Result,
  type TemporalIndexObservation,
} from "videobook-engine";
import { FFMPEG } from "../../server/src/ffmpeg.js";
import {
  commitDeepBatches,
  deepBatchEnd,
  indexArtifact,
  MAX_BATCH_SOURCE_SECONDS,
} from "../../server/src/jobs/semantic-index.js";
import { installLocalSearchProviderFixtures, registerLocalClipSearchProvider } from "../../server/src/local-search-models.js";
import { prepareSearchVideo } from "../../server/src/search-index-media.js";

const execFileAsync = promisify(execFile);

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** Frame timestamps the way process-video/migration frames sample a video of `durationSeconds`. */
function sampledSeconds(durationSeconds: number, count: number): number[] {
  const last = durationSeconds - Math.min(0.1, durationSeconds / count);
  const step = last / (count - 1);
  return Array.from({ length: count }, (_, index) =>
    Number((step * index).toFixed(2)),
  );
}

function frameSeconds(seconds: number[], durationSeconds: number) {
  return (start: number, end: number) =>
    (end < seconds.length ? seconds[end]! : durationSeconds) - seconds[start]!;
}

const fixtureManifest: IndexManifest = {
  manifestId: "cadence-model-v1",
  provider: "fixture",
  modelId: "fixture",
  modelRevision: "1",
  embeddingSpace: "cadence-space",
  dimensions: 1,
  modalities: ["visual"],
  supportedLanguages: ["en"],
  preprocessingVersion: "1",
  extractorVersion: "1",
  createdAt: 1,
};

type CommittedBatch = {
  phase: string;
  cursor: string;
  units: number;
  coveredSeconds: number;
};

/** Records every deep-model batch commit with the source seconds its observations cover. */
function recordBatches(engine: Engine, manifestId: string): CommittedBatch[] {
  const batches: CommittedBatch[] = [];
  const original = engine.temporalSearch.commitBatch;
  engine.temporalSearch.commitBatch = (input) => {
    if (input.manifestId === manifestId) {
      const coveredSeconds = input.observations.reduce(
        (sum, item) =>
          sum +
          (item.range
            ? (item.range.durationTicks * item.range.timeBase.numerator) /
              item.range.timeBase.denominator
            : 0),
        0,
      );
      batches.push({
        phase: input.phase,
        cursor: input.cursor ?? "",
        units: input.observations.length,
        coveredSeconds,
      });
    }
    return original(input);
  };
  return batches;
}

describe("progressive deep-model batch cadence (VE-NFR-003)", () => {
  let rootDir: string | undefined;
  const keys = ["VIDEOBOOK_MODEL_DOWNLOAD", "VIDEOBOOK_MODEL_CACHE_DIR"];
  const previous = keys.map((key) => process.env[key]);

  afterEach(async () => {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    if (rootDir)
      await rm(rootDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
  });

  it("stops a batch before it covers more than 60 seconds of source and never drops below one unit", () => {
    const base = {
      artifactId: "a",
      objectHash: "h",
      manifestId: "m",
      generation: "g",
      phase: "visual" as const,
    };
    const spaced = (seconds: number, total = 30) => ({
      ...base,
      totalUnits: total,
      unitSourceSeconds: (start: number, end: number) =>
        (end - start) * seconds,
    });
    expect(deepBatchEnd(0, { ...base, totalUnits: 30 })).toBe(4);
    expect(deepBatchEnd(28, { ...base, totalUnits: 30 })).toBe(30);
    expect(deepBatchEnd(0, spaced(5))).toBe(4);
    expect(deepBatchEnd(0, spaced(15))).toBe(4);
    expect(deepBatchEnd(0, spaced(20))).toBe(3);
    expect(deepBatchEnd(0, spaced(20.69))).toBe(2);
    expect(deepBatchEnd(0, spaced(41.4))).toBe(1);
    expect(deepBatchEnd(0, spaced(248))).toBe(1);
    expect(deepBatchEnd(29, spaced(5))).toBe(30);
    const sampled = sampledSeconds(600, 30);
    const bounded = frameSeconds(sampled, 600);
    for (
      let start = 0;
      start < 30;
      start = deepBatchEnd(start, {
        ...base,
        totalUnits: 30,
        unitSourceSeconds: bounded,
      })
    ) {
      const end = deepBatchEnd(start, {
        ...base,
        totalUnits: 30,
        unitSourceSeconds: bounded,
      });
      expect(end).toBeGreaterThan(start);
      if (end - start > 1)
        expect(bounded(start, end)).toBeLessThanOrEqual(
          MAX_BATCH_SOURCE_SECONDS,
        );
    }
  });

  it("commits bounded batches through the engine and resumes from the durable cursor", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-index-cadence-"));
    const engine = createEngine({ durableWrites: false, rootDir, initialBookName: "index-cadence" });
    await engine.ready;
    try {
      const artifactId = value(
        await engine.artifacts.create("video", "ten-minute-source"),
      ).artifactId;
      value(
        await engine.files.write(
          artifactId,
          "original.mp4",
          Buffer.from("ten-minute-video"),
        ),
      );
      const source = value(await engine.files.manifest(artifactId)).files[0]!;
      const stream = value(
        await engine.streams.register({
          artifactId,
          sourcePath: source.name,
          objectHash: source.objectHash,
          streamIndex: 0,
          kind: "video",
          timeBase: { numerator: 1, denominator: 1_000 },
          durationTicks: 600_000,
          codec: "h264",
          video: {
            width: 64,
            height: 64,
            rotationDegrees: 0,
            pixelAspect: { numerator: 1, denominator: 1 },
          },
        }),
      );
      value(engine.temporalSearch.manifests.register(fixtureManifest));
      const seconds = sampledSeconds(600, 30);
      const observation = (index: number): TemporalIndexObservation => {
        const startTick = Math.round(seconds[index]! * 1_000);
        const endTick =
          index + 1 < seconds.length
            ? Math.round(seconds[index + 1]! * 1_000)
            : 600_000;
        return {
          artifactId,
          objectHash: source.objectHash,
          streamId: stream.streamId,
          range: {
            streamId: stream.streamId,
            objectHash: source.objectHash,
            startTick,
            durationTicks: endTick - startTick,
            timeBase: stream.timeBase,
          },
          kind: "frame",
          representativeTick: startTick,
          segmentationVersion: "cadence-v1",
          texts: [],
          embeddings: [
            {
              modality: "visual",
              embeddingSpace: fixtureManifest.embeddingSpace,
              vector: [1],
              sourceHash: `${source.objectHash}:${index}`,
            },
          ],
          fingerprints: [],
        };
      };
      const options = {
        artifactId,
        objectHash: source.objectHash,
        manifestId: fixtureManifest.manifestId,
        generation: "cadence-generation",
        phase: "visual" as const,
        totalUnits: 30,
        unitSourceSeconds: frameSeconds(seconds, 600),
      };
      const batches = recordBatches(engine, fixtureManifest.manifestId);
      const build = async (start: number, end: number) =>
        Array.from({ length: end - start }, (_, offset) =>
          observation(start + offset),
        );
      const controller = new AbortController();
      await expect(
        commitDeepBatches(
          engine,
          { ...options, signal: controller.signal },
          async (start, end) => {
            if (start === 4)
              controller.abort(new Error("interrupted after two batches"));
            return build(start, end);
          },
        ),
      ).rejects.toThrow("interrupted after two batches");
      expect(batches.map((batch) => batch.cursor)).toEqual(["0", "2"]);
      expect(
        value(
          engine.temporalSearch.plan(
            artifactId,
            source.objectHash,
            fixtureManifest.manifestId,
            options.generation,
          ),
        ).coverage,
      ).toEqual([
        expect.objectContaining({
          phase: "visual",
          indexedUnits: 4,
          nextCursor: "4",
          state: "partial",
        }),
      ]);
      await commitDeepBatches(engine, options, build);
      expect(batches.map((batch) => batch.cursor)).toEqual([
        "0",
        "2",
        ...Array.from({ length: 13 }, (_, index) => String(4 + index * 2)),
      ]);
      expect(
        batches.every(
          (batch) =>
            batch.units === 2 &&
            batch.coveredSeconds <= MAX_BATCH_SOURCE_SECONDS,
        ),
      ).toBe(true);
      expect(
        Math.max(...batches.map((batch) => batch.coveredSeconds)),
      ).toBeGreaterThan(40);
      expect(
        value(
          engine.temporalSearch.plan(
            artifactId,
            source.objectHash,
            fixtureManifest.manifestId,
            options.generation,
          ),
        ).coverage,
      ).toEqual([
        expect.objectContaining({
          phase: "visual",
          indexedUnits: 30,
          state: "ready",
        }),
      ]);
    } finally {
      engine.close();
    }
  });

  it(
    "bounds and resumes CLIP-shaped frame batches on a ten-minute video",
    async () => {
      rootDir = await mkdtemp(join(tmpdir(), "videobook-index-cadence-clip-"));
      process.env.VIDEOBOOK_MODEL_DOWNLOAD = "disabled";
      process.env.VIDEOBOOK_MODEL_CACHE_DIR = join(rootDir, "missing-models");
      const videoPath = join(rootDir, "ten-minutes.mp4");
      await execFileAsync(FFMPEG, [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=64x64:r=1:d=600",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        videoPath,
      ]);
      const engine = createEngine({ durableWrites: false, rootDir: join(rootDir, "book"),
      initialBookName: "clip-cadence", });
      await engine.ready;
      try {
        const artifactId = value(
          await engine.artifacts.create("video", "ten-minute-clip-source"),
        ).artifactId;
        value(
          await engine.files.write(
            artifactId,
            "original.mp4",
            await readFile(videoPath),
          ),
        );
        await prepareSearchVideo(
          engine,
          artifactId,
          new AbortController().signal,
        );
        const frames = value(
          await engine.files.listSubdir(artifactId, "original_frames"),
        ).filter((name) => name.endsWith(".jpg"));
        expect(frames).toHaveLength(30);
        const source = value(
          await engine.files.manifest(artifactId),
        ).files.find((file) => file.name === "original.mp4")!;
        installLocalSearchProviderFixtures(engine);
        const provider = registerLocalClipSearchProvider(engine);
        let embeddedFrames = 0;
        const embedImage = provider.embedImage.bind(provider);
        provider.embedImage = async (path, options) => {
          embeddedFrames += 1;
          return embedImage(path, options);
        };
        const batches = recordBatches(engine, LOCAL_CLIP_MANIFEST.manifestId);
        const original = engine.temporalSearch.commitBatch;
        const controller = new AbortController();
        engine.temporalSearch.commitBatch = (input) => {
          const committed = original(input);
          if (
            input.manifestId === LOCAL_CLIP_MANIFEST.manifestId &&
            batches.length === 2
          )
            controller.abort(new Error("interrupted CLIP indexing"));
          return committed;
        };
        await expect(
          indexArtifact(engine, artifactId, {
            semanticVisual: true,
            strictVisual: true,
            semanticAudio: false,
            signal: controller.signal,
          }),
        ).rejects.toThrow();
        expect(batches.map((batch) => batch.cursor)).toEqual(["0", "2"]);
        expect(embeddedFrames).toBe(4);
        const plan = () =>
          value(
            engine.temporalSearch.plan(
              artifactId,
              source.objectHash,
              LOCAL_CLIP_MANIFEST.manifestId,
              LOCAL_CLIP_MANIFEST.manifestId,
            ),
          ).coverage;
        expect(plan()).toEqual([
          expect.objectContaining({
            phase: "visual",
            indexedUnits: 4,
            nextCursor: "4",
            state: "partial",
          }),
        ]);
        const resumed = await indexArtifact(engine, artifactId, {
          semanticVisual: true,
          strictVisual: true,
          semanticAudio: false,
        });
        expect(resumed.semanticVisual).toBe("ready");
        expect(batches.map((batch) => batch.cursor)).toEqual([
          "0",
          "2",
          ...Array.from({ length: 13 }, (_, index) => String(4 + index * 2)),
        ]);
        expect(embeddedFrames).toBe(30);
        expect(
          batches.every(
            (batch) =>
              batch.units <= 2 &&
              batch.coveredSeconds <= MAX_BATCH_SOURCE_SECONDS,
          ),
        ).toBe(true);
        expect(
          Math.max(...batches.map((batch) => batch.coveredSeconds)),
        ).toBeGreaterThan(40);
        expect(plan()).toEqual([
          expect.objectContaining({
            phase: "visual",
            indexedUnits: 30,
            state: "ready",
          }),
        ]);
        const manifest = value(await engine.files.manifest(artifactId));
        const vector = await provider.embedImage(
          join(manifest.path, "original_frames", frames[10]!),
        );
        const found = value(
          await engine.temporalSearch.queryPrepared(
            { modalities: ["visual"], limit: 5 },
            {
              kind: "image",
              embeddingSpace: provider.embeddingSpace,
              vector: [...vector],
            },
          ),
        );
        expect(found.hits[0]?.artifactId).toBe(artifactId);
      } finally {
        engine.close();
      }
    },
    180_000,
  );
});
