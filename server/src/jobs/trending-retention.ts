import { randomUUID } from "node:crypto";
import type { Engine } from "videobook-engine";
import { getApiKey } from "../api-key.js";
import type { BookManager, ManagedBook } from "../book-manager.js";
import { activeBookEngine } from "../book-context.js";
import { appendDiagnostic } from "../diagnostics.js";
import { queue, registerJobHandler, stopBookQueue } from "../queue.js";
import {
  cutLedgerDates, dayBookSlug, pruneLedgers, readHistory, readRuns, readSchedule, removeRun, retentionStart, writeHistory,
  writeRetention, writeRun,
} from "../trending/ledger.js";
import { trendingCutTime } from "../trending/scheduler.js";
import type { TrendingRetentionState, TrendingRunRecord, TrendingSchedule } from "../trending/types.js";
import { recordDownloadOutcome } from "./trending-cut.js";

export type ArchiveResearchClip = (input: {
  day: ManagedBook;
  schedule: TrendingSchedule;
  run: TrendingRunRecord;
  download: TrendingRunRecord["downloads"][number];
}) => Promise<void>;

const ARCHIVE_TIMEOUT_MS = 30 * 60_000;
const pending = new WeakMap<Engine, Promise<unknown>>();

const archiveResearchClip: ArchiveResearchClip = async ({ day, schedule, run, download }) => {
  if (!getApiKey("ELEVENLABS_API_KEY")) throw new Error("Archiving research clips needs ELEVENLABS_API_KEY");
  const video = run.videos.find((entry) => entry.videoId === download.videoId)!;
  await queue.enqueueAndWait(`trending-archive:${schedule.scheduleId}:${run.date}:${video.videoId}`, {
    type: "archive_clip", bookId: day.bookId, assetId: download.artifactId,
    title: `TikTok ${schedule.country} ${run.date} #${video.rank} ${video.author.handle}`,
    topics: [`tiktok-${schedule.country.toLowerCase()}-trending`], people: [],
    tagAudioEvents: true, diarize: true, ingestId: randomUUID(),
  }, ARCHIVE_TIMEOUT_MS);
};

function keepArchiveUsage(control: Engine, day: ManagedBook): number {
  let spendNanos = 0;
  for (const entry of day.engine.usage.recent(200)) {
    if (entry.operation !== "archive_clip") continue;
    const kept = control.usage.record({ ...entry, artifactId: null });
    if (!kept.ok) throw new Error(`Kept book ${day.name}: its archive usage could not be copied: ${kept.error.message}`);
    if (kept.value.status === "completed") spendNanos += Math.round((kept.value.costUsd ?? 0) * 1e9);
  }
  return spendNanos / 1e9;
}

function refreshOutcomes(day: Engine, run: TrendingRunRecord): void {
  for (const download of run.downloads) {
    const job = download.queueJobId ? day.jobs.queue.get(download.queueJobId) : null;
    if (job) recordDownloadOutcome(download, job);
  }
}

async function retire(
  control: Engine, books: BookManager, schedule: TrendingSchedule, run: TrendingRunRecord, archive: ArchiveResearchClip,
): Promise<TrendingRetentionState["deleted"][number] | undefined> {
  const slug = dayBookSlug(schedule.country, run.date);
  const previous = readHistory(control).find((entry) => entry.date === run.date && entry.dayBookId === run.dayBookId);
  const selected = run.dayBookId ? books.get(run.dayBookId) : books.getByName(slug);
  if (!selected.ok) {
    const entry = previous ?? { ...run, dayBookName: slug, retainedAt: new Date().toISOString() };
    await writeHistory(control, { ...entry, deletedAt: entry.deletedAt ?? new Date().toISOString() });
    await removeRun(control, run.date);
    return undefined;
  }
  const day = selected.value;
  if (day.bookId === control.book.get().bookId || day.name !== slug) {
    throw new Error(`Kept book ${day.name}: it is not the ${slug} day book`);
  }
  const retainedAt = previous?.retainedAt ?? new Date().toISOString();
  run.dayBookId = day.bookId;
  refreshOutcomes(day.engine, run);
  if (schedule.archiveTopClips) {
    for (const download of run.downloads) {
      if (download.status !== "completed" || !download.artifactId || download.archivedAt) continue;
      await archive({ day, schedule, run, download });
      download.archivedAt = new Date().toISOString();
      await writeRun(control, run);
    }
  }
  run.spend = keepArchiveUsage(control, day);
  await writeHistory(control, { ...run, dayBookName: day.name, retainedAt });
  const deleted = await books.delete(day.bookId, {
    confirmName: day.name,
    beforeDelete: (book) => stopBookQueue(book.bookId),
  });
  if (!deleted.ok) throw new Error(deleted.error.message);
  await writeHistory(control, { ...run, dayBookName: day.name, retainedAt, deletedAt: new Date().toISOString() });
  await removeRun(control, run.date);
  return { date: run.date, bookId: day.bookId, name: day.name };
}

export async function retainTrending(
  control: Engine, books: BookManager, date: string, archive: ArchiveResearchClip = archiveResearchClip,
): Promise<TrendingRetentionState | undefined> {
  const next = (pending.get(control) ?? Promise.resolve()).then(async () => {
    const schedule = readSchedule(control);
    if (!schedule) return undefined;
    await books.ready();
    const keepFrom = retentionStart(date, schedule.retentionDays);
    const state: TrendingRetentionState = {
      lastDate: date, lastRunAt: new Date().toISOString(), deleted: [], prunedLedgers: [], errors: [],
    };
    if (!keepFrom) state.errors.push(`Invalid retention window: ${schedule.retentionDays} days`);
    for (const run of keepFrom ? readRuns(control).filter((entry) => entry.date < keepFrom) : []) {
      try {
        const deleted = await retire(control, books, schedule, run, archive);
        if (deleted) state.deleted.push(deleted);
      } catch (error) {
        state.errors.push(`${run.date}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (keepFrom) {
      try {
        const cutReads = cutLedgerDates(schedule, trendingCutTime(schedule, date));
        state.prunedLedgers = await pruneLedgers(control, [keepFrom, ...cutReads].sort()[0]);
      } catch (error) {
        state.errors.push(`Ledger pruning failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await writeRetention(control, state);
    if (state.errors.length > 0) {
      await appendDiagnostic(control, "trending-retention-failed", {
        scheduleId: schedule.scheduleId, count: state.errors.length, error: new Error(state.errors[0]),
      });
    }
    return state;
  });
  pending.set(control, next.catch(() => {}));
  return next;
}

export function registerTrendingRetentionJob(books: BookManager): void {
  registerJobHandler("trending_retention", async (payload) => {
    const state = await retainTrending(activeBookEngine(), books, String(payload.date));
    return { success: true, deleted: state?.deleted.length ?? 0 };
  });
}
