import type { ArtifactRuntimeMeta, Engine, ArtifactWorkKind } from "videobook-engine";
import { logger } from "../logger.js";
import type { JobHandlerContext } from "../queue.js";

const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_EXTEND_MS = 60_000;
const DEFAULT_LEASE_MS = 15 * 60_000;
export const DOWNSTREAM_LEASE_WAIT_MS = 60_000;

type LeaseOptions = {
  durationMs?: number;
  waitForActiveMs?: number;
  meta?: Partial<ArtifactRuntimeMeta>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function beginLocalLease(
  engine: Engine,
  assetId: string,
  kind: ArtifactWorkKind,
  options: LeaseOptions,
  signal?: AbortSignal,
): Promise<{ ownerId: string } | null> {
  const started = Date.now();
  const waitForActiveMs = options.waitForActiveMs ?? 0;
  while (true) {
    signal?.throwIfAborted();
    const lease = await engine.jobs.artifactWork.begin(assetId, {
      kind,
      ownerKind: "job",
      durationMs: options.durationMs ?? DEFAULT_LEASE_MS,
      ...(options.meta ? { meta: options.meta } : {}),
    });
    if (lease) return lease;
    if (Date.now() - started >= waitForActiveMs) return null;
    await leaseSleep(250);
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
  engine: Engine,
  assetId: string,
  ctx: JobHandlerContext,
  kind: ArtifactWorkKind,
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
    const lease = await beginLocalLease(
      engine,
      assetId,
      kind,
      options,
      ctx.signal,
    );
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
        try {
          engine.jobs.artifactWork.renew(
            assetId,
            activeOwnerId,
            HEARTBEAT_EXTEND_MS,
          );
        } catch (error) {
          logger.warn("heartbeat-failed", { assetId, error });
        }
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
  engine: Engine,
  assetId: string,
  ctx: JobHandlerContext,
  kind: ArtifactWorkKind,
  fn: (ownerId: string) => Promise<T>,
  options: LeaseOptions = {},
): Promise<T> {
  const lease = await beginLocalLease(
    engine,
    assetId,
    kind,
    options,
    ctx.signal,
  );
  if (!lease) {
    throw new Error(
      `could not claim local lease for ${assetId}: active owner already holds it`,
    );
  }
  ctx.setLease({ kind: "owner", ownerId: lease.ownerId });
  const heartbeat = setInterval(() => {
    try {
      engine.jobs.artifactWork.renew(
        assetId,
        lease.ownerId,
        HEARTBEAT_EXTEND_MS,
      );
    } catch (error) {
      logger.warn("heartbeat-failed", { assetId, error });
    }
  }, HEARTBEAT_INTERVAL_MS);
  try {
    const result = await fn(lease.ownerId);
    await engine.jobs.artifactWork.complete(assetId, lease.ownerId);
    return result;
  } catch (err) {
    await engine.jobs.artifactWork.fail(assetId, lease.ownerId, {
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

export const CLAIM_RETRY_INTERVAL_MS = 1_000;

type LeaseSleepFn = (ms: number) => Promise<void>;

let leaseSleep: LeaseSleepFn = defaultSleep;

export function configureLeaseClockForTests(options: {
  sleep?: LeaseSleepFn;
} | null): void {
  leaseSleep = options?.sleep ?? defaultSleep;
}

type LockedLeaseClaim =
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
  engine: Engine,
  assetId: string,
  assetDir: string,
  kind: ArtifactWorkKind,
  lock: { durationMs: number; data?: Record<string, unknown> },
  options: LeaseOptions = {},
): Promise<LockedLeaseClaim> {
  const started = Date.now();
  const waitForActiveMs = options.waitForActiveMs ?? 0;
  let reason = "could not claim asset";
  while (true) {
    const lockResult = await engine.jobs.locks.acquire(assetDir, lock);
    if (lockResult.ok) {
      const lease = await engine.jobs.artifactWork.begin(assetId, {
        kind,
        ownerKind: "job",
        durationMs: options.durationMs ?? DEFAULT_LEASE_MS,
        ...(options.meta ? { meta: options.meta } : {}),
      });
      if (lease) return { ok: true, ownerId: lease.ownerId };
      engine.jobs.locks.release(assetDir);
      reason = "active owner already holds asset lease";
    } else {
      reason = `Asset is locked: ${lockResult.error.message}`;
    }
    if (Date.now() - started >= waitForActiveMs) return { ok: false, reason };
    await leaseSleep(CLAIM_RETRY_INTERVAL_MS);
  }
}

export async function withLockedLocalLease<T>(
  engine: Engine,
  assetId: string,
  assetDir: string,
  ctx: JobHandlerContext,
  kind: ArtifactWorkKind,
  lock: { durationMs: number; data?: Record<string, unknown> },
  fn: (ownerId: string) => Promise<T>,
  options: LeaseOptions = {},
): Promise<T> {
  const lockResult = await engine.jobs.locks.acquire(assetDir, lock);
  if (!lockResult.ok) {
    throw new Error(`Asset is locked: ${lockResult.error.message}`);
  }
  try {
    return await withLocalLease(
      engine,
      assetId,
      ctx,
      kind,
      fn,
      options,
    );
  } finally {
    engine.jobs.locks.release(assetDir);
  }
}
