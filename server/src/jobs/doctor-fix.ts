import type { VideocityFs } from "videocity-engine";
import { registerJobHandler } from "../queue.js";

// How far back through an asset's git history to look for a usable state.
const HISTORY_LIMIT = 25;

interface DoctorFixPayload {
  type: "doctor_fix";
  projectSlug: string;
  assetId: string;
}

export type DoctorFixResult =
  | { status: "already_healthy"; asset_id: string; asset_status: string }
  | { status: "recovered_in_place"; asset_id: string; asset_status: string }
  | {
      status: "restored";
      asset_id: string;
      from_commit: string;
      commit_date: string;
      asset_status: string;
    }
  | { status: "unfixable"; asset_id: string; scanned: number; asset_status: string }
  | { status: "busy"; asset_id: string; reason: string };

async function statusOf(
  fs: VideocityFs,
  projectSlug: string,
  assetId: string,
): Promise<string> {
  const res = await fs.getAssetStatus(assetId, projectSlug);
  return res.ok ? res.value : "error";
}

/**
 * Restore one asset to its last usable state before the current error.
 *
 * Runs lock-free, exactly like restore_asset_version: recoverAssetRow and
 * restoreAsset re-derive the asset row themselves, and a held lock would make
 * recoverAssetRow treat the asset as "abandoned". Concurrency is guarded by a
 * read-only check for a live work lease instead.
 *
 * Tier 1 (non-destructive): clear the durable failure signals — generation
 * error, stale pending task, expired lock — then re-derive the row from disk.
 * If the media on disk is intact, this *is* the last usable state and no file
 * changes are needed.
 *
 * Tier 2 (git restore): the working tree itself is broken, so walk the asset's
 * git history newest-first and restore the first commit that yields a `ready`
 * asset.
 */
async function fixAsset(
  fs: VideocityFs,
  projectSlug: string,
  assetId: string,
): Promise<DoctorFixResult> {
  // Refuse to touch an asset a job is actively working (live, unexpired lease).
  const work = await fs.assetWork.read(projectSlug, assetId);
  if (
    work.ok &&
    work.value &&
    work.value.status === "working" &&
    work.value.deadlineAt != null &&
    work.value.deadlineAt * 1000 > Date.now()
  ) {
    return { status: "busy", asset_id: assetId, reason: "asset has an active job lease" };
  }

  const before = await statusOf(fs, projectSlug, assetId);

  // Tier 1 — clear durable failure signals, then re-derive from disk.
  await fs.generationErrors.clear(projectSlug, assetId);
  const pending = await fs.pendingTasks.read(projectSlug, assetId);
  if (pending.ok && pending.value) {
    // delete (not forceFail) so we don't write a fresh generation error.
    await fs.pendingTasks.delete(projectSlug, assetId);
  }
  const dirRes = await fs.resolveAssetDir(assetId, projectSlug);
  if (dirRes.ok) await fs.cleanStaleLock(dirRes.value);
  await fs.recoverAssetRow(projectSlug, assetId);

  const afterTier1 = await statusOf(fs, projectSlug, assetId);
  if (afterTier1 === "ready") {
    return {
      status: before === "ready" ? "already_healthy" : "recovered_in_place",
      asset_id: assetId,
      asset_status: afterTier1,
    };
  }

  // Tier 2 — restore from git history.
  const history = await fs.getAssetHistory(assetId, projectSlug, HISTORY_LIMIT);
  for (const commit of history) {
    const restored = await fs.restoreAsset(assetId, commit.hash, projectSlug);
    if (!restored) continue;
    // restoreAsset re-derives the row; clear any error it carried forward.
    await fs.generationErrors.clear(projectSlug, assetId);
    const status = await statusOf(fs, projectSlug, assetId);
    if (status === "ready") {
      return {
        status: "restored",
        asset_id: assetId,
        from_commit: commit.hash,
        commit_date: commit.date,
        asset_status: status,
      };
    }
  }

  return {
    status: "unfixable",
    asset_id: assetId,
    scanned: history.length,
    asset_status: await statusOf(fs, projectSlug, assetId),
  };
}

export function registerDoctorFixJob(fs: VideocityFs): void {
  registerJobHandler("doctor_fix", async (payload) => {
    const { projectSlug, assetId } = payload as unknown as DoctorFixPayload;
    return fixAsset(fs, projectSlug, assetId);
  });
}
