import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import type { BookManager } from "../book-manager.js";
import { mutateNotebook } from "../notebook-mutations.js";
import { dayBookSlug } from "./ledger.js";
import type { RankedVideo, TrendingFunnel, TrendingRunRecord, TrendingSchedule } from "./types.js";

export interface DayBookResult {
  bookId: string;
  notebookId: string;
  ranks: { rank: number; videoId: string; videoCellId: string; notesCellId: string; artifactId: string }[];
}

export interface DayBookOptions {
  cutAt: string;
  ranking?: TrendingSchedule["ranking"];
  funnel?: TrendingFunnel;
  createVideoArtifact: (rank: number, video: RankedVideo, engine: Engine) => Promise<string>;
}

interface SummaryContext {
  cutAt: string;
  ranking?: TrendingSchedule["ranking"];
  funnel?: TrendingFunnel;
}

const builds = new WeakMap<BookManager, Map<string, Promise<unknown>>>();

function owned(cell: NotebookCell, scheduleId: string): boolean {
  return cell.inputs?.trendingScheduleId === scheduleId;
}

function text(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function formatScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function formatRate(count: number | undefined, views: number): string | undefined {
  if (count === undefined || !Number.isFinite(count) || !Number.isFinite(views) || views <= 0) {
    return undefined;
  }
  return `${((count / views) * 100).toFixed(2)}%`;
}

function formatFunnel(funnel: TrendingFunnel | undefined, rankedOnNumbers: boolean): string | undefined {
  if (!funnel && !rankedOnNumbers) return undefined;
  const parts: string[] = [];
  if (funnel) {
    const droppedEntries = Object.entries(funnel.screened)
      .filter(([, count]) => count > 0)
      .sort(([left], [right]) => left.localeCompare(right));
    const droppedTotal = droppedEntries.reduce((sum, [, count]) => sum + count, 0);
    const droppedText = droppedEntries.length > 0
      ? `${droppedTotal} dropped (${droppedEntries.map(([reason, count]) => `${text(reason)}: ${count}`).join(", ")})`
      : "0 dropped";
    parts.push(`${funnel.seen} seen; ${droppedText}; ${funnel.checked} checked; ${funnel.fit} fit the brief.`);
  }
  if (rankedOnNumbers) {
    parts.push("AI check did not run; ranked on numbers.");
  }
  return `Funnel: ${parts.join(" ")}`;
}

function summary(
  videos: readonly RankedVideo[],
  schedule: TrendingSchedule,
  context: SummaryContext,
  cells: NotebookCell[],
): string {
  const sources = [...new Set(videos.flatMap((video) => video.sources))];
  const method = context.ranking ?? schedule.ranking;
  const hasAuthentic = videos.some((video) => video.authentic !== undefined);
  const hasVerdict = videos.some((video) => video.authentic?.verdict !== undefined);
  const funnelLine = formatFunnel(context.funnel, hasAuthentic && !hasVerdict);
  const header = hasAuthentic
    ? "| Rank | Handle | Views | Likes | Posted | Sources | Download status | Fallback | Score | Shares | Why |"
    : "| Rank | Handle | Views | Likes | Posted | Sources | Download status | Fallback |";
  const divider = hasAuthentic
    ? "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
    : "| --- | --- | --- | --- | --- | --- | --- | --- |";
  return [
    `# Top ${schedule.topN} research`,
    `Method: ${method}; ${schedule.window} window: ${schedule.windowHours} hours; cutoff: ${context.cutAt} (${schedule.timezone}, ${schedule.cutoffLocalTime}).`,
    `Contributing sources: ${sources.join(", ") || "none"}.`,
    ...(funnelLine ? [funnelLine] : []),
    "",
    header,
    divider,
    ...videos.map((video) => {
      const cell = cells.find((candidate) => candidate.inputs?.workflowRole === `trending-video-${video.rank}`);
      const base = `| ${video.rank} | ${text(video.author.handle)} | ${video.metrics.views} | ${video.metrics.likes} | ${video.createdAt} | ${text(video.sources.join(", "))} | ${text(String(cell?.inputs?.state ?? "pending"))} | ${video.fallback ? "yes" : "no"} |`;
      if (!hasAuthentic) return base;
      const score = video.authentic ? formatScore(video.authentic.score) : "";
      const shares = formatRate(video.metrics.shares, video.metrics.views) ?? "";
      const why = video.authentic?.verdict ? text(video.authentic.verdict.why) : "";
      return `${base} ${score} | ${shares} | ${why} |`;
    }),
  ].join("\n");
}

function notes(video: RankedVideo): string {
  const lines = [
    `# Rank ${video.rank}: ${video.author.handle}`,
    video.caption,
    `Author: ${JSON.stringify(video.author)}`,
    `Metrics: ${JSON.stringify(video.metrics)}`,
    `Posted: ${video.createdAt}`,
    `URL: ${video.url}`,
    `Sources: ${video.sources.join(", ")}`,
    `Music: ${JSON.stringify(video.music ?? null)}`,
  ];
  if (video.authentic) {
    const { score, organic, verdict } = video.authentic;
    if (verdict) {
      lines.push(`Verdict: ${verdict.kind}, fit ${verdict.fit}/10, cover ${verdict.cover ? "seen" : "not seen"} — ${verdict.why}`);
    } else {
      lines.push("Verdict: none (AI check did not run)");
    }
    lines.push(`Score: ${formatScore(score)} (organic: ${formatScore(organic)})`);
    lines.push(
      `Rates: likes ${formatRate(video.metrics.likes, video.metrics.views) ?? "unknown"}, shares ${formatRate(video.metrics.shares, video.metrics.views) ?? "unknown"}, comments ${formatRate(video.metrics.comments, video.metrics.views) ?? "unknown"}, saves ${formatRate(video.metrics.saves, video.metrics.views) ?? "unknown"}`,
    );
    lines.push(`Duration: ${video.durationSeconds !== undefined ? `${video.durationSeconds}s` : "unknown"}`);
  }
  return lines.join("\n\n");
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
        ...(video.authentic ? { authentic: video.authentic } : {}),
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
    const method = options.ranking ?? schedule.ranking;
    upsert("trending-summary", {
      type: "prompt", label: "Trending summary", slot: { row: 0, column: 0 },
      prompt: summary(videos, schedule, { cutAt: options.cutAt, ranking: options.ranking, funnel: options.funnel }, cells),
      inputs: { trendingScheduleId: schedule.scheduleId, workflowRole: "trending-summary" },
    });
    const ids = new Set(cells.map((cell) => cell.id));
    const document: NotebookDocument = {
      ...current, name: `Top ${schedule.topN} · ${date}`,
      description: `${schedule.windowHours}h ${schedule.window} window; cutoff ${options.cutAt} (${schedule.cutoffLocalTime} ${schedule.timezone}); sources: ${schedule.sources.map((source) => source.id).join(", ")}; method: ${method}`,
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
        ? { ...cell, prompt: summary(run.videos, schedule, { cutAt: run.cutAt, ranking: run.ranking, funnel: run.funnel }, cells) }
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
