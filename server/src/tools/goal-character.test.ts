import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { getChainRun, waitForChainRun } from "../chain-executor.js";
import { revalidatePinnedTargets } from "../chain-plan.js";
import { createEngineForTest } from "../engine.js";
import { forgetAsset } from "../forget-asset.js";
import { readMainCharacter, saveMainCharacter, type MainCharacterView } from "../goal-short-character.js";
import { createShortGoal } from "../goal-short-runtime.js";
import { copyVideoFixture } from "../test-media-fixtures.js";
import type { ShortGoalSnapshot } from "./goal.js";
import { installFalDynamicEstimator } from "../media/cost.js";
import { configureProviderEndpoints } from "../media/endpoints.js";
import { configureProviderPollDriverForTests, resetProviderPollDriverForTests } from "../queue.js";
import { testBudget } from "../test-budget.js";
import { createTestClient } from "../test-client.js";
import { goalTestCharacters } from "../test-goals.js";

const SETTING_KEY = "application.goal.main-character.v1";
const SHEET_VIEWS = "the same person three times on a plain light grey background, a front view, a three-quarter view and a full-body view, neutral expression, mouth closed, even daylight.";
const SHEET_PROMPT = `Character reference sheet of a man in a green shirt: ${SHEET_VIEWS}`;
const EDIT_SHEET_PROMPT = `Character reference sheet of the person in reference image 1 and reference image 2 (a man in a green shirt): ${SHEET_VIEWS}\n\nKeep the face, hair, build and clothes from reference image 1 and reference image 2 exactly.`;
const FAL_STORAGE_HOST = "rest.fal.ai";
const FREE_HOSTS = new Set(["litterbox.catbox.moe", "uguu.se", "tmpfile.link"]);
const BLOCKED_SHEET = "Request blocked by the content policy";

type Submission = { path: string; body: Record<string, unknown> };

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

describe("video_goal character", () => {
  let server: Server;
  let baseURL: string;
  let sheetPng: Buffer;
  let submissions: Submission[];
  let uploads: string[];
  let unexpected: string[];
  let failNextSheet: boolean;
  let failingRequests: Set<string>;
  let requestCount = 0;
  let root: string;
  let engine: Engine;
  let client: Client;
  let bookId: string;
  let notebookId: string;
  let imageIds: string[];
  let originalFetch: typeof fetch;
  let restoreEndpoints: () => void;
  let restoreEstimator: () => void;
  const savedEnv = new Map<string, string | undefined>();

  function route(method: string, path: string, body: Buffer, response: ServerResponse): void {
    if (method === "POST" && path.startsWith("/openai/gpt-image-2.6/sunburst/")) {
      const requestId = `sheet-${++requestCount}`;
      if (failNextSheet) failingRequests.add(requestId);
      failNextSheet = false;
      submissions.push({ path, body: JSON.parse(body.toString()) as Record<string, unknown> });
      return sendJson(response, { request_id: requestId, status: "IN_QUEUE" });
    }
    const status = /^\/openai\/gpt-image-2\.6\/requests\/([^/]+)\/status$/u.exec(path);
    if (status) {
      return sendJson(response, failingRequests.has(status[1]!) ? { status: "COMPLETED", error: BLOCKED_SHEET } : { status: "COMPLETED" });
    }
    if (/^\/openai\/gpt-image-2\.6\/requests\/[^/]+$/u.test(path)) {
      return sendJson(response, { images: [{ url: `${baseURL}/files/sheet.png`, content_type: "image/png", width: 160, height: 90 }] });
    }
    if (method === "GET" && path === "/files/sheet.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(sheetPng);
      return;
    }
    if (method === "POST" && path === `/${FAL_STORAGE_HOST}/storage/upload/initiate`) {
      const { file_name: name } = JSON.parse(body.toString()) as { file_name: string };
      return sendJson(response, { file_url: `${baseURL}/files/${name}`, upload_url: `${baseURL}/fal-storage/${name}` });
    }
    if (method === "PUT" && path.startsWith("/fal-storage/")) {
      uploads.push(path.slice("/fal-storage/".length));
      response.end();
      return;
    }
    unexpected.push(`${method} ${path}`);
    response.writeHead(FREE_HOSTS.has(path.split("/")[1] ?? "") ? 503 : 404).end();
  }

  beforeAll(async () => {
    sheetPng = await sharp({ create: { width: 160, height: 90, channels: 3, background: "#4f7f4a" } }).png().toBuffer();
    server = createServer((request, response) => {
      void readBody(request).then((body) => route(request.method ?? "", new URL(request.url ?? "/", "http://127.0.0.1").pathname, body, response));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    submissions = [];
    uploads = [];
    unexpected = [];
    failNextSheet = false;
    failingRequests = new Set();
    for (const [key, value] of [["FAL_API_KEY", "local-fal-key"], ["VIDEOBOOK_HAR_CAPTURE", "off"]] as const) {
      savedEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.hostname === FAL_STORAGE_HOST || FREE_HOSTS.has(url.hostname)
        ? originalFetch(`${baseURL}/${url.hostname}${url.pathname}${url.search}`, init)
        : originalFetch(input, init);
    };
    restoreEndpoints = configureProviderEndpoints({ falQueueBaseURL: baseURL });
    restoreEstimator = installFalDynamicEstimator(null);
    configureProviderPollDriverForTests({ intervalMs: 50 });
    root = await mkdtemp(join(tmpdir(), "videobook-goal-character-"));
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    bookId = engine.book.get().bookId;
    const notebook = await engine.notebooks.create("Shorts");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
    imageIds = await goalTestCharacters(engine, notebookId);
  });

  afterEach(async () => {
    await client?.close();
    resetProviderPollDriverForTests();
    restoreEstimator();
    restoreEndpoints();
    globalThis.fetch = originalFetch;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  const raw = (args: Record<string, unknown>) => client.callTool({
    name: "video_goal",
    arguments: { book_id: bookId, notebook_id: notebookId, action: "character", ...args },
  });
  const textOf = (result: Awaited<ReturnType<typeof raw>>) => (result.content as Array<{ text: string }>)[0]!.text;

  async function character(args: Record<string, unknown> = {}): Promise<MainCharacterView> {
    const result = await raw(args);
    expect(result.isError, textOf(result)).toBeFalsy();
    return JSON.parse(textOf(result)) as MainCharacterView;
  }

  async function refusal(args: Record<string, unknown>): Promise<string> {
    const result = await raw(args);
    expect(result.isError, textOf(result)).toBe(true);
    return textOf(result);
  }

  const storedSetting = () => engine.settings.get<unknown>(SETTING_KEY) ?? null;
  const chainRunCount = () => Object.keys(engine.settings.get<{ runs: Record<string, unknown> }>("application.chain-runs.v1")?.runs ?? {}).length;

  it("reads the default silent character on a fresh book and writes nothing", async () => {
    expect(await character()).toEqual({
      character: { name: "Main character", description: "a man in a green shirt", silent: true },
      references: [],
      notes: [],
      sheet: { estimate: { usd: null, warnings: [expect.any(String)] }, pending: null, lastError: null },
    });
    expect(storedSetting()).toBeNull();
    expect(readMainCharacter(engine)).toEqual({
      version: 1, name: "Main character", description: "a man in a green shirt", silent: true,
      referenceArtifactIds: [], pending: null, lastError: null, updatedAt: null,
    });
    expect(storedSetting()).toBeNull();
  });

  it("saves a name, a description and image cells by grid address, and reads them back at their current addresses", async () => {
    const saved = await character({ name: "Mr Green", description: "a tall man in a green shirt and jeans", reference_ids: ["@a2", "@a1"] });
    expect(saved.character).toEqual({ name: "Mr Green", description: "a tall man in a green shirt and jeans", silent: true });
    expect(saved.references).toEqual([
      { artifactId: imageIds[1], address: "@a2", label: "Character 2" },
      { artifactId: imageIds[0], address: "@a1", label: "Character 1" },
    ]);
    expect(readMainCharacter(engine)).toMatchObject({ name: "Mr Green", referenceArtifactIds: [imageIds[1], imageIds[0]], pending: null });
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const moved = await engine.notebooks.write({
      ...notebook.value,
      cells: notebook.value.cells.map((cell) => cell.outputArtifactId === imageIds[0] ? { ...cell, slot: { row: 2, column: 3 } } : cell),
    });
    if (!moved.ok) throw new Error(moved.error.message);
    expect((await character()).references.map((reference) => reference.address)).toEqual(["@a2", "@c4"]);
    const other = await engine.notebooks.create("Elsewhere");
    if (!other.ok) throw new Error(other.error.message);
    const elsewhere = await client.callTool({ name: "video_goal", arguments: { book_id: bookId, notebook_id: other.value.id, action: "character" } });
    expect((JSON.parse(textOf(elsewhere)) as MainCharacterView).references.map((reference) => reference.address)).toEqual([null, null]);
  });

  it("skips a character reference it cannot use, and saves nothing when none remain", async () => {
    const video = await engine.artifacts.create("video", "Street clip");
    if (!video.ok) throw new Error(video.error.message);
    const inserted = await engine.notebooks.insertCell(notebookId, engine.notebooks.createCell({ type: "video", label: "Street clip", slot: { row: 0, column: 2 }, outputArtifactId: video.value.artifactId }));
    if (!inserted.ok) throw new Error(inserted.error.message);
    const loose = await engine.artifacts.create("image", "Loose image");
    if (!loose.ok) throw new Error(loose.error.message);
    expect(await refusal({ reference_ids: ["@h8"] })).toBe("@h8 is empty and was skipped.");
    expect(await refusal({ reference_ids: [loose.value.artifactId] })).toBe(`@${loose.value.artifactId} is not an image cell and was skipped.`);
    expect(await refusal({ reference_ids: ["@a3"] })).toBe("@a3 is a video, but its frame could not be read, so it was skipped.");
    await expect(saveMainCharacter(engine, { description: " " })).rejects.toThrow("The main character's description must be 1 to 400 characters.");
    expect(storedSetting()).toBeNull();
    const mixed = await character({ reference_ids: ["@a1", "@h8", "@a3"] });
    expect(mixed.references.map((reference) => reference.artifactId)).toEqual([imageIds[0]]);
    expect(mixed.notes).toEqual([
      "@h8 is empty and was skipped.",
      "@a3 is a video, but its frame could not be read, so it was skipped.",
    ]);
  });

  it("uses a video cell as a character reference by its extracted frame", async () => {
    const clip = join(root, "street.mp4");
    await copyVideoFixture({ width: 160, height: 90, durationSec: 2, fps: 12, source: "color", color: "green", audio: { frequency: 330 } }, clip);
    const video = await engine.artifacts.create("video", "Street clip");
    if (!video.ok) throw new Error(video.error.message);
    const written = await engine.files.writeFromPath(video.value.artifactId, "original.mp4", clip);
    if (!written.ok) throw new Error(written.error.message);
    const inserted = await engine.notebooks.insertCell(notebookId, engine.notebooks.createCell({ type: "video", label: "Street clip", slot: { row: 0, column: 2 }, outputArtifactId: video.value.artifactId }));
    if (!inserted.ok) throw new Error(inserted.error.message);
    const saved = await character({ reference_ids: ["@a3"] });
    expect(saved.references).toEqual([{
      artifactId: expect.any(String),
      address: expect.stringMatching(/^@[a-z]+\d$/u),
      label: "Frame of @a3",
    }]);
    expect(saved.references[0]!.artifactId).not.toBe(video.value.artifactId);
    expect(saved.notes).toEqual([`@a3 is a video, so its frame at 1.0 s (${saved.references[0]!.address}) is the reference.`]);
    expect(readMainCharacter(engine).referenceArtifactIds).toEqual([saved.references[0]!.artifactId]);
    expect(submissions).toEqual([]);
  });

  async function placedImage(column: number, label: string): Promise<string> {
    const created = await engine.artifacts.create("image", label);
    if (!created.ok) throw new Error(created.error.message);
    const written = await engine.files.write(created.value.artifactId, "original.png", await sharp({ create: { width: 96, height: 128, channels: 3, background: "#888888" } }).png().toBuffer());
    if (!written.ok) throw new Error(written.error.message);
    const inserted = await engine.notebooks.insertCell(notebookId, engine.notebooks.createCell({ type: "image", label, slot: { row: 0, column }, outputArtifactId: created.value.artifactId }));
    if (!inserted.ok) throw new Error(inserted.error.message);
    return created.value.artifactId;
  }

  it("keeps the first four character references and notes the rest", async () => {
    const extra = await Promise.all([2, 3, 4].map((column) => placedImage(column, `Extra ${column}`)));
    const saved = await character({ reference_ids: ["@a1", "@a2", "@a3", "@a4", "@a5"] });
    expect(saved.references.map((reference) => reference.artifactId)).toEqual([imageIds[0], imageIds[1], extra[0], extra[1]]);
    expect(saved.notes).toEqual(["@a5 was skipped because the main character takes at most 4 reference images."]);
    const repeated = await character({ reference_ids: ["@a1", "@a2", "@a1", "@a2", "@a1"] });
    expect(repeated.references.map((reference) => reference.artifactId)).toEqual(imageIds);
    expect(repeated.notes).toEqual([]);
  });

  it("refuses a character sheet without FAL_API_KEY before saving or creating a chain", async () => {
    delete process.env.FAL_API_KEY;
    expect(await refusal({ generate: true, description: "a man in a red shirt" })).toBe("Set FAL_API_KEY in Settings before generating a character sheet.");
    expect(chainRunCount()).toBe(0);
    expect(storedSetting()).toBeNull();
    expect(submissions).toEqual([]);
  });

  it("draws a character sheet with GPT Image 2.6 text-to-image on fal and adopts it as the only reference", async () => {
    const started = await character({ generate: true });
    expect(started.sheet.pending).toEqual({ chainId: expect.any(String), stepId: "sheet", notebookId });
    const chainId = started.sheet.pending!.chainId;
    expect(getChainRun(engine, chainId)?.steps.map((step) => [step.tool, step.params.model])).toEqual([["generate_image", "fal:openai/gpt-image-2.6/sunburst/text-to-image"]]);
    expect((await character({ generate: true })).sheet.pending?.chainId).toBe(chainId);
    expect(chainRunCount()).toBe(1);
    await expect.poll(() => submissions.length, { timeout: testBudget(30_000) }).toBe(1);
    expect(submissions[0]).toEqual({
      path: "/openai/gpt-image-2.6/sunburst/text-to-image",
      body: expect.objectContaining({ prompt: SHEET_PROMPT, image_size: "landscape_16_9", quality: "high", num_images: 1 }),
    });
    const run = await waitForChainRun(engine, chainId, testBudget(60_000));
    expect(run.status, run.error ?? run.steps[0]?.error ?? "").toBe("completed");
    const sheetId = String(run.steps[0]!.outputs?.asset_id);
    const done = await character();
    expect(done.references).toEqual([{ artifactId: sheetId, address: expect.stringMatching(/^@[a-z]+\d$/u), label: expect.any(String) }]);
    expect(done.sheet).toMatchObject({ pending: null, lastError: null });
    expect(readMainCharacter(engine)).toMatchObject({ referenceArtifactIds: [sheetId], pending: null, lastError: null });
    const goal = await createShortGoal(engine, bookId, notebookId, {
      brief: 'he waits, frame: "He stands at a bus stop." beat 1: "He watches the road."',
      requestId: "generated-character-short",
    });
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const sheetCell = notebook.value.cells.find((cell) => cell.outputArtifactId === sheetId)!;
    const review = JSON.parse(textOf(await raw({ action: "status", goal_id: goal.goalId }))) as ShortGoalSnapshot;
    const approved = await raw({ action: "approve", goal_id: goal.goalId, revision: review.revision });
    expect(approved.isError, textOf(approved)).toBeFalsy();
    const snapshot = JSON.parse(textOf(approved)) as ShortGoalSnapshot;
    expect(snapshot.shortPlan!.character.references[0]).toMatchObject({ artifactId: sheetId, cellId: sheetCell.id });
    const frameRun = await waitForChainRun(engine, snapshot.chainId!, testBudget(60_000));
    expect(frameRun.status, frameRun.error ?? "").toBe("completed");
    expect(await revalidatePinnedTargets(engine, notebookId, [{
      ...snapshot.shortPlan!.character.references[0]!, field: "refs.image", index: 0, artifactId: imageIds[0]!,
    }]))
      .toContain("no longer points at the same artifact");
    expect(unexpected).toEqual([]);
  });

  it("edits the saved references with GPT Image 2.6 and keeps them when the sheet fails, reporting the error once", async () => {
    await character({ reference_ids: ["@a1", "@a2"] });
    failNextSheet = true;
    const started = await character({ generate: true });
    const chainId = started.sheet.pending!.chainId;
    await expect.poll(() => submissions.length, { timeout: testBudget(30_000) }).toBe(1);
    expect(submissions[0]).toEqual({
      path: "/openai/gpt-image-2.6/sunburst/edit",
      body: expect.objectContaining({ prompt: EDIT_SHEET_PROMPT, image_size: "landscape_16_9", quality: "high" }),
    });
    expect(uploads).toHaveLength(2);
    expect(submissions[0]!.body.image_urls).toEqual(uploads.map((name) => `${baseURL}/files/${name}`));
    const run = await waitForChainRun(engine, chainId, testBudget(60_000));
    expect(run.status).toBe("failed");
    expect(run.steps[0]).toMatchObject({ status: "failed", error: expect.stringContaining(BLOCKED_SHEET) });
    const failed = await character();
    expect(failed.references.map((reference) => reference.artifactId)).toEqual(imageIds);
    expect(failed.sheet.pending).toBeNull();
    expect(failed.sheet.lastError).toMatch(/^The character sheet was not made: .*content policy/u);
    expect((await character()).sheet.lastError).toBeNull();
    expect(readMainCharacter(engine)).toMatchObject({ referenceArtifactIds: imageIds, pending: null, lastError: null });
    expect(unexpected).toEqual([]);
  });

  it("drops a forgotten asset from the saved references", async () => {
    await character({ reference_ids: ["@a1", "@a2"] });
    const outcome = await forgetAsset(engine, { assetId: imageIds[0]!, clearReferences: true });
    expect(outcome.status).toBe("forgotten");
    expect(readMainCharacter(engine).referenceArtifactIds).toEqual([imageIds[1]]);
    expect((await character()).references.map((reference) => reference.artifactId)).toEqual([imageIds[1]]);
  });

  it("sends an image the brief mentioned only as the character once it becomes the character before the frame", async () => {
    const goal = await createShortGoal(engine, bookId, notebookId, {
      brief: 'he slips on the steps in @a1 like @a2, frame: "He stands at the top of wet steps." beat 1: "He slips on the top step."',
      requestId: "mentioned-character-short",
    });
    const review = JSON.parse(textOf(await raw({ action: "status", goal_id: goal.goalId }))) as ShortGoalSnapshot;
    expect(review.shortPlan!.frame.references.map((reference) => reference.artifactId)).toEqual(imageIds);
    await character({ reference_ids: ["@a2"] });
    const approved = await raw({ action: "approve", goal_id: goal.goalId, revision: review.revision });
    expect(approved.isError, textOf(approved)).toBeFalsy();
    const plan = (JSON.parse(textOf(approved)) as ShortGoalSnapshot).shortPlan!;
    expect(plan.character.references.map((reference) => [reference.slot, reference.artifactId])).toEqual([["@image1", imageIds[1]]]);
    expect(plan.frame.references.map((reference) => [reference.slot, reference.artifactId])).toEqual([["@image2", imageIds[0]]]);
    await expect.poll(() => submissions.length, { timeout: testBudget(30_000) }).toBe(1);
    expect(submissions[0]!.path).toBe("/openai/gpt-image-2.6/sunburst/edit");
    expect(submissions[0]!.body.image_urls).toHaveLength(2);
    expect(unexpected).toEqual([]);
  });

  it("prices the sheet from fal's per-call average when fal has one", async () => {
    restoreEstimator();
    restoreEstimator = installFalDynamicEstimator(async () => ({ total_cost: 0.21, currency: "USD" }));
    expect((await character()).sheet.estimate.usd).toBeCloseTo(0.21);
    await character({ reference_ids: ["@a1"] });
    expect((await character()).sheet.estimate.usd).toBeCloseTo(0.21);
  });
});
