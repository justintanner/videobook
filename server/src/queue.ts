/**
 * SQLite-backed persistent queue, drop-in replacement for the old in-memory
 * `@platformatic/job-queue` queue.
 *
 * Public API preserved (so the ~90 enqueue call sites and ~80 handlers stay
 * untouched):
 *   queue.enqueue(jobId: string, payload: { type, projectSlug, ... })
 *   queue.enqueueAndWait(jobId, payload, timeoutMs?)
 *   queue.getStatus(jobId)
 *   queue.start() / queue.stop()
 *   queue.execute(handler)            — no-op shim (handler dispatch goes through registerJobHandler)
 *   waitForJob(jobId, timeoutMs?)
 *   registerJobHandler(type, handler)
 *
 * Storage is per-project: each project's `.clipfirst/state.sqlite` holds its
 * own pending_jobs rows. The queue routes enqueue calls to the right project's
 * state DB by joining `projectsDir` (settable for tests via setProjectsDir)
 * with the payload's `projectSlug`.
 */

import * as path from "node:path";

import {
  type Job,
  type JobHandler,
  type JobState,
  QueueRunner,
  queueApi,
  closeStateDb,
} from "clipfirst-fs";

import { fs as defaultFs, PROJECTS_DIR } from "./fs.js";
import { failPendingTask } from "./jobs/pending-task.js";

type JobPayload = Record<string, unknown>;

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(
  type: string,
  handler: (payload: Record<string, unknown>) => Promise<unknown>,
): void {
  handlers.set(type, async (job) => handler(job.payload));
}

function extractProjectSlug(payload: Record<string, unknown>): string | null {
  const a = payload.projectSlug;
  if (typeof a === "string" && a.length > 0) return a;
  const b = payload.project_slug;
  if (typeof b === "string" && b.length > 0) return b;
  return null;
}

function extractAssetId(payload: Record<string, unknown>): string | null {
  if (typeof payload.imgAssetId === "string") return payload.imgAssetId;
  if (typeof payload.vidAssetId === "string") return payload.vidAssetId;
  if (typeof payload.assetId === "string") return payload.assetId;
  if (typeof payload.imageAssetId === "string") return payload.imageAssetId;
  if (typeof payload.audioAssetId === "string") return payload.audioAssetId;
  return null;
}

function extractType(payload: Record<string, unknown>): string {
  const t = payload.type;
  if (typeof t !== "string" || t.length === 0) {
    throw new Error("queue.enqueue: payload.type is required");
  }
  return t;
}

let activeProjectsDir: string = PROJECTS_DIR;

interface RunnerInfo {
  projectsDir: string;
  slug: string;
  runner: QueueRunner;
}
const runnerByProject = new Map<string, RunnerInfo>();

function projectDirFor(slug: string): string {
  return path.join(activeProjectsDir, slug);
}

function makeWrappedResolver(): (type: string) => JobHandler | null {
  return (type) => {
    const handler = handlers.get(type);
    if (!handler) return null;
    return async (job) => {
      try {
        return await handler(job);
      } catch (error: unknown) {
        // Mirror the legacy queue's behavior: clear the asset's pending-task
        // sidecar and write .generation-error.json so /inbox doesn't show
        // "generating" forever. The fs.queue layer separately marks the SQLite
        // job row as failed via the runner's own catch.
        const assetId = extractAssetId(job.payload);
        const projectSlug = extractProjectSlug(job.payload);
        if (assetId && projectSlug) {
          await failPendingTask(defaultFs, assetId, projectSlug, {
            message: error instanceof Error ? error.message : String(error),
          }).catch(() => {});
          console.error(
            `[queue] cleared pending task for ${assetId} in ${projectSlug}`,
          );
        }
        throw error;
      }
    };
  };
}

function ensureRunner(slug: string): RunnerInfo {
  const cached = runnerByProject.get(slug);
  if (cached) return cached;
  const dir = projectDirFor(slug);
  const runner = queueApi.createRunner(dir, {
    concurrency: 5,
    pollIntervalMs: 250,
    resolveHandler: makeWrappedResolver(),
  });
  runner.start();
  const info: RunnerInfo = { projectsDir: activeProjectsDir, slug, runner };
  runnerByProject.set(slug, info);
  return info;
}

export async function reconcileQueueOnStartup(): Promise<void> {
  const projects = await defaultFs.listProjects();
  for (const project of projects) {
    const dir = projectDirFor(project.slug);
    await defaultFs.ensureClipfirstSetup(project.slug);
    queueApi.reapOnStartup(dir);
    await queueApi.reconcileFromSidecars(dir).catch((e) => {
      console.error(`[queue] reconcile failed for ${project.slug}:`, e);
    });
    ensureRunner(project.slug);
  }
}

export interface LegacyEnqueueResult {
  jobId: string;
  internalId: number;
  projectSlug: string;
}

interface QueueShim {
  enqueue(jobId: string, payload: JobPayload): Promise<LegacyEnqueueResult>;
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
  /** Legacy execute() — no-op. Handlers are registered via registerJobHandler. */
  execute(handler: unknown): void;
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

function findByJobIdSync(
  jobId: string,
): { slug: string; job: Job } | null {
  for (const info of runnerByProject.values()) {
    const jobs = queueApi.list(projectDirFor(info.slug), { limit: 10_000 });
    for (const j of jobs) {
      if ((j.payload as { __jobId?: string }).__jobId === jobId) {
        return { slug: info.slug, job: j };
      }
    }
  }
  return null;
}

export const queue: QueueShim = {
  enqueue: async (jobId, payload) => {
    const projectSlug = extractProjectSlug(payload);
    if (!projectSlug) {
      throw new Error(
        `queue.enqueue requires payload.projectSlug or project_slug; got jobId=${jobId} type=${String(payload.type)}`,
      );
    }
    const dir = projectDirFor(projectSlug);
    // Lazy bootstrap of .clipfirst/state.sqlite for projects created since boot.
    queueApi.list(dir, { limit: 0 }); // touch to open + migrate
    ensureRunner(projectSlug);
    const enriched = { ...payload, __jobId: jobId };
    const result = queueApi.enqueue(dir, {
      type: extractType(payload),
      assetId: extractAssetId(payload),
      payload: enriched,
      dedupeKey: jobId,
      maxAttempts: 1,
    });
    return { jobId, internalId: result.job.id, projectSlug };
  },

  enqueueAndWait: async <T = unknown>(
    jobId: string,
    payload: JobPayload,
    timeoutMs = 300_000,
  ): Promise<T> => {
    const enq = await queue.enqueue(jobId, payload);
    const dir = projectDirFor(enq.projectSlug);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const job = queueApi.getJob(dir, enq.internalId);
      if (!job) throw new Error(`Job ${jobId} disappeared`);
      if (job.state === "done") return job.result as T;
      if (job.state === "failed" || job.state === "aborted") {
        throw new Error(
          `Job ${jobId} ${job.state}: ${job.error?.message ?? "unknown"}`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Job ${jobId} timed out after ${timeoutMs}ms`);
  },

  getStatus: async (jobId) => {
    const found = findByJobIdSync(jobId);
    if (!found) return null;
    return {
      state: mapState(found.job.state),
      ...(found.job.error
        ? { error: { message: found.job.error.message } }
        : {}),
    };
  },

  start: async () => {
    // No-op in the new SQLite-backed queue: runners are created lazily on
    // first enqueue per project. Use reconcileQueueOnStartup() from server
    // boot to scan disk sidecars and reap stale leases.
  },

  stop: async () => {
    const infos = Array.from(runnerByProject.values());
    runnerByProject.clear();
    await Promise.all(infos.map((info) => info.runner.stop()));
    for (const info of infos) {
      closeStateDb(projectDirFor(info.slug));
    }
  },

  execute: () => {
    // No-op: dispatch is handled per-runner via the resolveHandler closure
    // installed by ensureRunner(). Kept for API compatibility.
  },
};

export async function waitForJob(
  jobId: string,
  timeoutMs = 300_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await queue.getStatus(jobId);
    if (status) {
      if (status.state === "completed") return;
      if (status.state === "failed") {
        throw new Error(
          `Job ${jobId} failed: ${status.error?.message ?? "unknown"}`,
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Job ${jobId} timed out after ${timeoutMs}ms`);
}

/**
 * Test-only: redirect all queue operations to a different projectsDir, and
 * tear down any runners pointing at the previous one. Tests call this from
 * createTestClient so each test's queue talks to its own state.sqlite.
 */
export async function setProjectsDir(dir: string): Promise<void> {
  if (dir === activeProjectsDir) return;
  const stale = Array.from(runnerByProject.values());
  runnerByProject.clear();
  await Promise.all(stale.map((info) => info.runner.stop().catch(() => {})));
  for (const info of stale) {
    closeStateDb(path.join(info.projectsDir, info.slug));
  }
  activeProjectsDir = dir;
}

export function getProjectsDir(): string {
  return activeProjectsDir;
}
