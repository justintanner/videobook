import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import type { BookManager } from "../book-manager.js";
import { mutateNotebook } from "../notebook-mutations.js";
import { dayBookSlug } from "./ledger.js";
import type { RankedVideo, TrendingRunRecord, TrendingSchedule } from "./types.js";

export interface DayBookResult {
  bookId: string;
  notebookId: string;
  ranks: { rank: number; videoId: string; videoCellId: string; notesCellId: string; artifactId: string }[];
}

export interface DayBookOptions {
  cutAt: string;
  createVideoArtifact: (rank: number, video: RankedVideo, engine: Engine) => Promise<string>;
}

const builds = new WeakMap<BookManager, Map<string, Promise<unknown>>>();

function owned(cell: NotebookCell, scheduleId: string): boolean {
  return cell.inputs?.trendingScheduleId === scheduleId;
}

function text(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function summary(videos: readonly RankedVideo[], schedule: TrendingSchedule, cutAt: string, cells: NotebookCell[]): string {
  const sources = [...new Set(videos.flatMap((video) => video.sources))];
  return [
    `# Top ${schedule.topN} research`,
    `Method: ${schedule.ranking}; ${schedule.window} window: ${schedule.windowHours} hours; cutoff: ${cutAt} (${schedule.timezone}, ${schedule.cutoffLocalTime}).`,
    `Contributing sources: ${sources.join(", ") || "none"}.`,
    "",
    "| Rank | Handle | Views | Likes | Posted | Sources | Download status | Fallback |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...videos.map((video) => {
      const cell = cells.find((candidate) => candidate.inputs?.workflowRole === `trending-video-${video.rank}`);
      return `| ${video.rank} | ${text(video.author.handle)} | ${video.metrics.views} | ${video.metrics.likes} | ${video.createdAt} | ${text(video.sources.join(", "))} | ${text(String(cell?.inputs?.state ?? "pending"))} | ${video.fallback ? "yes" : "no"} |`;
    }),
  ].join("\n");
}

function notes(video: RankedVideo): string {
  return [
    `# Rank ${video.rank}: ${video.author.handle}`,
    video.caption,
    `Author: ${JSON.stringify(video.author)}`,
    `Metrics: ${JSON.stringify(video.metrics)}`,
    `Posted: ${video.createdAt}`,
    `URL: ${video.url}`,
    `Sources: ${video.sources.join(", ")}`,
    `Music: ${JSON.stringify(video.music ?? null)}`,
  ].join("\n\n");
}

async function build(
  books: BookManager, schedule: TrendingSchedule, date: string,
  videos: readonly RankedVideo[], options: DayBookOptions,
): Promise<DayBookResult> {
  await books.ready();
  const slug = dayBookSlug(schedule.country, date);
  let selected = books.getByName(slug);
  if (!selected.ok) {
    const created = await books.create(slug);
    if (!created.ok) throw new Error(created.error.message);
    selected = books.getByName(slug);
  }
  if (!selected.ok) throw new Error(selected.error.message);
  const { engine, bookId } = selected.value;
  const notebook = engine.notebooks.list().find((entry) => {
    const record = entry.fixture?.trending as Record<string, unknown> | undefined;
    return record?.scheduleId === schedule.scheduleId && record?.date === date;
  }) ?? engine.notebooks.list().find((entry) => entry.name === "Main");
  if (!notebook) throw new Error("Day book has no Main or matching research notebook");
  const artifacts = new Map<number, string>();
  for (const video of videos) {
    const previous = notebook.cells.find((cell) => owned(cell, schedule.scheduleId)
      && cell.inputs?.workflowRole === `trending-video-${video.rank}`);
    const research = previous?.inputs?.research as Record<string, unknown> | undefined;
    const artifactId = research?.videoId === video.videoId && previous?.outputArtifactId
      && engine.artifacts.get(previous.outputArtifactId).ok
      ? previous.outputArtifactId
      : await options.createVideoArtifact(video.rank, video, engine);
    if (!engine.artifacts.get(artifactId).ok) throw new Error(`Missing video artifact: ${artifactId}`);
    artifacts.set(video.rank, artifactId);
  }
  const ranks: DayBookResult["ranks"] = [];
  const written = await mutateNotebook(engine, notebook.id, "trending-day-book", (current) => {
    const cells = current.cells.filter((cell) => !owned(cell, schedule.scheduleId));
    const upsert = (role: string, input: Parameters<Engine["notebooks"]["createCell"]>[0]): NotebookCell => {
      const previous = current.cells.find((cell) => owned(cell, schedule.scheduleId) && cell.inputs?.workflowRole === role);
      if (cells.some((cell) => cell.slot?.row === input.slot?.row && cell.slot?.column === input.slot?.column)) {
        throw new Error(`Research slot is occupied: ${role}`);
      }
      const cell = previous ? { ...previous, ...input } : engine.notebooks.createCell(input);
      cells.push(cell);
      return cell;
    };
    for (const video of videos) {
      const research = {
        videoId: video.videoId, rank: video.rank, metrics: video.metrics,
        sources: video.sources, url: video.url, createdAt: video.createdAt, fallback: video.fallback,
      };
      const previous = current.cells.find((cell) => owned(cell, schedule.scheduleId)
        && cell.inputs?.workflowRole === `trending-video-${video.rank}`);
      const sameArtifact = previous?.outputArtifactId === artifacts.get(video.rank);
      const videoCell = upsert(`trending-video-${video.rank}`, {
        type: "video", label: `#${video.rank} ${video.author.handle}`,
        slot: { row: video.rank, column: 0 }, outputArtifactId: artifacts.get(video.rank)!,
        inputs: {
          ...(sameArtifact ? previous?.inputs : {}),
          trendingScheduleId: schedule.scheduleId, workflowRole: `trending-video-${video.rank}`,
          sourceOperation: "download_video", sourceUrl: video.url, research,
          state: sameArtifact ? previous?.inputs?.state ?? "pending" : "pending",
        },
      });
      const notesCell = upsert(`trending-notes-${video.rank}`, {
        type: "prompt", label: `#${video.rank} notes`, slot: { row: video.rank, column: 1 },
        prompt: notes(video), inputs: {
          trendingScheduleId: schedule.scheduleId, workflowRole: `trending-notes-${video.rank}`, research,
        },
      });
      ranks.push({ rank: video.rank, videoId: video.videoId, videoCellId: videoCell.id, notesCellId: notesCell.id, artifactId: artifacts.get(video.rank)! });
    }
    upsert("trending-summary", {
      type: "prompt", label: "Trending summary", slot: { row: 0, column: 0 },
      prompt: summary(videos, schedule, options.cutAt, cells),
      inputs: { trendingScheduleId: schedule.scheduleId, workflowRole: "trending-summary" },
    });
    const ids = new Set(cells.map((cell) => cell.id));
    const document: NotebookDocument = {
      ...current, name: `Top ${schedule.topN} · ${date}`,
      description: `${schedule.windowHours}h ${schedule.window} window; cutoff ${options.cutAt} (${schedule.cutoffLocalTime} ${schedule.timezone}); sources: ${schedule.sources.map((source) => source.id).join(", ")}; method: ${schedule.ranking}`,
      cells, edges: current.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
      execution: Object.fromEntries(Object.entries(current.execution ?? {}).filter(([id]) => {
        const cell = cells.find((candidate) => candidate.id === id);
        const previous = current.cells.find((candidate) => candidate.id === id);
        return cell && cell.outputArtifactId === previous?.outputArtifactId;
      })),
      fixture: { ...current.fixture, trending: {
        version: 1, scheduleId: schedule.scheduleId, date, cutAt: options.cutAt,
        sources: [...new Set(videos.flatMap((video) => video.sources))],
        window: schedule.window, windowHours: schedule.windowHours,
      } },
    };
    return document;
  });
  if (!written.ok) throw new Error(written.error.message);
  return { bookId, notebookId: notebook.id, ranks };
}

export async function syncDayBookDownloads(engine: Engine, schedule: TrendingSchedule, run: TrendingRunRecord): Promise<void> {
  if (!run.notebookId) return;
  const written = await mutateNotebook(engine, run.notebookId, "trending-download-status", (notebook) => {
    const cells = notebook.cells.map((cell) => {
      const download = owned(cell, schedule.scheduleId) && cell.outputArtifactId
        ? run.downloads.find((entry) => entry.artifactId === cell.outputArtifactId) : undefined;
      if (!download) return cell;
      const { error: _error, ...inputs } = cell.inputs ?? {};
      return {
        ...cell,
        inputs: { ...inputs, state: download.status, ...(download.status === "failed" ? { error: download.error ?? "Download failed" } : {}) },
      };
    });
    return {
      ...notebook,
      cells: cells.map((cell) => owned(cell, schedule.scheduleId) && cell.inputs?.workflowRole === "trending-summary"
        ? { ...cell, prompt: summary(run.videos, schedule, run.cutAt, cells) }
        : cell),
    };
  });
  if (!written.ok) throw new Error(written.error.message);
}

export async function buildDayBook(
  books: BookManager, schedule: TrendingSchedule, date: string,
  videos: readonly RankedVideo[], options: DayBookOptions,
): Promise<DayBookResult> {
  const slug = dayBookSlug(schedule.country, date);
  if (!Number.isFinite(Date.parse(options.cutAt))) throw new Error("Invalid cutoff");
  if (videos.length > schedule.topN || videos.some((video, index) => video.rank !== index + 1 || video.rank > 63)) {
    throw new Error("Research ranks must be consecutive and fit the notebook");
  }
  const pending = builds.get(books) ?? new Map<string, Promise<unknown>>();
  builds.set(books, pending);
  const next = (pending.get(slug) ?? Promise.resolve()).then(() => build(books, schedule, date, videos, options));
  const settled = next.catch(() => {});
  pending.set(slug, settled);
  try {
    return await next;
  } finally {
    if (pending.get(slug) === settled) pending.delete(slug);
  }
}
