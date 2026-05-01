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
  type AssetWorkKind,
  type Job,
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

const jobIdIndex = new Map<string, { slug: string; internalId: number }>();

const directProviderHandoffKinds = new Map<string, AssetWorkKind>([
  ["extend_grok_imagine_video", "generate"],
  ["extend_wan27_video", "generate"],
  ["generate_alibaba_image", "generate"],
  ["generate_alibaba_image_pro", "generate"],
  ["generate_alibaba_qwen_image", "generate"],
  ["generate_alibaba_qwen_image_edit", "generate"],
  ["generate_alibaba_video", "generate"],
  ["generate_gpt_image", "generate"],
  ["generate_gpt_image_text", "generate"],
  ["generate_grok_imagine_image", "generate"],
  ["generate_grok_imagine_ref_video", "generate"],
  ["generate_grok_imagine_text_image", "generate"],
  ["generate_grok_imagine_video", "generate"],
  ["generate_kling30_motion_control_video", "generate"],
  ["generate_kling30_video", "generate"],
  ["generate_nano_banana_image", "generate"],
  ["generate_qwen2_image_edit", "generate"],
  ["generate_seedance2_frames_video", "generate"],
  ["generate_seedance2_i2v_video", "generate"],
  ["generate_seedance2_reference_video", "generate"],
  ["generate_seedance2_t2v_video", "generate"],
  ["generate_seedream_image", "generate"],
  ["generate_seedream_text_image", "generate"],
  ["generate_wan27_i2v_video", "generate"],
  ["generate_wan27_image", "generate"],
  ["generate_wan27_image_pro", "generate"],
  ["generate_wan27_r2v_video", "generate"],
  ["generate_wan27_videoedit_video", "generate"],
  ["isolate_vocals", "isolate"],
  ["transcribe", "transcribe"],
  ["upscale_grok_imagine_video", "generate"],
]);

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
      let lease: LeaseToken | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const providerKind = directProviderHandoffKinds.get(type);
      const ctx: JobHandlerContext = {
        setLease(token) {
          if (lease !== null) {
            // Allow re-registration of the same shape (idempotent), or
            // allow owner→task transition (Pattern A handoff).
            if (lease.kind === token.kind) {
              if (lease.kind === "owner" && token.kind === "owner") {
                if (lease.ownerId !== token.ownerId) {
                  throw new Error(
                    `setLease: cannot replace existing owner lease`,
                  );
                }
              } else if (lease.kind === "task" && token.kind === "task") {
                if (lease.taskId !== token.taskId) {
                  throw new Error(
                    `setLease: cannot replace existing task lease`,
                  );
                }
              }
              return;
            }
            if (lease.kind === "owner" && token.kind === "task") {
              // Allowed: Pattern A handoff from local job lease to provider task lease.
              lease = token;
              return;
            }
            throw new Error(
              `setLease: invalid lease transition ${lease.kind}→${token.kind}`,
            );
          }
          lease = token;
        },
        getOwnerId() {
          if (lease?.kind !== "owner") {
            throw new Error("No active owner lease is registered");
          }
          return lease.ownerId;
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
        return await handler(job.payload, ctx);
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
            lease,
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
  fs: ClipfirstFs,
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
