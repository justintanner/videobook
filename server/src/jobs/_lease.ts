import type { AssetMeta, VideocityFs } from "videocity-engine";
import type { JobHandlerContext } from "../queue.js";

type AssetWorkKind =
  | "render"
  | "generate"
  | "transcribe"
  | "isolate"
  | "download"
  | "archive"
  | "trim"
  | "crop"
  | "splice"
  | "reverse"
  | "change_speed"
  | "replace_audio"
  | "process"
  | "analyze"
  | "delete"
  | "upload"
  | "describe"
  | "rewrite_script"
  | "extract"
  | "apply_cuts"
  | "apply_sfx"
  | "final";

const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_EXTEND_MS = 60_000;
const DEFAULT_LEASE_MS = 15 * 60_000;

type LeaseOptions = {
  durationMs?: number;
  waitForActiveMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function beginLocalLease(
  fs: VideocityFs,
  projectSlug: string,
  assetId: string,
  kind: AssetWorkKind,
  options: LeaseOptions,
): Promise<{ ownerId: string } | null> {
  const started = Date.now();
  const waitForActiveMs = options.waitForActiveMs ?? 0;
  while (true) {
    const lease = await fs.assetWork.begin(projectSlug, assetId, {
      kind,
      ownerKind: "job",
      durationMs: options.durationMs ?? DEFAULT_LEASE_MS,
    });
    if (lease) return lease;
    if (Date.now() - started >= waitForActiveMs) return null;
    await sleep(250);
  }
}

/**
 * Pattern A — Provider handoff. Claim a local job lease, run the submission
 * work (upload/build/submit), then atomically hand off to the provider lease
 * via `pendingTasks.write(expectedOwnerId)`. The handler returns the freshly
 * minted task_id; this helper transitions the wrapper's lease token from
 * `{kind:'owner'}` to `{kind:'task'}` so a late crash CAS-fails by task_id.
 *
 * `fn` receives the local owner_id; it must pass that as the
 * `expectedOwnerId` to `pendingTasks.write` and return the task_id the
 * provider returned.
 */
export async function withProviderHandoff<T>(
  fs: VideocityFs,
  projectSlug: string,
  assetId: string,
  ctx: JobHandlerContext,
  kind: AssetWorkKind,
  fn: (ownerId: string) => Promise<{ taskId: string; result: T }>,
  options: LeaseOptions = {},
): Promise<T> {
  let ownerId: string | null = null;
  let ownsLease = false;
  try {
    ownerId = ctx.getOwnerId();
  } catch {
    ownerId = null;
  }

  if (!ownerId) {
    const lease = await beginLocalLease(fs, projectSlug, assetId, kind, options);
    if (!lease) {
      throw new Error(
        `could not claim local lease for ${assetId}: active owner already holds it`,
      );
    }
    ownerId = lease.ownerId;
    ownsLease = true;
    ctx.setLease({ kind: "owner", ownerId });
  }

  const activeOwnerId = ownerId;
  const heartbeat = ownsLease
    ? setInterval(() => {
        void fs.assetWork.renew(projectSlug, assetId, activeOwnerId, HEARTBEAT_EXTEND_MS);
      }, HEARTBEAT_INTERVAL_MS)
    : null;
  try {
    const { taskId, result } = await fn(activeOwnerId);
    ctx.setLease({ kind: "task", taskId });
    return result;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

/**
 * Pattern B — Local-work handler. Claim a job lease, run the work end-to-end,
 * call `completeAssetWork` on success or `failAssetWork` on throw. The
 * handler doesn't need to touch pending_tasks at all.
 */
export async function withLocalLease<T>(
  fs: VideocityFs,
  projectSlug: string,
  assetId: string,
  ctx: JobHandlerContext,
  kind: AssetWorkKind,
  fn: (ownerId: string) => Promise<T>,
  options: LeaseOptions = {},
): Promise<T> {
  const lease = await beginLocalLease(fs, projectSlug, assetId, kind, options);
  if (!lease) {
    throw new Error(
      `could not claim local lease for ${assetId}: active owner already holds it`,
    );
  }
  ctx.setLease({ kind: "owner", ownerId: lease.ownerId });
  const heartbeat = setInterval(() => {
    void fs.assetWork.renew(projectSlug, assetId, lease.ownerId, HEARTBEAT_EXTEND_MS);
  }, HEARTBEAT_INTERVAL_MS);
  try {
    const result = await fn(lease.ownerId);
    await fs.assetWork.complete(projectSlug, assetId, lease.ownerId);
    return result;
  } catch (err) {
    await fs.assetWork.fail(projectSlug, assetId, lease.ownerId, {
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

const CLAIM_RETRY_INTERVAL_MS = 1_000;

export type LockedLeaseClaim =
  | { ok: true; ownerId: string }
  | { ok: false; reason: string };

/**
 * Claim the asset dir lock AND a local job lease together, polling both until
 * `options.waitForActiveMs` elapses. Waiting (instead of failing fast)
 * serializes workers that target the same asset — e.g. the three
 * per-orientation render jobs the render tool enqueues at once — so
 * latecomers run after the current holder finishes rather than erroring.
 *
 * On success the caller owns both and must itself complete/fail the lease
 * and release the lock.
 */
export async function claimLockedLease(
  fs: VideocityFs,
  projectSlug: string,
  assetId: string,
  assetDir: string,
  kind: AssetWorkKind,
  lock: { durationMs: number; data?: Record<string, unknown> },
  options: LeaseOptions & { meta?: Partial<AssetMeta> } = {},
): Promise<LockedLeaseClaim> {
  const started = Date.now();
  const waitForActiveMs = options.waitForActiveMs ?? 0;
  let reason = "could not claim asset";
  while (true) {
    const lockResult = await fs.acquireLock(assetDir, lock);
    if (lockResult.ok) {
      const lease = await fs.assetWork.begin(projectSlug, assetId, {
        kind,
        ownerKind: "job",
        durationMs: options.durationMs ?? DEFAULT_LEASE_MS,
        ...(options.meta ? { meta: options.meta } : {}),
      });
      if (lease) return { ok: true, ownerId: lease.ownerId };
      await fs.releaseLock(assetDir).catch(() => {});
      reason = "active owner already holds asset lease";
    } else {
      reason = `Asset is locked: ${lockResult.error.message}`;
    }
    if (Date.now() - started >= waitForActiveMs) return { ok: false, reason };
    await sleep(CLAIM_RETRY_INTERVAL_MS);
  }
}

export async function withLockedLocalLease<T>(
  fs: VideocityFs,
  projectSlug: string,
  assetId: string,
  assetDir: string,
  ctx: JobHandlerContext,
  kind: AssetWorkKind,
  lock: { durationMs: number; data?: Record<string, unknown> },
  fn: (ownerId: string) => Promise<T>,
  options: LeaseOptions = {},
): Promise<T> {
  const lockResult = await fs.acquireLock(assetDir, lock);
  if (!lockResult.ok) {
    throw new Error(`Asset is locked: ${lockResult.error.message}`);
  }
  try {
    return await withLocalLease(
      fs,
      projectSlug,
      assetId,
      ctx,
      kind,
      fn,
      options,
    );
  } finally {
    await fs.releaseLock(assetDir).catch(() => {});
  }
}
