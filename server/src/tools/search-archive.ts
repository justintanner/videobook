import { z } from "zod";
import {
  archiveKey,
  archiveTags,
  indexKey,
} from "../archive-b2.js";
import type { ArchiveIndex } from "../archive-b2.js";
import { getArchiveStore } from "../archive-store.js";
import type { ArchiveStore } from "../archive-store.js";
import type { ToolDef } from "./tool-def.js";

type ArchiveMarker = {
  sha256: string;
  ingest_id: string;
  index_key: string;
};

type HitSeed = {
  sha256: string;
  indexKey: string;
};

type ArchiveSearchHit = {
  sortAt: string;
  result: Record<string, unknown>;
};

function markerShaFromKey(key: string): string | null {
  const match = /\/([a-f0-9]{64})-[^/]+\.json$/i.exec(key);
  return match?.[1]?.toLowerCase() ?? null;
}

function includesQuery(index: ArchiveIndex, transcript: string | null, query: string | undefined): boolean {
  const q = query?.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    index.title ?? "",
    ...index.topics.map((topic) => topic.label),
    ...index.people.map((person) => person.label),
    transcript ?? "",
  ].join("\n").toLowerCase();
  return haystack.includes(q);
}

function excerptFor(transcript: string | null, query: string | undefined): string | null {
  if (!transcript) return null;
  const clean = transcript.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const q = query?.trim().toLowerCase();
  if (!q) return clean.slice(0, 280);
  const idx = clean.toLowerCase().indexOf(q);
  if (idx < 0) return clean.slice(0, 280);
  const start = Math.max(0, idx - 100);
  return clean.slice(start, start + 320);
}

async function loadMarkerSeeds(
  args: {
    kind: "topics" | "people";
    keys: string[];
    store: ArchiveStore;
  },
): Promise<HitSeed[]> {
  const seeds: HitSeed[] = [];
  for (const key of args.keys) {
    const objects = await args.store.list(archiveKey(args.store, `${args.kind}/${key}/`));
    for (const object of objects) {
      const marker = await args.store.getJson<ArchiveMarker>(object.key);
      const sha256 = marker?.sha256 ?? markerShaFromKey(object.key);
      if (!sha256) continue;
      seeds.push({
        sha256,
        indexKey: marker?.index_key ?? indexKey(args.store, sha256),
      });
    }
  }
  return seeds;
}

async function loadAllIndexSeeds(
  args: {
    store: ArchiveStore;
  },
): Promise<HitSeed[]> {
  const objects = await args.store.list(archiveKey(args.store, "clips/"));
  return objects
    .filter((object) => /\/archive\.json$/.test(object.key))
    .map((object) => {
      const match = /(?:^|\/)clips\/([a-f0-9]{64})\/archive\.json$/i.exec(object.key);
      return match?.[1]
        ? { sha256: match[1].toLowerCase(), indexKey: object.key }
        : null;
    })
    .filter((seed): seed is HitSeed => seed !== null);
}

export function searchArchiveDef(): ToolDef {
  return {
    name: "search_archive",
    description: "Search the global clip archive (B2 if configured, otherwise the local archive folder) by topics, named people, or text query.",
    schema: {
      topics: z.array(z.string()).optional().default([]).describe("Topics to match; multiple values use match-any semantics"),
      people: z.array(z.string()).optional().default([]).describe("Named people to match; multiple values use match-any semantics"),
      query: z.string().optional().describe("Optional case-insensitive title/topic/person/transcript substring search"),
      limit: z.number().int().positive().max(100).optional().default(20),
      offset: z.number().int().min(0).optional().default(0),
      sort: z.enum(["newest", "oldest"]).optional().default("newest").describe("Sort archived clips by archive updated time"),
      include_transcript: z.boolean().optional().default(false).describe("Include full transcript text in results"),
      presign_media: z.boolean().optional().default(true).describe("Return a playable media URL (temporary B2 URL or local server path)"),
    },
    handler: async (args) => {
      const {
        topics,
        people,
        query,
        limit,
        offset,
        sort,
        include_transcript,
        presign_media,
      } = args as {
        topics: string[];
        people: string[];
        query?: string;
        limit: number;
        offset: number;
        sort: "newest" | "oldest";
        include_transcript: boolean;
        presign_media: boolean;
      };

      const store = getArchiveStore();
      const topicKeys = archiveTags(topics, "manual").map((topic) => topic.key);
      const personKeys = archiveTags(people, "manual").map((person) => person.key);

      const seeds = topicKeys.length > 0 || personKeys.length > 0
        ? [
            ...await loadMarkerSeeds({ kind: "topics", keys: topicKeys, store }),
            ...await loadMarkerSeeds({ kind: "people", keys: personKeys, store }),
          ]
        : await loadAllIndexSeeds({ store });

      const byHash = new Map<string, HitSeed>();
      for (const seed of seeds) {
        if (!byHash.has(seed.sha256)) byHash.set(seed.sha256, seed);
      }

      const hits: ArchiveSearchHit[] = [];
      for (const seed of byHash.values()) {
        const index = await store.getJson<ArchiveIndex>(seed.indexKey);
        if (!index) continue;
        const transcript = (query || include_transcript) && index.transcript
          ? await store.getText(index.transcript.text_key)
          : null;
        if (!includesQuery(index, transcript, query)) continue;
        hits.push({
          sortAt: index.updated_at || index.created_at,
          result: {
            archive_id: index.archive_id,
            sha256: index.sha256,
            title: index.title,
            topics: index.topics,
            people: index.people,
            sources: index.sources,
            duration: index.duration,
            media: {
              key: index.media.key,
              content_type: index.media.content_type,
              size_bytes: index.media.size_bytes,
              url: null,
              expires_at: null,
            },
            transcript_excerpt: excerptFor(transcript, query),
            ...(include_transcript ? { transcript } : {}),
          },
        });
      }

      hits.sort((a, b) => sort === "newest" ? b.sortAt.localeCompare(a.sortAt) : a.sortAt.localeCompare(b.sortAt));
      const paged = hits.slice(offset, offset + limit).map((hit) => hit.result);
      if (presign_media) {
        for (const result of paged) {
          const media = result.media as { key: string; url: string | null; expires_at: string | null };
          const signed = store.presignGet(media.key, 3600);
          media.url = signed?.url ?? null;
          media.expires_at = signed?.expiresAt ?? null;
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            results: paged,
            total: hits.length,
            offset,
            limit,
            has_more: offset + paged.length < hits.length,
          }),
        }],
      };
    },
  };
}
