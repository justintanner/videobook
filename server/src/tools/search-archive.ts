import { z } from "zod";
import {
  archiveKey,
  archiveTags,
  createArchiveB2,
  getArchiveConfig,
  getJson,
  getText,
  indexKey,
  listObjects,
  missingArchiveConfigKeys,
} from "../archive-b2.js";
import type { ArchiveIndex } from "../archive-b2.js";
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
    prefix: string;
    bucket: string;
    b2: ReturnType<typeof createArchiveB2>;
  },
): Promise<HitSeed[]> {
  const seeds: HitSeed[] = [];
  for (const key of args.keys) {
    const objects = await listObjects(args.b2, args.bucket, archiveKey({ prefix: args.prefix }, `${args.kind}/${key}/`));
    for (const object of objects) {
      const marker = await getJson<ArchiveMarker>(args.b2, args.bucket, object.key);
      const sha256 = marker?.sha256 ?? markerShaFromKey(object.key);
      if (!sha256) continue;
      seeds.push({
        sha256,
        indexKey: marker?.index_key ?? indexKey({ prefix: args.prefix }, sha256),
      });
    }
  }
  return seeds;
}

async function loadAllIndexSeeds(
  args: {
    prefix: string;
    bucket: string;
    b2: ReturnType<typeof createArchiveB2>;
  },
): Promise<HitSeed[]> {
  const objects = await listObjects(args.b2, args.bucket, archiveKey({ prefix: args.prefix }, "clips/"));
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
    description: "Search the global B2 clip archive by topics, named people, or text query.",
    schema: {
      topics: z.array(z.string()).optional().default([]).describe("Topics to match; multiple values use match-any semantics"),
      people: z.array(z.string()).optional().default([]).describe("Named people to match; multiple values use match-any semantics"),
      query: z.string().optional().describe("Optional case-insensitive title/topic/person/transcript substring search"),
      limit: z.number().int().positive().max(100).optional().default(20),
      include_transcript: z.boolean().optional().default(false).describe("Include full transcript text in results"),
      presign_media: z.boolean().optional().default(true).describe("Return a temporary B2 media URL"),
    },
    handler: async (args) => {
      const {
        topics,
        people,
        query,
        limit,
        include_transcript,
        presign_media,
      } = args as {
        topics: string[];
        people: string[];
        query?: string;
        limit: number;
        include_transcript: boolean;
        presign_media: boolean;
      };

      const missing = missingArchiveConfigKeys();
      if (missing.length > 0) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Missing B2 configuration: ${missing.join(", ")}` }],
        };
      }

      const config = getArchiveConfig();
      const b2 = createArchiveB2(config);
      const topicKeys = archiveTags(topics, "manual").map((topic) => topic.key);
      const personKeys = archiveTags(people, "manual").map((person) => person.key);

      const seeds = topicKeys.length > 0 || personKeys.length > 0
        ? [
            ...await loadMarkerSeeds({ kind: "topics", keys: topicKeys, prefix: config.prefix, bucket: config.bucket, b2 }),
            ...await loadMarkerSeeds({ kind: "people", keys: personKeys, prefix: config.prefix, bucket: config.bucket, b2 }),
          ]
        : await loadAllIndexSeeds({ prefix: config.prefix, bucket: config.bucket, b2 });

      const byHash = new Map<string, HitSeed>();
      for (const seed of seeds) {
        if (!byHash.has(seed.sha256)) byHash.set(seed.sha256, seed);
      }

      const results = [];
      for (const seed of byHash.values()) {
        const index = await getJson<ArchiveIndex>(b2, config.bucket, seed.indexKey);
        if (!index) continue;
        const transcript = (query || include_transcript) && index.transcript
          ? await getText(b2, config.bucket, index.transcript.text_key)
          : null;
        if (!includesQuery(index, transcript, query)) continue;
        const signed = presign_media
          ? b2.presign.getObject({ bucket: config.bucket, key: index.media.key, expiresIn: 3600 })
          : null;
        results.push({
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
            url: signed?.url ?? null,
            expires_at: signed?.expiresAt ?? null,
          },
          transcript_excerpt: excerptFor(transcript, query),
          ...(include_transcript ? { transcript } : {}),
        });
        if (results.length >= limit) break;
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ results }),
        }],
      };
    },
  };
}
