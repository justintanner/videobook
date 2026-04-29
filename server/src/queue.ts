/**
 * SQLite-backed persistent queue.
 *
 * Storage is per-project: each project's `.clipfirst/state.sqlite` holds its
 * own pending_jobs rows. The queue routes enqueue calls to the right project's
 * state DB by joining `projectsDir` (settable for tests via setProjectsDir)
 * with the payload's `projectSlug`.
 */

import * as path from "node:path";
import * as fsp from "node:fs/promises";

import {
  type ClipfirstFs,
  type JobHandler,
  type JobState,
  QueueRunner,
  createFs,
  isValidProjectSlug,
  queueApi,
  closeStateDb,
} from "clipfirst-engine";

import { fs as defaultFs, PROJECTS_DIR } from "./fs.js";

async function projectExists(dir: string): Promise<boolean> {
  try {
    await fsp.access(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

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
const fsRef: { current: ClipfirstFs } = { current: defaultFs };

interface RunnerInfo {
  projectsDir: string;
  slug: string;
  runner: QueueRunner;
}
const runnerByProject = new Map<string, RunnerInfo>();

// Maps the user-facing jobId (string) → the project + internal numeric row id
// so getStatus/waitForJob can locate a job in O(1) without scanning every
// project. Populated on enqueue + enqueueAndWait; cleared on stop/setProjectsDir.
const jobIdIndex = new Map<string, { slug: string; internalId: number }>();

function projectDirFor(slug: string): string {
  if (!isValidProjectSlug(slug)) {
    throw new Error(`Invalid project slug: ${slug}`);
  }
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
        // On handler error, clear the asset's pending-task sidecar and write
        // .generation-error.json so /inbox doesn't show "generating" forever.
        // The fs.queue layer separately marks the SQLite job row as failed via
        // the runner's own catch.
        //
        // Fire-and-forget: the runner shouldn't block on this best-effort
        // sidecar cleanup. If the project dir was torn down (test cleanup,
        // shutdown), proper-lockfile may retry for many seconds while
        // mkdir(.project.lock) hits ENOENT, holding the runner from draining.
        // We capture fsRef.current at throw time so the cleanup targets the
        // active projectsDir, not stale defaultFs.
        const assetId = extractAssetId(job.payload);
        const projectSlug = extractProjectSlug(job.payload);
        if (assetId && projectSlug) {
          const fsForCleanup = fsRef.current;
          const message = error instanceof Error ? error.message : String(error);
          void fsForCleanup.pendingTasks
            .fail(projectSlug, assetId, { message })
            .then((r) => {
              if (!r.ok) return;
              return fsForCleanup
                .logAction("job-error", { assetId, error: message }, projectSlug)
                .catch(() => {});
            })
            .then(() => {
              console.error(
                `[queue] cleared pending task for ${assetId} in ${projectSlug}`,
              );
            })
            .catch(() => {});
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
  const projects = await fsRef.current.listProjects();
  for (const project of projects) {
    const dir = projectDirFor(project.slug);
    await fsRef.current.ensureProjectInitialized(project.slug);
    queueApi.reapOnStartup(dir);
    await queueApi.reconcileFromSidecars(dir).catch((e) => {
      console.error(`[queue] reconcile failed for ${project.slug}:`, e);
    });
    ensureRunner(project.slug);
  }
}

interface Queue {
  enqueue(jobId: string, payload: JobPayload): Promise<void>;
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

async function ensureProjectReady(
  jobId: string,
  payload: JobPayload,
): Promise<{ slug: string; dir: string }> {
  const slug = extractProjectSlug(payload);
  if (!slug) {
    throw new Error(
      `queue.enqueue requires payload.projectSlug; got jobId=${jobId} type=${String(payload.type)}`,
    );
  }
  // Validate slug shape, then verify the project actually exists before
  // touching SQLite — queueApi opens .clipfirst/ as a side-effect, which
  // would silently spawn a phantom project directory for typos.
  const dir = projectDirFor(slug);
  if (!(await projectExists(dir))) {
    throw new Error(
      `queue.enqueue: project not found: ${slug} (jobId=${jobId})`,
    );
  }
  await fsRef.current.ensureProjectInitialized(slug);
  ensureRunner(slug);
  return { slug, dir };
}

function buildEnqueueOptions(jobId: string, payload: JobPayload) {
  // Don't pass externalTaskId here: clipfirst-engine reserves that field for jobs
  // that track an already-submitted external task, and starts those rows in
  // "running" state — which means the runner skips them. clipfirst's jobId is
  // just a client-side dedupe key, so dedupeKey + jobIdIndex (in-memory) is
  // the right pairing.
  return {
    type: extractType(payload),
    assetId: extractAssetId(payload),
    payload,
    dedupeKey: jobId,
    maxAttempts: 1,
  };
}

export const queue: Queue = {
  enqueue: async (jobId, payload) => {
    const { slug, dir } = await ensureProjectReady(jobId, payload);
    const result = queueApi.enqueue(dir, buildEnqueueOptions(jobId, payload));
    jobIdIndex.set(jobId, { slug, internalId: result.job.id });
  },

  enqueueAndWait: async <T = unknown>(
    jobId: string,
    payload: JobPayload,
    timeoutMs = 300_000,
  ): Promise<T> => {
    const { slug } = await ensureProjectReady(jobId, payload);
    return fsRef.current.queue.enqueueAndWait<T>(
      slug,
      buildEnqueueOptions(jobId, payload),
      timeoutMs,
    );
  },

  getStatus: async (jobId) => {
    const ix = jobIdIndex.get(jobId);
    if (!ix) return null;
    const job = await fsRef.current.queue.getJob(ix.slug, ix.internalId);
    if (!job) return null;
    return {
      state: mapState(job.state),
      ...(job.error ? { error: { message: job.error.message } } : {}),
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
    jobIdIndex.clear();
    await Promise.all(infos.map((info) => info.runner.stop()));
    for (const info of infos) {
      closeStateDb(projectDirFor(info.slug));
    }
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
  jobIdIndex.clear();
  await Promise.all(stale.map((info) => info.runner.stop().catch(() => {})));
  for (const info of stale) {
    closeStateDb(path.join(info.projectsDir, info.slug));
  }
  const prior = fsRef.current;
  if (prior !== defaultFs) prior.close();
  activeProjectsDir = dir;
  fsRef.current = createFs({ projectsDir: dir });
}

export function getProjectsDir(): string {
  return activeProjectsDir;
}
