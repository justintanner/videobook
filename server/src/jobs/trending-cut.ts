import type { Engine } from "videobook-engine";
import type { BookManager } from "../book-manager.js";
import { activeBookEngine } from "../book-context.js";
import { appendDiagnostic } from "../diagnostics.js";
import { mutateNotebook } from "../notebook-mutations.js";
import { queue, registerJobHandler } from "../queue.js";
import { buildDayBook } from "../trending/day-book.js";
import { localDate, readLedger, readRuns, readSchedule, writeRun } from "../trending/ledger.js";
import { rankVideos } from "../trending/ranking.js";
import type { RankedVideo, TrendingRunRecord, TrendingSchedule } from "../trending/types.js";

const cuts = new WeakMap<Engine, Promise<unknown>>();

function researchProvenance(schedule: TrendingSchedule, run: TrendingRunRecord, video: RankedVideo) {
  return {
    rank: video.rank, videoId: video.videoId, metrics: video.metrics, sources: video.sources,
    window: schedule.window, windowHours: schedule.windowHours, country: schedule.country,
    scheduleId: schedule.scheduleId, date: run.date, cutAt: run.cutAt, fallback: video.fallback,
    downstream: schedule.downstream,
  };
}

export async function enqueueResearchDownload(
  engine: Engine, schedule: TrendingSchedule, run: TrendingRunRecord,
  download: TrendingRunRecord["downloads"][number], enqueue: typeof queue.enqueue = queue.enqueue,
): Promise<void> {
  const video = run.videos.find((entry) => entry.videoId === download.videoId)!;
  const artifact = engine.artifacts.get(download.artifactId!);
  if (!artifact.ok) throw new Error(artifact.error.message);
  const attempt = download.attempts ?? 1;
  const jobId = `trending-download:${schedule.scheduleId}:${run.date}:${video.videoId}:${attempt}`;
  const research = researchProvenance(schedule, run, video);
  const existing = engine.jobs.queue.list({ type: "download_video", artifactId: download.artifactId }).find((job) => job.payload.researchAttempt === attempt);
  const job = existing ?? await enqueue(jobId, {
    type: "download_video", bookId: run.dayBookId, assetId: download.artifactId,
    assetDir: artifact.value.path, url: video.url, exportVideos: false, full: true,
    sourcePrefix: "tiktok", research, researchAttempt: attempt,
  });
  download.jobId = jobId;
  download.queueJobId = job.id;
  download.attempts = attempt;
  if (run.notebookId) {
    const result = await mutateNotebook(engine, run.notebookId, "trending-download", (notebook) => ({
      ...notebook,
      cells: notebook.cells.map((cell) => cell.outputArtifactId === download.artifactId ? {
        ...cell, inputs: { ...cell.inputs, sourceOperation: "download_video", sourceUrl: video.url, jobId, research, state: job.state === "done" ? "completed" : job.state === "failed" ? "failed" : "pending" },
      } : cell),
    }));
    if (!result.ok) throw new Error(result.error.message);
  }
}

async function cut(
  engine: Engine, books: BookManager, date: string, cutAt: string, enqueue: typeof queue.enqueue,
): Promise<TrendingRunRecord | undefined> {
  const schedule = readSchedule(engine);
  if (!schedule?.enabled) return;
  let run = readRuns(engine).find((entry) => entry.date === date);
  if (run?.completed) return run;
  if (!run) {
    const dates = new Set<string>();
    const window = Math.max(48, schedule.windowHours);
    for (let hour = 0; hour <= Math.max(window + 24, 8 * 24); hour += 1) {
      dates.add(localDate(new Date(Date.parse(cutAt) - hour * 3_600_000), schedule.timezone));
    }
    const sightings = [...dates].flatMap((day) => readLedger(engine, day).sightings);
    const videos = rankVideos(sightings, schedule, { cutAt, fallback: sightings.filter((row) => row.source === "tiktok-creative-center") });
    run = { date, cutAt, dayBookId: "", videos, downloads: videos.map((video) => ({ videoId: video.videoId, status: "pending" })), spend: 0, errors: [] };
    await writeRun(engine, run);
  }
  const record = run;
  const result = await buildDayBook(books, schedule, date, record.videos, {
    cutAt: record.cutAt,
    createVideoArtifact: async (_rank, video, dayEngine) => {
      const download = record.downloads.find((entry) => entry.videoId === video.videoId)!;
      if (download.artifactId && dayEngine.artifacts.get(download.artifactId).ok) return download.artifactId;
      const created = await dayEngine.artifacts.create("video", `#${video.rank} ${video.author.handle}`);
      if (!created.ok) throw new Error(created.error.message);
      download.artifactId = created.value.artifactId;
      record.dayBookId = dayEngine.book.get().bookId;
      await writeRun(engine, record);
      const metadata = await dayEngine.metadata.artifacts.write(download.artifactId, "original", { research: researchProvenance(schedule, record, video) });
      if (!metadata.ok) throw new Error(metadata.error.message);
      return download.artifactId;
    },
  });
  record.dayBookId = result.bookId;
  record.notebookId = result.notebookId;
  await writeRun(engine, record);
  const selected = books.get(result.bookId);
  if (!selected.ok) throw new Error(selected.error.message);
  for (const rank of result.ranks) {
    const download = record.downloads.find((entry) => entry.videoId === rank.videoId)!;
    download.artifactId = rank.artifactId;
    await enqueueResearchDownload(selected.value.engine, schedule, record, download, enqueue);
    await writeRun(engine, record);
  }
  record.completed = true;
  await writeRun(engine, record);
  return record;
}

export async function cutTrending(
  engine: Engine, books: BookManager, date: string, cutAt: string,
  enqueue: typeof queue.enqueue = queue.enqueue,
): Promise<TrendingRunRecord | undefined> {
  const next = (cuts.get(engine) ?? Promise.resolve()).then(() => cut(engine, books, date, cutAt, enqueue));
  cuts.set(engine, next.catch(() => {}));
  try {
    return await next;
  } catch (error) {
    const run = readRuns(engine).find((entry) => entry.date === date);
    if (run) {
      const message = error instanceof Error ? error.message : String(error);
      await writeRun(engine, { ...run, errors: [...new Set([...run.errors, message])] });
    }
    await appendDiagnostic(engine, "trending-cut-failed", { error, scheduleId: readSchedule(engine)?.scheduleId });
    throw error;
  }
}

export function registerTrendingCutJob(books: BookManager): void {
  registerJobHandler("trending_cut", async (payload) => {
    await cutTrending(activeBookEngine(), books, String(payload.date), String(payload.cutAt));
    return { success: true };
  });
}
