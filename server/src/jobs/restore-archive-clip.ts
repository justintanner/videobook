import type { VideocityFs } from "videocity-engine";
import { join } from "node:path";
import { getArchiveStore } from "../archive-store.js";
import { queue, registerJobHandler } from "../queue.js";
import { withLockedLocalLease } from "./_lease.js";

const LOCK_DURATION_MS = 10 * 60_000;

type RestoreArchiveClipPayload = {
  type: "restore_archive_clip";
  projectSlug: string;
  assetId: string;
  assetDir: string;
  archiveId: string;
  mediaKey: string;
  filename: string;
  contentType: string;
  mediaKind: "video" | "audio";
  title?: string | null;
  duration?: number | null;
  topics?: string[];
  people?: string[];
};

function provenance(payload: RestoreArchiveClipPayload): Record<string, unknown> {
  return {
    origin: "archive",
    archive_id: payload.archiveId,
    title: payload.title ?? "",
    topics: payload.topics ?? [],
    people: payload.people ?? [],
    restored_at: new Date().toISOString(),
  };
}

export function registerRestoreArchiveClipJob(fs: VideocityFs): void {
  registerJobHandler("restore_archive_clip", async (payload, ctx) => {
    const p = payload as RestoreArchiveClipPayload;
    return withLockedLocalLease(
      fs,
      p.projectSlug,
      p.assetId,
      p.assetDir,
      ctx,
      "download",
      { durationMs: LOCK_DURATION_MS, data: { state: "downloading" } },
      async () => {
        const store = getArchiveStore();
        const body = await store.getBytes(p.mediaKey);
        if (!body) throw new Error(`Archive media not found: ${p.mediaKey}`);
        const write = await fs.writeFile(p.assetId, p.filename, Buffer.from(body), p.projectSlug);
        if (!write.ok) throw new Error(write.error.message);

        const meta = provenance(p);
        if (p.mediaKind === "video") {
          const processJobId = `process-video-${p.assetId}-${Date.now()}`;
          await queue.enqueue(processJobId, {
            type: "process_video",
            videoPath: join(p.assetDir, p.filename),
            assetId: p.assetId,
            assetDir: p.assetDir,
            projectSlug: p.projectSlug,
            provenance: meta,
          } as unknown as Record<string, unknown>);
          return { success: true, archive_id: p.archiveId, asset_id: p.assetId, job_id: processJobId };
        }

        const writeMeta = await fs.writeMetadata(p.assetId, "original", {
          ...meta,
          content_type: p.contentType,
          duration: typeof p.duration === "number" ? p.duration : null,
        }, p.projectSlug);
        if (!writeMeta.ok) throw new Error(writeMeta.error.message);
        return { success: true, archive_id: p.archiveId, asset_id: p.assetId };
      },
      { durationMs: LOCK_DURATION_MS },
    );
  });
}
