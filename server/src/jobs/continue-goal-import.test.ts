import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { BOOK_AUTOMATION_PAUSED_KEY, inspectBookArchive, packBookArchive, restoreBookArchive, type Engine } from "videobook-engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { BookManager } from "../book-manager.js";
import { scopedBookEngine, withBookContext } from "../book-context.js";
import { guardGoalSubmission } from "../goal-automation-guard.js";
import type { GoalReservation } from "../goal-automation-model.js";
import { sweepGoalAutomation } from "../goal-automation.js";
import { writeRemixPreferences } from "../goal-remix-analysis.js";
import { createShortGoal } from "../goal-short-runtime.js";
import { readGoal, saveGoal } from "../goal-store.js";
import { installFalDynamicEstimator } from "../media/cost.js";
import { configureProviderEndpoints } from "../media/endpoints.js";
import { pauseBookQueueForTests, queue, setEngineRoot } from "../queue.js";
import { writeTaggingSettings } from "../tag-settings.js";
import { goalTestCharacters } from "../test-goals.js";
import { copyVideoFixture } from "../test-media-fixtures.js";
import { redirectFalStorage, startShortStub, type ShortStub } from "../test-short-stub.js";
import { goalDefs } from "../tools/goal.js";
import type { ShortGoalSnapshot } from "../tools/goal.js";
import { registerContinueGoalJob } from "./continue-goal.js";

const BRIEF = '@a1, 5 seconds. frame: "A man waits under a bus shelter." video: "He waits, then waves to the bus."';

describe("imported automatic goals", () => {
  let stub: ShortStub;
  let fixtures: string;
  let root: string;
  const open: BookManager[] = [];
  let restoreFetch: () => void;
  let restoreEndpoints: () => void;
  let restoreEstimator: () => void;
  const environment = new Map<string, string | undefined>();

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "videobook-import-goal-fixtures-"));
    const path = join(fixtures, "clip.mp4");
    await copyVideoFixture({ width: 90, height: 160, durationSec: 5, fps: 12, source: "color", color: "blue", audio: false }, path);
    const clip = await readFile(path);
    stub = await startShortStub({ frame: await sharp({ create: { width: 90, height: 160, channels: 3, background: "#557744" } }).png().toBuffer(), clip, extended: clip });
  });
  afterAll(async () => { await stub.close(); await rm(fixtures, { recursive: true, force: true }); });
  beforeEach(async () => {
    stub.reset();
    for (const [key, value] of [["FAL_API_KEY", "offline-import-key"], ["OPENAI_API_KEY", "offline-import-key"], ["VIDEOBOOK_HAR_CAPTURE", "off"]]) {
      environment.set(key!, process.env[key!]); process.env[key!] = value;
    }
    restoreFetch = redirectFalStorage(stub.baseURL);
    restoreEndpoints = configureProviderEndpoints({ falQueueBaseURL: stub.baseURL, openaiBaseURL: stub.baseURL });
    restoreEstimator = installFalDynamicEstimator(async () => ({ total_cost: 0.21, currency: "USD" }));
    root = await mkdtemp(join(tmpdir(), "videobook-import-goal-"));
    registerContinueGoalJob(scopedBookEngine);
  });
  afterEach(async () => {
    await queue.stop();
    for (const books of open.splice(0)) await books.close();
    restoreEstimator(); restoreEndpoints(); restoreFetch();
    for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  async function library(name: string): Promise<BookManager> {
    const books = new BookManager({ libraryDir: join(root, name) });
    open.push(books);
    await books.ready();
    return books;
  }

  function book(books: BookManager, bookId: string): { engine: Engine; rootDir: string } {
    const managed = books.get(bookId);
    if (!managed.ok) throw new Error(managed.error.message);
    return managed.value;
  }

  async function goalAction(engine: Engine, bookId: string, notebookId: string, args: Record<string, unknown>): Promise<ShortGoalSnapshot> {
    const def = goalDefs(scopedBookEngine).find((entry) => entry.name === "video_goal")!;
    const result = await withBookContext({ bookId, engine }, () => def.handler({ book_id: bookId, notebook_id: notebookId, ...args }));
    const text = result.content[0]!.text;
    expect(result.isError, text).toBeFalsy();
    return JSON.parse(text) as ShortGoalSnapshot;
  }

  const continuations = (engine: Engine) => engine.jobs.queue.list({ type: "continue_goal", states: ["queued", "running", "completing"] });

  it("waits for approval in the destination library before an imported goal spends again", async () => {
    const source = await library("source");
    const created = await source.create("auto-export");
    if (!created.ok) throw new Error(created.error.message);
    const bookId = created.value.bookId;
    const original = book(source, bookId);
    await setEngineRoot(original.rootDir, original.engine);
    writeTaggingSettings(original.engine, { analysisOnNewAssets: false });
    writeRemixPreferences(original.engine, { audio: "mute", branding: false, reviewImages: false, autoContinue: true, allowanceUsd: 10 });
    const notebook = await original.engine.notebooks.create("Automatic shorts");
    if (!notebook.ok) throw new Error(notebook.error.message);
    const notebookId = notebook.value.id;
    await goalTestCharacters(original.engine, notebookId);
    const goalId = (await createShortGoal(original.engine, bookId, notebookId, { brief: BRIEF, requestId: uuidv7() })).goalId;
    const draft = await goalAction(original.engine, bookId, notebookId, { action: "status", goal_id: goalId });
    await pauseBookQueueForTests(bookId);
    const approved = await goalAction(original.engine, bookId, notebookId, { action: "auto_continue", goal_id: goalId, revision: draft.revision, confirmed: true, allowance_usd: 10 });
    expect(approved.automation).toMatchObject({ status: "running", allowanceUsd: 10 });
    const settled: GoalReservation = { id: uuidv7(), stage: "frame", index: 0, inputKey: "earlier-frame", amountUsd: 0.21, warnings: [], status: "settled",
      chainId: null, runIds: [], usageIds: [], spentUsd: 0.21, submittedArtifactIds: [], createdAt: new Date().toISOString() };
    const running = readGoal(original.engine, goalId);
    saveGoal(original.engine, { ...running, automation: { ...running.automation!, reservations: [settled] } });
    expect(continuations(original.engine)).toHaveLength(1);
    await queue.stop();

    const exported = await source.prepareExport(bookId);
    const archive = join(root, "auto-export.videobook.tar.gz");
    await packBookArchive(exported.rootDir, archive);
    await source.releaseArchive(exported.token);
    const destination = await library("destination");
    const manifest = await inspectBookArchive(archive);
    const staging = await destination.prepareImport(manifest.book, manifest.head);
    await restoreBookArchive(archive, staging.rootDir);
    await destination.commitImport(staging.token);
    const imported = book(destination, bookId);
    await setEngineRoot(imported.rootDir, imported.engine);
    await pauseBookQueueForTests(bookId);
    const stale = readGoal(imported.engine, goalId).automation!;
    expect(stale.status).toBe("running");
    await expect(guardGoalSubmission(imported.engine, {
      assetId: uuidv7(),
      goalOrigin: { version: 1, goalId, stage: "frame", index: 0, revision: draft.revision, fingerprint: "earlier-frame", basePrompt: "",
        frameArtifactId: null, source: null, automation: { id: stale.id, reservationId: settled.id } },
    }, true)).rejects.toThrow("another library");

    for (let sweep = 0; sweep < 3; sweep += 1) await sweepGoalAutomation(imported.engine);
    expect(continuations(imported.engine)).toEqual([]);
    expect(readGoal(imported.engine, goalId).automation).toMatchObject({
      status: "paused", reason: expect.stringContaining("another library"), allowanceUsd: 10, reservations: [settled],
    });

    expect(imported.engine.settings.set(BOOK_AUTOMATION_PAUSED_KEY, false).ok).toBe(true);
    for (let sweep = 0; sweep < 3; sweep += 1) await sweepGoalAutomation(imported.engine);
    expect(continuations(imported.engine)).toEqual([]);
    expect(stub.submissions).toEqual([]);

    const current = await goalAction(imported.engine, bookId, notebookId, { action: "status", goal_id: goalId });
    const resumed = await goalAction(imported.engine, bookId, notebookId, { action: "auto_continue", goal_id: goalId, revision: current.revision, confirmed: true });
    expect(resumed.automation).toMatchObject({ status: "running", allowanceUsd: 10, reservations: [settled] });
    for (let sweep = 0; sweep < 3; sweep += 1) await sweepGoalAutomation(imported.engine);
    expect(continuations(imported.engine)).toHaveLength(1);
    expect(stub.submissions).toEqual([]);
  });
});
