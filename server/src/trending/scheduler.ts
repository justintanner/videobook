import type { Engine } from "videobook-engine";
import { logger } from "../logger.js";
import { listBookEngines, queue } from "../queue.js";
import { localDate, readLedger, readRuns, readSchedule } from "./ledger.js";
import type { TrendingSchedule } from "./types.js";

function dueEvents(schedule: TrendingSchedule, from: number, until: number) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: schedule.timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const [hour, minute] = schedule.cutoffLocalTime.split(":").map(Number);
  const cutoff = hour * 60 + minute;
  const slots = new Set(Array.from({ length: schedule.samplesPerDay }, (_, index) => Math.floor(index * 1440 / schedule.samplesPerDay)));
  const events: { type: "sample" | "cut"; at: string; date: string }[] = [];
  let previousDate = "";
  let cutSeen = false;
  for (let at = Math.floor(from / 86_400_000) * 86_400_000 - 86_400_000; at <= until; at += 60_000) {
    const parts = formatter.formatToParts(at);
    const part = (name: string) => parts.find((entry) => entry.type === name)!.value;
    const date = `${part("year")}-${part("month")}-${part("day")}`;
    const minutes = Number(part("hour")) * 60 + Number(part("minute"));
    if (date !== previousDate) { previousDate = date; cutSeen = false; }
    if (at >= from && slots.has(minutes)) events.push({ type: "sample", at: new Date(at).toISOString(), date });
    if (!cutSeen && minutes >= cutoff) {
      if (at >= from) events.push({ type: "cut", at: new Date(at).toISOString(), date });
      cutSeen = true;
    }
  }
  return events;
}

export function createTrendingScheduler(options: {
  engines?: () => Promise<Engine[]>;
  now?: () => Date;
  enqueueAndWait?: typeof queue.enqueueAndWait;
  enqueue?: typeof queue.enqueue;
} = {}) {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  const wait = options.enqueueAndWait ?? queue.enqueueAndWait;
  const enqueue = options.enqueue ?? queue.enqueue;
  const collect = async () => {
    const now = (options.now ?? (() => new Date()))();
    for (const engine of await (options.engines ?? listBookEngines)()) {
      if (stopped) return;
      const schedule = readSchedule(engine);
      if (!schedule?.enabled) continue;
      const bookId = engine.book.get().bookId;
      const cursorKey = `trending.scheduler.${schedule.scheduleId}`;
      const cursor = engine.settings.get<string>(cursorKey);
      const from = cursor ? Date.parse(cursor) + 60_000 : Date.parse(schedule.createdAt);
      if (cursor && from > now.getTime()) continue;
      try {
        for (const event of dueEvents(schedule, from, now.getTime())) {
          if (stopped) return;
          if (event.type === "sample" && !readLedger(engine, event.date).completedSlots.includes(event.at)) {
            await wait(`trending-sample:${schedule.scheduleId}:${event.at}`, { type: "trending_sample", bookId, slot: event.at });
          }
          if (event.type === "cut" && !readRuns(engine).some((run) => run.date === event.date && run.completed)) {
            await wait(`trending-cut:${schedule.scheduleId}:${event.date}`, { type: "trending_cut", bookId, date: event.date, cutAt: event.at });
          }
        }
        const saved = engine.settings.set(cursorKey, new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString());
        if (!saved.ok) throw new Error(saved.error.message);
        for (const run of readRuns(engine)) {
          const today = run.date === localDate(now, schedule.timezone);
          if (!run.completed || !run.downloads.some((download) => download.status === "pending"
            || (today && download.status === "failed" && (download.attempts ?? 1) < 3))) continue;
          await enqueue(`trending-retry:${schedule.scheduleId}:${run.date}:${Math.floor(now.getTime() / 60_000)}`, {
            type: "trending_retry", bookId: run.dayBookId, controlBookId: bookId, date: run.date,
          });
        }
      } catch (error) {
        logger.warn("trending-cut-failed", { bookId, scheduleId: schedule.scheduleId, error });
      }
    }
  };
  const tick = (): Promise<void> => {
    if (running) return running;
    running = collect().finally(() => { running = undefined; });
    return running;
  };
  return {
    tick,
    start(): void {
      if (timer) return;
      stopped = false;
      timer = setInterval(() => { void tick().catch(() => undefined); }, 60_000).unref();
      void tick().catch(() => undefined);
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}

export const trendingScheduler = createTrendingScheduler();

export async function stopTrendingSchedulerAndQueue(): Promise<void> {
  await Promise.all([trendingScheduler.stop(), queue.stop()]);
}
