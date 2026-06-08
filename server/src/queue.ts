/**
 * SQLite-backed persistent queue.
 *
 * Storage is per-project: each project's `.videocity/state.sqlite` holds its
 * own pending_jobs rows. The queue routes enqueue calls to the right project's
 * state DB by joining `projectsDir` (settable for tests via setProjectsDir)
 * with the payload's `projectSlug`.
 */

import * as path from "node:path";
import * as fsp from "node:fs/promises";

import {
  type VideocityFs,
  type AssetWorkKind,
  type Job,
  type JobHandler,
  type JobState,
  QueueRunner,
  createFs,
  isValidProjectSlug,
  queueApi,
  closeStateDb,
} from "vc-engine";

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

/**
 * Lease token registered by a handler so the queue wrapper's catch can
 * CAS-fail the correct owner. Handlers that hold a local lease pass `owner`
 * (their beginAssetWork ownerId); handlers that observed a provider task pass
 * `task` (the task_id). A handler that dies before registering is in the
 * "queued-but-unclaimed" state, which the wrapper falls back to.
 */
export type LeaseToken =
  | { kind: "owner"; ownerId: string }
  | { kind: "task"; taskId: string };

export interface JobHandlerContext {
  setLease(token: LeaseToken): void;
  getOwnerId(): string;
}

export type ServerJobHandler = (
  payload: Record<string, unknown>,
  ctx: JobHandlerContext,
) => Promise<unknown>;

const handlers = new Map<string, ServerJobHandler>();

export function registerJobHandler(
  type: string,
  handler: ServerJobHandler,
): void {
  handlers.set(type, handler);
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
  if (typeof payload.audAssetId === "string") return payload.audAssetId;
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
const fsRef: { current: VideocityFs } = { current: defaultFs };

interface RunnerInfo {
  projectsDir: string;
  slug: string;
  runner: QueueRunner;
}
const runnerByProject = new Map<string, RunnerInfo>();

const jobIdIndex = new Map<string, { slug: string; internalId: number }>();
const rewindingProjects = new Set<string>();

type Orientation = "portrait" | "landscape" | "square";
type ClassifiedJob = { kind: AssetWorkKind; orientation?: Orientation };

/**
 * Maps a job type to the clean AssetWorkKind that the engine writes into
 * assets.meta.kind at enqueue time. Mirrors what the corresponding handler
 * later passes to beginAssetWork, so a single in-progress UI state is
 * derivable for the asset across the queued → working → ready lifecycle.
 *
 * Returns null for jobs that should not surface an asset state (e.g.
 * post_to_x — runs sub-second and the asset is already ready).
 */
function jobTypeToAssetWorkKind(
  jobType: string,
  payload: JobPayload,
): ClassifiedJob | null {
  if (jobType === "render_project" || jobType === "render_timeline") {
    const o = payload.orientation;
    const orientation =
      o === "portrait" || o === "landscape" || o === "square"
        ? (o as Orientation)
        : undefined;
    const kind: AssetWorkKind =
      jobType === "render_timeline" ? "final" : "render";
    return orientation ? { kind, orientation } : { kind };
  }
  switch (jobType) {
    case "process_video":
    case "process_image":          return { kind: "process" };
    case "analyze_video":          return { kind: "analyze" };
    case "transcribe":
    case "transcribe_video_audio": return { kind: "transcribe" };
    case "trim_video":             return { kind: "trim" };
    case "split_video":            return { kind: "trim" };
    case "crop_video":             return { kind: "crop" };
    case "splice_video":           return { kind: "splice" };
    case "reverse_video":          return { kind: "reverse" };
    case "change_video_speed":     return { kind: "change_speed" };
    case "replace_video_audio":    return { kind: "replace_audio" };
    case "apply_cuts":             return { kind: "apply_cuts" };
    case "apply_sfx":              return { kind: "apply_sfx" };
    case "extract_frame":
    case "extract_audio":
    case "extract_character":      return { kind: "extract" };
    case "describe_image":         return { kind: "describe" };
    case "rewrite_script":         return { kind: "rewrite_script" };
    case "download_video":         return { kind: "download" };
    case "watermark_video":        return { kind: "final" };
    case "complete_kie_task":      return { kind: "generate" };
    case "post_to_x":              return null;
  }
  if (jobType === "isolate_vocals") return { kind: "isolate" };
  if (
    jobType.startsWith("generate_") ||
    jobType.startsWith("extend_") ||
    jobType.startsWith("upscale_")
  ) {
    return { kind: "generate" };
  }
  return null;
}

/** Subset of jobTypeToAssetWorkKind used by the wrapper to decide whether to
 *  pre-claim a local lease before invoking the handler (Pattern A handoff).
 *  Only generation/extend/upscale/isolate_vocals follow this pattern. */
function providerHandoffKindFor(jobType: string): AssetWorkKind | null {
  if (jobType === "isolate_vocals") return "isolate";
  if (
    jobType.startsWith("generate_") ||
    jobType.startsWith("extend_") ||
    jobType.startsWith("upscale_")
  ) {
    return "generate";
  }
  return null;
}

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
    return async (job: Job) => {
      // Ref-cell instead of `let lease`: setLease is captured in ctx and
      // invoked via `ctx.setLease(...)` from inside this scope and via the
      // handler. TypeScript's control-flow analysis doesn't widen a let
      // variable's narrowing through object-method calls on a captured
      // closure, so reads of `lease` after `ctx.setLease(...)` would be
      // narrowed back to the initial `null` (and `lease?.kind === "owner"`
      // would dead-narrow to `never`). A ref-cell sidesteps that — TS treats
      // each `leaseRef.current` read as a fresh access at its declared type.
      const leaseRef: { current: LeaseToken | null } = { current: null };
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const providerKind = providerHandoffKindFor(type);
      const ctx: JobHandlerContext = {
        setLease(token) {
          const current = leaseRef.current;
          if (current !== null) {
            // Allow re-registration of the same shape (idempotent), or
            // allow owner→task transition (Pattern A handoff).
            if (current.kind === token.kind) {
              if (current.kind === "owner" && token.kind === "owner") {
                if (current.ownerId !== token.ownerId) {
                  throw new Error(
                    `setLease: cannot replace existing owner lease`,
                  );
                }
              } else if (current.kind === "task" && token.kind === "task") {
                if (current.taskId !== token.taskId) {
                  throw new Error(
                    `setLease: cannot replace existing task lease`,
                  );
                }
              }
              return;
            }
            if (current.kind === "owner" && token.kind === "task") {
              // Allowed: Pattern A handoff from local job lease to provider task lease.
              leaseRef.current = token;
              return;
            }
            throw new Error(
              `setLease: invalid lease transition ${current.kind}→${token.kind}`,
            );
          }
          leaseRef.current = token;
        },
        getOwnerId() {
          const current = leaseRef.current;
          if (current?.kind !== "owner") {
            throw new Error("No active owner lease is registered");
          }
          return current.ownerId;
        },
      };

      try {
        if (providerKind) {
          const assetId = extractAssetId(job.payload);
          const projectSlug = extractProjectSlug(job.payload);
          if (!assetId || !projectSlug) {
            throw new Error(
              `Provider handoff job ${type} requires projectSlug and asset id`,
            );
          }
          const claimed = await fsRef.current.assetWork.begin(
            projectSlug,
            assetId,
            {
              kind: providerKind,
              ownerKind: "job",
              durationMs: 15 * 60_000,
            },
          );
          if (!claimed) {
            throw new Error(`Could not claim local lease for ${assetId}`);
          }
          ctx.setLease({ kind: "owner", ownerId: claimed.ownerId });
          heartbeat = setInterval(() => {
            void fsRef.current.assetWork.renew(
              projectSlug,
              assetId,
              claimed.ownerId,
              60_000,
            );
          }, 20_000);
        }
        const result = await handler(job.payload, ctx);
        const assetId = extractAssetId(job.payload);
        const projectSlug = extractProjectSlug(job.payload);
        const finalLease = leaseRef.current;
        if (finalLease?.kind === "owner" && assetId && projectSlug) {
          await fsRef.current.assetWork.complete(
            projectSlug,
            assetId,
            finalLease.ownerId,
          );
        }
        return result;
      } catch (error: unknown) {
        const assetId = extractAssetId(job.payload);
        const projectSlug = extractProjectSlug(job.payload);
        const message =
          error instanceof Error ? error.message : String(error);

        if (assetId && projectSlug) {
          const fsForCleanup = fsRef.current;
          await dispatchFailure(
            fsForCleanup,
            projectSlug,
            assetId,
            leaseRef.current,
            message,
          );
        }
        throw error;
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
    };
  };
}

async function dispatchFailure(
  fs: VideocityFs,
  projectSlug: string,
  assetId: string,
  lease: LeaseToken | null,
  message: string,
): Promise<void> {
  try {
    if (lease?.kind === "owner") {
      await fs.assetWork.fail(projectSlug, assetId, lease.ownerId, {
        message,
      });
      await fs
        .logAction("job-error", { assetId, error: message }, projectSlug)
        .catch(() => {});
      return;
    }
    if (lease?.kind === "task") {
      await fs.pendingTasks.fail(projectSlug, assetId, lease.taskId, {
        message,
      });
      await fs
        .logAction("job-error", { assetId, error: message }, projectSlug)
        .catch(() => {});
      return;
    }
    // No lease registered. Force-fail by asset_id to clear any pending row.
    await fs.pendingTasks.forceFail(projectSlug, assetId, { message });
    await fs
      .logAction("job-error", { assetId, error: message }, projectSlug)
      .catch(() => {});
  } catch {
    // best-effort; nothing more we can do here
  }
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
  const dir = projectDirFor(slug);
  if (rewindingProjects.has(slug)) {
    throw new Error(`queue.enqueue: project is rewinding: ${slug}`);
  }
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
  const type = extractType(payload);
  const assetId = extractAssetId(payload);
  const classified = assetId ? jobTypeToAssetWorkKind(type, payload) : null;
  return {
    type,
    assetId,
    payload,
    dedupeKey: jobId,
    maxAttempts: 1,
    assetWorkKind: classified?.kind ?? null,
    assetWorkOrientation: classified?.orientation ?? null,
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

  start: async () => {},

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

export interface RewindQueuePreparation {
  abortedJobs: number;
  failedPendingTasks: number;
}

async function waitForRunnerStop(
  runner: QueueRunner,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stopped = runner.stop().then(() => true);
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const result = await Promise.race([stopped, timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}

async function restartRunnerIfProjectExists(projectSlug: string): Promise<void> {
  try {
    if (await projectExists(projectDirFor(projectSlug))) {
      ensureRunner(projectSlug);
    }
  } catch {
    return;
  }
}

export async function prepareProjectForRewind(
  projectSlug: string,
  timeoutMs = 15_000,
): Promise<RewindQueuePreparation> {
  if (rewindingProjects.has(projectSlug)) {
    throw new Error(`Project is already rewinding: ${projectSlug}`);
  }
  rewindingProjects.add(projectSlug);
  let stoppedRunner = false;
  try {
    await fsRef.current.ensureProjectInitialized(projectSlug);
    const info = runnerByProject.get(projectSlug);
    if (info) {
      const stopped = await waitForRunnerStop(info.runner, timeoutMs);
      if (!stopped) {
        info.runner.start();
        throw new Error(
          `Timed out waiting for active jobs to stop before rewinding ${projectSlug}`,
        );
      }
      runnerByProject.delete(projectSlug);
      stoppedRunner = true;
    }

    const states: JobState[] = ["queued", "running", "completing"];
    const jobs = await fsRef.current.queue.list(projectSlug, { states });
    for (const job of jobs) {
      await fsRef.current.queue.abort(
        projectSlug,
        job.id,
        "Aborted by project rewind",
      );
    }

    const pending = await fsRef.current.pendingTasks.findAll(projectSlug);
    let failedPendingTasks = 0;
    if (pending.ok) {
      for (const task of pending.value) {
        const failed = await fsRef.current.pendingTasks.forceFail(
          projectSlug,
          task.assetId,
          { message: "Aborted by project rewind", failCode: "rewind" },
        );
        if (failed.ok) failedPendingTasks += 1;
      }
    }

    if (jobs.length > 0 || failedPendingTasks > 0) {
      await fsRef.current
        .logAction(
          "rewind-abort-jobs",
          { aborted_jobs: jobs.length, failed_pending_tasks: failedPendingTasks },
          projectSlug,
        )
        .catch(() => {});
    }

    closeStateDb(projectDirFor(projectSlug));
    return { abortedJobs: jobs.length, failedPendingTasks };
  } catch (error) {
    rewindingProjects.delete(projectSlug);
    if (stoppedRunner) await restartRunnerIfProjectExists(projectSlug);
    throw error;
  }
}

export async function resumeProjectAfterRewind(projectSlug: string): Promise<void> {
  rewindingProjects.delete(projectSlug);
  await restartRunnerIfProjectExists(projectSlug);
}

/**
 * Test-only: redirect all queue operations to a different projectsDir, and
 * tear down any runners pointing at the previous one.
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
