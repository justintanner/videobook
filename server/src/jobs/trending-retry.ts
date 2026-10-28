import type { Engine } from "videobook-engine";
import type { BookManager } from "../book-manager.js";
import { activeBookEngine } from "../book-context.js";
import { queue, registerJobHandler } from "../queue.js";
import { syncDayBookDownloads } from "../trending/day-book.js";
import { localDate, readRuns, readSchedule, writeRun } from "../trending/ledger.js";
import { enqueueResearchDownload, recordDownloadOutcome } from "./trending-cut.js";

const pending = new WeakMap<Engine, Promise<unknown>>();

export async function retryTrending(
  control: Engine, day: Engine, date: string, now: Date,
  enqueue: typeof queue.enqueue = queue.enqueue,
): Promise<void> {
  const next = (pending.get(control) ?? Promise.resolve()).then(async () => {
    const schedule = readSchedule(control);
    const run = readRuns(control).find((entry) => entry.date === date);
    if (!schedule || !run?.completed || run.dayBookId !== day.book.get().bookId) return;
    for (const download of run.downloads) {
      if (!download.queueJobId) continue;
      const job = day.jobs.queue.get(download.queueJobId);
      if (!job) continue;
      recordDownloadOutcome(download, job);
      if (job.state !== "failed" && job.state !== "aborted") continue;
      download.nextRetryAt ??= new Date((job.finishedAt ?? now.getTime()) + 60_000 * 2 ** ((download.attempts ?? 1) - 1)).toISOString();
      await writeRun(control, run);
      if (!schedule.enabled || localDate(now, schedule.timezone) !== date
        || (download.attempts ?? 1) >= 3 || Date.parse(download.nextRetryAt) > now.getTime()) continue;
      download.attempts = (download.attempts ?? 1) + 1;
      download.status = "pending";
      delete download.nextRetryAt;
      await enqueueResearchDownload(day, schedule, run, download, enqueue);
      await writeRun(control, run);
    }
    await writeRun(control, run);
    await syncDayBookDownloads(day, schedule, run);
  });
  pending.set(control, next.catch(() => {}));
  await next;
}

export function registerTrendingRetryJob(books: BookManager): void {
  registerJobHandler("trending_retry", async (payload) => {
    const control = books.get(String(payload.controlBookId));
    if (!control.ok) throw new Error(control.error.message);
    await retryTrending(control.value.engine, activeBookEngine(), String(payload.date), new Date());
    return { success: true };
  });
}
