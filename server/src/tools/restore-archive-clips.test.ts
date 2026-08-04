import { describe, expect, it } from "vitest";
import type { ArchiveIndex } from "../archive-b2.js";
import { __restoreArchiveClipsTest } from "./restore-archive-clips.js";

const sha = "a".repeat(64);

function archiveIndex(filename: string, contentType: string): ArchiveIndex {
  return {
    schema_version: 1,
    sha256: sha,
    archive_id: sha,
    title: "Clip",
    topics: [],
    people: [],
    sources: [],
    ingests: [],
    media: {
      key: `archive/clips/${sha}/${filename}`,
      filename,
      content_type: contentType,
      size_bytes: 10,
    },
    transcript: null,
    duration: null,
    created_at: "2026-06-09T00:00:00.000Z",
    updated_at: "2026-06-09T00:00:00.000Z",
  };
}

describe("restore archive clips helpers", () => {
  it("dedupes and normalizes archive IDs", () => {
    expect(__restoreArchiveClipsTest.normalizeArchiveIds([
      ` ${sha.toUpperCase()} `,
      sha,
      "",
      "b".repeat(64),
    ])).toEqual([sha, "b".repeat(64)]);
  });

  it("maps archived video media to restored video assets", () => {
    expect(__restoreArchiveClipsTest.archiveMediaTarget(
      archiveIndex("original.mov", "video/quicktime"),
    )).toEqual({ kind: "video", filename: "original.mov" });
  });

  it("maps archived audio media to restored audio assets", () => {
    expect(__restoreArchiveClipsTest.archiveMediaTarget(
      archiveIndex("original", "audio/mpeg"),
    )).toEqual({ kind: "audio", filename: "original.mp3" });
  });

  it("rejects unsupported archive media", () => {
    expect(__restoreArchiveClipsTest.archiveMediaTarget(
      archiveIndex("original.txt", "text/plain"),
    )).toBeNull();
  });
});
