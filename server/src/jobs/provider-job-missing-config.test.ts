import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { queue, setEngineRoot } from "../queue.js";
import { registerGenerateMediaJob } from "./generate-media.js";
import { registerIsolateVocalsJob } from "./isolate-vocals.js";

type MissingConfigCase = {
  name: string;
  type: string;
  key: "KIE_API_KEY" | "XAI_API_KEY";
  artifactKind: "image" | "video" | "audio";
  payload: (
    assetId: string,
    assetDir: string,
    bookId: string,
  ) => Record<string, unknown>;
};

function mediaCase(name: string, model: string, key: MissingConfigCase["key"], artifactKind: "image" | "video"): MissingConfigCase {
  return {
    name,
    type: "generate_media",
    key,
    artifactKind,
    payload: (assetId, assetDir, bookId) => ({
      type: "generate_media",
      model,
      prompt: "offline failure",
      refs: {},
      options: {},
      assetId,
      assetDir,
      bookId,
    }),
  };
}

const cases: MissingConfigCase[] = [
  mediaCase("Kie GPT Image 2.5", "kie:gpt-image-2-5-sunburst-text-to-image", "KIE_API_KEY", "image"),
  mediaCase("Kie Nano Banana", "kie:nano-banana-2-1", "KIE_API_KEY", "image"),
  mediaCase("Kie Grok text-to-video", "kie:grok-imagine/text-to-video", "KIE_API_KEY", "video"),
  mediaCase("xAI Grok video", "xai:grok-imagine-video", "XAI_API_KEY", "video"),
  {
    name: "vocal isolation",
    type: "isolate_vocals",
    key: "KIE_API_KEY",
    artifactKind: "audio",
    payload: (assetId, assetDir, bookId) => ({
      type: "isolate_vocals",
      audioPath: join(assetDir, "original.mp3"),
      audioFilename: "original.mp3",
      assetId,
      assetDir,
      bookId,
      isAudioAsset: true,
    }),
  },
];

function valueOf<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("provider job missing configuration", () => {
  let tempDir: string;
  let engineRoot: string;
  let fs: Engine;
  let originalKieKey: string | undefined;
  let originalXaiKey: string | undefined;

  beforeAll(async () => {
    originalKieKey = process.env.KIE_API_KEY;
    originalXaiKey = process.env.XAI_API_KEY;
    delete process.env.KIE_API_KEY;
    delete process.env.XAI_API_KEY;
    tempDir = await mkdtemp(join(tmpdir(), "videobook-provider-job-config-"));
    engineRoot = join(tempDir, "engine");
    fs = createEngineForTest(engineRoot);
    await setEngineRoot(engineRoot, fs);
    registerGenerateMediaJob(fs);
    registerIsolateVocalsJob(fs);
  });

  afterAll(async () => {
    await queue.stop();
    if (originalKieKey === undefined) delete process.env.KIE_API_KEY;
    else process.env.KIE_API_KEY = originalKieKey;
    if (originalXaiKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = originalXaiKey;
    closeEngineForTest(engineRoot, fs);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it.each(cases)("fails $name before provider access and persists the worker failure", async (entry) => {
    const asset = valueOf(await fs.artifacts.create(entry.artifactKind, `${entry.name} output`));
    const bookId = fs.book.get().bookId;
    const expectedMessage = `${entry.key} environment variable is not set`;

    await expect(queue.enqueueAndWait(
      `missing-config-${entry.type}-${asset.artifactId}`,
      entry.payload(asset.artifactId, asset.path, bookId),
    )).rejects.toThrow(expectedMessage);

    const job = fs.jobs.queue.list({
      type: entry.type,
      artifactId: asset.artifactId,
    })[0];
    expect(job).toMatchObject({
      type: entry.type,
      artifactId: asset.artifactId,
      state: "failed",
      error: { message: expectedMessage },
    });

    const failure = valueOf(fs.jobs.failures.read(asset.artifactId));
    expect(failure).toMatchObject({
      artifactId: asset.artifactId,
      message: expectedMessage,
    });
    const work = valueOf(fs.jobs.artifactWork.read(asset.artifactId));
    expect(work).toMatchObject({
      artifactId: asset.artifactId,
      status: "error",
      ownerId: null,
    });
  });
});
