import { elevenLabsClient } from "../media/elevenlabs-client.js";
import type { Engine, ArtifactKind, ArtifactManifestFile } from "videobook-engine";
import type {
  ElevenLabsSpeechToTextRequest,
  ElevenLabsSpeechToTextResponse,
  ElevenLabsTranscript,
  ElevenLabsTranscriptWord,
  ElevenLabsTranscriptCharacter,
} from "@apicity/elevenlabs";
import { findAudioFile, findPrimaryMediaFile, findVideoFile } from "videobook-engine";

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, posix } from "node:path";
import { YtDlp } from "ytdlp-nodejs";
import { ytdlpRunOptions } from "../ytdlp-binary.js";
import { registerJobHandler } from "../queue.js";
import { getApiKey, requireApiKey } from "../api-key.js";
import { probeVideo } from "../ffmpeg.js";
import {
  buildIntelligenceResponses,
  firstResponseText,
  intelligenceRequest,
} from "../openai-intelligence.js";
import { validateDownloadOutput } from "./download-video.js";
import { withLocalLease } from "./_lease.js";
import { chunkStarts, chunkLength, extractAudioChunk } from "./_audio-chunks.js";
import {
  archiveTags,
  assetSnapshotKey,
  assetSnapshotPrefix,
  chunkKey,
  clipKey,
  contentTypeForFilename,
  hashFile,
  indexKey,
  ingestKey,
  mergeArchiveIngests,
  personMarkerKey,
  topicMarkerKey,
  transcriptJsonKey,
  transcriptTextKey,
} from "../archive-b2.js";
import type { ArchiveIndex, ArchiveIngest, ArchiveSourceRef } from "../archive-b2.js";
import {
  ARCHIVE_STORE_BOUNDARY,
  getArchiveStore,
  readArchiveIngests,
} from "../archive-store.js";
import type { ArchiveStore } from "../archive-store.js";

type ArchiveClipPayload = {
  type: "archive_clip";
  bookId: string;
  assetId?: string;
  url?: string;
  title?: string;
  topics: string[];
  people: string[];
  languageCode?: string;
  tagAudioEvents: boolean;
  diarize: boolean;
  ingestId: string;
};

type PreparedMedia = {
  mediaPath: string;
  filename: string;
  source: ArchiveSourceRef;
  cleanup?: () => Promise<void>;
  analysisTopics: string[];
  assetSnapshot?: AssetSnapshot;
};

type AssetSnapshotFile = {
  relativePath: string;
  filePath: string;
};

type AssetSnapshot = {
  bookId: string;
  assetId: string;
  files: AssetSnapshotFile[];
};

type TranscriptResult = {
  transcript: ArchiveIndex["transcript"];
  text: string;
  duration: number | null;
};

const MEDIA_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv", ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]);
const CHUNK_SECONDS = 20 * 60;
const ELEVENLABS_TIMEOUT_MS = 10 * 60_000;
const ENRICHMENT_JSON_SCHEMA = {
  type: "object",
  required: ["topics", "people"],
  additionalProperties: false,
  properties: {
    topics: { type: "array", items: { type: "string" } },
    people: { type: "array", items: { type: "string" } },
  },
} as const;

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function sourceTitle(title: string | undefined, fallback: string | undefined): string | undefined {
  const value = title?.trim() || fallback?.trim();
  return value || undefined;
}

function pickMediaFile(files: ArtifactManifestFile[], kind: ArtifactKind): ArtifactManifestFile | null {
  const full = files.find((file) => /^original_full\.(mp4|mov|webm|avi|mkv)$/i.test(file.name));
  return full
    ?? findPrimaryMediaFile(files, kind)
    ?? findVideoFile(files)
    ?? findAudioFile(files, kind);
}

function buildAssetSnapshot(
  manifest: { path: string; files: ArtifactManifestFile[]; directories?: Record<string, string[]> },
  bookId: string,
  assetId: string,
): AssetSnapshot {
  const files: AssetSnapshotFile[] = manifest.files.map((file) => ({
    relativePath: file.name,
    filePath: join(manifest.path, file.name),
  }));
  for (const [dir, names] of Object.entries(manifest.directories ?? {})) {
    for (const name of names) {
      const relativePath = posix.join(dir, name);
      files.push({
        relativePath,
        filePath: join(manifest.path, dir, name),
      });
    }
  }
  return { bookId, assetId, files };
}

async function readAnalysisTopics(
  engine: Engine,
  assetId: string,
): Promise<string[]> {
  const read = await engine.files.read(assetId, ".original.analysis.json");
  if (!read.ok) return [];
  try {
    const parsed = JSON.parse(new TextDecoder().decode(read.value)) as Record<string, unknown>;
    const topics = [
      ...readStringArray(parsed.tags),
      ...readStringArray(parsed.actions),
    ];
    const scenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];
    for (const scene of scenes) {
      if (scene && typeof scene === "object") {
        topics.push(...readStringArray((scene as Record<string, unknown>).tags));
      }
    }
    return topics;
  } catch {
    return [];
  }
}

async function prepareAssetMedia(
  engine: Engine,
  payload: ArchiveClipPayload,
): Promise<PreparedMedia> {
  if (!payload.assetId) {
    throw new Error("asset archive requires assetId");
  }
  const manifest = await engine.files.manifest(payload.assetId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const artifact = engine.artifacts.get(payload.assetId);
  if (!artifact.ok) throw new Error(artifact.error.message);
  const media = pickMediaFile(manifest.value.files, artifact.value.kind);
  if (!media) throw new Error(`No media file found in asset ${payload.assetId}`);
  const extension = extname(media.name).toLowerCase();
  if (!MEDIA_EXTENSIONS.has(extension)) {
    throw new Error(`Archive only supports video/audio media, got ${media.name}`);
  }
  const title = sourceTitle(payload.title, media.name.replace(/\.[^.]+$/, ""));
  return {
    mediaPath: join(manifest.value.path, media.name),
    filename: `original${extension}`,
    source: {
      kind: "asset",
      book_id: payload.bookId,
      asset_id: payload.assetId,
      ...(title ? { title } : {}),
      created_at: new Date().toISOString(),
    },
    analysisTopics: await readAnalysisTopics(engine, payload.assetId),
    assetSnapshot: buildAssetSnapshot(manifest.value, payload.bookId, payload.assetId),
  };
}

async function prepareUrlMedia(payload: ArchiveClipPayload): Promise<PreparedMedia> {
  if (!payload.url) throw new Error("url archive requires url");
  const dir = await mkdtemp(join(tmpdir(), "videocity-archive-"));
  const outputPath = join(dir, "original.mp4");
  const ytdlp = new YtDlp(ytdlpRunOptions());
  try {
    await ytdlp
      .download(payload.url)
      .setOutputTemplate(outputPath)
      .addArgs("--merge-output-format", "mp4")
      .addArgs("--no-playlist")
      .run();
    await validateDownloadOutput(outputPath);
    return {
      mediaPath: outputPath,
      filename: "original.mp4",
      source: {
        kind: "url",
        url: payload.url,
        ...(payload.title?.trim() ? { title: payload.title.trim() } : {}),
        created_at: new Date().toISOString(),
      },
      cleanup: () => rm(dir, { recursive: true, force: true }),
      analysisTopics: [],
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function offsetCharacter(char: ElevenLabsTranscriptCharacter, seconds: number): ElevenLabsTranscriptCharacter {
  return { ...char, start: char.start + seconds, end: char.end + seconds };
}

function offsetWord(word: ElevenLabsTranscriptWord, seconds: number): ElevenLabsTranscriptWord {
  return {
    ...word,
    start: word.start + seconds,
    end: word.end + seconds,
    ...(word.characters ? { characters: word.characters.map((char: ElevenLabsTranscriptCharacter) => offsetCharacter(char, seconds)) } : {}),
  };
}

function transcriptFromResponse(response: ElevenLabsSpeechToTextResponse): ElevenLabsTranscript {
  if ("words" in response) return response;
  if ("transcripts" in response && response.transcripts[0]) return response.transcripts[0];
  throw new Error("ElevenLabs returned an async acknowledgement instead of a transcript");
}

function mergeTranscripts(chunks: Array<{ transcript: ElevenLabsTranscript; offset: number }>, duration: number | null): ElevenLabsTranscript {
  const words = chunks.flatMap((chunk) => chunk.transcript.words.map((word: ElevenLabsTranscriptWord) => offsetWord(word, chunk.offset)));
  const texts = chunks.map((chunk) => chunk.transcript.text.trim()).filter(Boolean);
  const first = chunks[0]?.transcript;
  return {
    language_code: first?.language_code ?? "und",
    language_probability: first?.language_probability ?? 0,
    text: texts.join(" ").trim(),
    words,
    channel_index: first?.channel_index ?? 0,
    transcription_id: null,
    audio_duration_secs: duration ?? chunks.reduce((sum, chunk) => sum + chunk.transcript.audio_duration_secs, 0),
  };
}

async function transcribeMedia(
  store: ArchiveStore,
  args: {
    mediaPath: string;
    sha256: string;
    languageCode?: string;
    tagAudioEvents: boolean;
    diarize: boolean;
  },
): Promise<TranscriptResult> {
  const probe = await probeVideo(args.mediaPath);
  if (!probe.hasAudio) {
    const empty: ElevenLabsTranscript = {
      language_code: args.languageCode ?? "und",
      language_probability: 0,
      text: "",
      words: [],
      channel_index: 0,
      transcription_id: null,
      audio_duration_secs: probe.duration,
    };
    await store.putJson(transcriptJsonKey(store, args.sha256), empty);
    await store.putText(transcriptTextKey(store, args.sha256), "");
    return {
      transcript: {
        json_key: transcriptJsonKey(store, args.sha256),
        text_key: transcriptTextKey(store, args.sha256),
        chunk_count: 0,
        provider: "elevenlabs",
      },
      text: "",
      duration: probe.duration,
    };
  }

  const apiKey = requireApiKey("ELEVENLABS_API_KEY");
  const provider = elevenLabsClient({ apiKey, timeout: ELEVENLABS_TIMEOUT_MS });
  const dir = await mkdtemp(join(tmpdir(), "videocity-archive-audio-"));
  const chunks: Array<{ transcript: ElevenLabsTranscript; offset: number }> = [];
  try {
    const starts = chunkStarts(probe.duration, CHUNK_SECONDS);
    for (let index = 0; index < starts.length; index++) {
      const start = starts[index];
      const length = chunkLength(probe.duration, start, CHUNK_SECONDS);
      const chunkPath = join(dir, `chunk-${String(index).padStart(3, "0")}.mp3`);
      await extractAudioChunk(args.mediaPath, start, length, chunkPath);
      const bytes = await readFile(chunkPath);
      const file = new Blob([new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))], { type: "audio/mpeg" });
      const request: ElevenLabsSpeechToTextRequest = {
        model_id: "scribe_v2",
        file,
        tag_audio_events: args.tagAudioEvents,
        diarize: args.diarize,
        ...(args.languageCode ? { language_code: args.languageCode } : {}),
      };
      const response = await provider.v1.speechToText(request);
      await store.putJson(chunkKey(store, args.sha256, index), response);
      chunks.push({ transcript: transcriptFromResponse(response), offset: start });
    }
    const merged = mergeTranscripts(chunks, probe.duration);
    await store.putJson(transcriptJsonKey(store, args.sha256), merged);
    await store.putText(transcriptTextKey(store, args.sha256), merged.text);
    return {
      transcript: {
        json_key: transcriptJsonKey(store, args.sha256),
        text_key: transcriptTextKey(store, args.sha256),
        chunk_count: chunks.length,
        provider: "elevenlabs",
      },
      text: merged.text,
      duration: probe.duration,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function sampleTranscript(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= 14000) return clean;
  const head = clean.slice(0, 6000);
  const middleStart = Math.max(0, Math.floor(clean.length / 2) - 3000);
  const middle = clean.slice(middleStart, middleStart + 6000);
  const tail = clean.slice(-4000);
  return [head, middle, tail].join("\n\n");
}

async function enrichMetadata(title: string | null, transcript: string): Promise<{ topics: string[]; people: string[] }> {
  const apiKey = getApiKey("OPENAI_API_KEY");
  const sample = sampleTranscript(transcript);
  if (!apiKey || (!title && !sample)) return { topics: [], people: [] };
  try {
    const responses = buildIntelligenceResponses(apiKey, { timeout: 120_000 });
    const response = await responses(intelligenceRequest({
      instructions: "Identify searchable subjects and named people. People must be named people only, not generic roles.",
      input: [{
        role: "user",
        content: `Title: ${title ?? ""}\n\nTranscript sample:\n${sample}`,
      }],
      text: {
        format: {
          type: "json_schema",
          name: "archive_metadata",
          schema: ENRICHMENT_JSON_SCHEMA,
          strict: true,
        },
      },
      max_output_tokens: 1000,
    }));
    const outputText = firstResponseText(response);
    const parsed = JSON.parse(outputText) as Record<string, unknown>;
    return {
      topics: readStringArray(parsed.topics),
      people: readStringArray(parsed.people),
    };
  } catch {
    return { topics: [], people: [] };
  }
}

async function writeMarkers(args: {
  ingest: ArchiveIngest;
  store: ArchiveStore;
}): Promise<void> {
  const marker = {
    sha256: args.ingest.sha256,
    ingest_id: args.ingest.ingest_id,
    title: args.ingest.title,
    topics: args.ingest.topics,
    people: args.ingest.people,
    index_key: indexKey(args.store, args.ingest.sha256),
    created_at: args.ingest.created_at,
  };
  await Promise.all([
    ...args.ingest.topics.map((topic) =>
      args.store.putJson(
        topicMarkerKey(args.store, topic.key, args.ingest.sha256, args.ingest.ingest_id),
        marker,
      ),
    ),
    ...args.ingest.people.map((person) =>
      args.store.putJson(
        personMarkerKey(args.store, person.key, args.ingest.sha256, args.ingest.ingest_id),
        marker,
      ),
    ),
  ]);
}

async function buildAndWriteIndex(args: {
  sha256: string;
  mediaKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  transcript: ArchiveIndex["transcript"];
  duration: number | null;
  existing: ArchiveIndex | null;
  store: ArchiveStore;
}): Promise<ArchiveIndex> {
  const ingests = await readArchiveIngests(args.store, args.sha256);
  const index = mergeArchiveIngests(ingests, {
    sha256: args.sha256,
    mediaKey: args.mediaKey,
    filename: args.filename,
    contentType: args.contentType,
    sizeBytes: args.sizeBytes,
    transcript: args.transcript,
    duration: args.duration,
    existing: args.existing,
  });
  await args.store.putJson(indexKey(args.store, args.sha256), index);
  return index;
}

async function uploadAssetSnapshot(args: {
  snapshot: AssetSnapshot | undefined;
  sha256: string;
  store: ArchiveStore;
}): Promise<{ prefix: string; fileCount: number } | null> {
  if (!args.snapshot) return null;
  const prefix = assetSnapshotPrefix(
    args.store,
    args.sha256,
  );
  let fileCount = 0;
  for (const file of args.snapshot.files) {
    const key = assetSnapshotKey(
      args.store,
      args.sha256,
      file.relativePath,
    );
    await args.store.uploadFile(
      key,
      file.filePath,
      contentTypeForFilename(file.relativePath),
    );
    fileCount += 1;
  }
  return { prefix, fileCount };
}

async function runArchive(engine: Engine, payload: ArchiveClipPayload): Promise<Record<string, unknown>> {
  const prepared = payload.url ? await prepareUrlMedia(payload) : await prepareAssetMedia(engine, payload);
  try {
    const store = getArchiveStore();
    const sha256 = await hashFile(prepared.mediaPath);
    const existing = await store.getJson<ArchiveIndex>(indexKey(store, sha256));
    const duplicate = existing !== null;
    const contentType = duplicate ? existing.media.content_type : contentTypeForFilename(prepared.filename);
    const mediaKey = duplicate ? existing.media.key : clipKey(store, sha256, prepared.filename);
    const size = duplicate ? existing.media.size_bytes : (await import("node:fs/promises")).stat(prepared.mediaPath).then((item) => item.size);
    const sizeBytes = await size;

    let transcript = existing?.transcript ?? null;
    let transcriptText = "";
    let duration = existing?.duration ?? null;

    if (!duplicate) {
      if (!(await store.exists(mediaKey))) {
        await store.uploadFile(mediaKey, prepared.mediaPath, contentType);
      }
      const transcriptResult = await transcribeMedia(store, {
        mediaPath: prepared.mediaPath,
        sha256,
        languageCode: payload.languageCode,
        tagAudioEvents: payload.tagAudioEvents,
        diarize: payload.diarize,
      });
      transcript = transcriptResult.transcript;
      transcriptText = transcriptResult.text;
      duration = transcriptResult.duration;
    }
    const assetSnapshot = await uploadAssetSnapshot({
      snapshot: prepared.assetSnapshot,
      sha256,
      store,
    });

    const title = sourceTitle(payload.title, prepared.source.title);
    const enriched = duplicate ? { topics: [], people: [] } : await enrichMetadata(title ?? null, transcriptText);
    const manualTopics = archiveTags(payload.topics, "manual");
    const manualPeople = archiveTags(payload.people, "manual");
    const autoTopics = archiveTags([...prepared.analysisTopics, ...enriched.topics], "auto");
    const autoPeople = archiveTags(enriched.people, "auto");
    const ingest: ArchiveIngest = {
      schema_version: 1,
      ingest_id: payload.ingestId,
      sha256,
      source: prepared.source,
      title: title ?? null,
      topics: [...manualTopics, ...autoTopics],
      people: [...manualPeople, ...autoPeople],
      created_at: new Date().toISOString(),
    };

    await store.putJson(ingestKey(store, sha256, payload.ingestId), ingest);
    await writeMarkers({ ingest, store });
    const index = await buildAndWriteIndex({
      sha256,
      mediaKey,
      filename: duplicate ? existing.media.filename : prepared.filename,
      contentType,
      sizeBytes,
      transcript,
      duration,
      existing,
      store,
    });

    return {
      archive_id: sha256,
      cache_role: ARCHIVE_STORE_BOUNDARY.role,
      sha256,
      duplicate,
      ingest_id: payload.ingestId,
      asset_snapshot_prefix: assetSnapshot?.prefix ?? null,
      asset_snapshot_file_count: assetSnapshot?.fileCount ?? 0,
      topics: index.topics.map((topic) => topic.label),
      people: index.people.map((person) => person.label),
      title: index.title,
      sources: index.sources,
      transcript: index.transcript,
      duration: index.duration,
    };
  } finally {
    await prepared.cleanup?.();
  }
}

async function writeArchiveMetadata(engine: Engine, payload: ArchiveClipPayload, result: Record<string, unknown>): Promise<void> {
  if (!payload.assetId) return;
  const archiveId = result.archive_id;
  if (typeof archiveId !== "string") return;
  const write = await engine.metadata.artifacts.write(payload.assetId, "archive", {
    archive_id: archiveId,
    ingest_id: result.ingest_id,
    duplicate: result.duplicate,
    asset_snapshot_prefix: result.asset_snapshot_prefix,
    asset_snapshot_file_count: result.asset_snapshot_file_count,
    topics: result.topics,
    people: result.people,
    title: result.title,
    sources: result.sources,
    transcript: result.transcript,
    duration: result.duration,
    cache_role: result.cache_role,
    archived_at: new Date().toISOString(),
  });
  if (!write.ok) throw new Error(write.error.message);
}

export function registerArchiveClipJob(engine: Engine): void {
  registerJobHandler("archive_clip", async (payload, ctx) => {
    const p = payload as ArchiveClipPayload;
    if (p.assetId) {
      return withLocalLease(engine, p.assetId, ctx, "archive", async () => {
        const result = await runArchive(engine, p);
        await writeArchiveMetadata(engine, p, result);
        return result;
      });
    }
    return runArchive(engine, { ...p, ingestId: p.ingestId || randomUUID() });
  });
}

export const __archiveClipJobTest = {
  archiveTags,
  buildAssetSnapshot,
  mergeTranscripts,
  sampleTranscript,
};
