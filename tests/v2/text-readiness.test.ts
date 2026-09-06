import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Engine, Result, SearchModality } from "videobook-engine";
import { BookManager } from "../../server/src/book-manager.js";
import { scopedBookEngine } from "../../server/src/book-context.js";
import { FFMPEG } from "../../server/src/ffmpeg.js";
import { enqueueSearchIndex } from "../../server/src/jobs/enqueue-search-index.js";
import { registerSemanticIndexJob } from "../../server/src/jobs/semantic-index.js";
import { queue, setEngineRoot } from "../../server/src/queue.js";

const execFileAsync = promisify(execFile);

/** VE-NFR-002: new metadata and an imported normalized transcript become lexically searchable within 5 s of their semantic commit. */
const READINESS_BUDGET_MS = 5_000;

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

let root: string;
let books: BookManager;
let engine: Engine;
let bookId: string;
const keys = ["VIDEOBOOK_MODEL_DOWNLOAD", "VIDEOBOOK_MODEL_CACHE_DIR"];
let previous: Array<string | undefined>;

beforeEach(async () => {
  previous = keys.map((key) => process.env[key]);
  root = await mkdtemp(join(tmpdir(), "videobook-text-readiness-"));
  process.env.VIDEOBOOK_MODEL_DOWNLOAD = "disabled";
  process.env.VIDEOBOOK_MODEL_CACHE_DIR = join(root, "missing-models");
  books = new BookManager({ libraryDir: join(root, "books") });
  bookId = value(await books.create("Readiness")).bookId;
  const managed = value(books.get(bookId));
  engine = managed.engine;
  await setEngineRoot(managed.rootDir, engine);
  registerSemanticIndexJob(scopedBookEngine);
});

afterEach(async () => {
  await queue.stop();
  await books.close();
  keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  });
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

/** Polls the public lexical query until `artifactId` is a hit; returns the elapsed time since `committedAt`. */
async function readinessMs(
  artifactId: string,
  text: string,
  modalities: SearchModality[],
  committedAt: number,
): Promise<number> {
  const deadline = committedAt + READINESS_BUDGET_MS * 3;
  while (performance.now() < deadline) {
    const page = await engine.temporalSearch.query({
      text,
      modalities,
      limit: 5,
    });
    if (page.ok && page.value.hits.some((hit) => hit.artifactId === artifactId))
      return performance.now() - committedAt;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `"${text}" did not become searchable within ${READINESS_BUDGET_MS * 3} ms`,
  );
}

it("makes committed analysis metadata and an imported transcript lexically searchable within five seconds through the real job queue", async () => {
  const videoPath = join(root, "readiness.mp4");
  await execFileAsync(FFMPEG, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=64x64:r=10:d=6",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=6",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    videoPath,
  ]);
  const artifactId = value(
    await engine.artifacts.create("video", "readiness-source"),
  ).artifactId;
  value(
    await engine.files.write(
      artifactId,
      "original.mp4",
      await readFile(videoPath),
    ),
  );
  const metadataCommittedAt = performance.now();
  value(
    await engine.files.write(
      artifactId,
      ".original.analysis.json",
      JSON.stringify({
        summary: "A quartz lantern parade drifts through the harbor",
        scenes: [
          { timestamp: 0, description: "Lanterns reflect on the water" },
        ],
        textOnScreen: ["HARBOR NIGHT"],
      }),
    ),
  );
  await enqueueSearchIndex(engine, artifactId);
  const metadataMs = await readinessMs(
    artifactId,
    "quartz lantern parade",
    ["metadata"],
    metadataCommittedAt,
  );
  expect(metadataMs).toBeLessThan(READINESS_BUDGET_MS);
  const ocrMs = await readinessMs(
    artifactId,
    '"HARBOR NIGHT"',
    ["ocr"],
    metadataCommittedAt,
  );
  expect(ocrMs).toBeLessThan(READINESS_BUDGET_MS);

  const audio = value(engine.streams.list(artifactId)).find(
    (stream) => stream.kind === "audio",
  );
  expect(audio).toBeTruthy();
  if (!audio) return;
  const source = value(await engine.files.manifest(artifactId)).files.find(
    (file) => file.name === "original.mp4",
  )!;
  const transcriptCommittedAt = performance.now();
  const transcript = value(
    await engine.transcripts.import({
      artifactId,
      streamId: audio.streamId,
      objectHash: source.objectHash,
      language: "en",
      provider: "human",
      segments: [
        {
          ordinal: 0,
          range: {
            streamId: audio.streamId,
            objectHash: source.objectHash,
            startTick: Math.floor(audio.durationTicks / 3),
            durationTicks: Math.floor(audio.durationTicks / 3),
            timeBase: audio.timeBase,
          },
          speaker: "A",
          text: "the corrected launch phrase lands here",
          kind: "speech",
          words: [],
        },
      ],
    }),
  );
  await queue.enqueue(`semantic-index-${artifactId}-transcript-${Date.now()}`, {
    type: "semantic_index",
    assetId: artifactId,
    bookId,
  } as unknown as Record<string, unknown>);
  const transcriptMs = await readinessMs(
    artifactId,
    '"corrected launch phrase"',
    ["speech"],
    transcriptCommittedAt,
  );
  expect(transcriptMs).toBeLessThan(READINESS_BUDGET_MS);
  const hit = value(
    await engine.temporalSearch.query({
      text: '"corrected launch phrase"',
      modalities: ["speech"],
      limit: 5,
    }),
  ).hits[0];
  expect(hit).toMatchObject({
    artifactId,
    excerpt: "the corrected launch phrase lands here",
    location: {
      kind: "timed",
      range: { startTick: Math.floor(audio.durationTicks / 3) },
    },
  });
  expect(transcript.segments).toHaveLength(1);
  const jobs = engine.jobs.queue.list({ type: "semantic_index" });
  expect(jobs.length).toBeGreaterThanOrEqual(2);
  expect(
    jobs.every(
      (job) =>
        job.state === "done" ||
        job.state === "running" ||
        job.state === "queued",
    ),
  ).toBe(true);
  console.info(
    `text readiness: metadata ${metadataMs.toFixed(0)} ms, ocr ${ocrMs.toFixed(0)} ms, transcript ${transcriptMs.toFixed(0)} ms`,
  );
}, 60_000);
