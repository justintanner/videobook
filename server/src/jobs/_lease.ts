import type { ClipfirstFs } from "clipfirst-engine";
import type { JobHandlerContext } from "../queue.js";

type AssetWorkKind =
  | "render"
  | "generate"
  | "transcribe"
  | "isolate"
  | "download"
  | "trim"
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
  fs: ClipfirstFs,
  projectSlug: string,
  assetId: string,
  ctx: JobHandlerContext,
  kind: AssetWorkKind,
  fn: (ownerId: string) => Promise<{ taskId: string; result: T }>,
  options: { durationMs?: number } = {},
): Promise<T> {
  const lease = await fs.assetWork.begin(projectSlug, assetId, {
    kind,
    ownerKind: "job",
    durationMs: options.durationMs ?? DEFAULT_LEASE_MS,
  });
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
    const { taskId, result } = await fn(lease.ownerId);
    ctx.setLease({ kind: "task", taskId });
    return result;
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Pattern B — Local-work handler. Claim a job lease, run the work end-to-end,
 * call `completeAssetWork` on success or `failAssetWork` on throw. The
 * handler doesn't need to touch pending_tasks at all.
 */
export async function withLocalLease<T>(
  fs: ClipfirstFs,
  projectSlug: string,
  assetId: string,
  ctx: JobHandlerContext,
  kind: AssetWorkKind,
  fn: (ownerId: string) => Promise<T>,
  options: { durationMs?: number } = {},
): Promise<T> {
  const lease = await fs.assetWork.begin(projectSlug, assetId, {
    kind,
    ownerKind: "job",
    durationMs: options.durationMs ?? DEFAULT_LEASE_MS,
  });
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
