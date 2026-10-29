import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { BookManager } from "../../server/src/book-manager.js";
import { enqueueOptions } from "../../server/src/queue.js";
import { trendingResearchDef } from "../../server/src/tools/trending-research.js";
import { getCanonicalCommands } from "../../server/src/tools/commands.js";
import { defaultTrendingSources } from "../../server/src/trending/default-sources.js";
import { readSchedule, updateLedger, writeSourceHealth } from "../../server/src/trending/ledger.js";
import { nextTrendingEvents, trendingCutTime } from "../../server/src/trending/scheduler.js";
import { applyInjectedCommandArgs, parseTrendingCommandArgs } from "../../src/lib/command-registry.js";
import { testBudget } from "../../server/src/test-budget.js";
import { schedule, sighting } from "./trending-fixtures.js";

let root: string;
let books: BookManager;
afterEach(async () => {
  await books?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

async function setup() {
  root = await mkdtemp(join(tmpdir(), "trending-tool-"));
  books = new BookManager({ libraryDir: root });
  return trendingResearchDef(books, {
    now: () => new Date("2026-10-28T03:00:00.000Z"),
    enqueue: async (key, payload) => {
      const selected = books.get(String(payload.bookId));
      if (!selected.ok) throw new Error(selected.error.message);
      return selected.value.engine.jobs.queue.enqueue(enqueueOptions(key, payload)).job;
    },
  });
}

function control() {
  const selected = books.getByName("tiktok-th-research");
  if (!selected.ok) throw new Error(selected.error.message);
  return selected.value;
}

describe("trending_research", () => {
  it("creates, updates, lists and disables schedules without losing identity or history", async () => {
    const tool = await setup();
    expect(tool.scope).toBe("global");
    expect(z.object(tool.schema).toJSONSchema().properties?.country).toMatchObject({ type: "string" });
    expect((await tool.handler({ op: "list" })).content[0].text).toBe('{"schedules":[]}');
    expect((await tool.handler({ op: "schedule", country: "th" })).isError).toBeUndefined();
    const first = readSchedule(control().engine)!;
    expect(first).toMatchObject({
      platform: "tiktok", country: "TH", timezone: "Asia/Bangkok", cutoffLocalTime: "00:30",
      topN: 10, samplesPerDay: 4, window: "trending", windowHours: 24, excludePromoted: true, ranking: "views",
      sources: [{ id: "endless" }, { id: "tiktok-creative-center" }],
      downstream: { transcribe: false, translateTo: [], analyze: false }, retentionDays: 30, enabled: true,
    });
    await tool.handler({ op: "schedule", country: "TH", top_n: 5, downstream: { analyze: true } });
    expect(readSchedule(control().engine)).toMatchObject({ scheduleId: first.scheduleId, createdAt: first.createdAt, topN: 5, downstream: { transcribe: false, analyze: true, translateTo: [] } });
    const listed = JSON.parse((await tool.handler({ op: "list", country: "TH" })).content[0].text);
    expect(listed.schedules).toHaveLength(1);
    await tool.handler({ op: "unschedule", country: "TH" });
    expect(readSchedule(control().engine)?.enabled).toBe(false);
    expect((await tool.handler({ op: "run", country: "TH" })).isError).toBe(true);
    await tool.handler({ op: "schedule", country: "TH", enabled: true });
    expect(books.list()).toHaveLength(1);
    expect(readSchedule(control().engine)?.scheduleId).toBe(first.scheduleId);
  }, testBudget(60_000));

  it("enqueues samples and dated cuts with persisted job IDs and scheduler-compatible keys", async () => {
    const tool = await setup();
    await tool.handler({ op: "schedule", country: "TH" });
    const sample = JSON.parse((await tool.handler({ op: "run", country: "TH" })).content[0].text);
    const cut = JSON.parse((await tool.handler({ op: "run", country: "TH", date: "2026-10-26" })).content[0].text);
    await tool.handler({ op: "run", country: "TH", date: "2026-10-26" });
    const { engine, bookId } = control();
    expect(engine.jobs.queue.list()).toHaveLength(2);
    expect(engine.jobs.queue.get(sample.jobs[0].jobId)?.payload).toMatchObject({ type: "trending_sample", bookId, slot: "2026-10-28T03:00:00.000Z" });
    expect(engine.jobs.queue.get(cut.jobs[0].jobId)?.payload).toMatchObject({ type: "trending_cut", bookId, date: "2026-10-26", cutAt: "2026-10-25T17:30:00.000Z" });
    expect(cut.jobs[0].jobKey).toBe(`trending-cut:${readSchedule(engine)!.scheduleId}:2026-10-26`);
  }, testBudget(60_000));

  it("reports ledger counts, source failures and next local runs", async () => {
    const tool = await setup();
    await tool.handler({ op: "schedule", country: "TH" });
    const { engine } = control();
    await updateLedger(engine, "2026-10-28", (ledger) => ({ ...ledger, sightings: [sighting("1"), sighting("2")], completedSlots: ["2026-10-28T00:00:00.000Z"] }));
    await writeSourceHealth(engine, "endless", { lastOk: "2026-10-28T00:00:00.000Z" });
    await writeSourceHealth(engine, "tiktok-creative-center", { lastError: "unavailable" });
    const result = JSON.parse((await tool.handler({ op: "status", country: "TH" })).content[0].text).schedules[0];
    expect(result).toMatchObject({ ledgerDate: "2026-10-28", ledgerCounts: { endless: 2, "tiktok-creative-center": 0 }, lastSample: "2026-10-28T00:00:00.000Z", nextRuns: { sample: "2026-10-28T05:00:00.000Z", cut: "2026-10-28T17:30:00.000Z" }, recentFailures: { sources: [{ source: "tiktok-creative-center", error: "unavailable" }] } });
    await tool.handler({ op: "unschedule", country: "TH" });
    expect(JSON.parse((await tool.handler({ op: "status" })).content[0].text).schedules[0].nextRuns).toEqual({ sample: null, cut: null });
  }, testBudget(60_000));

  it("returns structured errors for invalid parameters and missing schedules", async () => {
    const tool = await setup();
    for (const input of [
      { op: "schedule", country: "ZZ" }, { op: "schedule", country: "USA" },
      { op: "schedule", country: "US" }, { op: "schedule", country: "TH", timezone: "Not/AZone" },
      { op: "schedule", country: "TH", cutoff_local_time: "24:00" },
      { op: "schedule", country: "TH", samples_per_day: 0 },
      { op: "schedule", country: "TH", top_n: 64 },
      { op: "run", country: "TH", date: "2026-02-30" },
      { op: "run", country: "TH" }, { op: "unschedule", country: "TH" },
    ]) expect((await tool.handler(input)).isError).toBe(true);
    expect(books.list()).toHaveLength(0);
    expect((await tool.handler({ op: "schedule", country: "US", timezone: "America/New_York" })).isError).toBeUndefined();
  }, testBudget(60_000));

  it("uses the scheduler's spring-forward cutoff and dispatches the slash command", () => {
    const dst = { ...schedule, timezone: "America/New_York", cutoffLocalTime: "02:30" };
    expect(trendingCutTime(dst, "2026-03-08")).toBe("2026-03-08T07:00:00.000Z");
    expect(nextTrendingEvents(dst, new Date("2026-03-08T06:59:00.000Z")).cut).toBe("2026-03-08T07:00:00.000Z");
    const command = getCanonicalCommands().find((entry) => entry.command === "/trending")!;
    expect(command.mcpTool).toEqual({ tool: "trending_research", injectParams: { op: "run" } });
    expect(command.params.map((param) => [param.name, param.required])).toEqual([["op", false], ["country", false], ["date", false]]);
    expect(parseTrendingCommandArgs("")).toEqual({ op: "run" });
    expect(parseTrendingCommandArgs("schedule")).toEqual({ op: "schedule" });
    expect(parseTrendingCommandArgs("TH")).toEqual({ op: "run", country: "TH" });
    expect(parseTrendingCommandArgs("th 2026-10-28")).toEqual({ op: "run", country: "TH", date: "2026-10-28" });
    expect(parseTrendingCommandArgs("schedule TH")).toEqual({ op: "schedule", country: "TH" });
    expect(parseTrendingCommandArgs("status")).toEqual({ op: "status" });
    expect(parseTrendingCommandArgs("2026-10-28")).toEqual({ op: "run", date: "2026-10-28" });
    expect(applyInjectedCommandArgs(command, parseTrendingCommandArgs("schedule"))).toEqual({ op: "schedule" });
    expect(applyInjectedCommandArgs(command, parseTrendingCommandArgs("TH"))).toEqual({ op: "run", country: "TH" });
    expect(() => parseTrendingCommandArgs("schedule extra")).toThrow(/Unexpected \/trending argument/);
  });

  it("defaults an omitted schedule to Thailand and keeps list, run, and status on that schedule when another country exists", async () => {
    const tool = await setup();
    const created = JSON.parse((await tool.handler({ op: "schedule" })).content[0].text);
    expect(created.schedule).toMatchObject({ country: "TH", timezone: "Asia/Bangkok", downstream: { transcribe: false } });
    expect(JSON.parse((await tool.handler({ op: "status" })).content[0].text).schedules[0].schedule.country).toBe("TH");
    await tool.handler({ op: "schedule", country: "US", timezone: "America/New_York" });
    const listed = JSON.parse((await tool.handler({ op: "list" })).content[0].text).schedules;
    expect(listed.map((entry: { schedule: { country: string } }) => entry.schedule.country)).toEqual(["TH"]);
    const thailand = JSON.parse((await tool.handler({ op: "run" })).content[0].text);
    expect(thailand.jobs[0].bookId).toBe(control().bookId);
    await tool.handler({ op: "unschedule" });
    expect(readSchedule(control().engine)?.enabled).toBe(false);
    const unitedStates = books.getByName("tiktok-us-research");
    if (!unitedStates.ok) throw new Error(unitedStates.error.message);
    expect(readSchedule(unitedStates.value.engine)?.enabled).toBe(true);
  }, testBudget(60_000));

  it("uses the only schedule for list, run, and status, and still defaults unschedule to Thailand", async () => {
    const tool = await setup();
    await tool.handler({ op: "schedule", country: "US", timezone: "America/New_York" });
    const unitedStates = books.getByName("tiktok-us-research");
    if (!unitedStates.ok) throw new Error(unitedStates.error.message);
    expect(JSON.parse((await tool.handler({ op: "list" })).content[0].text).schedules[0].schedule.country).toBe("US");
    expect(JSON.parse((await tool.handler({ op: "status" })).content[0].text).schedules[0].schedule.country).toBe("US");
    const sample = JSON.parse((await tool.handler({ op: "run" })).content[0].text);
    expect(sample.jobs[0].bookId).toBe(unitedStates.value.bookId);
    expect((await tool.handler({ op: "unschedule" })).isError).toBe(true);
    expect(readSchedule(unitedStates.value.engine)?.enabled).toBe(true);
  }, testBudget(60_000));

  it("adds omkar only when its key and package are both available", () => {
    const free = ["endless", "tiktok-creative-center"];
    expect(defaultTrendingSources({ apiKey: null, packageInstalled: true }).map((source) => source.id)).toEqual(free);
    expect(defaultTrendingSources({ apiKey: "test-omkar", packageInstalled: true }).map((source) => source.id)).toEqual(free);
    expect(defaultTrendingSources({ apiKey: "omkar-live", packageInstalled: false }).map((source) => source.id)).toEqual(free);
    expect(defaultTrendingSources({ apiKey: "omkar-live", packageInstalled: true }).map((source) => source.id)).toEqual([...free, "omkar"]);
    expect(defaultTrendingSources().some((source) => source.id === "omkar")).toBe(false);
  });
});
