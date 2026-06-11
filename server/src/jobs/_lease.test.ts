import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { VideocityFs } from "videocity-engine";
import { createFsForTest } from "../fs.js";
import { claimLockedLease } from "./_lease.js";

const LOCK = { durationMs: 60_000 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("claimLockedLease", () => {
  let fs: VideocityFs;
  let tempDir: string;
  let assetId: string;
  let assetDir: string;
  const projectSlug = "test-proj";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-claim-lease-test-"));
    fs = createFsForTest(tempDir);
    const project = await fs.createProject(projectSlug);
    if (!project.ok) throw new Error(project.error.message);
    const created = await fs.createAsset("vid", "clip", projectSlug);
    if (!created.ok) throw new Error(created.error.message);
    assetId = created.value.assetId;
    const manifest = await fs.getManifest(assetId, projectSlug);
    if (!manifest.ok) throw new Error(manifest.error.message);
    assetDir = manifest.value.path;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function releaseClaim(ownerId: string): Promise<void> {
    await fs.assetWork.complete(projectSlug, assetId, ownerId);
    await fs.releaseLock(assetDir);
  }

  it("claims lock and lease when the asset is free", async () => {
    const claim = await claimLockedLease(fs, projectSlug, assetId, assetDir, "render", LOCK);

    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(await fs.isLocked(assetDir)).toBe(true);
    const second = await fs.assetWork.begin(projectSlug, assetId, {
      kind: "render",
      ownerKind: "job",
      durationMs: 60_000,
    });
    expect(second).toBeNull();
    await releaseClaim(claim.ownerId);
  });

  it("fails fast when the dir lock is held and no wait is requested", async () => {
    const lock = await fs.acquireLock(assetDir, LOCK);
    if (!lock.ok) throw new Error(lock.error.message);

    const claim = await claimLockedLease(fs, projectSlug, assetId, assetDir, "render", LOCK);

    expect(claim.ok).toBe(false);
    if (claim.ok) return;
    expect(claim.reason).toContain("locked");
    await fs.releaseLock(assetDir);
  });

  it("waits for a held dir lock to be released", async () => {
    const lock = await fs.acquireLock(assetDir, LOCK);
    if (!lock.ok) throw new Error(lock.error.message);
    const releaseLater = (async () => {
      await sleep(300);
      await fs.releaseLock(assetDir);
    })();

    const claim = await claimLockedLease(
      fs, projectSlug, assetId, assetDir, "render", LOCK,
      { waitForActiveMs: 10_000 },
    );

    await releaseLater;
    expect(claim.ok).toBe(true);
    if (claim.ok) await releaseClaim(claim.ownerId);
  });

  it("waits for an active lease to complete", async () => {
    const lease = await fs.assetWork.begin(projectSlug, assetId, {
      kind: "transcribe",
      ownerKind: "job",
      durationMs: 60_000,
    });
    if (!lease) throw new Error("test setup: could not begin lease");
    const completeLater = (async () => {
      await sleep(300);
      await fs.assetWork.complete(projectSlug, assetId, lease.ownerId);
    })();

    const claim = await claimLockedLease(
      fs, projectSlug, assetId, assetDir, "render", LOCK,
      { waitForActiveMs: 10_000, meta: { orientation: "portrait" } },
    );

    await completeLater;
    expect(claim.ok).toBe(true);
    if (claim.ok) await releaseClaim(claim.ownerId);
  });

  it("serializes concurrent claims for the same asset", async () => {
    let active = 0;
    let maxActive = 0;
    const worker = async (): Promise<boolean> => {
      const claim = await claimLockedLease(
        fs, projectSlug, assetId, assetDir, "render", LOCK,
        { waitForActiveMs: 20_000 },
      );
      if (!claim.ok) return false;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(100);
      active -= 1;
      await releaseClaim(claim.ownerId);
      return true;
    };

    const results = await Promise.all([worker(), worker(), worker()]);

    expect(results).toEqual([true, true, true]);
    expect(maxActive).toBe(1);
  });
});
