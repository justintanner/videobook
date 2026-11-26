import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { CostEstimate } from "@apicity/cost";
import type { Engine, NotebookCell } from "videobook-engine";
import {
  DUB_VIDEO_MODELS,
  dubLanguageCandidates,
  estimateDubCost,
  resolveDubLanguages,
} from "../dub-video.js";
import { createEngineForTest } from "../engine.js";
import { runFfmpeg } from "../ffmpeg.js";
import { readGenerationProviderMemory } from "../generation-memory.js";
import { readGenerationModelMemory, rememberGenerationModel } from "../generation-model-memory.js";
import { runGenerateMedia, type GenerateMediaJob } from "../jobs/generate-media.js";
import { lowerBoundWarnings } from "../media/cost.js";
import { configureProviderEndpoints } from "../media/endpoints.js";
import {
  pauseBookQueueForTests,
  resumeBookQueueForTests,
  waitForJob,
  type JobHandlerContext,
  type LeaseToken,
} from "../queue.js";
import { testBudget } from "../test-budget.js";
import { createTestClient } from "../test-client.js";
import { redirectFalStorage } from "../test-short-stub.js";
import { pollPendingProviderTasks } from "./reconcile-project-work.js";
import {
  adaptCommandArgs,
  parseSlashCommandArgs,
  selectCommandForInput,
  type ServerCommand,
} from "../../../src/lib/command-registry.js";
import { prepareVoiceChatAction } from "./chat.js";
import { getCanonicalCommands } from "./commands.js";

type RecordedRequest = { method: string; path: string; body: Buffer };

type DubChatPlan = {
  kind: string;
  routedTool: string;
  tool: string;
  params: Record<string, unknown>;
  confirmation: { required: boolean; reason: string };
  estimate?: { usd: number | null; warnings: string[] };
};

type DubToolResponse = {
  dubs: Array<{ language: string; asset_id: string; job_id: string; cell_id?: string }>;
  status: string;
  estimated_usd: number;
};

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function sendBytes(response: ServerResponse, bytes: Buffer, contentType: string): void {
  response.writeHead(200, { "content-type": contentType });
  response.end(bytes);
}

function toolJson<T = Record<string, unknown>>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  const content = result.content as Array<{ type: string; text?: string }>;
  expect(result.isError, content[0]?.text).toBeFalsy();
  return JSON.parse(content[0]!.text!) as T;
}

function toolErrorText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  expect(result.isError).toBe(true);
  return (result.content as Array<{ text: string }>)[0]!.text;
}

describe("dub_video language resolution", () => {
  const candidates = dubLanguageCandidates("speed");

  it("reads the HeyGen output_language enum from the media catalog", () => {
    expect(candidates.length).toBeGreaterThan(100);
    expect(candidates).toContain("Thai (Thailand)");
    expect(candidates).toContain("Chinese (Mandarin, Simplified)");
    expect(dubLanguageCandidates("precision")).toEqual(candidates);
  });

  it("matches exact, case-insensitive, and unique bare names before parentheses", () => {
    expect(resolveDubLanguages("Spanish", candidates)).toEqual({ ok: true, languages: ["Spanish"] });
    expect(resolveDubLanguages("arabic", candidates)).toEqual({ ok: true, languages: ["Arabic"] });
    expect(resolveDubLanguages("Arabic (Egypt)", candidates)).toEqual({ ok: true, languages: ["Arabic (Egypt)"] });
    expect(resolveDubLanguages("thai", candidates)).toEqual({ ok: true, languages: ["Thai (Thailand)"] });
    expect(resolveDubLanguages("VIETNAMESE", candidates)).toEqual({ ok: true, languages: ["Vietnamese (Vietnam)"] });
  });

  it("splits comma and 'and' lists while keeping parenthesized names whole", () => {
    expect(resolveDubLanguages("thai, japanese", candidates)).toEqual({
      ok: true,
      languages: ["Thai (Thailand)", "Japanese"],
    });
    expect(resolveDubLanguages("Spanish and German", candidates)).toEqual({
      ok: true,
      languages: ["Spanish", "German"],
    });
    expect(resolveDubLanguages("thai, japanese, and spanish", candidates)).toEqual({
      ok: true,
      languages: ["Thai (Thailand)", "Japanese", "Spanish"],
    });
    expect(resolveDubLanguages("Chinese (Mandarin, Simplified)", candidates)).toEqual({
      ok: true,
      languages: ["Chinese (Mandarin, Simplified)"],
    });
    expect(resolveDubLanguages("Chinese (Mandarin, Simplified), Thai", candidates)).toEqual({
      ok: true,
      languages: ["Chinese (Mandarin, Simplified)", "Thai (Thailand)"],
    });
    expect(resolveDubLanguages("Bosnian (Bosnia and Herzegovina) and Thai", candidates)).toEqual({
      ok: true,
      languages: ["Bosnian (Bosnia and Herzegovina)", "Thai (Thailand)"],
    });
  });

  it("deduplicates resolved languages and refuses more than 5", () => {
    expect(resolveDubLanguages(["thai", "Thai (Thailand)", "THAI"], candidates)).toEqual({
      ok: true,
      languages: ["Thai (Thailand)"],
    });
    expect(resolveDubLanguages(
      ["English", "english", "Spanish", "French", "German", "Italian"],
      candidates,
    )).toEqual({
      ok: true,
      languages: ["English", "Spanish", "French", "German", "Italian"],
    });
    const tooMany = resolveDubLanguages(
      "English, Spanish, French, German, Italian, Japanese",
      candidates,
    );
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error).toContain("at most 5");
  });

  it("refuses unknown and ambiguous languages with up to 8 close candidates", () => {
    const ambiguous = resolveDubLanguages("swahili", candidates);
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.candidates).toEqual(["Swahili (Kenya)", "Swahili (Tanzania)"]);
      expect(ambiguous.error).toContain("Swahili (Kenya)");
      expect(ambiguous.error).toContain("Swahili (Tanzania)");
    }

    const typo = resolveDubLanguages("Spansh", candidates);
    expect(typo.ok).toBe(false);
    if (!typo.ok) {
      expect(typo.candidates.length).toBeGreaterThan(0);
      expect(typo.candidates.length).toBeLessThanOrEqual(8);
      expect(typo.candidates).toContain("Spanish");
      expect(typo.error).toContain("Spanish");
    }

    const prefix = resolveDubLanguages("English (", candidates);
    expect(prefix.ok).toBe(false);
    if (!prefix.ok) {
      expect(prefix.candidates.length).toBe(8);
    }

    const nonsense = resolveDubLanguages("klingon", candidates);
    expect(nonsense.ok).toBe(false);
    if (!nonsense.ok) {
      expect(nonsense.candidates.length).toBeLessThanOrEqual(8);
      expect(nonsense.error).toContain("klingon");
    }
  });
});

describe("dub_video MCP tool", () => {
  let fixtures: string;
  let sourceMp4: Buffer;
  let dubbedMp4: Buffer;
  let png: Buffer;
  let server: Server;
  let baseURL: string;
  let requests: RecordedRequest[];
  let requestCounter: number;
  let root: string;
  let engine: Engine;
  let client: Client;
  let restoreEndpoints: () => void;
  let restoreFetch: () => void;
  const originalFalKey = process.env.FAL_API_KEY;
  const originalHarMode = process.env.VIDEOBOOK_HAR_CAPTURE;

  function route(request: IncomingMessage, response: ServerResponse, body: Buffer): void {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = request.method ?? "GET";
    if (method === "POST" && path === "/rest.fal.ai/storage/upload/initiate") {
      const id = `upload-${++requestCounter}`;
      return sendJson(response, {
        upload_url: `${baseURL}/upload/${id}`,
        file_url: `${baseURL}/files/${id}.mp4`,
      });
    }
    if (method === "PUT" && path.startsWith("/upload/")) {
      response.writeHead(200);
      response.end();
      return;
    }
    if (path === "/fal-ai/heygen/v2/translate/speed" || path === "/fal-ai/heygen/v2/translate/precision") {
      const id = `heygen-req-${++requestCounter}`;
      return sendJson(response, { request_id: id, status: "IN_QUEUE" });
    }
    if (/^\/fal-ai\/heygen\/requests\/[^/]+\/status$/u.test(path)) {
      return sendJson(response, { status: "COMPLETED" });
    }
    if (/^\/fal-ai\/heygen\/requests\/[^/]+$/u.test(path)) {
      return sendJson(response, { video: { url: `${baseURL}/files/dubbed.mp4` } });
    }
    if (path === "/files/dubbed.mp4") {
      return sendBytes(response, dubbedMp4, "video/mp4");
    }
    void body;
    response.writeHead(404).end();
  }

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "videobook-dub-fixtures-"));
    const sourcePath = join(fixtures, "source.mp4");
    const dubbedPath = join(fixtures, "dubbed.mp4");
    const pngPath = join(fixtures, "frame.png");
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=2:r=12",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest",
      sourcePath,
    ]);
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "color=c=green:s=64x64:d=2:r=12",
      "-f", "lavfi", "-i", "sine=frequency=520:duration=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest",
      dubbedPath,
    ]);
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=red:s=32x32", "-frames:v", "1", pngPath]);
    sourceMp4 = await readFile(sourcePath);
    dubbedMp4 = await readFile(dubbedPath);
    png = await readFile(pngPath);

    server = createServer((request, response) => {
      void readBody(request).then((body) => {
        requests.push({ method: request.method ?? "", path: request.url ?? "", body });
        route(request, response, body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixtures, { recursive: true, force: true });
  });

  beforeEach(async () => {
    requests = [];
    requestCounter = 0;
    root = await mkdtemp(join(tmpdir(), "videobook-dub-tool-"));
    engine = createEngineForTest(root);
    client = await createTestClient(root);
    await pauseBookQueueForTests(engine.book.get().bookId);
    process.env.FAL_API_KEY = "local-fal-dub-key";
    process.env.VIDEOBOOK_HAR_CAPTURE = "off";
    restoreFetch = redirectFalStorage(baseURL);
    restoreEndpoints = configureProviderEndpoints({ falQueueBaseURL: baseURL });
  });

  afterEach(async () => {
    restoreEndpoints();
    restoreFetch();
    await client.close();
    if (originalFalKey === undefined) delete process.env.FAL_API_KEY;
    else process.env.FAL_API_KEY = originalFalKey;
    if (originalHarMode === undefined) delete process.env.VIDEOBOOK_HAR_CAPTURE;
    else process.env.VIDEOBOOK_HAR_CAPTURE = originalHarMode;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createVideoArtifact(label = "Product demo", duration = 5.2): Promise<string> {
    const created = await engine.artifacts.create("video", label);
    if (!created.ok) throw new Error(created.error.message);
    expect((await engine.files.write(created.value.artifactId, "original.mp4", sourceMp4)).ok).toBe(true);
    expect((await engine.metadata.artifacts.write(created.value.artifactId, "original", {
      duration,
      width: 64,
      height: 64,
    })).ok).toBe(true);
    return created.value.artifactId;
  }

  async function createImageArtifact(): Promise<string> {
    const created = await engine.artifacts.create("image", "Poster frame");
    if (!created.ok) throw new Error(created.error.message);
    expect((await engine.files.write(created.value.artifactId, "original.png", png)).ok).toBe(true);
    return created.value.artifactId;
  }

  async function createNotebookWithVideo(
    name: string,
    videoArtifactId: string,
  ): Promise<{ notebookId: string; sourceCellId: string }> {
    const created = await engine.notebooks.create(name);
    if (!created.ok) throw new Error(created.error.message);
    const sourceCell = engine.notebooks.createCell({
      type: "video",
      label: "Opening clip",
      slot: { row: 0, column: 0 },
      outputArtifactId: videoArtifactId,
    });
    const written = await engine.notebooks.write({
      ...created.value,
      cells: [sourceCell],
    });
    if (!written.ok) throw new Error(written.error.message);
    return { notebookId: created.value.id, sourceCellId: sourceCell.id };
  }

  async function ownerContext(assetId: string): Promise<JobHandlerContext> {
    const lease = await engine.jobs.artifactWork.begin(assetId, {
      kind: "generate",
      ownerKind: "job",
      durationMs: testBudget(60_000),
    });
    if (!lease) throw new Error("could not lease asset");
    let token: LeaseToken = { kind: "owner", ownerId: lease.ownerId };
    return {
      jobId: 1,
      signal: new AbortController().signal,
      setLease: (next) => { token = next; },
      getOwnerId: () => {
        if (token.kind !== "owner") throw new Error("lease handed off");
        return token.ownerId;
      },
      markAssetFailureHandled: () => {},
    };
  }

  function queuedGenerateJob(assetId: string): GenerateMediaJob {
    const job = engine.jobs.queue
      .list({ type: "generate_media" })
      .find((entry) => (entry.payload as GenerateMediaJob).assetId === assetId);
    if (!job) throw new Error(`no generate_media job for ${assetId}`);
    return job.payload as GenerateMediaJob;
  }

  it("refuses non-video, over-480s, unknown language, and missing FAL_API_KEY without creating artifacts or enqueueing jobs", async () => {
    const book_id = engine.book.get().bookId;
    const imageId = await createImageArtifact();
    const longVideoId = await createVideoArtifact("Long talk", 481);
    const shortVideoId = await createVideoArtifact("Short clip", 10);

    const artifactsBefore = engine.artifacts.list().length;
    const jobsBefore = engine.jobs.queue.list().length;

    expect(toolErrorText(await client.callTool({
      name: "dub_video",
      arguments: { book_id, asset_id: imageId, language: "thai" },
    }))).toContain("requires video media");

    const overLimit = toolErrorText(await client.callTool({
      name: "dub_video",
      arguments: { book_id, asset_id: longVideoId, language: "thai" },
    }));
    expect(overLimit).toContain("480");
    expect(overLimit).toContain("trim_video");

    const unknown = toolErrorText(await client.callTool({
      name: "dub_video",
      arguments: { book_id, asset_id: shortVideoId, language: "klingon" },
    }));
    expect(unknown).toContain("klingon");

    delete process.env.FAL_API_KEY;
    const missingKey = toolErrorText(await client.callTool({
      name: "dub_video",
      arguments: { book_id, asset_id: shortVideoId, language: "thai" },
    }));
    expect(missingKey).toContain("FAL_API_KEY");

    expect(engine.artifacts.list()).toHaveLength(artifactsBefore);
    expect(engine.jobs.queue.list()).toHaveLength(jobsBefore);
  });

  it("dubs a video into two languages against the local fal stand-in without altering the source", async () => {
    const book_id = engine.book.get().bookId;
    const sourceId = await createVideoArtifact("Product demo", 5.2);
    const originalBytesBefore = await engine.files.read(sourceId, "original.mp4");
    expect(originalBytesBefore.ok).toBe(true);

    const response = toolJson<DubToolResponse>(await client.callTool({
      name: "dub_video",
      arguments: {
        book_id,
        asset_id: `@${sourceId}`,
        language: "thai, japanese",
        lip_sync: false,
        speakers: 2,
        dynamic_duration: true,
      },
    }));

    expect(response.status).toBe("enqueued");
    expect(response.estimated_usd).toBeCloseTo(estimateDubCost({
      durationSeconds: 5.2,
      languageCount: 2,
      quality: "speed",
      dynamicDuration: true,
    }).usd, 6);
    expect(response.dubs).toHaveLength(2);
    expect(response.dubs.map((entry) => entry.language)).toEqual(["Thai (Thailand)", "Japanese"]);
    expect(response.dubs.every((entry) => entry.cell_id === undefined)).toBe(true);

    for (const entry of response.dubs) {
      const artifact = engine.artifacts.get(entry.asset_id);
      expect(artifact.ok && artifact.value.label).toBe(`Product demo · ${entry.language} dub`);
      const dubMeta = await engine.metadata.artifacts.read<Record<string, unknown>>(entry.asset_id, "dub");
      expect(dubMeta.ok && dubMeta.value).toEqual({
        source_artifact_id: sourceId,
        language: entry.language,
        quality: "speed",
        lip_sync: false,
      });

      const job = queuedGenerateJob(entry.asset_id);
      expect(job.model).toBe(DUB_VIDEO_MODELS.speed);
      expect(job.transcribe).toBeUndefined();
      await runGenerateMedia(engine, job, await ownerContext(entry.asset_id));
    }

    const submissions = requests
      .filter((entry) => entry.path === "/fal-ai/heygen/v2/translate/speed")
      .map((entry) => JSON.parse(entry.body.toString()) as Record<string, unknown>);
    expect(submissions).toHaveLength(2);
    expect(submissions).toEqual([
      expect.objectContaining({
        output_language: "Thai (Thailand)",
        translate_audio_only: true,
        speaker_num: 2,
        enable_dynamic_duration: true,
      }),
      expect.objectContaining({
        output_language: "Japanese",
        translate_audio_only: true,
        speaker_num: 2,
        enable_dynamic_duration: true,
      }),
    ]);

    const polled = await pollPendingProviderTasks(engine, book_id);
    expect(polled.failed).toEqual([]);
    await resumeBookQueueForTests(book_id);
    for (const completed of polled.completed) {
      await waitForJob(completed.jobId, testBudget(30_000));
    }

    for (const entry of response.dubs) {
      const manifest = await engine.files.manifest(entry.asset_id);
      expect(manifest.ok && manifest.value.files.map((file) => file.name)).toContain("original.mp4");
    }
    const originalBytesAfter = await engine.files.read(sourceId, "original.mp4");
    expect(originalBytesAfter.ok && originalBytesBefore.ok
      && originalBytesAfter.value.equals(originalBytesBefore.value)).toBe(true);
  });

  function submittedDurations(): Array<[string | undefined, unknown]> {
    return requests
      .filter((entry) => entry.method === "POST" && /^\/fal-ai\/heygen\/v2\/translate\/(?:speed|precision)$/u.test(entry.path))
      .map((entry) => [
        entry.path.split("/").at(-1),
        (JSON.parse(entry.body.toString()) as Record<string, unknown>).enable_dynamic_duration,
      ]);
  }

  async function submitDub(args: Record<string, unknown>): Promise<DubToolResponse> {
    const response = toolJson<DubToolResponse>(await client.callTool({ name: "dub_video", arguments: args }));
    for (const entry of response.dubs) {
      await runGenerateMedia(engine, queuedGenerateJob(entry.asset_id), await ownerContext(entry.asset_id));
    }
    return response;
  }

  it("sends a fixed duration to HeyGen unless dynamic duration is asked for, on both tiers, without a notebook", async () => {
    const book_id = engine.book.get().bookId;
    const asset_id = await createVideoArtifact("Wire clip", 3);
    await submitDub({ book_id, asset_id, language: "thai" });
    await submitDub({ book_id, asset_id, language: "thai", quality: "precision" });
    await submitDub({ book_id, asset_id, language: "thai", dynamic_duration: true });
    await submitDub({ book_id, asset_id, language: "thai", quality: "precision", dynamic_duration: true });
    expect(submittedDurations()).toEqual([
      ["speed", false],
      ["precision", false],
      ["speed", true],
      ["precision", true],
    ]);
  });

  it("sends a fixed duration from notebook generators, including a reused one, unless dynamic duration is asked for", async () => {
    const book_id = engine.book.get().bookId;
    const sourceId = await createVideoArtifact("Wire clip", 3);
    const { notebookId } = await createNotebookWithVideo("Dubbing", sourceId);
    const dub = (args: Record<string, unknown>) => submitDub({ book_id, notebook_id: notebookId, asset_id: "@a1", ...args });
    await dub({ language: "thai" });
    await dub({ language: "thai", quality: "precision", dynamic_duration: true });
    await dub({ language: "thai", quality: "precision" });
    await dub({ language: "japanese", dynamic_duration: true });
    expect(submittedDurations()).toEqual([
      ["speed", false],
      ["precision", true],
      ["precision", false],
      ["speed", true],
    ]);
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    expect(notebook.value.cells
      .filter((cell) => cell.type === "generate_video")
      .map((cell) => cell.inputs?.generationSettings)).toEqual([
      { output_language: "Thai (Thailand)", translate_audio_only: false, enable_dynamic_duration: false },
      { output_language: "Japanese", translate_audio_only: false, enable_dynamic_duration: true },
    ]);
  });

  it("accepts a 480s boundary video with default speed, lip_sync and fixed duration, and omits unset speakers", async () => {
    const book_id = engine.book.get().bookId;
    const sourceId = await createVideoArtifact("Eight minute clip", 480);

    const response = toolJson<DubToolResponse>(await client.callTool({
      name: "dub_video",
      arguments: { book_id, asset_id: sourceId, language: "Spanish" },
    }));

    expect(response.status).toBe("enqueued");
    expect(response.estimated_usd).toBeCloseTo(480 * 0.05, 6);
    expect(response.dubs).toHaveLength(1);
    const job = queuedGenerateJob(response.dubs[0]!.asset_id);
    expect(job.options).toEqual({
      output_language: "Spanish",
      translate_audio_only: false,
      enable_dynamic_duration: false,
    });
    expect("speaker_num" in job.options).toBe(false);
  });

  it("creates one generator per language in a notebook, reuses it on repeat dubs, and leaves generation memory unchanged", async () => {
    const book_id = engine.book.get().bookId;
    const sourceId = await createVideoArtifact("Launch clip", 8);
    const { notebookId, sourceCellId } = await createNotebookWithVideo("Dubbing", sourceId);

    const seededModel = "fal:minimax/h3/text-to-video";
    expect(engine.settings.set("generation-model-memory", { video: seededModel }).ok).toBe(true);
    expect(engine.settings.set("generation-provider-memory", { "video:minimax-h3": "fal" }).ok).toBe(true);

    const first = toolJson<DubToolResponse>(await client.callTool({
      name: "dub_video",
      arguments: {
        book_id,
        asset_id: "@a1",
        language: ["thai", "Japanese"],
      },
    }));

    expect(first.dubs).toHaveLength(2);
    expect(first.dubs.every((entry) => typeof entry.cell_id === "string")).toBe(true);

    const afterFirst = engine.notebooks.read(notebookId);
    if (!afterFirst.ok) throw new Error(afterFirst.error.message);
    const generatorsAfterFirst = afterFirst.value.cells.filter((cell) => cell.type === "generate_video");
    expect(generatorsAfterFirst).toHaveLength(2);
    for (const generator of generatorsAfterFirst) {
      expect(generator).toMatchObject({
        provider: "fal",
        model: DUB_VIDEO_MODELS.speed,
        operation: "edit_video",
        tool: "generate_video",
      });
      expect(afterFirst.value.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: sourceCellId, target: generator.id, targetInput: "video" }),
      ]));
    }
    const thaiGenerator = generatorsAfterFirst.find((cell) =>
      (cell.inputs?.generationSettings as Record<string, unknown> | undefined)?.output_language === "Thai (Thailand)")!;
    expect(thaiGenerator).toBeDefined();
    expect(thaiGenerator.inputs?.generationSettings).toEqual({
      output_language: "Thai (Thailand)",
      translate_audio_only: false,
      enable_dynamic_duration: false,
    });

    const firstThaiTake = afterFirst.value.cells.find((cell) => cell.id === first.dubs[0]!.cell_id);
    expect(firstThaiTake).toMatchObject({
      type: "video",
      outputArtifactId: first.dubs[0]!.asset_id,
      inputs: expect.objectContaining({ producerCellId: thaiGenerator.id }),
    });

    const second = toolJson<DubToolResponse>(await client.callTool({
      name: "dub_video",
      arguments: {
        book_id,
        asset_id: sourceId,
        language: "thai",
        quality: "precision",
        lip_sync: false,
      },
    }));

    expect(second.dubs).toHaveLength(1);
    const afterSecond = engine.notebooks.read(notebookId);
    if (!afterSecond.ok) throw new Error(afterSecond.error.message);
    const generatorsAfterSecond = afterSecond.value.cells.filter((cell) => cell.type === "generate_video");
    expect(generatorsAfterSecond).toHaveLength(2);

    const updatedThaiGenerator = generatorsAfterSecond.find((cell) => cell.id === thaiGenerator.id)!;
    expect(updatedThaiGenerator.model).toBe(DUB_VIDEO_MODELS.precision);
    expect(updatedThaiGenerator.inputs?.generationSettings).toEqual({
      output_language: "Thai (Thailand)",
      translate_audio_only: true,
      enable_dynamic_duration: false,
    });

    const thaiTakes = afterSecond.value.cells.filter((cell) =>
      cell.type === "video" && cell.inputs?.producerCellId === thaiGenerator.id);
    expect(thaiTakes).toHaveLength(2);
    expect(thaiTakes.map((cell) => cell.id)).toEqual(
      expect.arrayContaining([first.dubs[0]!.cell_id, second.dubs[0]!.cell_id]),
    );

    rememberGenerationModel(engine, updatedThaiGenerator as NotebookCell);
    expect(readGenerationModelMemory(engine)).toEqual({ video: seededModel });
    expect(readGenerationProviderMemory(engine)).toEqual({ "video:minimax-h3": "fal" });
  });

  it("falls back to plain generation when the source video appears in multiple notebooks and no notebook_id is given", async () => {
    const book_id = engine.book.get().bookId;
    const sourceId = await createVideoArtifact("Shared clip", 6);
    const firstNb = await createNotebookWithVideo("First", sourceId);
    const secondNb = await createNotebookWithVideo("Second", sourceId);

    const plain = toolJson<DubToolResponse>(await client.callTool({
      name: "dub_video",
      arguments: { book_id, asset_id: sourceId, language: "thai" },
    }));
    expect(plain.dubs[0]!.cell_id).toBeUndefined();
    const firstRead = engine.notebooks.read(firstNb.notebookId);
    const secondRead = engine.notebooks.read(secondNb.notebookId);
    expect(firstRead.ok && firstRead.value.cells).toHaveLength(1);
    expect(secondRead.ok && secondRead.value.cells).toHaveLength(1);

    const targeted = toolJson<DubToolResponse>(await client.callTool({
      name: "dub_video",
      arguments: { book_id, asset_id: sourceId, language: "thai", notebook_id: secondNb.notebookId },
    }));
    expect(typeof targeted.dubs[0]!.cell_id).toBe("string");
    const refreshedSecond = engine.notebooks.read(secondNb.notebookId);
    expect(refreshedSecond.ok && refreshedSecond.value.cells.filter((cell) => cell.type === "generate_video")).toHaveLength(1);
  });

  it("quotes dub_video at both tiers via estimate_cost as a lower bound", async () => {
    const book_id = engine.book.get().bookId;
    const sourceId = await createVideoArtifact("Quote clip", 5.2);

    const payload = toolJson<{
      estimate: CostEstimate;
      per_call: Array<{ tool_name: string; estimate: CostEstimate }>;
    }>(await client.callTool({
      name: "estimate_cost",
      arguments: {
        calls: [
          { tool_name: "dub_video", input: { book_id, asset_id: sourceId, language: "thai, japanese", quality: "speed" } },
          { tool_name: "dub_video", input: { book_id, asset_id: sourceId, language: "Spanish", quality: "precision", dynamic_duration: true } },
        ],
      },
    }));

    const speed = payload.per_call[0]!.estimate;
    const precision = payload.per_call[1]!.estimate;
    expect(speed.usd).toBeCloseTo(6 * 0.05 * 2, 6);
    expect(speed.breakdown).toEqual({ units: 12, unit: "seconds", perUnitUsd: 0.05 });
    expect(lowerBoundWarnings(speed.warnings)).toBe(true);
    expect(speed.warnings[0]).toContain("dynamic_duration");

    expect(precision.usd).toBeCloseTo(6 * 0.1 * 1, 6);
    expect(precision.breakdown).toEqual({ units: 6, unit: "seconds", perUnitUsd: 0.1 });
    expect(lowerBoundWarnings(precision.warnings)).toBe(true);
    expect(precision.warnings[0]).toContain("dynamic_duration");

    expect(payload.estimate.usd).toBeCloseTo(speed.usd + precision.usd, 6);
  });

  function generatorSettings(notebookId: string): Array<[string | undefined, unknown]> {
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    return notebook.value.cells
      .filter((cell) => cell.type === "generate_video")
      .map((cell) => [cell.model, (cell.inputs?.generationSettings as Record<string, unknown> | undefined)?.output_language]);
  }

  it("runs what /dub and /translate-video build once their review is applied", async () => {
    const book_id = engine.book.get().bookId;
    const sourceId = await createVideoArtifact("Launch clip", 3);
    const { notebookId } = await createNotebookWithVideo("Dubbing", sourceId);
    const commands = getCanonicalCommands() as ServerCommand[];
    const slash = (input: string): Record<string, unknown> => {
      const [token = "", ...words] = input.split(/\s+/u);
      const rest = words.join(" ");
      const command = selectCommandForInput(commands, token, rest);
      if (!command?.mcpTool) throw new Error(`${token} has no tool`);
      expect(command.mcpTool.tool).toBe("dub_video");
      return {
        book_id,
        notebook_id: notebookId,
        ...adaptCommandArgs(command.mcpTool.adapter, parseSlashCommandArgs(command, rest)),
      };
    };

    const thai = toolJson<DubToolResponse>(await client.callTool({ name: "dub_video", arguments: slash("/dub @a1 thai") }));
    expect(thai.dubs.map((entry) => entry.language)).toEqual(["Thai (Thailand)"]);
    expect(thai.estimated_usd).toBeCloseTo(3 * 0.05, 6);
    expect(generatorSettings(notebookId)).toEqual([[DUB_VIDEO_MODELS.speed, "Thai (Thailand)"]]);

    const pair = toolJson<DubToolResponse>(await client.callTool({
      name: "dub_video",
      arguments: slash("/dub @a1 thai, japanese precision"),
    }));
    expect(pair.dubs.map((entry) => entry.language)).toEqual(["Thai (Thailand)", "Japanese"]);
    expect(pair.estimated_usd).toBeCloseTo(2 * 3 * 0.1, 6);
    expect(generatorSettings(notebookId)).toEqual([
      [DUB_VIDEO_MODELS.precision, "Thai (Thailand)"],
      [DUB_VIDEO_MODELS.precision, "Japanese"],
    ]);

    const alias = toolJson<DubToolResponse>(await client.callTool({
      name: "dub_video",
      arguments: slash("/translate-video @a1 Spanish voice-only"),
    }));
    expect(alias.dubs.map((entry) => entry.language)).toEqual(["Spanish"]);
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const spanish = notebook.value.cells.find((cell) =>
      (cell.inputs?.generationSettings as Record<string, unknown> | undefined)?.output_language === "Spanish");
    expect(spanish).toMatchObject({ model: DUB_VIDEO_MODELS.speed });
    expect(spanish?.inputs?.generationSettings).toEqual({
      output_language: "Spanish",
      translate_audio_only: true,
      enable_dynamic_duration: false,
    });
  });

  it("plans a chat dub with its price and runs dub_video only once the plan is approved", async () => {
    const book_id = engine.book.get().bookId;
    const sourceId = await createVideoArtifact("Launch clip", 4.2);
    const { notebookId } = await createNotebookWithVideo("Dubbing", sourceId);
    const jobsBefore = engine.jobs.queue.list().length;
    const artifactsBefore = engine.artifacts.list().length;

    const plan = toolJson<DubChatPlan>(await client.callTool({
      name: "chat",
      arguments: { book_id, notebook_id: notebookId, prompt: "dub @a1 into Thai" },
    }));
    expect(plan).toMatchObject({
      kind: "chat-action-plan",
      routedTool: "dub_video",
      tool: "dub_video",
      params: { asset_id: sourceId, language: ["Thai (Thailand)"], notebook_id: notebookId },
      confirmation: { required: true },
    });
    expect(plan.confirmation.reason).toContain("spends provider money");
    expect(plan.estimate?.usd).toBeCloseTo(5 * 0.05, 6);
    expect(lowerBoundWarnings(plan.estimate?.warnings ?? [])).toBe(true);
    expect(engine.jobs.queue.list()).toHaveLength(jobsBefore);
    expect(engine.artifacts.list()).toHaveLength(artifactsBefore);

    const applied = toolJson<DubToolResponse>(await client.callTool({
      name: "chat",
      arguments: { book_id, action_plan: plan },
    }));
    expect(applied.status).toBe("enqueued");
    expect(applied.dubs.map((entry) => entry.language)).toEqual(["Thai (Thailand)"]);
    expect(generatorSettings(notebookId)).toEqual([[DUB_VIDEO_MODELS.speed, "Thai (Thailand)"]]);

    const precise = toolJson<DubChatPlan>(await client.callTool({
      name: "chat",
      arguments: { book_id, notebook_id: notebookId, prompt: "make a Japanese and Korean version of @a1 with the best lip sync" },
    }));
    expect(precise.params).toMatchObject({ language: ["Japanese", "Korean"], quality: "precision" });
    expect(precise.estimate?.usd).toBeCloseTo(2 * 5 * 0.1, 6);
  });

  it("resolves a routed dub's languages at plan time and refuses one that does not resolve", async () => {
    const book_id = engine.book.get().bookId;
    const sourceId = await createVideoArtifact("Launch clip", 4);
    const { notebookId } = await createNotebookWithVideo("Dubbing", sourceId);
    const jobsBefore = engine.jobs.queue.list().length;
    const routed = await prepareVoiceChatAction(engine, {
      book_id,
      notebook_id: notebookId,
      prompt: "put this clip into thai and japanese, voice only",
    }, {
      tool: "dub_video",
      params: { asset_id: sourceId, language: "thai and japanese" },
      message: "Dubbing video.",
    });
    const plan = toolJson<DubChatPlan>(routed as Awaited<ReturnType<Client["callTool"]>>);
    expect(plan.params).toMatchObject({ language: ["Thai (Thailand)", "Japanese"], lip_sync: false });
    expect(plan.estimate?.usd).toBeCloseTo(2 * 4 * 0.05, 6);

    const refused = await prepareVoiceChatAction(engine, {
      book_id,
      notebook_id: notebookId,
      prompt: "dub @a1 into Swahili",
    }, {
      tool: "dub_video",
      params: { asset_id: sourceId, language: "Swahili" },
      message: "Dubbing video.",
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain("Swahili (Kenya), Swahili (Tanzania)");
    expect(engine.jobs.queue.list()).toHaveLength(jobsBefore);
  });
});
