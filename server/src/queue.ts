import {
  type ArtifactWorkKind,
  type Engine,
  type Job,
  type JobHandler,
  type JobState,
  QueueRunner,
  createEngine,
} from "videobook-engine";
import { activeBookEngine, withBookContext } from "./book-context.js";
import { bookManager } from "./fs.js";
import { runWithJobDeadline } from "./job-deadline.js";

type JobPayload = Record<string, unknown>;

export type LeaseToken =
  | { kind: "owner"; ownerId: string }
  | { kind: "task"; taskId: string };

export interface JobHandlerContext {
  signal: AbortSignal;
  setLease(token: LeaseToken): void;
  getOwnerId(): string;
  markAssetFailureHandled(): void;
}

export type ServerJobHandler = (
  payload: Record<string, unknown>,
  context: JobHandlerContext,
) => Promise<unknown>;

interface RunnerInfo {
  bookId: string;
  engine: Engine;
  runner: QueueRunner;
  reaper: { stop: () => void };
}

interface QueueIndexEntry {
  bookId: string;
  internalId: number;
}

interface Queue {
  enqueue(jobId: string, payload: JobPayload): Promise<Job>;
  enqueueAndWait<T = unknown>(
    jobId: string,
    payload: JobPayload,
    timeoutMs?: number,
  ): Promise<T>;
  getStatus(jobId: string): Promise<{
    state: "queued" | "running" | "completed" | "failed";
    error?: { message: string };
  } | null>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const handlers = new Map<string, ServerJobHandler>();
const runnerByBook = new Map<string, RunnerInfo>();
const jobIdIndex = new Map<string, QueueIndexEntry>();
const rewindingBooks = new Set<string>();
const testEngines = new Map<string, Engine>();
let activeTestRoot: string | null = null;

const JOB_INDEX_MAX = 2_000;
const ASSET_REAPER_INTERVAL_MS = 30_000;

export function registerJobHandler(
  type: string,
  handler: ServerJobHandler,
): void {
  handlers.set(type, handler);
}

export function extractAssetId(payload: Record<string, unknown>): string | null {
  for (const key of [
    "imgAssetId",
    "vidAssetId",
    "assetId",
    "imageAssetId",
    "audioAssetId",
    "audAssetId",
  ]) {
    const value = payload[key];
    if (typeof value === "string") return value;
  }
  return null;
}

function extractBookId(payload: JobPayload): string {
  const value = payload.bookId;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("queue payload requires bookId");
  }
  return value;
}

function extractType(payload: JobPayload): string {
  const value = payload.type;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("queue payload requires type");
  }
  return value;
}

type Orientation = "portrait" | "landscape" | "square";
type ClassifiedJob = { kind: ArtifactWorkKind; orientation?: Orientation };

function jobTypeToAssetWorkKind(
  jobType: string,
  payload: JobPayload,
): ClassifiedJob | null {
  if (
    jobType === "render_project"
    || jobType === "render_timeline"
    || jobType === "render_qr_outro"
  ) {
    const orientation = payload.orientation;
    const normalized = orientation === "portrait" || orientation === "landscape" || orientation === "square"
      ? orientation
      : undefined;
    const kind: ArtifactWorkKind = jobType === "render_timeline" ? "final" : "render";
    return normalized ? { kind, orientation: normalized } : { kind };
  }
  switch (jobType) {
    case "process_video":
    case "process_image":
    case "inject_first_frame":
      return { kind: "process" };
    case "analyze_video":
    case "analyze_keyword_placement":
    case "suggest_cuts":
    case "suggest_sfx":
    case "analyze_jokes":
    case "detect_scenes":
      return { kind: "analyze" };
    case "transcribe":
    case "transcribe_video_audio":
      return { kind: "transcribe" };
    case "trim_video":
    case "split_video":
      return { kind: "trim" };
    case "crop_video":
    case "crop_image":
      return { kind: "crop" };
    case "splice_video":
    case "smooth_scene_concat":
      return { kind: "splice" };
    case "reverse_video":
      return { kind: "reverse" };
    case "change_video_speed":
    case "timewarp_video":
    case "sync_video_to_audio":
      return { kind: "change_speed" };
    case "replace_video_audio":
    case "clean_video_audio":
    case "remove_sound":
    case "audio_mix":
      return { kind: "replace_audio" };
    case "apply_cuts":
      return { kind: "apply_cuts" };
    case "apply_sfx":
      return { kind: "apply_sfx" };
    case "extract_frame":
    case "extract_audio":
      return { kind: "extract" };
    case "describe_image":
      return { kind: "describe" };
    case "rewrite_script":
      return { kind: "rewrite_script" };
    case "archive_clip":
      return { kind: "archive" };
    case "restore_archive_clip":
      return { kind: "download" };
    case "download_video":
      return { kind: "download" };
    case "complete_kie_task":
      return { kind: "generate" };
    case "isolate_vocals":
      return { kind: "isolate" };
    case "post_to_x":
      return null;
    default:
      return jobType.startsWith("generate_")
        || jobType.startsWith("extend_")
        || jobType.startsWith("upscale_")
        ? { kind: "generate" }
        : null;
  }
}

function providerHandoffKindFor(jobType: string): ArtifactWorkKind | null {
  if (jobType === "isolate_vocals") return "isolate";
  return jobType.startsWith("generate_")
    || jobType.startsWith("extend_")
    || jobType.startsWith("upscale_")
    ? "generate"
    : null;
}

async function resolveEngine(bookId: string): Promise<Engine> {
  const testEngine = testEngines.get(bookId);
  if (testEngine) return testEngine;
  await bookManager.ready();
  const book = bookManager.get(bookId);
  if (!book.ok) throw new Error(book.error.message);
  return book.value.engine;
}

function makeWrappedResolver(
  bookId: string,
  engine: Engine,
): (type: string) => JobHandler | null {
  return (type) => {
    const handler = handlers.get(type);
    if (!handler) return null;
    return async (job: Job, queueSignal?: AbortSignal) => withBookContext(
      { bookId, engine },
      () => runWithJobDeadline(type, async (signal) => {
        const jobSignal = queueSignal
          ? AbortSignal.any([signal, queueSignal])
          : signal;
        const lease: { current: LeaseToken | null } = { current: null };
        let assetFailureHandled = false;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        const context: JobHandlerContext = {
          signal: jobSignal,
          setLease(next) {
            const current = lease.current;
            if (!current) {
              lease.current = next;
              return;
            }
            if (current.kind === next.kind) {
              const currentId = current.kind === "owner" ? current.ownerId : current.taskId;
              const nextId = next.kind === "owner" ? next.ownerId : next.taskId;
              if (currentId !== nextId) throw new Error("Cannot replace an active lease");
              return;
            }
            if (current.kind === "owner" && next.kind === "task") {
              lease.current = next;
              return;
            }
            throw new Error("Invalid lease transition");
          },
          getOwnerId() {
            if (lease.current?.kind !== "owner") throw new Error("No active owner lease");
            return lease.current.ownerId;
          },
          markAssetFailureHandled() {
            assetFailureHandled = true;
          },
        };
        const assetId = extractAssetId(job.payload);
        try {
          const providerKind = providerHandoffKindFor(type);
          if (providerKind && assetId) {
            const claimed = engine.jobs.artifactWork.begin(assetId, {
              kind: providerKind,
              ownerKind: "job",
              durationMs: 15 * 60_000,
            });
            if (!claimed) throw new Error(`Could not claim local lease for ${assetId}`);
            context.setLease({ kind: "owner", ownerId: claimed.ownerId });
            heartbeat = setInterval(() => {
              if (lease.current?.kind === "owner") {
                engine.jobs.artifactWork.renew(assetId, claimed.ownerId, 60_000);
              }
            }, 20_000);
          }
          const result = await handler(job.payload, context);
          if (assetId && lease.current?.kind === "owner") {
            engine.jobs.artifactWork.complete(assetId, lease.current.ownerId);
          }
          return result;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          if (assetId && !assetFailureHandled) {
            await dispatchFailure(engine, assetId, lease.current, message);
          }
          throw cause;
        } finally {
          if (heartbeat) clearInterval(heartbeat);
        }
      }),
    );
  };
}

async function dispatchFailure(
  engine: Engine,
  assetId: string,
  lease: LeaseToken | null,
  message: string,
): Promise<void> {
  if (lease?.kind === "owner") {
    await engine.jobs.artifactWork.fail(assetId, lease.ownerId, { message });
  } else if (lease?.kind === "task") {
    await engine.jobs.pending.fail(assetId, lease.taskId, { message });
  } else {
    await engine.jobs.pending.forceFail(assetId, { message });
  }
  await engine.history.logAction("job-error", { assetId, error: message });
}

async function ensureRunner(bookId: string): Promise<RunnerInfo> {
  const existing = runnerByBook.get(bookId);
  if (existing) return existing;
  const engine = await resolveEngine(bookId);
  await engine.ready;
  await engine.jobs.queue.reap();
  const runner = engine.jobs.queue.createRunner({
    concurrency: 5,
    pollIntervalMs: 250,
    resolveHandler: makeWrappedResolver(bookId, engine),
  });
  runner.start();
  const reaper = engine.jobs.startReaper({ intervalMs: ASSET_REAPER_INTERVAL_MS });
  const info = { bookId, engine, runner, reaper };
  runnerByBook.set(bookId, info);
  return info;
}

async function ensureBookReady(
  jobId: string,
  payload: JobPayload,
): Promise<{ bookId: string; engine: Engine; runner: QueueRunner }> {
  const bookId = extractBookId(payload);
  if (rewindingBooks.has(bookId)) throw new Error(`Book is rewinding: ${bookId}`);
  const info = await ensureRunner(bookId);
  return { bookId, engine: info.engine, runner: info.runner };
}

function enqueueOptions(jobId: string, payload: JobPayload) {
  const type = extractType(payload);
  const assetId = extractAssetId(payload);
  const classified = assetId ? jobTypeToAssetWorkKind(type, payload) : null;
  return {
    type,
    artifactId: assetId,
    payload,
    dedupeKey: jobId,
    maxAttempts: 1,
    artifactWorkKind: classified?.kind ?? null,
    artifactWorkOrientation: classified?.orientation ?? null,
  };
}

function rememberJob(jobId: string, entry: QueueIndexEntry): void {
  jobIdIndex.set(jobId, entry);
  while (jobIdIndex.size > JOB_INDEX_MAX) {
    const oldest = jobIdIndex.keys().next().value;
    if (typeof oldest !== "string") return;
    jobIdIndex.delete(oldest);
  }
}

function mapState(state: JobState): "queued" | "running" | "completed" | "failed" {
  switch (state) {
    case "queued":
      return "queued";
    case "running":
    case "completing":
      return "running";
    case "done":
      return "completed";
    case "failed":
    case "aborted":
      return "failed";
  }
}

export const queue: Queue = {
  async enqueue(jobId: string, payload: JobPayload) {
    const { bookId, engine } = await ensureBookReady(jobId, payload);
    const result = engine.jobs.queue.enqueue(enqueueOptions(jobId, payload));
    rememberJob(jobId, { bookId, internalId: result.job.id });
    return result.job;
  },
  async enqueueAndWait<T = unknown>(
    jobId: string,
    payload: JobPayload,
    timeoutMs = 300_000,
  ): Promise<T> {
    const { bookId, engine, runner } = await ensureBookReady(jobId, payload);
    const result = engine.jobs.queue.enqueue(enqueueOptions(jobId, payload));
    rememberJob(jobId, { bookId, internalId: result.job.id });
    return await runner.waitFor(result.job.id, timeoutMs) as T;
  },
  async getStatus(jobId: string) {
    const entry = jobIdIndex.get(jobId);
    if (!entry) return null;
    const engine = await resolveEngine(entry.bookId);
    const job = engine.jobs.queue.get(entry.internalId);
    if (!job) return null;
    const state = mapState(job.state);
    if (state === "completed" || state === "failed") jobIdIndex.delete(jobId);
    return {
      state,
      ...(job.error ? { error: { message: job.error.message } } : {}),
    };
  },
  async start() {
    await reconcileQueueOnStartup();
  },
  async stop() {
    const infos = [...runnerByBook.values()];
    runnerByBook.clear();
    jobIdIndex.clear();
    for (const info of infos) info.reaper.stop();
    await Promise.all(infos.map((info) => info.runner.stop()));
  },
};

export async function reconcileQueueOnStartup(): Promise<void> {
  await bookManager.ready();
  await Promise.all(bookManager.list().map((book) => ensureRunner(book.bookId)));
}

export async function stopBookQueue(bookId: string): Promise<void> {
  const info = runnerByBook.get(bookId);
  if (!info) return;
  runnerByBook.delete(bookId);
  info.reaper.stop();
  await info.runner.stop();
  const active = info.engine.jobs.queue.list({ states: ["queued", "running", "completing"] });
  await Promise.all(active.map((job) => info.engine.jobs.queue.abort(job.id, "Book deleted")));
  const pending = info.engine.jobs.pending.findAll();
  if (pending.ok) {
    await Promise.all(pending.value.map((task) => (
      info.engine.jobs.pending.forceFail(task.artifactId, {
        message: "Book deleted",
        failCode: "book_deleted",
      })
    )));
  }
}

export async function waitForJob(
  jobId: string,
  timeoutMs = 300_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await queue.getStatus(jobId);
    if (status?.state === "completed") return;
    if (status?.state === "failed") {
      throw new Error(`Job ${jobId} failed: ${status.error?.message ?? "unknown"}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Job ${jobId} timed out after ${timeoutMs}ms`);
}

export interface RewindQueuePreparation {
  abortedJobs: number;
  failedPendingTasks: number;
}

export async function prepareBookForRewind(
  bookId: string,
): Promise<RewindQueuePreparation> {
  if (rewindingBooks.has(bookId)) throw new Error(`Book is already rewinding: ${bookId}`);
  rewindingBooks.add(bookId);
  const engine = await resolveEngine(bookId);
  const info = runnerByBook.get(bookId);
  if (info) {
    runnerByBook.delete(bookId);
    info.reaper.stop();
    await info.runner.stop();
  }
  const jobs = engine.jobs.queue.list({ states: ["queued", "running", "completing"] });
  await Promise.all(jobs.map((job) => engine.jobs.queue.abort(job.id, "Aborted by book rewind")));
  const pending = engine.jobs.pending.findAll();
  let failedPendingTasks = 0;
  if (pending.ok) {
    for (const task of pending.value) {
      const failed = await engine.jobs.pending.forceFail(task.artifactId, {
        message: "Aborted by book rewind",
        failCode: "rewind",
      });
      if (failed.ok) failedPendingTasks += 1;
    }
  }
  return { abortedJobs: jobs.length, failedPendingTasks };
}

export async function resumeBookAfterRewind(bookId: string): Promise<void> {
  rewindingBooks.delete(bookId);
  await ensureRunner(bookId);
}

export async function setEngineRoot(
  rootDir: string,
  engine?: Engine,
): Promise<void> {
  const previousRoot = activeTestRoot;
  if (previousRoot && previousRoot !== rootDir) {
    const previous = [...testEngines.entries()].find(([, value]) => value === testEngines.get(previousRoot));
    if (previous) await stopBookQueue(previous[0]);
  }
  const next = engine ?? createEngine({ rootDir, initialBookSlug: "test-book" });
  await next.ready;
  const bookId = next.book.get().bookId;
  testEngines.set(bookId, next);
  activeTestRoot = rootDir;
  await ensureRunner(bookId);
}

export function getEngineRoot(): string {
  if (!activeTestRoot) return bookManager.rootDir;
  return activeTestRoot;
}

export function getActiveEngine(): Engine {
  return activeBookEngine();
}
