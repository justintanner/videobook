import { describe, expect, it } from "vitest";
import {
  archiveTags,
  chunkKey,
  clipKey,
  indexKey,
  ingestKey,
  mergeArchiveIngests,
  normalizeArchiveKey,
  personMarkerKey,
  topicMarkerKey,
  transcriptJsonKey,
  transcriptTextKey,
} from "./archive-b2.js";
import type { ArchiveIndex, ArchiveIngest } from "./archive-b2.js";

const sha256 = "a".repeat(64);

describe("B2 archive helpers", () => {
  it("normalizes searchable topic and person keys", () => {
    expect(normalizeArchiveKey("  José Núñez / AI Safety!!  ")).toBe("jose-nunez-ai-safety");
    expect(archiveTags(["AI Safety", "ai safety", "  Film  "], "manual")).toEqual([
      { key: "ai-safety", label: "AI Safety", source: "manual" },
      { key: "film", label: "Film", source: "manual" },
    ]);
  });

  it("keeps clip files flat under clips/<sha256>/", () => {
    const config = { prefix: "archive" };

    expect(clipKey(config, sha256, "original.mp4")).toBe(`archive/clips/${sha256}/original.mp4`);
    expect(indexKey(config, sha256)).toBe(`archive/clips/${sha256}/index.json`);
    expect(transcriptJsonKey(config, sha256)).toBe(`archive/clips/${sha256}/transcript.json`);
    expect(transcriptTextKey(config, sha256)).toBe(`archive/clips/${sha256}/transcript.txt`);
    expect(chunkKey(config, sha256, 7)).toBe(`archive/clips/${sha256}/chunk-007.json`);
    expect(ingestKey(config, sha256, "ingest-a")).toBe(`archive/clips/${sha256}/ingest-ingest-a.json`);
    expect(topicMarkerKey(config, "ai-safety", sha256, "ingest-a")).toBe(`archive/topics/ai-safety/${sha256}-ingest-a.json`);
    expect(personMarkerKey(config, "ada-lovelace", sha256, "ingest-a")).toBe(`archive/people/ada-lovelace/${sha256}-ingest-a.json`);
  });

  it("merges concurrent ingests by hash and preserves manual metadata", () => {
    const existing: ArchiveIndex = {
      schema_version: 1,
      sha256,
      archive_id: sha256,
      title: null,
      topics: [{ key: "ai", label: "AI", source: "auto" }],
      people: [{ key: "grace-hopper", label: "Grace Hopper", source: "auto" }],
      sources: [],
      ingests: [],
      media: {
        key: `clips/${sha256}/original.mp4`,
        filename: "original.mp4",
        content_type: "video/mp4",
        size_bytes: 100,
      },
      transcript: null,
      duration: null,
      created_at: "2026-06-09T08:00:00.000Z",
      updated_at: "2026-06-09T08:00:00.000Z",
    };
    const first: ArchiveIngest = {
      schema_version: 1,
      ingest_id: "ingest-2",
      sha256,
      source: { kind: "url", url: "https://example.com/b", created_at: "2026-06-09T08:02:00.000Z" },
      title: null,
      topics: [{ key: "film", label: "Film", source: "manual" }],
      people: [],
      created_at: "2026-06-09T08:02:00.000Z",
    };
    const second: ArchiveIngest = {
      schema_version: 1,
      ingest_id: "ingest-1",
      sha256,
      source: { kind: "url", url: "https://example.com/a", created_at: "2026-06-09T08:01:00.000Z" },
      title: "Lecture",
      topics: [{ key: "ai", label: "AI", source: "manual" }],
      people: [{ key: "grace-hopper", label: "Grace Hopper", source: "manual" }],
      created_at: "2026-06-09T08:01:00.000Z",
    };

    const index = mergeArchiveIngests([first, second], {
      sha256,
      mediaKey: `clips/${sha256}/original.mp4`,
      filename: "original.mp4",
      contentType: "video/mp4",
      sizeBytes: 100,
      transcript: null,
      duration: null,
      existing,
    });

    expect(index.title).toBe("Lecture");
    expect(index.created_at).toBe(existing.created_at);
    expect(index.ingests).toEqual(["ingest-1", "ingest-2"]);
    expect(index.sources.map((source) => source.url)).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(index.topics).toEqual([
      { key: "ai", label: "AI", source: "manual" },
      { key: "film", label: "Film", source: "manual" },
    ]);
    expect(index.people).toEqual([
      { key: "grace-hopper", label: "Grace Hopper", source: "manual" },
    ]);
  });
});
