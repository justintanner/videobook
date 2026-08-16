import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";

interface DoctorFixPayload {
  type: "doctor_fix";
  bookId: string;
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
  fs: Engine,
  assetId: string,
): Promise<string> {
  const res = await fs.status.get(assetId);
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
 * Tier 2 (Dolt restore): the current manifest itself is broken, so walk the
 * asset history newest-first and restore the first revision that yields a `ready`
 * asset.
 */
async function fixAsset(
  fs: Engine,
  assetId: string,
): Promise<DoctorFixResult> {
  // Refuse to touch an asset a job is actively working (live, unexpired lease).
  const work = await fs.jobs.artifactWork.read(assetId);
  if (
    work.ok &&
    work.value &&
    work.value.status === "working" &&
    work.value.deadlineAt != null &&
    work.value.deadlineAt > Date.now()
  ) {
    return { status: "busy", asset_id: assetId, reason: "asset has an active job lease" };
  }

  const before = await statusOf(fs, assetId);

  // Tier 1 — clear durable failure signals, then re-derive from disk.
  await fs.jobs.failures.clear(assetId);
  const pending = await fs.jobs.pending.read(assetId);
  if (pending.ok && pending.value) {
    // delete (not forceFail) so we don't write a fresh generation error.
    await fs.jobs.pending.delete(assetId);
  }
  const dirRes = await fs.workspaces.resolveArtifact(assetId);
  if (dirRes.ok) await fs.jobs.locks.cleanStale(dirRes.value);
  await fs.jobs.recoverArtifact(assetId);

  const afterTier1 = await statusOf(fs, assetId);
  if (afterTier1 === "ready") {
    return {
      status: before === "ready" ? "already_healthy" : "recovered_in_place",
      asset_id: assetId,
      asset_status: afterTier1,
    };
  }

  // Tier 2 — restore from immutable Dolt history using stable identity.
  const artifact = fs.artifacts.get(assetId);
  if (!artifact.ok) {
    return {
      status: "unfixable",
      asset_id: assetId,
      scanned: 0,
      asset_status: afterTier1,
    };
  }
  const history = fs.history.artifact(artifact.value.artifactId);
  for (const commit of history) {
    const restored = await fs.history.restoreArtifact(
      artifact.value.artifactId,
      commit.hash,
    );
    if (!restored.ok) continue;
    // restoreAsset re-derives the row; clear any error it carried forward.
    await fs.jobs.failures.clear(assetId);
    const status = await statusOf(fs, assetId);
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
    asset_status: await statusOf(fs, assetId),
  };
}

export function registerDoctorFixJob(fs: Engine): void {
  registerJobHandler("doctor_fix", async (payload) => {
    const { assetId } = payload as unknown as DoctorFixPayload;
    return fixAsset(fs, assetId);
  });
}
