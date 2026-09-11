import type { Engine } from "videobook-engine";
import { z } from "zod";
import { extname } from "node:path";
import { indexKey } from "../archive-b2.js";
import type { ArchiveIndex } from "../archive-b2.js";
import { getArchiveStore } from "../archive-store.js";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";

const MAX_RESTORE_IDS = 25;
const ARCHIVE_ID_RE = /^[a-f0-9]{64}$/i;

type ArchiveMediaTarget = {
  kind: "video" | "audio";
  filename: string;
};

type ArchiveMetadata = {
  archive_id?: unknown;
};

const EXTENSION_TARGETS = new Map<string, Omit<ArchiveMediaTarget, "filename">>([
  [".mp4", { kind: "video" }],
  [".mov", { kind: "video" }],
  [".webm", { kind: "video" }],
  [".mkv", { kind: "video" }],
  [".mp3", { kind: "audio" }],
  [".wav", { kind: "audio" }],
  [".m4a", { kind: "audio" }],
  [".aac", { kind: "audio" }],
  [".flac", { kind: "audio" }],
  [".ogg", { kind: "audio" }],
  [".weba", { kind: "audio" }],
]);

const CONTENT_TYPE_EXTENSIONS = new Map<string, string>([
  ["video/mp4", ".mp4"],
  ["video/quicktime", ".mov"],
  ["video/webm", ".webm"],
  ["video/x-matroska", ".mkv"],
  ["audio/mpeg", ".mp3"],
  ["audio/wav", ".wav"],
  ["audio/mp4", ".m4a"],
  ["audio/aac", ".aac"],
  ["audio/flac", ".flac"],
  ["audio/ogg", ".ogg"],
  ["audio/webm", ".weba"],
]);

function toolError(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

function normalizeArchiveIds(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const id = value.trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function archiveMediaTarget(index: ArchiveIndex): ArchiveMediaTarget | null {
  const filenameExtension = extname(index.media.filename).toLowerCase();
  const contentType = index.media.content_type.toLowerCase().split(";")[0]?.trim() ?? "";
  const contentTypeExtension = CONTENT_TYPE_EXTENSIONS.get(contentType) || "";
  const extension = filenameExtension === ".webm" && contentTypeExtension === ".weba"
    ? ".weba"
    : EXTENSION_TARGETS.has(filenameExtension) ? filenameExtension : contentTypeExtension;
  const target = EXTENSION_TARGETS.get(extension);
  if (!target) return null;
  return {
    ...target,
    filename: `original${extension}`,
  };
}

function archiveAssetName(index: ArchiveIndex): string {
  const title = index.title?.trim();
  if (title) return title;
  const base = index.media.filename.replace(/\.[^.]+$/, "").trim();
  return base || `archive ${index.archive_id.slice(0, 8)}`;
}

function tagLabels(tags: ArchiveIndex["topics"]): string[] {
  return tags.map((tag) => tag.label);
}

function archiveMetadata(index: ArchiveIndex): Record<string, unknown> {
  return {
    archive_id: index.archive_id,
    sha256: index.sha256,
    title: index.title,
    media_key: index.media.key,
    media_filename: index.media.filename,
    media_content_type: index.media.content_type,
    media_size_bytes: index.media.size_bytes,
    archive_created_at: index.created_at,
    archive_updated_at: index.updated_at,
    archived_at: index.created_at,
    restored_at: new Date().toISOString(),
    topics: tagLabels(index.topics),
    people: tagLabels(index.people),
  };
}

async function existingArchiveAssets(
  engine: Engine,
  archiveIds: string[],
): Promise<Map<string, string>> {
  const wanted = new Set(archiveIds);
  const out = new Map<string, string>();
  const assets = await engine.artifacts.list();
  await Promise.all(assets.map(async (asset) => {
    const meta = await engine.metadata.artifacts.read<ArchiveMetadata>(asset.artifactId, "archive");
    if (!meta.ok) return;
    const archiveId = meta.value.archive_id;
    if (typeof archiveId === "string" && wanted.has(archiveId)) {
      out.set(archiveId, asset.artifactId);
    }
  }));
  return out;
}

export function restoreArchiveClipsDef(engine: Engine): ToolDef {
  return {
    name: "restore_archive_clips",
    description: "Restore selected archived video/audio clips into the current Videobook as new assets.",
    schema: {
      book_id: z.string().describe("Book id to restore clips into"),
      archive_ids: z.array(z.string()).min(1).max(MAX_RESTORE_IDS).describe("Archive IDs to restore"),
      skip_existing: z.boolean().optional().default(true).describe("Skip archive IDs already restored into this project"),
    },
    handler: async (args) => {
      const { book_id, archive_ids, skip_existing } = args as {
        book_id: string;
        archive_ids: string[];
        skip_existing: boolean;
      };

      const archiveIds = normalizeArchiveIds(archive_ids);
      if (archiveIds.length === 0) return toolError("restore_archive_clips requires at least one archive_id");
      if (archiveIds.length > MAX_RESTORE_IDS) return toolError(`restore_archive_clips supports at most ${MAX_RESTORE_IDS} archive_ids`);
      const invalid = archiveIds.filter((id) => !ARCHIVE_ID_RE.test(id));
      if (invalid.length > 0) return toolError(`Invalid archive_id: ${invalid.join(", ")}`);

      const store = getArchiveStore();
      const indices: ArchiveIndex[] = [];
      for (const archiveId of archiveIds) {
        const index = await store.getJson<ArchiveIndex>(indexKey(store, archiveId));
        if (!index) return toolError(`Archive clip not found: ${archiveId}`);
        indices.push(index);
      }

      const existing = skip_existing
        ? await existingArchiveAssets(engine, indices.map((index) => index.archive_id))
        : new Map<string, string>();
      const targets = new Map<string, ArchiveMediaTarget>();
      for (const index of indices) {
        if (existing.has(index.archive_id)) continue;
        const target = archiveMediaTarget(index);
        if (!target) return toolError(`Archive media type is not supported: ${index.media.filename}`);
        targets.set(index.archive_id, target);
      }
      const restored: Array<{ archive_id: string; asset_id: string; job_id: string }> = [];
      const skipped: Array<{ archive_id: string; asset_id: string; reason: string }> = [];

      for (const index of indices) {
        const existingAssetId = existing.get(index.archive_id);
        if (existingAssetId) {
          skipped.push({ archive_id: index.archive_id, asset_id: existingAssetId, reason: "already_restored" });
          continue;
        }

        const target = targets.get(index.archive_id)!;

        const created = await engine.artifacts.create(target.kind, archiveAssetName(index));
        if (!created.ok) return toolError(created.error.message);

        const writeArchive = await engine.metadata.artifacts.write(created.value.artifactId, "archive", archiveMetadata(index));
        if (!writeArchive.ok) {
          await engine.artifacts.delete(created.value.artifactId).catch(() => undefined);
          return toolError(writeArchive.error.message);
        }

        const jobId = `restore-archive-${created.value.artifactId}-${Date.now()}`;
        try {
          await queue.enqueue(jobId, {
            type: "restore_archive_clip",
            bookId: book_id,
            assetId: created.value.artifactId,
            assetDir: created.value.path,
            archiveId: index.archive_id,
            mediaKey: index.media.key,
            filename: target.filename,
            contentType: index.media.content_type,
            mediaKind: target.kind,
            title: index.title,
            duration: index.duration,
            topics: tagLabels(index.topics),
            people: tagLabels(index.people),
          } as unknown as Record<string, unknown>);
        } catch (error) {
          await engine.artifacts.delete(created.value.artifactId).catch(() => undefined);
          return toolError(error instanceof Error ? error.message : String(error));
        }

        restored.push({
          archive_id: index.archive_id,
          asset_id: created.value.artifactId,
          job_id: jobId,
        });
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: restored.length > 0 ? "enqueued" : "noop",
            restored,
            skipped,
          }),
        }],
      };
    },
  };
}

export const __restoreArchiveClipsTest = {
  archiveMediaTarget,
  normalizeArchiveIds,
};
